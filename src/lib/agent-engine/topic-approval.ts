import type { Client, JobRunType } from "@/lib/types";

/**
 * G3 / D18 — approve the topic before the visuals are made.
 *
 * Every manual Instagram run generates a full set of visuals for a topic the
 * client has not seen. When they do not want that topic, the generation is
 * thrown away: the expensive half of the run is spent before the cheap decision
 * is asked for.
 *
 * D18, verbatim: *"a manual run means the client picks the topic first; a
 * calendar run is autopilot, because the client is not there. It is a switch,
 * defaulting to auto on calendar-linked runs."*
 *
 * ## The two halves
 *
 * The engine pauses at topic; the portal decides whether it should. This file
 * is the portal's half — it resolves the switch and puts one field on the run
 * input. The pause itself, and the gate the pause opens, are the engine's.
 *
 * The portal needs no new gate UI for it: `agent-engine-gate-approval.tsx` is
 * generic over gate payloads by design ("a payload key nobody anticipated still
 * reaches the screen"), so a topic gate renders the moment the engine opens
 * one. That is the whole reason this ticket is small on this side.
 *
 * ## Why `approveTopicFirst: true` or nothing, never `false`
 *
 * Same convention as `slotStage` (`learning-sequence.ts`, §1.1): the absence of
 * a field is the default, and only the non-default is stated. An engine that
 * receives `false` has to decide whether that means "the portal considered it
 * and said no" or "an old portal that has never heard of this"; an engine that
 * receives nothing has one answer, and it is the same answer either way.
 *
 * ## Why not every product
 *
 * A topic gate is only meaningful where a topic is chosen before expensive
 * generation, which is what makes the early pause worth the interruption. G3
 * names Instagram and that is where the engine's pause point exists. The set is
 * a constant rather than a boolean on the product table because the next
 * product to join it — most likely the TikTok three, which have the same
 * expensive-visuals shape — should be one line here and no schema change.
 */
const TOPIC_GATE_PRODUCTS = new Set(["instagram-agent"]);

/**
 * The client-level switch. Three values rather than a boolean, because
 * "follow D18" and "always ask" are genuinely different instructions and a
 * boolean would have to pick one of them to be its `undefined`.
 *
 * - `default` (or absent) — D18: ask on a manual run, autopilot on a calendar
 *   one. What every client gets until someone changes it.
 * - `always` — ask even on a calendar fire. For a client who would rather a
 *   scheduled slot sit waiting than go out on a topic nobody chose.
 * - `never` — never ask, including on a manual run. For a client who wants the
 *   old behaviour back, and for staff running the agent on a client's behalf.
 */
export type TopicApprovalMode = "default" | "always" | "never";

export function isTopicApprovalMode(value: unknown): value is TopicApprovalMode {
  return value === "default" || value === "always" || value === "never";
}

/**
 * `{ approveTopicFirst: true }` when this run should pause at its topic, `{}`
 * otherwise.
 *
 * PURE, and deliberately so: unlike `slotStageForCalendarRun` — which has to
 * ask the middleware for a slot plan and therefore has a failure mode — every
 * input to this decision is already in hand at submit time. No network call
 * means no "the control plane could not be asked" branch, and no run that
 * quietly loses its gate because a side channel was down.
 *
 * A stored value that is not one of the three is ignored rather than trusted
 * and falls through to `default`, matching `agentBand`: an unrecognised word
 * cannot be acted on, and letting it suppress a gate the decisions log asked
 * for would be the worst of the three readings.
 */
export function topicApprovalForRun(
  client: Pick<Client, "topicApproval">,
  productId: string | undefined,
  runType: JobRunType | undefined,
): { approveTopicFirst?: true } {
  if (!productId || !TOPIC_GATE_PRODUCTS.has(productId)) return {};

  const mode: TopicApprovalMode = isTopicApprovalMode(client.topicApproval) ? client.topicApproval : "default";
  if (mode === "never") return {};
  if (mode === "always") return { approveTopicFirst: true };

  // D18's default. `scheduled` is what the cron stamps on a fire it made from a
  // schedule row (`/api/run-scheduled`) and is the only run type the calendar
  // produces — the same test `slotStageForCalendarRun` makes, read the other
  // way round, because these two fields are opposite sides of one fact: whether
  // a person is present at this run.
  return runType === "scheduled" ? {} : { approveTopicFirst: true };
}
