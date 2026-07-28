import "server-only";

import { listAssets, listPlannedScheduledRuns, updatePlannedScheduledRun } from "@/lib/data";
import {
  createAgentSlots,
  listAgentSlots,
  updateAgentSlot,
  updateClientAgent,
} from "@/lib/data-client-agents";
import {
  dateKeyInZone,
  effectiveRotation,
  isOptionsMode,
  OPTIONS_TEMPLATE_KEY,
  shiftDateKey,
} from "@/lib/client-agents";
import {
  assignOptionRefs,
  generateSlotHorizon,
  slotScheduleFor,
  type SlotSchedule,
} from "@/lib/slot-plan";
import { optionCandidatesFromBatch } from "@/lib/x-options";
import { parseXDrafts, type XParsedBatch } from "@/lib/x-drafts";
import { runtimeTimeZone } from "@/lib/run-cadence";
import type { AgentSlot, ClientAgent, PlannedScheduledRun } from "@/lib/types";

/**
 * Keeping an umbrella's slot plan extended (Phase 3 §4.2).
 *
 * The design's ruling: the horizon is regenerated OPPORTUNISTICALLY from the
 * actions that touch the plan — no new cron. This module is that seam. It is
 * deliberately not called from page render: a render that writes is a render
 * that writes on every refresh, from every viewer, including ones with no
 * permission to change the plan.
 *
 * Everything here is idempotent. `createAgentSlots` uses create-not-set
 * semantics, so a second call with the same inputs writes nothing, and
 * `generateSlotHorizon` already skips days that exist.
 */

/**
 * The weekly schedule row that fires this umbrella.
 *
 * Prefers the stored linkage (`scheduleRunId`) and falls back to the client's
 * weekly row for the same custom agent — the state every umbrella is in before
 * the backfill (§9 step 3) or a go-live has linked one. When the fallback hits,
 * both sides of the link are stamped so the next read is direct.
 */
export async function resolveUmbrellaSchedule(
  umbrella: ClientAgent,
): Promise<PlannedScheduledRun | null> {
  const runs = await listPlannedScheduledRuns({ clientId: umbrella.clientId });
  const linked = umbrella.scheduleRunId
    ? runs.find((run) => run.id === umbrella.scheduleRunId)
    : undefined;
  if (linked) return linked;

  const candidate = runs.find(
    (run) =>
      run.customAgentId === umbrella.customAgentId &&
      run.cadence === "weekly" &&
      run.status !== "completed",
  );
  if (!candidate) return null;
  // Link both directions — the schedule stays the single clock (F108), the
  // umbrella just learns which clock is its own.
  await Promise.all([
    updateClientAgent(umbrella.id, { scheduleRunId: candidate.id }),
    candidate.clientAgentId === umbrella.id
      ? Promise.resolve()
      : updatePlannedScheduledRun(candidate.id, { clientAgentId: umbrella.id }),
  ]);
  return candidate;
}

export interface HorizonResult {
  /** Slot docs created by this call. */
  created: number;
  /** Options-mode only: days given their candidate drafts by this call. */
  assigned?: number;
  /** Why nothing was created, when nothing was. */
  skipped?: "not_live" | "no_schedule" | "schedule_paused" | "no_templates";
}

/**
 * Extend a live umbrella's slot plan to the rolling horizon.
 *
 * Never touches a day that already exists: the plan is a record of intent, and
 * a client who moved a template onto a Thursday, or left a note on it, must not
 * have that undone by the next reorder that happens to regenerate.
 */
export async function ensureSlotHorizon(
  umbrella: ClientAgent,
  actorUid: string,
  now = Date.now(),
): Promise<HorizonResult> {
  if (umbrella.launchState !== "live") return { created: 0, skipped: "not_live" };

  const scheduleRun = await resolveUmbrellaSchedule(umbrella);
  if (!scheduleRun) return { created: 0, skipped: "no_schedule" };
  const schedule: SlotSchedule | null = slotScheduleFor(scheduleRun, runtimeTimeZone());
  if (!schedule) return { created: 0, skipped: "no_schedule" };
  if (schedule.status !== "active") return { created: 0, skipped: "schedule_paused" };

  const options = isOptionsMode(umbrella);
  const rotation = options ? [] : effectiveRotation(umbrella);
  if (!options && rotation.length === 0) return { created: 0, skipped: "no_templates" };

  const existingSlots = await listAgentSlots({ clientAgentId: umbrella.id });
  const drafts = generateSlotHorizon({
    clientId: umbrella.clientId,
    clientAgentId: umbrella.id,
    rotation,
    schedule,
    existingSlots,
    now,
    kind: options ? "options" : "single",
    ...(options ? { optionsTemplateKey: OPTIONS_TEMPLATE_KEY } : {}),
  });
  const created = await createAgentSlots(drafts, actorUid);
  const assigned = options
    ? await assignOptionsToSlots(umbrella, now)
    : 0;
  return { created, ...(assigned > 0 ? { assigned } : {}) };
}

/**
 * Give each unassigned options day its three candidate drafts (§4.5b, B1).
 *
 * THE INTERIM MODE, and the one that actually ships. The X engine produces a
 * weekly BATCH; the client is shown three options a DAY. Until Tomer's seam T7
 * teaches the engine to produce three-a-day directly, the gap is closed here by
 * slicing the batch across the plan — and §8.3 is explicit that the batch-sliced
 * version is the shipping degraded mode, not a placeholder. Without this the
 * picker, the pick action and the whole telemetry loop are unreachable code:
 * nothing else in the system ever writes `optionRefs`.
 *
 * Runs opportunistically beside horizon generation, for the same reason and
 * with the same guarantees: never reassigns a day that already has options (a
 * client may have picked from it), never uses one draft twice, and leaves a day
 * empty rather than offering it as a "pick of 3" with one card in it.
 *
 * CHURN-SAFE. Assignment is not presentation: a future day's refs live on the
 * slot doc, and only the CURRENT day's option texts ever cross the RSC boundary
 * (client-agent-rows). Writing tomorrow's refs today reveals nothing, because
 * nothing reads them until tomorrow.
 */
async function assignOptionsToSlots(umbrella: ClientAgent, now: number): Promise<number> {
  const batch = await latestXBatchAsset(umbrella.clientId);
  if (!batch) return 0;

  const candidates = optionCandidatesFromBatch(batch.parsed);
  if (candidates.length === 0) return 0;

  const todayKey = dateKeyInZone(now, runtimeTimeZone());
  const slots = (await listAgentSlots({ clientAgentId: umbrella.id }))
    // Today and forward only. A past day cannot be picked (the action refuses
    // it), so assigning to one would burn drafts on a day nobody can act on.
    .filter((slot) => slot.dateKey >= todayKey && slot.status !== "skipped");

  const assignments = assignOptionRefs(candidates, slots);
  if (assignments.length === 0) return 0;

  await Promise.all(
    assignments.map((assignment) =>
      updateAgentSlot(assignment.slotId, {
        optionRefs: assignment.optionRefs,
        // The slot points at the BATCH until a pick materializes a per-day
        // asset over it. That is what lets the picker resolve refs to text.
        assetId: batch.assetId,
      }),
    ),
  );
  return assignments.length;
}

/**
 * The newest asset for this client whose content is an X drafts batch.
 *
 * Identified by PARSING rather than by a flag: DRAFTS.md batches arrive through
 * the ordinary custom-agent webhook path with no marker distinguishing them, and
 * `parseXDrafts` already returns null for anything that is not one — so the
 * parse IS the test, and it is the same test every other X surface applies.
 */
async function latestXBatchAsset(
  clientId: string,
): Promise<{ assetId: string; parsed: XParsedBatch } | null> {
  const assets = await listAssets({ clientId });
  const byNewest = [...assets].sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
  for (const asset of byNewest) {
    const content = asset.content ?? "";
    // Cheap prefilter before the line-by-line parse — most assets are posts.
    if (!content.includes("# Account ")) continue;
    const parsed = parseXDrafts(content);
    if (parsed) return { assetId: asset.id, parsed };
  }
  return null;
}

/**
 * The next `days` days of an umbrella's plan, in date order — what the week
 * strip on the live card renders.
 *
 * Returns INTENT only (template key + day + whether the day has passed). No
 * asset id, no status beyond the slot's own, nothing that could tell a client
 * whether the post for next Tuesday already exists: two producers, one
 * projection (§4.1), and the indistinguishability is the churn guard.
 */
export async function upcomingSlots(
  clientAgentId: string,
  fromDateKey: string,
  days: number,
): Promise<AgentSlot[]> {
  const slots = await listAgentSlots({ clientAgentId });
  const horizon = new Set<string>();
  for (let i = 0; i < days; i += 1) horizon.add(shiftDateKey(fromDateKey, i));
  return slots
    .filter((slot) => horizon.has(slot.dateKey) && slot.status !== "skipped")
    .sort((a, b) => (a.dateKey < b.dateKey ? -1 : 1));
}

/**
 * Flip the slot that a now-published asset fulfils to `posted` (§3, §1.2).
 *
 * The slot's status is DERIVED — the asset is the source of truth for content
 * state, the slot is the source of truth for intent (template + day + note) —
 * so nothing reads slot.status to decide what a client may see. It exists so
 * the plan can say "this day happened" without re-deriving it from assets on
 * every read, and so a re-planned day never silently overwrites a day the
 * client already posted (slot-plan's reorder validator refuses a posted day;
 * until now nothing could ever reach that state, which made the guard dead
 * code).
 *
 * BEST-EFFORT and OUT-OF-BAND, deliberately. reconcileAssetPublished is a
 * transaction, and Firestore forbids a query inside one — the slot has to be
 * found by asset id, which is a query. A failure here must never fail the
 * publish: the asset is live either way, and the next horizon pass or reader
 * re-derives it. Same contract the webhook's chain reflow already runs under.
 */
export async function syncSlotPostedForAsset(input: {
  clientId: string;
  assetId: string;
  now?: number;
}): Promise<{ changed: boolean }> {
  const slots = await listAgentSlots({ clientId: input.clientId });
  const slot = slots.find((s) => s.assetId === input.assetId);
  if (!slot || slot.status === "posted") return { changed: false };
  await updateAgentSlot(slot.id, { status: "posted" });
  return { changed: true };
}
