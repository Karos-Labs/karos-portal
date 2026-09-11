import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  STEER_NEWS_BODY,
  STEER_RUN_HELPER_WITH_KIND,
  STEER_RUN_LABEL,
  STEER_STANDING_BODY,
} from "@/lib/intake-steer-copy";
import { stripComments } from "./source-scan";

/**
 * SCRUM-411: three ways to steer an agent, three stated scopes, no
 * cross-references.
 *
 * WHAT LOLA REPORTED. "The second 'direction for this run' box is repetitive
 * and confusing, clashing with the first one."
 *
 * THE MERGE THE TICKET ASKED FOR IS REFUSED, and the refusal is the first thing
 * this file holds - because the next person to read that ticket will try it
 * again. It said to fold "What happened this week" into "What should we cover
 * next", and to check the consumers first. Checked: that box is mounted on BOTH
 * the X and the LinkedIn intake, writes to ONE collection, is read by both
 * `x-agent-context` and `linkedin-agent-context`, and is not free text - its
 * `type` comes from a pick-list the lab skill routes by. Folding it into a
 * LinkedIn-only per-identity free-text box cuts the X agent off from company
 * news and throws away that schema.
 *
 * WHAT THE CLASH ACTUALLY WAS. Each box's paragraph claimed the other's job.
 * The direction box invited "information to work in" (the news box's job) and
 * the news box offered to "turn it into the post" (the direction box's), a few
 * hundred pixels apart on one screen. And the run dialog's field told the
 * reader that another box was the real one - which is a field admitting it is a
 * duplicate.
 */

const SRC = path.resolve(__dirname, "../..");
const code = (rel: string) => stripComments(readFileSync(path.join(SRC, rel), "utf8"));

/* ───────────────── the refusal, held so it is not retried ──────────────── */

describe("the shared news box stays shared", () => {
  it("is still mounted on both intakes and still writes to one action", () => {
    // The evidence for refusing the merge. If a later change makes this one
    // platform's box, the merge becomes possible - and this test is where that
    // conversation restarts.
    const news = code("components/company-news-box.tsx");
    expect(news).toContain("addXNewsUpdateAction");
    for (const family of ["linkedin", "x"] as const) {
      expect(code(`components/${family}-agent-intake.tsx`), family).toContain("<CompanyNewsBox");
    }
  });

  it("is still read by both agents' context builders", () => {
    for (const ctx of ["x-agent-context", "linkedin-agent-context"] as const) {
      expect(code(`lib/agent-service/${ctx}.ts`), ctx).toContain("listXNewsUpdates");
    }
  });

  it("still carries the structured fields its skill routes on", () => {
    // Not free text: folding it into the free-text direction box would lose
    // the pick-list.
    const news = code("components/company-news-box.tsx");
    expect(news).toContain("const NEWS_TYPES");
    expect(news).toMatch(/"customer story"/);
  });
});

/* ────────────────────────── each box states its own job ────────────────── */

describe("the two standing boxes", () => {
  it("stop claiming each other's job", () => {
    // The two exact phrases that crossed over.
    expect(STEER_STANDING_BODY).not.toMatch(/information to work in/i);
    expect(STEER_NEWS_BODY).not.toMatch(/turn it into the post/i);
  });

  it("say which one takes a subject and which one takes facts", () => {
    expect(STEER_STANDING_BODY).toMatch(/subject/i);
    expect(STEER_NEWS_BODY).toMatch(/facts/i);
    expect(STEER_NEWS_BODY).toMatch(/not a topic request/i);
  });

  it("says the standing row closes itself, which is what makes it not a run note", () => {
    // A reader who knows this stops re-typing it into the run dialog every time.
    expect(STEER_STANDING_BODY).toMatch(/until a run covers it/i);
  });

  it("says the news drop is read by every agent, so it is filed once", () => {
    expect(STEER_NEWS_BODY).toMatch(/every agent/i);
  });

  it("are rendered from the register, not retyped in the components", () => {
    expect(code("components/linkedin-agent-intake.tsx")).toContain("{STEER_STANDING_BODY}");
    expect(code("components/company-news-box.tsx")).toContain("{STEER_NEWS_BODY}");
  });
});

/* ─────────────────────────── the per-run field ─────────────────────────── */

describe("the run dialog's direction field", () => {
  const launch = code("lib/custom-agent-launch.ts");

  it("is named the way the rest of the product names it", () => {
    // `engine-agent-card.tsx` and the dynamic profile already said this; the
    // three custom-agent profiles said "Anything to lean into this run?".
    expect(STEER_RUN_LABEL).toBe("Direction for this run (optional)");
    expect(code("components/agents/engine-agent-card.tsx")).toContain(
      "Direction for this run (optional)",
    );
    expect(launch).not.toContain("Anything to lean into this run?");
  });

  it("points at no other box", () => {
    // The sentence that made it read as a duplicate. Asserted on the register
    // AND on the file, because a redirect could be re-typed at a call site.
    for (const helper of [STEER_RUN_HELPER_WITH_KIND]) {
      expect(helper).not.toMatch(/What should we cover next/i);
      expect(helper).not.toMatch(/instead/i);
    }
    expect(launch).not.toContain("What should we cover next");
  });

  it("keeps SCRUM-409's correction, which is a fact about the engine", () => {
    // The shape is decided by "Kind of post"; the note does not override it.
    // That is not a statement about the other boxes and it stays.
    expect(STEER_RUN_HELPER_WITH_KIND).toMatch(/Kind of post/);
    expect(STEER_RUN_HELPER_WITH_KIND).toMatch(/this run only/);
  });

  it("is the label on every profile that has the field", () => {
    // Three profiles carried three spellings of one field. A floor rather than
    // a count, since profiles are expected to be added.
    expect((launch.match(/label: STEER_RUN_LABEL,/g) ?? []).length).toBeGreaterThanOrEqual(3);
  });
});

/* ──────────────────────────────── the copy rules ────────────────────────── */

describe("all four strings read as client copy", () => {
  const all = [
    STEER_STANDING_BODY,
    STEER_NEWS_BODY,
    STEER_RUN_LABEL,
    STEER_RUN_HELPER_WITH_KIND,
  ];

  it("carries no em dash and no spaced hyphen", () => {
    for (const s of all) {
      expect(s).not.toContain("—");
      expect(s).not.toMatch(/ - /);
    }
  });

  it("says something, so none of these is an empty pin", () => {
    for (const s of all) expect(s.length).toBeGreaterThan(10);
  });
});
