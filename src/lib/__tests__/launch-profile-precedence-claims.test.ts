import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { ENGINE_FIELD_CONTRACT } from "@/lib/agent-engine/engine-field-contract";
import { STEER_RUN_HELPER_WITH_KIND } from "@/lib/intake-steer-copy";

/**
 * A run dialog may not promise a precedence the engine does not implement.
 *
 * Reported from outside (SCRUM-409): a client picked one of the three "Kind of
 * post" options, typed a note, and got the kind they picked — while the helper
 * under the note box read "it wins over everything else this run". Nothing was
 * broken. Both fields reached the engine and both were read, INDEPENDENTLY, so
 * the sentence described an intention rather than the product.
 *
 * WHY THE RULE IS ABOUT COPY AND NOT ABOUT ONE STRING. The failure is a dialog
 * asserting a relationship BETWEEN two wire fields — and the portal cannot make
 * such an assertion true on its own, because which field wins is decided inside
 * an agent-engine workflow, in another repository. So the rule is: this side
 * claims a precedence ONLY where `ENGINE_FIELD_CONTRACT` records one, with
 * source evidence, for the product the dialog runs. That holds however many
 * profiles and fields are added, and it fails loudly the next time someone
 * writes copy from an intended contract instead of the recorded one.
 *
 * THE ESCAPE HATCH IS THE CONTRACT, DELIBERATELY — and it has now been used
 * once. tiktok-agent always had a recorded precedence (`requestedTopic` "only
 * when customPrompt is absent"). agent-engine PR #120 (SCRUM-430, main
 * 2026-09-14) added a second, CONDITIONAL one for linkedin-agent and x-agent:
 * a note naming exactly one kind of post wins over `requestedMode`. The
 * contract rows changed first, the second test below changed with them, and
 * only then did `STEER_RUN_HELPER_WITH_KIND` start describing it. The third
 * test is the new floor: the helper that makes the claim is tied to the
 * products that have it recorded, so pulling the engine change out (or adding
 * the helper to a profile whose product lacks the precedence) fails here.
 */

const LAUNCH_PROFILES = join(process.cwd(), "src/lib/custom-agent-launch.ts");

/**
 * Copy that asserts one field beats another. Deliberately a short, strong list:
 * a loose pattern would trip on honest sentences like "the agent works from the
 * stored data either way", which is the wording this rule is steering toward.
 *
 * `unless this note …` is on the list because that is how the ONE permitted
 * claim is phrased — it is a precedence claim with its condition attached, and
 * it must be caught as one so the allowance below is exercised rather than
 * bypassed.
 */
const PRECEDENCE_CLAIM =
  /\bwins over\b|\boverrides?\b|\btakes precedence\b|\breplaces (?:the|your|everything)\b|\bignores? (?:the|your)\b|\bunless (?:this|your) note\b/i;

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

/**
 * The products whose `customPrompt` row records a precedence over another
 * field, read off the evidence text the same way a reviewer would.
 */
function productsWithRecordedPrecedence(): string[] {
  return ENGINE_FIELD_CONTRACT.customPrompt.readBy
    .filter((entry) => PRECEDENCE_CLAIM.test(entry.evidence))
    .map((entry) => entry.product)
    .sort();
}

describe("what a run dialog's helper text may claim", () => {
  it("no helper string literal claims precedence over another field", () => {
    const source = readFileSync(LAUNCH_PROFILES, "utf8");
    const helpers = helperStrings(source);

    // A sweep that stopped matching would pass over an empty list and say
    // nothing, which is the failure mode this floor exists to make loud.
    expect(helpers.length).toBeGreaterThan(5);

    // Literals only. The one permitted claim lives in `intake-steer-copy.ts`
    // as `STEER_RUN_HELPER_WITH_KIND` and is pinned to the contract in the
    // third test; a literal re-typed at a call site would not be, so none
    // may make the claim.
    const claims = helpers
      .filter((h) => PRECEDENCE_CLAIM.test(h.text))
      .map((h) => `custom-agent-launch.ts:${h.line} → "${h.text.slice(0, 120)}"`);

    expect(
      claims,
      "which field wins is decided in an agent-engine workflow, not here — see ENGINE_FIELD_CONTRACT",
    ).toEqual([]);
  });

  it("exactly five products have a recorded customPrompt precedence: the three TikTok ids' unconditional one, and the SCRUM-430 pair", () => {
    // If this set changes, the copy in `intake-steer-copy.ts` must change
    // with it — the third test says how. Growing it is a contract edit with
    // engine line numbers; shrinking it means an engine change pulled the
    // behaviour out, and the helper must stop claiming it the same day.
    //
    // It grew from three to five when D08's product ids entered
    // REACHABLE_PRODUCTS. That is not a behaviour change: `tiktok-clipping-agent`
    // and `tiktok-content-design-agent` are `createTikTokAgentWorkflow` under
    // two more names (wiring/workflows.ts:213,215), so they have had the same
    // unconditional precedence as `tiktok-agent` since the day they were
    // routable — the audit simply was not looking at them. `tiktok-editing-agent`
    // is absent on purpose: it aliases branded-shorts, whose direction reaches
    // the editorial steps without outranking anything.
    expect(productsWithRecordedPrecedence()).toEqual([
      "linkedin-agent",
      "tiktok-agent",
      "tiktok-clipping-agent",
      "tiktok-content-design-agent",
      "x-agent",
    ]);
  });

  it("the shared helper claims the precedence only for products that have it recorded, and states its condition", () => {
    // The helper is a claim, and it is caught as one.
    expect(PRECEDENCE_CLAIM.test(STEER_RUN_HELPER_WITH_KIND)).toBe(true);

    // It is used on exactly the profiles that pair the note with "Kind of
    // post" — the LinkedIn post (linkedin-agent) and X draft (x-agent)
    // dialogs — and both of those products carry the precedence in the
    // contract. Reading the profile table for `helper: STEER_RUN_HELPER_WITH_KIND`
    // rather than importing profiles keeps this a source-level pin: a third
    // use added to a profile whose product lacks the row shows up as a count.
    const source = readFileSync(LAUNCH_PROFILES, "utf8");
    const uses = (source.match(/helper: STEER_RUN_HELPER_WITH_KIND,/g) ?? []).length;
    expect(uses).toBe(2);
    for (const product of ["linkedin-agent", "x-agent"]) {
      expect(productsWithRecordedPrecedence(), `${product} must record the precedence the helper claims`).toContain(product);
    }

    // The engine yields to a note that carries cues for exactly one mode; a
    // note that names none, or two, leaves the select in charge. The copy
    // has to carry that "unless", and name the kinds in words the cues
    // recognise, or a reader satisfies it with wording the engine ignores.
    expect(STEER_RUN_HELPER_WITH_KIND).toMatch(/\bunless\b/i);
    expect(STEER_RUN_HELPER_WITH_KIND).toMatch(/news/i);
    expect(STEER_RUN_HELPER_WITH_KIND).toMatch(/lesson|how-to/i);
    expect(STEER_RUN_HELPER_WITH_KIND).toMatch(/question/i);
    // And it still says the select decides in the ordinary case — the note is
    // not "everything else this run", which is the sentence SCRUM-409 removed.
    expect(STEER_RUN_HELPER_WITH_KIND).toMatch(/Kind of post decides the shape/);
    expect(STEER_RUN_HELPER_WITH_KIND).not.toMatch(/everything else/i);
  });

  it("both fields the LinkedIn and X dialogs pair are read by their products", () => {
    // The reason the old copy was wrong rather than merely vague: the mode is
    // not ignored when a note is present, it is applied — unless the note
    // names one, which is the recorded exception, not a general override.
    const reads = (key: "customPrompt" | "requestedMode", product: string) =>
      ENGINE_FIELD_CONTRACT[key].readBy.some((e) => e.product === product);

    for (const product of ["linkedin-agent", "x-agent"]) {
      expect(reads("customPrompt", product)).toBe(true);
      expect(reads("requestedMode", product)).toBe(true);
    }
  });
});
