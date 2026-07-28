/**
 * The slot plan — pure, deterministic calendar-intent planning for client
 * agents (Phase 3 §4).
 *
 * A SLOT is a day's intent: template + calendar day (+ an optional client
 * note). It is what a client sees on the calendar; content never is. Two
 * producers project into the same slot — an asset generated ahead of time and
 * a day-of run that has not happened yet — and the client cannot tell them
 * apart. That indistinguishability IS the churn guard (A3), so it is enforced
 * structurally here rather than by copy downstream.
 *
 * CLIENT-SAFE and side-effect free, exactly like post-chain.ts: no
 * firebase-admin, no data layer, no Date.now() inside (callers inject `now`),
 * same inputs → same outputs. The persistence twin lives in
 * data-client-agents.ts; the chain predicates are REUSED from post-chain.ts
 * rather than re-derived, so the slot planner and the plain chain can never
 * disagree about what a candidate asset is.
 */

import type { AgentSlot, Asset, PlannedScheduledRun } from "@/lib/types";
import {
  CHAIN_SLOT_HOUR,
  type ChainAssignment,
  type ChainFamily,
  chainFamilyFor,
  deriveOrderKey,
  isReferenceDocAsset,
  templateForAsset,
} from "@/lib/post-chain";
import { zonedWallToUtc } from "@/lib/run-cadence";
import {
  agentSlotDocId,
  compareDateKeys,
  dateKeyInZone,
  dateKeyParts,
  shiftDateKey,
  weekdayOfDateKey,
} from "@/lib/client-agents";

/** How far ahead the slot plan is extended, in days. */
export const SLOT_HORIZON_DAYS = 28;

/* ──────────────────────── the umbrella's firing cadence ─────────────────── */

/**
 * The subset of the linked PlannedScheduledRun the planner needs. Derived from
 * the schedule row (never re-invented): the schedule remains the single clock,
 * per the F108 contract.
 */
export interface SlotSchedule {
  /** Firing weekdays, 0=Sun..6=Sat. */
  weekdays: number[];
  /** IANA zone the schedule's wall-clock intent is expressed in. */
  timeZone: string;
  /** Paused/completed schedules freeze horizon extension (§4.4). */
  status: "active" | "paused" | "completed";
}

/**
 * Read a schedule row as a slot cadence. `fallbackZone` is used only for rows
 * written before `timeZone` existed — the same fallback the scheduler itself
 * applies, passed in so this module stays pure.
 */
export function slotScheduleFor(
  run: Pick<PlannedScheduledRun, "weekdays" | "weekday" | "timeZone" | "status" | "cadence">,
  fallbackZone: string,
): SlotSchedule | null {
  if (run.cadence !== "weekly") return null;
  const weekdays =
    run.weekdays && run.weekdays.length > 0
      ? [...new Set(run.weekdays)]
      : run.weekday != null
        ? [run.weekday]
        : [];
  if (weekdays.length === 0) return null;
  return {
    weekdays: weekdays.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6).sort((a, b) => a - b),
    timeZone: run.timeZone || fallbackZone,
    status: run.status,
  };
}

/* ──────────────────────────── horizon generation ────────────────────────── */

/** A slot the horizon generator wants created. Never an update to an existing one. */
export interface PlannedSlotDraft {
  id: string;
  clientId: string;
  clientAgentId: string;
  dateKey: string;
  templateKey: string;
  kind: "single" | "options";
  status: "planned";
}

export interface SlotHorizonInput {
  clientId: string;
  clientAgentId: string;
  /** Firing order of template keys (see effectiveRotation). Ignored in options mode. */
  rotation: string[];
  schedule: SlotSchedule | null;
  /** Every slot that already exists for this umbrella. Never modified. */
  existingSlots: Array<Pick<AgentSlot, "dateKey" | "templateKey">>;
  now: number;
  /** Defaults to SLOT_HORIZON_DAYS. */
  horizonDays?: number;
  /** "options" umbrellas (X) carry one fixed template key. */
  kind?: "single" | "options";
  /** The fixed key options slots carry. Required when kind is "options". */
  optionsTemplateKey?: string;
}

/**
 * Extend the slot plan to a rolling horizon.
 *
 * Firing days come from the linked schedule's weekdays, in the schedule's own
 * zone. Templates cycle `rotation` (which the caller has already filtered to
 * active templates). Existing slot docs are NEVER overwritten — the plan is a
 * record of intent, and a client who moved a template to a Thursday must not
 * have that undone by the next page load that happens to regenerate.
 *
 * Returns only the slots that need creating, so calling it repeatedly with the
 * same inputs converges to a no-op.
 */
export function generateSlotHorizon(input: SlotHorizonInput): PlannedSlotDraft[] {
  const schedule = input.schedule;
  // No schedule, or a paused/completed one: the plan freezes where it is.
  // Existing slots survive (resume keeps the plan) — only extension stops.
  if (!schedule || schedule.status !== "active" || schedule.weekdays.length === 0) return [];

  const kind = input.kind ?? "single";
  const rotation =
    kind === "options"
      ? input.optionsTemplateKey
        ? [input.optionsTemplateKey]
        : []
      : input.rotation.filter((key) => key.length > 0);
  if (rotation.length === 0) return [];

  const firingDays = new Set(schedule.weekdays);
  const startKey = dateKeyInZone(input.now, schedule.timeZone);
  const horizonDays = Math.max(1, Math.round(input.horizonDays ?? SLOT_HORIZON_DAYS));
  const endKey = shiftDateKey(startKey, horizonDays);

  const takenDays = new Set(input.existingSlots.map((slot) => slot.dateKey));

  // Continue the rotation where the plan left off rather than restarting at
  // position 0: a regenerated horizon that resets the cycle would hand the
  // client the same template twice in a row for no reason they can see.
  let cursor = 0;
  const priorInRotation = [...input.existingSlots]
    .filter((slot) => rotation.includes(slot.templateKey))
    .sort((a, b) => compareDateKeys(a.dateKey, b.dateKey))
    .filter((slot) => compareDateKeys(slot.dateKey, endKey) <= 0);
  const last = priorInRotation[priorInRotation.length - 1];
  if (last) cursor = (rotation.indexOf(last.templateKey) + 1) % rotation.length;

  const drafts: PlannedSlotDraft[] = [];
  for (let dayKey = startKey; compareDateKeys(dayKey, endKey) <= 0; dayKey = shiftDateKey(dayKey, 1)) {
    if (!firingDays.has(weekdayOfDateKey(dayKey))) continue;
    if (takenDays.has(dayKey)) continue;
    const templateKey = rotation[cursor % rotation.length];
    cursor += 1;
    drafts.push({
      id: agentSlotDocId(input.clientAgentId, dayKey),
      clientId: input.clientId,
      clientAgentId: input.clientAgentId,
      dateKey: dayKey,
      templateKey,
      kind,
      status: "planned",
    });
  }
  return drafts;
}

/* ─────────────────────── asset ↔ slot matching (§4.2) ───────────────────── */

/**
 * The instant a slot's post is published at: CHAIN_SLOT_HOUR wall-clock on the
 * slot's day, in the SCHEDULE's zone. The plain chain buckets server-locally
 * (post-chain.ts) because it has no schedule to ask; a slot does, and the F108
 * contract says the schedule's stored zone is the intent.
 */
export function slotInstant(dateKey: string, timeZone: string): number {
  const { y, mo, d } = dateKeyParts(dateKey);
  return zonedWallToUtc(y, mo, d, CHAIN_SLOT_HOUR, 0, timeZone);
}

/**
 * Same candidacy rules as planClientChain, minus the day-cursor: an asset the
 * chain would never move must not be moved by the slot planner either.
 *
 * Duplicated predicates are the failure mode this guards against, so each line
 * mirrors post-chain.ts exactly: placeholders and reference docs are not
 * calendar entities, only chain-provenance drafts may be re-dated, and a
 * pinned (staff-booked / already-visible / published) asset is untouchable.
 */
function isSlotCandidate(a: Asset, family: ChainFamily, todayStartMs: number): boolean {
  if (chainFamilyFor(a.type) !== family) return false;
  if (a.publishMode === "placeholder") return false;
  if (isReferenceDocAsset(a)) return false;
  if (a.status !== "draft") return false;
  if (a.publishedAt != null) return false;
  // Chain provenance: lab imports, or anything already carrying an orderKey.
  const source = typeof a.meta?.source === "string" ? a.meta.source : null;
  const hasProvenance = source === "lab-import" || (typeof a.orderKey === "string" && a.orderKey.length > 0);
  if (!hasProvenance) return false;
  // Already client-visible (its day has arrived) ⇒ pinned, exactly as the chain
  // treats a draft dated on or before today.
  if (a.scheduledAt != null && a.scheduledAt <= todayStartMs) return false;
  return true;
}

export interface SlotMatchInput {
  assets: Asset[];
  /** Every slot of the umbrella (past ones are ignored). */
  slots: Array<Pick<AgentSlot, "id" | "dateKey" | "templateKey" | "status" | "assetId" | "kind">>;
  family: ChainFamily;
  timeZone: string;
  now: number;
}

export interface SlotMatch {
  slotId: string;
  assetId: string;
  dateKey: string;
}

export interface SlotMatchResult {
  /** Slot → asset links to persist. */
  matches: SlotMatch[];
  /** Re-dating to persist through the existing applyChainAssignments path. */
  assignments: ChainAssignment[];
  /** Candidate assets no future slot could absorb — they keep chain behavior. */
  unmatchedAssetIds: string[];
  /** Future slots with no asset — day-of generation fills them, or they pass. */
  unfilledSlotIds: string[];
}

/**
 * Fit a client's existing draft assets onto the slot plan.
 *
 * For each FUTURE slot in date order, take the earliest unassigned candidate
 * of that slot's template (deriveOrderKey order, id tiebreak — the same
 * ordering planClientChain uses, so the slot plan and the chain agree about
 * which post comes first in a numbered series). A slot with no matching asset
 * is left `planned`; a candidate with no slot keeps plain chain behavior.
 *
 * Never moves an asset to a past day: slots on or before today are skipped
 * entirely, which is what keeps a horizon regeneration from back-dating work a
 * client has already seen.
 */
export function matchAssetsToSlots(input: SlotMatchInput): SlotMatchResult {
  const todayKey = dateKeyInZone(input.now, input.timeZone);
  const todayStartMs = slotInstant(todayKey, input.timeZone);

  const futureSlots = input.slots
    .filter((slot) => (slot.kind ?? "single") === "single")
    .filter((slot) => slot.status === "planned" || slot.status === "generated")
    .filter((slot) => compareDateKeys(slot.dateKey, todayKey) > 0)
    .sort((a, b) => compareDateKeys(a.dateKey, b.dateKey));

  const alreadyLinked = new Set(
    input.slots.map((slot) => slot.assetId).filter((id): id is string => Boolean(id)),
  );

  const candidates = input.assets
    .filter((a) => isSlotCandidate(a, input.family, todayStartMs))
    .filter((a) => !alreadyLinked.has(a.id))
    .sort((a, b) => {
      const cmp = deriveOrderKey(a).localeCompare(deriveOrderKey(b));
      return cmp !== 0 ? cmp : a.id.localeCompare(b.id);
    });

  const byTemplate = new Map<string, Asset[]>();
  for (const asset of candidates) {
    const key = templateForAsset(asset)?.key;
    if (!key) continue;
    const bucket = byTemplate.get(key);
    if (bucket) bucket.push(asset);
    else byTemplate.set(key, [asset]);
  }

  const matches: SlotMatch[] = [];
  const assignments: ChainAssignment[] = [];
  const unfilledSlotIds: string[] = [];
  const used = new Set<string>();

  for (const slot of futureSlots) {
    if (slot.assetId) continue; // already fulfilled — the slot owns it
    const bucket = byTemplate.get(slot.templateKey);
    const asset = bucket?.find((a) => !used.has(a.id));
    if (!asset) {
      unfilledSlotIds.push(slot.id);
      continue;
    }
    used.add(asset.id);
    matches.push({ slotId: slot.id, assetId: asset.id, dateKey: slot.dateKey });
    const scheduledAt = slotInstant(slot.dateKey, input.timeZone);
    const orderKey = deriveOrderKey(asset);
    // Emit only real changes so re-planning the planner's own output is a no-op.
    if (asset.scheduledAt !== scheduledAt || asset.orderKey !== orderKey) {
      assignments.push({ id: asset.id, scheduledAt, orderKey });
    }
  }

  return {
    matches,
    assignments,
    unmatchedAssetIds: candidates.filter((a) => !used.has(a.id)).map((a) => a.id),
    unfilledSlotIds,
  };
}

/* ─────────────────────────────── reordering ─────────────────────────────── */

export interface SlotTemplateEdit {
  slotId: string;
  templateKey: string;
}

export interface SlotReorderContext {
  slots: Array<Pick<AgentSlot, "id" | "dateKey" | "status">>;
  /** Template keys currently active on the umbrella. */
  activeTemplateKeys: string[];
  /** Today in the schedule's zone — edits are future-only. */
  todayKey: string;
}

/**
 * Validate a client's slot reorder before anything is written: every touched
 * slot must exist, be in the FUTURE (a past day is history, not a plan), carry
 * an active template, and no day may be edited twice in one request.
 */
export function validateSlotReorder(
  edits: SlotTemplateEdit[],
  ctx: SlotReorderContext,
): { ok: true } | { ok: false; error: string } {
  if (edits.length === 0) return { ok: false, error: "Nothing to reorder." };
  const active = new Set(ctx.activeTemplateKeys);
  const byId = new Map(ctx.slots.map((slot) => [slot.id, slot]));
  const seen = new Set<string>();
  for (const edit of edits) {
    if (seen.has(edit.slotId)) return { ok: false, error: "A day can only be set once." };
    seen.add(edit.slotId);
    const slot = byId.get(edit.slotId);
    if (!slot) return { ok: false, error: "That day is no longer on the plan." };
    if (compareDateKeys(slot.dateKey, ctx.todayKey) <= 0) {
      return { ok: false, error: "Past days can't be changed." };
    }
    if (slot.status === "posted") return { ok: false, error: "Posted days can't be changed." };
    if (!active.has(edit.templateKey)) {
      return { ok: false, error: "That template isn't active on this agent." };
    }
  }
  return { ok: true };
}

/**
 * Re-position a template registry from an ordered list of keys. Keys the list
 * omits keep their relative order after the ones it names, so a partial reorder
 * (the drag-and-drop case) can never silently drop a stream.
 */
export function reorderTemplateKeys(currentKeys: string[], orderedKeys: string[]): string[] {
  const known = new Set(currentKeys);
  const ordered = orderedKeys.filter((key, i) => known.has(key) && orderedKeys.indexOf(key) === i);
  const rest = currentKeys.filter((key) => !ordered.includes(key));
  return [...ordered, ...rest];
}

/* ───────────────── options slots — the X daily pick-of-3 (§4.5b) ────────── */

/**
 * One candidate draft an options slot may offer. Parsed from the weekly batch
 * asset in the interim mode; produced day-of once the engine gains a daily
 * mode (Tomer seam T7). The portal surfaces are identical either way.
 */
export interface OptionCandidate {
  /** Stable ref within the batch asset (what XDraftFeedback records). */
  ref: string;
  /** The angle this draft takes — used to keep a day's three options distinct. */
  direction?: string | null;
  /** Which account/seat it was drafted for. */
  account?: string | null;
}

export interface OptionAssignment {
  slotId: string;
  optionRefs: string[];
}

/** Options per day. Three "slightly different directions" per the Q9 ruling. */
export const OPTIONS_PER_SLOT = 3;

/**
 * Deterministically slice a parsed batch into per-day option sets.
 *
 * Rules, all of them testable and none of them time-dependent:
 *  • slots are filled in date order, earliest first;
 *  • a slot that already has options is never reassigned (a client may have
 *    picked from it — reshuffling would strand the pick);
 *  • a candidate is used at most once across the whole plan;
 *  • within a day the three options prefer DISTINCT directions, then distinct
 *    accounts — three drafts of the same angle is not a choice;
 *  • a day that cannot be given at least two options is left empty rather than
 *    shown as a "pick of 3" with one card in it.
 */
export function assignOptionRefs(
  candidates: OptionCandidate[],
  slots: Array<Pick<AgentSlot, "id" | "dateKey" | "optionRefs" | "optionPick">>,
  opts?: { perSlot?: number },
): OptionAssignment[] {
  const perSlot = Math.max(2, Math.round(opts?.perSlot ?? OPTIONS_PER_SLOT));
  const used = new Set<string>();
  for (const slot of slots) {
    for (const ref of slot.optionRefs ?? []) used.add(ref);
  }

  const pool = candidates.filter((c) => c.ref.length > 0 && !used.has(c.ref));
  const target = [...slots]
    .filter((slot) => (slot.optionRefs?.length ?? 0) === 0 && !slot.optionPick)
    .sort((a, b) => compareDateKeys(a.dateKey, b.dateKey));

  const assignments: OptionAssignment[] = [];
  for (const slot of target) {
    // Recomputed per day (rather than walked with a cursor) so a draft the
    // diversity passes skipped stays available for a later day instead of
    // being stranded behind the cursor.
    const remaining = pool.filter((c) => !used.has(c.ref));
    if (remaining.length < 2) break;
    const chosen: OptionCandidate[] = [];
    const directions = new Set<string>();
    const accounts = new Set<string>();
    // Pass 1: distinct directions. Pass 2: distinct accounts. Pass 3: fill.
    for (const pass of [0, 1, 2]) {
      for (const candidate of remaining) {
        if (chosen.length >= perSlot) break;
        if (chosen.includes(candidate)) continue;
        const direction = candidate.direction ?? "";
        const account = candidate.account ?? "";
        if (pass === 0 && direction && directions.has(direction)) continue;
        if (pass === 1 && account && accounts.has(account)) continue;
        chosen.push(candidate);
        if (direction) directions.add(direction);
        if (account) accounts.add(account);
      }
      if (chosen.length >= perSlot) break;
    }
    if (chosen.length < 2) break;
    for (const candidate of chosen) used.add(candidate.ref);
    assignments.push({ slotId: slot.id, optionRefs: chosen.map((c) => c.ref) });
  }
  return assignments;
}
