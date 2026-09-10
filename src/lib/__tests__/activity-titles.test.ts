import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  agentSetupStartedTitle,
  customRunStartedTitle,
  isRunMachineryTitle,
  labImportTitle,
  opsImportTitle,
  intelReportImportedTitle,
  managedRunStartedTitle,
  researchReportReadyTitle,
  templateRunStartedTitle,
} from "@/lib/activity-titles";

/**
 * The machinery-title boundary (A3/A4).
 *
 * An activity row's title is stored verbatim and reaches a client's Activity
 * tab verbatim, so "Managed job started: Social posts (IG/TikTok)" was the
 * machine's vocabulary on the client's own timeline — and one row per dispatch
 * meant a runway top-up printed up to fourteen of them at the same minute.
 *
 * Two things have to hold, and neither can be checked by reading one file:
 * the classifier must recognise what the writers actually mint, and the writers
 * must keep going through the builders instead of re-inlining a literal that
 * drifts out of the classifier's reach.
 */

/**
 * The files that mint a MACHINERY title, i.e. one the classifier has to hide
 * from a client's timeline. Not every file that logs activity.
 *
 * competitor-actions.ts left this list on 2026-07-31: its only machinery row was
 * the retired intel-report import (QA #99), and the titles it still writes
 * ("Competitor added: …", "Competitor intelligence updated") are account events
 * that belong on the client's timeline — both are asserted NOT machinery below.
 * Dropping it narrows nothing, because "has no machinery title minted outside
 * the builders" walks the whole of src/ and would catch that file re-inlining
 * one; this list only buys a sharper failure message for the known writers.
 */
const WRITERS = [
  "src/lib/jobs/submit-managed.ts",
  "src/lib/jobs/submit-custom.ts",
  "src/lib/agent-service/run-custom-agent.ts",
  "src/lib/actions/client-agent-actions.ts",
  "src/lib/actions/client-agent-run-actions.ts",
  "src/lib/actions/lab-output-actions.ts",
  "src/lib/actions/ops-import-actions.ts",
] as const;

function read(rel: string): string {
  return readFileSync(join(process.cwd(), rel), "utf8");
}

/** Source with comments stripped — the negative assertions are about CODE. */
function code(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".next") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(full)) out.push(full);
  }
  return out;
}

describe("run-machinery activity titles", () => {
  it("classifies every title its own builders mint", () => {
    // The pairing that matters: if a builder's wording moves, this fails rather
    // than silently un-hiding the row on a client's timeline.
    expect(isRunMachineryTitle(managedRunStartedTitle("Social posts (IG/TikTok)"))).toBe(true);
    expect(isRunMachineryTitle(customRunStartedTitle("X Agent"))).toBe(true);
    expect(isRunMachineryTitle(agentSetupStartedTitle("Social"))).toBe(true);
    expect(isRunMachineryTitle(templateRunStartedTitle("Social", "Daily post"))).toBe(true);
    expect(isRunMachineryTitle(labImportTitle("2026-07-21-sonnet-trial", 4))).toBe(true);
    expect(isRunMachineryTitle(opsImportTitle("lab repo abc123", "14 document(s)"))).toBe(true);
    expect(isRunMachineryTitle(intelReportImportedTitle())).toBe(true);
  });

  it("still matches the rows already written to production", () => {
    // The fix has to be retroactive: months of these rows are in Firestore,
    // minted before the builders existed, and they are what a client's timeline
    // renders today.
    expect(isRunMachineryTitle("Managed job started: Newsletter issue")).toBe(true);
    expect(isRunMachineryTitle("Agent run started: Karos X Agent")).toBe(true);
    expect(isRunMachineryTitle("Agent setup started: LinkedIn")).toBe(true);
    expect(isRunMachineryTitle("Instagram: Carousel run started")).toBe(true);
    // The old schedule-change wording decomposed the batch — retroactively
    // machinery. Its replacement (pace vocabulary) stays on the timeline below.
    expect(isRunMachineryTitle("Set Instagram to 3 runs per week (12 drafts)")).toBe(true);
  });

  it("leaves rows that describe what happened to the account", () => {
    // Deliberately narrow. These are events in the client's account, not the
    // dispatcher's bookkeeping, and a client's timeline is the right place for
    // every one of them.
    //
    // BOTH SPELLINGS of every title reworded as client copy on 2026-07-31 (the
    // seventh-channel pass) — SIX of them, and the first count here said three.
    // The three it left out were the two `${docType} corrected …` forms and the
    // feedback row's template slug, which are precisely the ones whose stored
    // rows could drift from this matcher unnoticed: an inventory that undercounts
    // is wrong in the direction that hides retroactivity debt.
    //
    // The old spellings are what months of Firestore rows still say and what a
    // client's timeline renders today, so dropping them here would stop pinning
    // the rows that actually exist; the new ones are what the writers mint from
    // now on. Neither may become machinery — un-hiding is not the risk, HIDING an
    // account event is.
    //
    // The interpolated ones are pinned at a REAL value on each side of the
    // rename: the old form printed the Firestore key ("branding-guidelines", and
    // "numbers" for the feedback row), the new one prints the name a client
    // recognises.
    for (const title of [
      "Competitor added: Acme",
      "Competitor intelligence updated",
      "Brand guidelines updated",
      "SEO/GEO fix approved",
      "Set Instagram's pace: 3 posting days a week",
      // ── retroactive ⇢ current, one pair per reworded title ──
      // 1. the research report (three retroactive spellings, two writers)
      "Intel Report generated",
      "Intel Report generated (scheduled)",
      researchReportReadyTitle(),
      // 2. a generation cycle that stopped
      "Workspace generation stopped early",
      "Workspace update didn't finish",
      // 3. the competitor discovery pass
      "Competitors discovered & analyzed",
      "Competitors discovered and analyzed",
      // 4. a targeted document correction
      "branding-guidelines corrected (targeted)",
      "Branding guidelines corrected",
      // 5. the same correction taken through review
      "branding-guidelines corrected via Fix with Review",
      "Branding guidelines corrected after review",
      // 6. feedback on one agent format
      "Feedback on Instagram · by-the-numbers",
      "Feedback on Instagram · By The Numbers",
    ]) {
      expect(isRunMachineryTitle(title), `${title} is not machinery`).toBe(false);
    }
  });

  it("pins every writer to a builder", () => {
    // The drift guard. A writer that re-inlines its title is a row the
    // classifier cannot see, on a surface where not seeing it is the bug.
    for (const rel of WRITERS) {
      const src = code(read(rel));
      expect(src, `${rel} does not import the title builders`).toContain(
        'from "@/lib/activity-titles"',
      );
      expect(src, `${rel} inlines a machinery title`).not.toMatch(
        /title:\s*`[^`]*(?:job started|run started|setup started|imported lab run|ops import from|intel report imported)/i,
      );
    }
  });

  it("has no machinery title minted outside the builders", () => {
    // The same guard, asked of the whole tree rather than a list that could go
    // stale: a writer added tomorrow, on or off WRITERS, fails here.
    const offenders: string[] = [];
    for (const file of walk(join(process.cwd(), "src"))) {
      if (file.endsWith("activity-titles.ts")) continue;
      if (file.includes("__tests__")) continue;
      if (/title:\s*[`"'][^`"']*(?:job started|run started|setup started|imported lab run|ops import from|intel report imported)/i.test(code(readFileSync(file, "utf8")))) {
        offenders.push(file);
      }
    }
    expect(offenders, "these mint a machinery title without the builder").toEqual([]);
  });
});
