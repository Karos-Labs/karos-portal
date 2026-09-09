import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

/**
 * SCRUM-272 (T-B20) — the capability probe for D1 (SCRUM-277, decision 5 of
 * Tomer's 2026-08-28 record): "DELETE the hardcoded pipeline. Build a new
 * agent-based onboarding from the real Intel Report and SEO/GEO agents […] the
 * output must be written in exactly the same shape, to exactly the same
 * Firestore location the system already reads from."
 *
 * This file imports nothing from the implementation on purpose. It asks the
 * repo one question — does a path exist that turns the two REAL agent-engine
 * deliverables into the stored context documents? — and it answers it by
 * reading source, so it is runnable against the tree with or without that path
 * present.
 *
 * Before this ticket the answer was no, and not by omission: the only place
 * `intel-report-agent`/`seo-geo-agent` were dispatched at all is
 * `src/lib/agent-engine/dispatch-research-agents.ts`, whose own doc comment
 * says the dispatch is "purely additive — their output does not feed anything
 * below", and materialize.ts turns both into a `note` asset a staff member
 * reads. Nothing consumed them as onboarding input.
 */

/** The `kind` each product writes through the engine's `ledger.writeDeliverable`. */
const INTEL_REPORT_KIND = "intel-report";
const SEO_GEO_KIND = "seo-geo-report";
/** The unchanged wrapper over the unchanged `clientContextDocs` collection. */
const CONTEXT_DOC_WRITER = "replaceClientContextDocs";

function sourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === "__tests__") continue;
        walk(full);
      } else if (/\.tsx?$/.test(e.name)) {
        out.push(path.relative(process.cwd(), full).split(path.sep).join("/"));
      }
    }
  };
  walk(path.join(process.cwd(), "src"));
  return out;
}

function read(file: string): string {
  return fs.readFileSync(path.join(process.cwd(), file), "utf8");
}

describe("the 13 context documents have an agent-based producer (D1 / SCRUM-272)", () => {
  it("has at least one module that reads BOTH agent deliverables and writes the context docs", () => {
    const producers = sourceFiles().filter((f) => {
      const text = read(f);
      return (
        text.includes(`"${INTEL_REPORT_KIND}"`) &&
        text.includes(`"${SEO_GEO_KIND}"`) &&
        text.includes(CONTEXT_DOC_WRITER)
      );
    });

    expect(
      producers,
      "no module derives the stored context documents from the intel-report + seo-geo-report deliverables — " +
        "onboarding still has only the hardcoded in-process research pipeline D1 ruled out",
    ).not.toEqual([]);
  });

  it("keeps that producer off any Firestore collection of its own — the read path may not move", () => {
    const producers = sourceFiles().filter((f) => {
      const text = read(f);
      return text.includes(`"${INTEL_REPORT_KIND}"`) && text.includes(`"${SEO_GEO_KIND}"`) && text.includes(CONTEXT_DOC_WRITER);
    });

    // Not vacuous: a loop over an empty list passes every clause inside it, which
    // is the exact defect family this codebase keeps finding. With no producer
    // present this line fails first, so the check below can never report green
    // on a tree where there is nothing to check.
    expect(producers.length, "nothing to check — no producer exists").toBeGreaterThan(0);

    for (const file of producers) {
      const text = read(file);
      // `col.clientContextDocs()` / `adminDb()` here would mean the producer had
      // grown its own write, which is the side-effect migration D1 forbids.
      expect(text, `${file} reaches Firestore directly instead of going through ${CONTEXT_DOC_WRITER}`).not.toMatch(
        /col\.clientContextDocs\(\)|adminDb\(\)/,
      );
    }
  });
});
