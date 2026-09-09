import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { collapseRunsPerDay, runDayKey } from "@/lib/client-run-rows";

/**
 * The run history on the X, LinkedIn and Reddit intake cards.
 *
 * Those rows printed `Run <date>` — the generation instant, one row per fire.
 * A fire produces a week of drafts, so the card showed four rows carrying the
 * same date, which states outright that the week came out of one minute (A3/A4,
 * the same tell the pass-2 stamp round closed on five other surfaces).
 *
 * Two halves: the collapse, which is pure and driven here, and the wording,
 * which lives in three "use client" components and is read from source.
 */

const run = (at: number, status = "review") => ({ id: String(at), status, createdAt: at });

const DAY = 24 * 60 * 60 * 1000;
const noon = (dayOffset: number, hour = 12) =>
  new Date(2026, 6, 20 + dayOffset, hour, 0, 0).getTime();

describe("a client's run history", () => {
  it("keeps one row per calendar day, the newest", () => {
    // The runway top-up case: several fires inside one day, newest first.
    const rows = collapseRunsPerDay([
      run(noon(0, 15)),
      run(noon(0, 14)),
      run(noon(0, 9)),
      run(noon(-1, 10)),
    ]);
    expect(rows).toHaveLength(2);
    expect(rows[0].createdAt).toBe(noon(0, 15));
    expect(rows[1].createdAt).toBe(noon(-1, 10));
  });

  it("keeps every failure, even inside a collapsed day", () => {
    // A run that could not finish is a distinct event with its own badge — the
    // one row a client may actually need to ask about.
    const rows = collapseRunsPerDay([
      run(noon(0, 15)),
      run(noon(0, 14), "failed"),
      run(noon(0, 13)),
      run(noon(0, 11), "failed"),
    ]);
    expect(rows.map((r) => r.status)).toEqual(["review", "failed", "failed"]);
  });

  it("preserves order, so a later slice still takes the most recent rows", () => {
    const rows = collapseRunsPerDay([run(noon(0)), run(noon(-1)), run(noon(-2))]);
    expect(rows.map((r) => r.createdAt)).toEqual([noon(0), noon(-1), noon(-2)]);
  });

  it("buckets by local calendar day, not by 24-hour windows", () => {
    // 23:30 and 00:30 are an hour apart and are two different days — the label
    // the client reads is a date, so the grain has to be the date's.
    const late = new Date(2026, 6, 20, 23, 30).getTime();
    const early = new Date(2026, 6, 21, 0, 30).getTime();
    expect(runDayKey(late)).not.toBe(runDayKey(early));
    expect(collapseRunsPerDay([run(early), run(late)])).toHaveLength(2);
    expect(runDayKey(late)).toBe(runDayKey(late + 20 * 60 * 1000));
    expect(runDayKey(late)).not.toBe(runDayKey(late + DAY));
  });
});

// carousel-agent-intake.tsx used to be a seventh surface here; the whole
// karos-carousel family was retired in full 2026-08-29 (SCRUM-377/T-B25a) and
// the component deleted along with it.
const SURFACES = [
  "src/components/x-agent-intake.tsx",
  "src/components/linkedin-agent-intake.tsx",
  "src/components/reddit-agent-intake.tsx",
  "src/components/newsletter-agent-intake.tsx",
  "src/components/blog-agent-intake.tsx",
  "src/components/reputation-agent-intake.tsx",
] as const;

describe("the intake cards' run rows", () => {
  it("collapse a client's runs on the server, before the payload", () => {
    const views = readFileSync(join(process.cwd(), "src/lib/agent-intake-views.ts"), "utf8");
    // One helper for all six surfaces — the drift that let Reddit print raw
    // status words while X printed badges started as three copies of this.
    expect(views).toContain("function toRunRowViews(");
    expect(views).toMatch(/const rows = isStaff \? jobs : collapseRunsPerDay\(jobs\)/);
    expect(views.match(/toRunRowViews\(/g)).toHaveLength(7); // the definition + 6 call sites
    // Staff keep every run and the forensic link.
    expect(views).toMatch(/isStaff \? \{ href: `\/jobs\/\$\{j\.id\}` \} : \{\}/);
  });

  it("print the same primary sentence to both roles, with the instant appended for staff", () => {
    // PARITY PASS (2026-09). This used to assert the OPPOSITE: that the row's
    // one label SPLIT on the viewer, `Run <date>` for staff and the relative
    // sentence for a client. That is the divergence the parity ruling removed —
    // a staff member previewing an intake page read a different row from the
    // one the client gets, on a card that is otherwise identical. The client's
    // sentence is now the primary text for both, the instant staff debug with
    // is a secondary suffix, and the /jobs link on it carries an Internal
    // marker because it leaves the client workspace.
    for (const rel of SURFACES) {
      const src = readFileSync(join(process.cwd(), rel), "utf8");
      expect(src, `${rel} does not use the shared relative sentence`).toMatch(
        /const label = `Worked on your content · \$\{relativeTime\(r\.createdAt\)\}`/,
      );
      // The split label, gone.
      expect(src, `${rel} still splits the run stamp by viewer`).not.toMatch(
        /isStaff\s*\?\s*`Run \$\{formatDate\(r\.createdAt\)\}`/,
      );
      // Staff keep the instant — additively, and gated.
      expect(src, `${rel} drops the staff stamp`).toMatch(
        /const stamp = `Run \$\{formatDate\(r\.createdAt\)\}`/,
      );
      expect(src, `${rel} shows the staff stamp to everyone`).toMatch(/\{isStaff &&\s*\(r\.href \?/);
      // The staff-only route out is marked as one.
      expect(src, `${rel} does not mark the /jobs link as internal`).toMatch(
        /\{isStaff && r\.href && <Badge tone="neutral">Internal<\/Badge>\}/,
      );
      // The oldest form, still gone: an exact generation date to whoever asked.
      expect(src).not.toMatch(/<span>Run \{formatDate\(r\.createdAt\)\}<\/span>/);
    }
  });

  it("never tells a client their work arrives in batches", () => {
    // The mechanics wording the feedback copy used to name ("once your Karos
    // team approves a batch"). The approval step stays named — clients need to
    // know a human sees it first — but the shipping unit is not their business.
    for (const rel of SURFACES) {
      const src = readFileSync(join(process.cwd(), rel), "utf8");
      const rendered = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
      expect(rendered, `${rel} still says "batch" to the client`).not.toMatch(/\bbatch\b/i);
      // The newsletter's noun is singular because one run prepares ONE issue —
      // "the issues" would describe a batch, which is the very thing this test
      // is here to keep out of client copy.
      expect(rendered).toMatch(
        /Once your Karos team has approved (the drafts|the replies|an issue|an article|a reply),/,
      );
    }
  });
});
