import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  agentSetupStartedTitle,
  customRunStartedTitle,
  isRunMachineryTitle,
  managedRunStartedTitle,
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

const WRITERS = [
  "src/lib/jobs/submit-managed.ts",
  "src/lib/jobs/submit-custom.ts",
  "src/lib/agent-service/run-custom-agent.ts",
  "src/lib/actions/client-agent-actions.ts",
  "src/lib/actions/client-agent-run-actions.ts",
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
  });

  it("still matches the rows already written to production", () => {
    // The fix has to be retroactive: months of these rows are in Firestore,
    // minted before the builders existed, and they are what a client's timeline
    // renders today.
    expect(isRunMachineryTitle("Managed job started: Newsletter issue")).toBe(true);
    expect(isRunMachineryTitle("Agent run started: Karos X Agent")).toBe(true);
    expect(isRunMachineryTitle("Agent setup started: LinkedIn")).toBe(true);
    expect(isRunMachineryTitle("Instagram: Carousel run started")).toBe(true);
  });

  it("leaves rows that describe what happened to the account", () => {
    // Deliberately narrow. These are events in the client's account, not the
    // dispatcher's bookkeeping, and a client's timeline is the right place for
    // every one of them.
    for (const title of [
      "Competitor added: Acme",
      "Competitor intelligence updated",
      "Brand guidelines updated",
      "Intel Report generated",
      "Workspace generation stopped early",
      "SEO/GEO fix approved",
      "Set Instagram to 3 runs per week (12 drafts)",
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
        /title:\s*`[^`]*(?:job started|run started|setup started)/i,
      );
    }
  });

  it("has no machinery title minted outside the builders", () => {
    // The same guard, asked of the whole tree rather than a list that could go
    // stale: a sixth writer added tomorrow fails here.
    const offenders: string[] = [];
    for (const file of walk(join(process.cwd(), "src"))) {
      if (file.endsWith("activity-titles.ts")) continue;
      if (file.includes("__tests__")) continue;
      if (/title:\s*[`"'][^`"']*(?:job started|run started|setup started)/i.test(code(readFileSync(file, "utf8")))) {
        offenders.push(file);
      }
    }
    expect(offenders, "these mint a machinery title without the builder").toEqual([]);
  });
});
