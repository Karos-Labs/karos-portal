import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { readSource } from "./source-scan";

/**
 * THE CLOCK ON A GATE IS PART OF THE DECISION.
 *
 * Every agent-engine gate auto-approves on timeout, and since the engine's
 * three-tier policy that wait is no longer a flat hour: a deliverable the run
 * itself flagged — a landing page that failed its own checks, a report with a
 * redacted figure, a pulse carrying a crisis trigger — waits six hours instead
 * of one. The engine sends the sentence and the marks on the gate payload
 * (`gateWaitReason`, `gateFlags`).
 *
 * This component paints any payload key it does not recognise: a string becomes
 * a "fact" row somewhere in a list, an array becomes collapsed JSON. Both would
 * technically be "rendered" and neither would be READ — a reviewer deciding
 * whether to open this now or after lunch is deciding against a clock, and the
 * clock has to say what it is.
 *
 * A source scan rather than a render, the rule this component's own lightbox
 * test states: it portals through `createPortal`, which has no
 * `renderToStaticMarkup` output to assert on. WHAT IS PINNED IS THE MECHANISM
 * — the keys are read defensively, they are kept OUT of the generic lists, and
 * they have a block of their own. Class names and copy are free to move.
 */
const GATE = readSource(join(process.cwd(), "src", "components", "agent-engine-gate-approval.tsx"));

describe("the gate says what its own clock is worth", () => {
  it("scanned the file it claims to have scanned", () => {
    // The premise. A typo'd path reads "" and passes every assertion below.
    expect(GATE.length).toBeGreaterThan(2000);
    expect(GATE).toContain("SUPPRESSED_KEYS");
  });

  it("reads both keys defensively, never asserting the engine sent them", () => {
    // An engine build older than the policy sends neither, and a gate that
    // threw on a missing key would be a worse failure than a missing line.
    expect(GATE).toContain(`typeof fields["gateWaitReason"] === "string"`);
    expect(GATE).toContain(`Array.isArray(fields["gateFlags"])`);
    // The flags are filtered to strings: the payload is arbitrary by contract.
    expect(GATE).toContain("filter((f): f is string");
  });

  it("keeps them out of the generic fact list and the collapsed JSON", () => {
    // Where they would land by default, and where nobody reads them.
    const suppressed = GATE.slice(GATE.indexOf("SUPPRESSED_KEYS"), GATE.indexOf("SUPPRESSED_KEYS") + 800);
    expect(suppressed).toContain(`"gateWaitReason"`);
    expect(suppressed).toContain(`"gateFlags"`);
  });

  it("gives them a block of their own, with the marks as a list", () => {
    expect(GATE).toContain("{waitReason && (");
    expect(GATE).toContain("waitFlags.length > 0 && (");
    expect(GATE).toContain("waitFlags.map((flag) =>");
  });

  it("renders nothing at all when the engine sent no policy", () => {
    // Standing furniture is the failure mode of every notice: an empty box on
    // every gate teaches a reviewer to skip the box, and the box that matters
    // is the one that is only ever there when something is wrong.
    expect(GATE).not.toContain("waitReason || ");
    expect(GATE).not.toContain("gateWaitReason ?? ");
  });
});
