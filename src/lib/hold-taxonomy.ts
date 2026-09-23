/**
 * What a held run is waiting for, and the one thing that would release it.
 *
 * ## Why this exists
 *
 * `job.heldReason` is rendered verbatim, truncated to one line, with nothing
 * beside it. `jobs-list.tsx` says so in its own comment — "the reason is the
 * whole message (unclassified)" — and that was the right call when the
 * alternative was a "Held" badge and no reason at all. It is not enough now:
 * 42 gates went unanswered and three production runs waited 595 hours, and a
 * reader who cannot tell "attach a video" from "run it again" leaves both.
 *
 * A hold is not a failure. It is a rule declining, which is why the failure
 * taxonomy's Retry button has no place here — re-running a run that was held
 * for a missing attachment just spends money to be declined again. So each
 * family names the ACTION, and only the families where re-running is genuinely
 * the answer say so.
 *
 * ## The families come from the data
 *
 * Read off the held jobs in prep rather than imagined: no source material, a
 * self-check that never passed, figures the numbers gate could not trace, a
 * platform limit, and a missing credit. Everything else keeps the raw reason
 * and offers nothing — a confident wrong instruction costs more than no
 * instruction, which is the lesson the failure taxonomy's own header records
 * about a 401 that sent people to the wrong system.
 */

export type HoldFamily =
  | "no_source_material"
  | "self_check_never_passed"
  | "numbers_unsourced"
  | "platform_limit"
  | "attribution_missing"
  | "unclassified";

export interface ClassifiedHold {
  family: HoldFamily;
  /** A short label for the row. */
  label: string;
  /** The one thing that would release it, in the reader's terms. Absent when nothing honest can be said. */
  action?: string;
  /** True when running it again is genuinely capable of producing a different outcome. */
  rerunnable: boolean;
  /** Always kept, so nothing is lost when the guess is wrong. */
  raw: string;
}

const PATTERNS: Array<{
  test: RegExp;
  family: HoldFamily;
  label: string;
  action?: string;
  rerunnable: boolean;
}> = [
  {
    // "no source footage from any tier", "no media attached to this run",
    // "no unused commentary-clip candidate", "no viable image found for slide(s)".
    test: /no (source footage|media attached|unused .*candidate|viable image)|no footage in any (tier|layer)/i,
    family: "no_source_material",
    label: "Nothing to work from",
    action: "Attach a video or image to the run, or give this client a source pool.",
    // Re-running finds the same empty shelf. This is the family the Retry
    // button would have been most wrong about.
    rerunnable: false,
  },
  {
    // "selected moment is not clippable: snapped clip is 2.0s, under the 20s floor"
    test: /not clippable|under the \d+s floor/i,
    family: "no_source_material",
    label: "The source has no usable moment",
    action: "Attach a longer recording, or widen the clip window for this client.",
    rerunnable: false,
  },
  {
    // "step 07's self-check never passed after 3 attempt(s)",
    // "no drafting attempt produced copy that cleared its own schema".
    test: /self-check never passed|no drafting attempt produced|did not (clear|pass) its own schema/i,
    family: "self_check_never_passed",
    label: "The agent could not satisfy its own check",
    action: "Run it again — each attempt samples fresh. If it holds twice, the brief is the thing to change.",
    rerunnable: true,
  },
  {
    // "numbers not sourced: text makes N numeric claim(s) whose figure does not appear…"
    test: /numbers not sourced/i,
    family: "numbers_unsourced",
    label: "Figures the agent could not trace",
    action: "Run it again, or add the source document the figures come from.",
    rerunnable: true,
  },
  {
    // "thread part 3 exceeds the X character limit (283 chars)"
    test: /exceeds the .* character limit|over the \d+ character/i,
    family: "platform_limit",
    label: "Too long for the platform",
    action: "Run it again — the length is resampled each attempt.",
    rerunnable: true,
  },
  {
    // "the caption does not carry the source credit, and an on-clip attribution…"
    test: /does not carry the source credit|attribution/i,
    family: "attribution_missing",
    label: "Missing a credit it is required to carry",
    action: "Add the credit to the caption yourself, or set the client's attribution line.",
    // A compliance rule, not a sampling accident. Another run declines again.
    rerunnable: false,
  },
];

export function classifyHold(reason: string | null | undefined): ClassifiedHold | undefined {
  const raw = (reason ?? "").trim();
  if (!raw) return undefined;
  for (const pattern of PATTERNS) {
    if (pattern.test.test(raw)) {
      return {
        family: pattern.family,
        label: pattern.label,
        ...(pattern.action ? { action: pattern.action } : {}),
        rerunnable: pattern.rerunnable,
        raw,
      };
    }
  }
  // Deliberately actionless. The raw reason still renders — it is the thing
  // that was already there — and inventing an instruction for a hold nobody
  // has seen is how a reader is sent to the wrong place with confidence.
  return { family: "unclassified", label: "Held", rerunnable: false, raw };
}
