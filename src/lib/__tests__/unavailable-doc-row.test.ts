import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  docListEmptyLine,
  docsPipelineState,
  unavailableDocCopy,
  type DocsPipelineState,
} from "@/lib/doc-rail-copy";
import { stripComments } from "./source-scan";

/**
 * A ROW THAT SAID WORK WAS HAPPENING WHEN NOTHING WAS RUNNING.
 *
 * The document rail draws a placeholder for any doc type that exists internally
 * with no client-readable copy, and that row was hard-coded "Rebuilding" over a
 * tooltip reading "check back shortly". Its condition never asked whether
 * anything was running: `pickDoc` returns it whenever there is an internal twin
 * and no usable client one, which is equally true when the last cycle finished
 * hours ago, when the cycle FAILED, and when the client-tier row is present but
 * under 40 characters (`hasBody`). The one control that clears the row is
 * Regenerate — gated `isAdmin && clientId`, so no client has ever seen it.
 *
 * Two things had to change and both are pinned here: the row's words now come
 * from the pipeline's actual state, and every branch ends somewhere.
 *
 * WHY THE COPY IS A MODULE. `components/client-documents.tsx` reaches the
 * server-action barrel and cannot be imported in vitest, so anything asserted
 * about it is a source pin — "this string appears in the file", which a string
 * in the WRONG BRANCH satisfies. The words moved to `lib/doc-rail-copy.ts` so
 * the branch can be CALLED. The source pins below are only for the wiring, which
 * is the part a call cannot prove.
 */

const ROOT = process.cwd();
const RAIL = join(ROOT, "src/components/client-documents.tsx");

/** Comment-free source through the shared strip, so prose cannot satisfy a pin. */
const rail = stripComments(readFileSync(RAIL, "utf8"));
const flatRail = rail.replace(/\s+/g, " ");

const ALL_STATES: DocsPipelineState[] = ["running", "failed", "idle"];

describe("the pipeline question behind the row", () => {
  it("reads a live cycle as running, whatever the last one did", () => {
    // ORDER IS THE RULE. A cycle in flight outranks the previous failure,
    // because the failure it would otherwise report is the one this run is
    // retrying — and reporting both would put "the last rebuild stopped early"
    // on a screen where a rebuild is under way.
    expect(docsPipelineState({ isAiProcessing: true, aiProcessingFailed: true })).toBe("running");
    expect(docsPipelineState({ isAiProcessing: true })).toBe("running");
    expect(docsPipelineState({ aiProcessingFailed: true })).toBe("failed");
    expect(docsPipelineState({})).toBe("idle");
    // Absent is not the same as false anywhere in this repo's props, so both
    // spellings of "no" have to land on the same answer.
    expect(docsPipelineState({ isAiProcessing: false, aiProcessingFailed: false })).toBe("idle");
  });
});

describe("what one unreadable document tells a client", () => {
  it("claims a rebuild is under way in exactly the state where one is", () => {
    // THE DEFECT, both directions. The word and the promise travel together:
    // only the running branch may say a rebuild is happening, and only it may
    // tell the client that waiting works.
    expect(unavailableDocCopy("running").state).toBe("Rebuilding");
    expect(unavailableDocCopy("running").hint).toMatch(/check back/i);

    for (const state of ["failed", "idle"] as const) {
      const copy = unavailableDocCopy(state);
      expect(copy.state, `"${state}" still calls itself a rebuild in progress`).not.toMatch(
        /rebuilding/i,
      );
      expect(copy.hint, `"${state}" still tells the client to wait`).not.toMatch(/check back/i);
      expect(copy.hint, `"${state}" claims a rebuild is running`).not.toMatch(
        /(?:are|is) rebuilding|rebuilding (?:your|this)/i,
      );
    }
  });

  it("gives every branch an end the client can actually take", () => {
    // A row with no destination is the other half of this finding. The row is
    // not a control and cannot be made one, so the sentence has to carry the
    // end — and the only end a client has here is asking their team, which is
    // the same one the rail's own empty-document overlay already offers.
    for (const state of ALL_STATES) {
      const { hint } = unavailableDocCopy(state);
      expect(hint, `"${state}" says nothing`).toBeTruthy();
      expect(hint, `"${state}" is a dead end`).toMatch(/check back|ask your Karos team/i);
    }
    // And the two that cannot promise waiting name the action instead.
    expect(unavailableDocCopy("failed").hint).toMatch(/ask your Karos team/i);
    expect(unavailableDocCopy("idle").hint).toMatch(/ask your Karos team/i);
  });

  it("promises no notification, and carries no lab vocabulary or spaced hyphen", () => {
    // Nothing on this path emails, tasks or logs anything, so the copy may not
    // say otherwise — the same rule publish-error-boundary.test.ts enforces
    // repo-wide for the three wordings of that claim. Ledger F71 for the hyphen.
    for (const state of ALL_STATES) {
      const { state: word, hint } = unavailableDocCopy(state);
      expect(hint).not.toMatch(/been (?:notified|alerted|informed)/i);
      expect(hint, `"${state}" uses a spaced hyphen`).not.toContain(" - ");
      expect(hint).toMatch(/^[A-Z]/);
      expect(word).toMatch(/^[A-Z]/);
      // No internal tier vocabulary: "internal", "condensation" and "tier" are
      // what this row is ABOUT, and none of them is the client's business.
      expect(hint, `"${state}" leaks the tier vocabulary`).not.toMatch(
        /internal|condens|\btier\b/i,
      );
    }
  });
});

describe("the rail is wired to that answer", () => {
  it("no longer has a DocPick variant that asserts activity", () => {
    // The name WAS the copy: `{ kind: "rebuilding" }` is a claim about a run,
    // returned from a function that has no way of knowing about one. It states a
    // fact now, and what the fact is CALLED is decided at the render.
    expect(rail, "the variant that named a run is back").not.toContain('"rebuilding"');
    expect(rail, "the fact-shaped variant is gone").toContain('kind: "unavailable"');
  });

  it("asks the pipeline once and renders both halves of the answer", () => {
    // The wiring a call cannot prove: that the row prints what the module
    // returned, rather than importing it and printing something else. Pinned as
    // whole elements — the shape this directory has repeatedly been bitten by is
    // a substring that also matches the line above the one it means.
    expect(flatRail, "the question is not asked").toContain(
      "const pipeline = docsPipelineState({ isAiProcessing, aiProcessingFailed });",
    );
    expect(flatRail, "the row's copy is not resolved from it").toContain(
      "const unavailable = unavailableDocCopy(pipeline);",
    );
    // The state word at the row's right edge…
    expect(flatRail, "the row prints a state word of its own").toContain(
      '<span className="shrink-0 text-[11px] text-muted-2">{unavailable.state}</span>',
    );
    // …and the hint RENDERED, not only hung in a `title`. A tooltip is not an
    // affordance on touch, which is where most of this rail is read, so the end
    // has to be on the page.
    expect(flatRail, "the hint is not rendered, only tooltipped").toMatch(
      /<p className="[^"]*">\s*\{unavailable\.hint\}\s*<\/p>/,
    );
    // No survivor of the hard-coded sentence anywhere in the file.
    expect(rail, "the hard-coded tooltip is back").not.toContain(
      "This document is being rebuilt",
    );
  });

  it("asks the SAME question for the whole-list empty state", () => {
    // The three-way branch was written twice: the empty state had it and the row
    // had none. Both read `pipeline` now, so the list and a row inside it cannot
    // disagree about whether anything is happening. The SENTENCES stay
    // per-surface — "no documents at all" and "this one document" are not the
    // same thing to say — which is why they are two functions and not one.
    expect(flatRail, "the empty line does not read the shared answer").toContain(
      "<p className=\"px-1 py-1.5 text-xs text-muted-2\">{docListEmptyLine(pipeline)}</p>",
    );
    // The raw-prop ternary that used to answer it, in the shape a revert brings
    // back. Reading the props is legitimate (they are the question's arguments);
    // BRANCHING on them here is not.
    expect(flatRail, "the empty state re-derives the answer itself").not.toContain(
      "{isAiProcessing ?",
    );
    expect(flatRail).not.toContain(": aiProcessingFailed ?");
  });

  it("keeps the empty line's three situations apart, and off the row's words", () => {
    // QA F69's own rule, now callable. Three states, three different sentences —
    // one line covering all three is what told a client who had just finished
    // onboarding to finish onboarding.
    const lines = ALL_STATES.map(docListEmptyLine);
    expect(new Set(lines).size, "two situations share a sentence again").toBe(3);
    expect(docListEmptyLine("idle")).toMatch(/onboarding/i);
    expect(docListEmptyLine("running")).toMatch(/writing your documents/i);
    expect(docListEmptyLine("failed")).toMatch(/stopped early/i);
    // And it is not the ROW's copy wearing a different name: the whole list
    // being empty is a different subject from one document being unreadable.
    for (const state of ALL_STATES) {
      expect(docListEmptyLine(state)).not.toBe(unavailableDocCopy(state).hint);
    }
  });
});
