import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { ENGINE_FIELD_CONTRACT } from "@/lib/agent-engine/engine-field-contract";

/**
 * A run dialog may not promise a precedence the engine does not implement.
 *
 * Reported from outside (SCRUM-409): a client picked one of the three "Kind of
 * post" options, typed a note, and got the kind they picked — while the helper
 * under the note box read "it wins over everything else this run". Nothing was
 * broken. Both fields reach the engine and both are read, INDEPENDENTLY:
 * `engine-field-contract` records `requestedMode` arriving through
 * RUN_SCOPED_KEYS into linkedin-agent's 07b-select-content-mode, and
 * `customPrompt` as that run's direction. Neither yields to the other, so the
 * sentence described an intention rather than the product.
 *
 * WHY THE RULE IS ABOUT COPY AND NOT ABOUT ONE STRING. The failure is a dialog
 * asserting a relationship BETWEEN two wire fields — and the portal cannot make
 * such an assertion true on its own, because which field wins is decided inside
 * an agent-engine workflow, in another repository. So the honest rule is: this
 * side does not claim precedence at all. That holds however many profiles and
 * fields are added, and it fails loudly the next time someone writes copy from
 * an intended contract instead of the recorded one.
 *
 * THE ESCAPE HATCH IS THE CONTRACT, DELIBERATELY. One precedence does exist
 * upstream — tiktok-agent reads `requestedTopic` "only when customPrompt is
 * absent" — and it is recorded in the contract table as evidence, which is why
 * the second test pins the set of products that have one. When linkedin-agent
 * grows the same behaviour, that entry changes first, this test says so, and
 * only then may the copy make the claim.
 */

const LAUNCH_PROFILES = join(process.cwd(), "src/lib/custom-agent-launch.ts");

/**
 * Copy that asserts one field beats another. Deliberately a short, strong list:
 * a loose pattern would trip on honest sentences like "the agent works from the
 * stored data either way", which is the wording this rule is steering toward.
 */
const PRECEDENCE_CLAIM =
  /\bwins over\b|\boverrides?\b|\btakes precedence\b|\breplaces (?:the|your|everything)\b|\bignores? (?:the|your)\b/i;

/** Every `helper:` string literal in the launch-profile table. */
function helperStrings(source: string): { line: number; text: string }[] {
  const out: { line: number; text: string }[] = [];
  const pattern = /helper:\s*\n?\s*"((?:[^"\\]|\\.)*)"/g;
  for (const match of source.matchAll(pattern)) {
    out.push({
      line: source.slice(0, match.index).split("\n").length,
      text: match[1]!,
    });
  }
  return out;
}

describe("what a run dialog's helper text may claim", () => {
  it("no field helper claims precedence over another field", () => {
    const source = readFileSync(LAUNCH_PROFILES, "utf8");
    const helpers = helperStrings(source);

    // A sweep that stopped matching would pass over an empty list and say
    // nothing, which is the failure mode this floor exists to make loud.
    expect(helpers.length).toBeGreaterThan(10);

    const claims = helpers
      .filter((h) => PRECEDENCE_CLAIM.test(h.text))
      .map((h) => `custom-agent-launch.ts:${h.line} → "${h.text.slice(0, 120)}"`);

    expect(
      claims,
      "which field wins is decided in an agent-engine workflow, not here — see ENGINE_FIELD_CONTRACT",
    ).toEqual([]);
  });

  it("exactly one product has a recorded customPrompt precedence, and it is not linkedin-agent", () => {
    const withPrecedence = ENGINE_FIELD_CONTRACT.customPrompt.readBy
      .filter((entry) => PRECEDENCE_CLAIM.test(entry.evidence))
      .map((entry) => entry.product)
      .sort();

    // If this set grows, the product it grew by MAY start describing the
    // precedence in its dialog copy — and the first test above will need an
    // allowance for exactly that field pair. Until then, no dialog may.
    expect(withPrecedence).toEqual(["tiktok-agent"]);
  });

  it("both fields the LinkedIn dialog pairs are read by linkedin-agent", () => {
    // The reason the old copy was wrong rather than merely vague: the mode is
    // not ignored when a note is present, it is applied.
    const reads = (key: "customPrompt" | "requestedMode") =>
      ENGINE_FIELD_CONTRACT[key].readBy.some((e) => e.product === "linkedin-agent");

    expect(reads("customPrompt")).toBe(true);
    expect(reads("requestedMode")).toBe(true);
  });
});
