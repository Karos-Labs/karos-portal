import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";

import { NO_FORMATS_RUNNING, NO_FORMATS_YET } from "@/lib/client-agent-format-copy";
import { stripComments } from "./source-scan";

/**
 * THE OBJECT HAS ONE NAME ON A CLIENT'S SCREEN, AND IT IS "FORMAT".
 *
 * It had three. The schema calls it a template stream (`ClientAgentTemplate`,
 * `Asset.templateKey`, submit-custom's job field) and that is correct in the
 * schema; the client vocabulary settled on "format" and every client surface says
 * so — until one did not. The launch card's live summary read "No template
 * streams registered yet." while the detail panel one component over, for the
 * same empty registry, said "no formats registered yet": two of the three names
 * on one page, and the internal one at that.
 *
 * TWO RULES, and they are different questions rather than one asked twice:
 *
 *  1. The INTERNAL name reaches no rendered string. Swept over src/ by shape, so
 *     the next surface to spell it is caught rather than the one that was
 *     reported.
 *  2. The SENTENCE is written once. Two surfaces say it, and they had already
 *     drifted, which is the evidence that a shared constant is the fix and not
 *     tidiness.
 */

const SRC = join(process.cwd(), "src");
const HOME = join(SRC, "lib", "client-agent-format-copy.ts");

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(full)) out.push(full);
  }
  return out;
}

const FILES = walk(SRC).filter((f) => !f.includes("__tests__"));

/** Singular or plural, any casing — the shape, not the one spelling reported. */
const INTERNAL_NAME = /template\s+streams?/i;

describe("the client's word for a template stream", () => {
  it("puts the internal name in no rendered string anywhere in src/", () => {
    // COMMENT-STRIPPED, and that is load-bearing rather than hygiene: the phrase
    // is all over this repo's docstrings, correctly — types.ts defines the thing,
    // the webhook resolves one, archive-view's own comment explains the grouping.
    // A scan over raw source would be satisfied by prose, so it would have to be
    // green everywhere or red everywhere, and neither reads the rendered string.
    const offenders = FILES.filter((f) =>
      INTERNAL_NAME.test(stripComments(readFileSync(f, "utf8"))),
    ).map((f) => relative(SRC, f).split(sep).join("/"));
    expect(
      offenders,
      'these render the schema\'s name for a format; the client\'s word is "format"',
    ).toEqual([]);
  });

  it("is still reading the tree, and the strip is what makes it green", () => {
    // NON-VACUITY, in the one form that proves both halves at once: the phrase IS
    // in this tree — in comments — so a scan of RAW source must find it. If that
    // list is empty the walk is broken, and if the stripped list above were green
    // for the same reason it would be worthless.
    const inProse = FILES.filter((f) => INTERNAL_NAME.test(readFileSync(f, "utf8"))).map((f) =>
      relative(SRC, f).split(sep).join("/"),
    );
    expect(
      inProse.length,
      "the phrase is nowhere in src/ at all, so the sweep above proves nothing",
    ).toBeGreaterThan(0);
    // And the strip really removed something rather than the two lists being
    // trivially equal.
    const stripped = FILES.filter((f) =>
      INTERNAL_NAME.test(stripComments(readFileSync(f, "utf8"))),
    );
    expect(stripped.length).toBeLessThan(inProse.length);
  });
});

describe("the empty-registry sentence", () => {
  it("is written in one place, and both surfaces read it from there", () => {
    // The duplicate is the defect, so the sweep is for a SECOND copy of the
    // literal rather than for the absence of the first.
    const spellers = FILES.filter(
      (f) => f !== HOME && stripComments(readFileSync(f, "utf8")).includes(NO_FORMATS_YET),
    ).map((f) => relative(SRC, f).split(sep).join("/"));
    expect(spellers, "these re-type the sentence instead of importing it").toEqual([]);

    // Non-vacuity for that negative: the two surfaces really do reference the
    // constants, so "nobody re-types it" is not "nobody says it".
    const readers = FILES.filter((f) => {
      const src = stripComments(readFileSync(f, "utf8"));
      return src.includes("NO_FORMATS_YET") || src.includes("NO_FORMATS_RUNNING");
    }).map((f) => relative(SRC, f).split(sep).join("/"));
    expect(readers).toContain("components/client-agents/live-card.tsx");
    expect(readers).toContain("components/client-agents/launch-card.tsx");
  });

  it("says two different things, because the two surfaces ask different questions", () => {
    // A CONSOLIDATION HAS TO BE TRUE AT EVERY SITE IT TAKES OVER, and one sentence
    // would not have been. The detail panel asks "are there any formats at all";
    // the launch summary lists only the ACTIVE ones, so on an agent whose formats
    // are all paused or retired "no formats registered yet" is false.
    expect(NO_FORMATS_YET).not.toBe(NO_FORMATS_RUNNING);
    // Neither may name the schema's word, or the fix would have moved the defect
    // into the shared module.
    expect(NO_FORMATS_YET).not.toMatch(INTERNAL_NAME);
    expect(NO_FORMATS_RUNNING).not.toMatch(INTERNAL_NAME);
    // And neither prints one of the three stored states at a client: "active",
    // "paused" and "retired" are our enum, and the second sentence has to be true
    // under every mix of them, which is why it says "running".
    for (const stored of ["active", "paused", "retired"]) {
      expect(NO_FORMATS_RUNNING.toLowerCase(), `names the stored state "${stored}"`).not.toContain(
        stored,
      );
    }
  });
});


describe("each sentence goes with the condition that makes it true", () => {
  /**
   * THE SPLIT'S WHOLE ARGUMENT, WHICH NOTHING PINNED.
   *
   * `client-agent-format-copy.ts` calls the two constants "a correctness point
   * rather than a flourish": "no formats registered yet" is FALSE on an agent
   * whose formats are all paused or retired, because it has formats — none of
   * them running. The caller that implements that argument is a single ternary
   * in launch-card's TemplateSummary, and the suite pinned the vocabulary while
   * stopping exactly short of the branch.
   *
   * Swapping the arms puts a false statement on a client's card in BOTH
   * directions, and neither is visible to a word scan: an empty registry told
   * "none are running right now", or a fully-paused agent told it has none.
   *
   * Asserted as CONTAINMENT of each constant inside the correct arm of the real
   * ternary, not as proximity — the two constants sit three tokens apart.
   */
  const LAUNCH_CARD = join(process.cwd(), "src/components/client-agents/launch-card.tsx");
  const src = stripComments(readFileSync(LAUNCH_CARD, "utf8"));
  const at = src.indexOf("agent.templates.length === 0");

  it("still has the branch this file is about", () => {
    expect(at, "TemplateSummary's empty-formats branch moved or was renamed").toBeGreaterThan(-1);
  });

  it("tells an agent with NO formats that it has none yet", () => {
    const arms = src.slice(at, src.indexOf("}", at));
    const q = arms.indexOf("?");
    const colon = arms.indexOf(":", q);
    expect(q, "the branch is no longer a ternary").toBeGreaterThan(-1);
    expect(arms.slice(q, colon), "the empty-registry arm says the wrong thing").toContain(
      "NO_FORMATS_YET",
    );
  });

  it("tells an agent whose formats are all paused that none are running", () => {
    const arms = src.slice(at, src.indexOf("}", at));
    const colon = arms.indexOf(":", arms.indexOf("?"));
    expect(arms.slice(colon), "the all-paused arm says the wrong thing").toContain(
      "NO_FORMATS_RUNNING",
    );
  });

  it("keeps the two sentences distinct, so a swap is observable at all", () => {
    // If they ever converge the branch above becomes decorative — and the
    // module's stated reason for having two constants stops being true.
    expect(NO_FORMATS_YET).not.toBe(NO_FORMATS_RUNNING);
  });
});
