/**
 * A run's raw steps, as the six things a client would say the agent is doing.
 *
 * ── WHY PHASES AND NOT STEPS ─────────────────────────────────────────────────
 *
 * agent-engine records every step it executes, and a real Instagram run has 29
 * of them: `06f-verify-images-on-disk-attempt-1`, `07d-dedupe-check-attempt-1`,
 * `07c-emit-slides-data-attempt-1`. That list is exactly right for the staff
 * Jobs page, which is auditing the run. Put it in front of a client and it is
 * 29 rows of jargon that answer a question nobody asked — and several of those
 * rows finish in under half a second, so the list would also flicker.
 *
 * A client is asking one question: what is it doing right now. "Writing the
 * copy" is a true answer to that for `05-write-copy-attempt-1`, and it stays
 * true for the next three steps too, which is what makes it a phase.
 *
 * ── MATCHED ON STEMS, NOT ON AN ID LIST ──────────────────────────────────────
 *
 * The obvious implementation is a map from all 29 ids to labels. It would be
 * wrong within a release: agent-engine owns those ids, ships on its own cycle,
 * and adds steps without telling this repo (`04e-read-past-feedback` and
 * `read-output-history` are the same idea in one product, spelled two ways
 * already). An unmatched id would then fall through to a blank, on a screen
 * whose entire job is saying what is happening.
 *
 * So the rules match on the WORD stems that survive renaming, in order, and
 * anything unmatched lands in a phase that is still true ("Working on it")
 * rather than nowhere. Adding a step to the engine cannot break this file; it
 * can only make one phase slightly broader than intended, which is a
 * degradation a reader will not notice.
 *
 * Observed vocabulary this was built against (production records, 2026-09-09):
 * instagram-agent 29 steps, linkedin-agent 20 steps. Their measured agent time
 * — 5.6 and 1.7 minutes — is why `lib/run-estimate.ts` stopped saying 30.
 */

export type RunPhaseId = "setup" | "research" | "writing" | "visuals" | "checks" | "review";

export interface RunPhase {
  id: RunPhaseId;
  /** Present tense, because it is printed while it is happening. */
  active: string;
  /** Past tense, for the same phase once it is behind the run. */
  done: string;
}

/**
 * In run order. The order is the bar, so it is declared here rather than
 * inferred from whatever order steps happen to arrive in — a run that
 * interleaves (Instagram sources images between two writing steps) must not
 * make the bar go backwards.
 */
export const RUN_PHASES: readonly RunPhase[] = [
  { id: "setup", active: "Getting set up", done: "Set up" },
  { id: "research", active: "Reading up on your brand and this week", done: "Research done" },
  { id: "writing", active: "Writing the copy", done: "Copy written" },
  { id: "visuals", active: "Making the visuals", done: "Visuals made" },
  { id: "checks", active: "Checking its own work", done: "Checks passed" },
  // The gate. It is a HUMAN step, and naming it as one is the whole reason the
  // old "ready in about 30 minutes" was misleading: the agent's own work is
  // minutes, and this is what the rest of the wait actually was.
  { id: "review", active: "Waiting for your Karos team to review", done: "Reviewed" },
] as const;

/**
 * Rules in priority order — first match wins.
 *
 * THE `load-` / `read-` SPLIT IS THE ENGINE'S OWN CONVENTION, not a guess, and
 * it is checked before the keyword rules because it is more reliable than any
 * of them. Across both observed products the engine prefixes a step that loads
 * something we already hold with `load-` (`load-client-context`,
 * `load-memory-shelf`, `load-brand-kit`, `load-recent-decisions`) and a step
 * that goes and reads something to write FROM with `read-` (`read-past-feedback`,
 * `read-output-history`, `read-intel-context`). That is exactly the line a
 * client draws between getting ready and finding something to say.
 *
 * Without these two, keyword matching gets it wrong in both directions:
 * `load-memory-shelf` hits "memory" and reads as research, and
 * `read-intel-context` hits "context" and reads as setup.
 */
const RULES: ReadonlyArray<{ phase: RunPhaseId; stems: readonly string[]; prefix?: string }> = [
  // Gates first: a gate is a review no matter what else its id says.
  { phase: "review", stems: ["review", "gate", "approval"] },
  // Then the phases whose stems are most specific.
  {
    phase: "visuals",
    stems: ["image", "carousel", "render", "visual", "media", "slide", "video", "clip", "thumbnail"],
  },
  {
    phase: "checks",
    stems: ["verify", "self-check", "hygiene", "dedupe", "compliance", "qa", "leak", "placeholder"],
  },
  { phase: "writing", stems: ["write", "draft", "copy", "caption", "compose"] },
  // The convention, before the keywords that would misread it.
  { phase: "setup", stems: [], prefix: "load-" },
  { phase: "research", stems: [], prefix: "read-" },
  {
    phase: "research",
    stems: [
      "research", "fact", "topic", "candidate", "archetype", "intel", "history",
      "feedback", "template", "claim", "reserve", "select",
    ],
  },
  {
    phase: "setup",
    stems: ["setup", "set-up", "intake", "open-run", "config", "context", "brand-kit", "voice", "channel", "load", "memory", "decision"],
  },
];

/**
 * Strip the parts of a step id that are position and retry bookkeeping, so the
 * stems match what the step is rather than where it sits.
 *
 * `09a-batch-review-r0` → `batch-review`, `05-write-copy-attempt-1` → `write-copy`.
 */
export function stepStem(stepId: string): string {
  return stepId
    .toLowerCase()
    .replace(/^\d+[a-z]?-/, "")
    .replace(/-attempt-\d+$/, "")
    .replace(/-r\d+$/, "");
}

/**
 * Which phase a raw engine step belongs to.
 *
 * `kind` wins for gates, because agent-engine marks a human-approval step as
 * `kind: "gate"` and that is a stronger signal than any word in its id.
 */
export function phaseForStep(stepId: string, kind?: string): RunPhaseId {
  if (kind === "gate") return "review";
  const stem = stepStem(stepId);
  for (const rule of RULES) {
    if (rule.prefix && stem.startsWith(rule.prefix)) return rule.phase;
    if (rule.stems.some((s) => stem.includes(s))) return rule.phase;
  }
  // Deliberately `writing` rather than a seventh "other" phase: an unmatched
  // step is most often a new step in the part of the pipeline that changes
  // most, and "Writing the copy" is a safe thing to be told is happening.
  return "writing";
}

export interface PhaseProgress {
  phases: Array<{ id: RunPhaseId; label: string; state: "done" | "active" | "pending" }>;
  /** The line that answers "what is it doing". */
  headline: string;
  /** Phases behind the run. The bar's numerator. */
  done: number;
  /** Always `RUN_PHASES.length` — an honest denominator, unlike a step count. */
  total: number;
}

/**
 * The bar and its rows, from whatever the run has actually reported.
 *
 * `completedStepIds` is not required: the CURRENT step alone is enough to place
 * the run on the ladder, because the phases are ordered and a run cannot be in
 * phase 4 without having passed 1 to 3. That matters because agent-engine
 * reports `currentStepId` and does not report a completed-id list — only the
 * Dynamic Agent Studio channel does.
 */
export function phaseProgress(input: {
  currentStepId?: string | null;
  currentStepKind?: string | null;
  /** Every step the run has recorded, for the "has it got there yet" test. */
  recordedStepIds?: readonly string[];
  /** A terminal run shows every phase done and nothing animating. */
  finished?: boolean;
}): PhaseProgress {
  const { currentStepId, currentStepKind, recordedStepIds = [], finished = false } = input;

  if (finished) {
    return {
      phases: RUN_PHASES.map((p) => ({ id: p.id, label: p.done, state: "done" as const })),
      headline: "Finished",
      done: RUN_PHASES.length,
      total: RUN_PHASES.length,
    };
  }

  const reached = new Set<RunPhaseId>();
  for (const id of recordedStepIds) reached.add(phaseForStep(id));

  const activePhase = currentStepId
    ? phaseForStep(currentStepId, currentStepKind ?? undefined)
    : null;
  const activeIndex = activePhase ? RUN_PHASES.findIndex((p) => p.id === activePhase) : -1;

  const phases = RUN_PHASES.map((p, i) => {
    // Behind the active phase, or recorded and not the active one.
    const isDone = activeIndex >= 0 ? i < activeIndex : reached.has(p.id);
    const state = i === activeIndex ? "active" : isDone ? "done" : "pending";
    return { id: p.id, label: state === "done" ? p.done : p.active, state } as const;
  });

  return {
    phases: [...phases],
    headline:
      activeIndex >= 0
        ? RUN_PHASES[activeIndex]!.active
        : // A submitted run that has not reported a step yet. It is queued, and
          // saying so is better than animating a phase it may not be in.
          "Starting the run",
    done: phases.filter((p) => p.state === "done").length,
    total: RUN_PHASES.length,
  };
}
