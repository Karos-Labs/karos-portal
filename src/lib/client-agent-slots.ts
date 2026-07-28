import "server-only";

import { listPlannedScheduledRuns, updatePlannedScheduledRun } from "@/lib/data";
import { createAgentSlots, listAgentSlots, updateClientAgent } from "@/lib/data-client-agents";
import {
  effectiveRotation,
  isOptionsMode,
  OPTIONS_TEMPLATE_KEY,
  shiftDateKey,
} from "@/lib/client-agents";
import { generateSlotHorizon, slotScheduleFor, type SlotSchedule } from "@/lib/slot-plan";
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
  return { created };
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
