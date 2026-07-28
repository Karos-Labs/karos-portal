/**
 * Client agents — identity, day keys, and the launch gate ladder (Phase 3).
 *
 * PURE and client-safe (no firebase-admin, no data layer, no `server-only`):
 * the same functions run in the launch action, in the card that draws the
 * disabled CTA, and in unit tests. That is the point of the gate ladder living
 * here — a card must never show an enabled control the server would refuse
 * (F131), and it can only guarantee that by evaluating the SAME predicate in
 * the same order the server does.
 *
 * Timestamps are epoch millis everywhere; a slot's `dateKey` is a calendar DAY
 * (see AgentSlot.dateKey) and is derived through the run-cadence zone helpers,
 * never through a second clock implementation.
 */

import type { ClientAgent, ClientAgentLaunchState, ClientAgentTemplate } from "@/lib/types";
import { localYMD } from "@/lib/run-cadence";

/* ─────────────────────────── deterministic ids ─────────────────────────── */

/**
 * The umbrella's agent-key slug: lowercased, path separators folded to "-",
 * and every character outside [a-z0-9._-] dropped so the result is always a
 * legal Firestore document id segment.
 */
export function agentKeySlug(agentKey: string): string {
  return agentKey
    .toLowerCase()
    .replace(/\//g, "-")
    .replace(/[^a-z0-9._-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "");
}

/**
 * Deterministic `clientAgents` doc id: `${clientId}__${agentKeySlug}`. One
 * umbrella per (client, lab agent) by construction, so upserts are idempotent
 * and the backfill can be re-run safely.
 */
export function clientAgentDocId(clientId: string, agentKey: string): string {
  return `${clientId}__${agentKeySlug(agentKey)}`;
}

/** Deterministic `agentSlots` doc id: one slot per day per umbrella. */
export function agentSlotDocId(clientAgentId: string, dateKey: string): string {
  return `${clientAgentId}__${dateKey}`;
}

/* ──────────────────────────── calendar day keys ─────────────────────────── */

const DATE_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isDateKey(value: string): boolean {
  return DATE_KEY_RE.test(value);
}

/** "YYYY-MM-DD" of an instant as observed in `timeZone` (F108 zone contract). */
export function dateKeyInZone(atUtcMs: number, timeZone: string): string {
  const { y, mo, d } = localYMD(timeZone, atUtcMs);
  return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** Calendar parts of a dateKey. Throws on a malformed key (callers validate). */
export function dateKeyParts(dateKey: string): { y: number; mo: number; d: number } {
  if (!isDateKey(dateKey)) throw new Error(`Invalid dateKey: ${dateKey}`);
  const [y, mo, d] = dateKey.split("-").map(Number);
  return { y, mo, d };
}

/**
 * `dateKey` shifted by whole calendar days. Month/year rollover comes from UTC
 * Date arithmetic on the plain calendar date — no zone is involved, because a
 * dateKey is a wall-calendar day, not an instant.
 */
export function shiftDateKey(dateKey: string, days: number): string {
  const { y, mo, d } = dateKeyParts(dateKey);
  const shifted = new Date(Date.UTC(y, mo - 1, d + days));
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, "0")}-${String(
    shifted.getUTCDate(),
  ).padStart(2, "0")}`;
}

/** Weekday (0=Sun..6=Sat) of a dateKey. */
export function weekdayOfDateKey(dateKey: string): number {
  const { y, mo, d } = dateKeyParts(dateKey);
  return new Date(Date.UTC(y, mo - 1, d)).getUTCDay();
}

/** dateKeys sort lexicographically — this is here so call sites read as intent. */
export function compareDateKeys(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/* ─────────────────────────── launch state machine ───────────────────────── */

/** States a fresh launch may be submitted from (§2). */
export function canSubmitLaunch(state: ClientAgentLaunchState): boolean {
  return state === "not_launched" || state === "launch_failed";
}

/** True while a setup job is in flight — blocks a second submit, server-side. */
export function isLaunchInFlight(state: ClientAgentLaunchState): boolean {
  return state === "launching" || state === "curating";
}

/**
 * The three phases a CLIENT sees. The five internal states collapse so a client
 * never reads staff vocabulary ("curating") and never learns that deliverables
 * already exist before their day (the A3 churn rule).
 */
export type ClientLaunchPhase = "not_started" | "researching" | "designing" | "live" | "failed";

export function clientLaunchPhase(
  state: ClientAgentLaunchState,
  opts?: { startedAt?: number | null; now?: number },
): ClientLaunchPhase {
  switch (state) {
    case "not_launched":
      return "not_started";
    case "launching": {
      // Until the service emits progress events (Tomer seam T2) the split is a
      // two-stage narrative keyed off elapsed time. It never claims completed
      // work it cannot see: stage 2 is "designing", not "templates ready".
      const startedAt = opts?.startedAt ?? null;
      const now = opts?.now ?? Date.now();
      if (startedAt != null && now - startedAt >= LAUNCH_STAGE_SPLIT_MS) return "designing";
      return "researching";
    }
    case "curating":
      return "designing";
    case "live":
      return "live";
    case "launch_failed":
      return "failed";
  }
}

/** Halfway through the quoted launch window — where the client narrative turns. */
export const LAUNCH_STAGE_SPLIT_MS = 12 * 60 * 1000;

export const CLIENT_LAUNCH_PHASE_COPY: Record<
  Exclude<ClientLaunchPhase, "not_started" | "failed">,
  { title: string; detail: string }
> = {
  researching: {
    title: "Researching your brand",
    detail: "Reading your brand, your audience, and what already works in your market.",
  },
  designing: {
    title: "Designing your templates",
    detail: "Turning that research into the set of post formats this agent will produce for you.",
  },
  live: {
    title: "Live",
    detail: "Your agent is producing on its schedule.",
  },
};

/* ───────────────────────────── the launch gate ──────────────────────────── */

/**
 * Why a launch cannot be started right now. One code per rung of the §2
 * ladder, in the order the server checks them, so the disabled CTA names the
 * SAME blocker the server would refuse with.
 */
export type LaunchBlockCode =
  /** The agent is not granted to this client. */
  | "not_granted"
  /** A setup job is already in flight for this umbrella. */
  | "launch_in_flight"
  /** Already launched — there is nothing left to launch. */
  | "already_live"
  /** An intake-driven agent (X / LinkedIn) has no stored intake yet. */
  | "intake_required"
  /** launchCreditCost is null — the price has not been calibrated (§6.3, Q10). */
  | "pricing_uncalibrated"
  /** A billable client actor cannot afford the launch. */
  | "credits_short";

export const LAUNCH_BLOCK_REASON: Record<
  Exclude<LaunchBlockCode, "intake_required" | "credits_short">,
  string
> = {
  // Same wording the submit core uses for an agent outside the allowlist —
  // never leak which agents exist beyond it.
  not_granted: "Agent not found.",
  launch_in_flight: "Setup is already running — this page updates itself when it finishes.",
  already_live: "This agent is already set up.",
  pricing_uncalibrated: "Launch pricing for this agent is being finalized — ask your Karos team.",
};

/** The intake rung's line, naming the page that unblocks it. */
export function intakeBlockReason(intakeLabel: string): string {
  return `Setup needs your ${intakeLabel} — this agent is built from it.`;
}

export interface LaunchGateInput {
  launchState: ClientAgentLaunchState;
  /** Whether this client may run the bound agent at all (allowlist / activation). */
  granted: boolean;
  /** False only for an intake-driven agent whose intake is missing. */
  intakeReady: boolean;
  /** Names the intake page, e.g. "X agent data". Required when intakeReady is false. */
  intakeLabel?: string | null;
  /** CustomAgent.launchCreditCost — null ⇒ uncalibrated. */
  launchCreditCost?: number | null;
  /**
   * Spendable credits right now. `undefined` means the actor is NOT billable
   * (staff, or an admin in "View as Client"): the pricing and credit rungs are
   * skipped entirely for them — a staff launch is free and is precisely the run
   * that produces the price measurement.
   */
  availableCredits?: number;
  /**
   * The pre-resolved binding-limit line for a blocked charge
   * (credits.ts creditBlockReason). Falls back to a plain line when absent.
   */
  creditBlockReason?: string | null;
}

export type LaunchGateResult =
  | { allowed: true; cost: number }
  | { allowed: false; code: LaunchBlockCode; reason: string };

/**
 * The §2 gate ladder, evaluated in the server's own order:
 *   1. granted + a launchable state (one launch in flight per umbrella)
 *   2. intake gate (X / LinkedIn — the existing hard gate)
 *   3. pricing gate  (billable client actors only)
 *   4. credits       (billable client actors only; the charge itself is the
 *                     server's business, this is the pre-flight twin)
 *
 * Order matters as much as the predicates: a client with no intake AND no
 * credits must be told about the intake first, because that is what the server
 * refuses on and it is the one they can fix themselves.
 */
export function evaluateLaunchGate(input: LaunchGateInput): LaunchGateResult {
  if (!input.granted) {
    return { allowed: false, code: "not_granted", reason: LAUNCH_BLOCK_REASON.not_granted };
  }
  if (isLaunchInFlight(input.launchState)) {
    return {
      allowed: false,
      code: "launch_in_flight",
      reason: LAUNCH_BLOCK_REASON.launch_in_flight,
    };
  }
  if (!canSubmitLaunch(input.launchState)) {
    return { allowed: false, code: "already_live", reason: LAUNCH_BLOCK_REASON.already_live };
  }
  if (!input.intakeReady) {
    return {
      allowed: false,
      code: "intake_required",
      reason: intakeBlockReason(input.intakeLabel?.trim() || "agent setup data"),
    };
  }

  // Staff / impersonated sessions never charge, so neither price nor balance
  // can block them.
  if (input.availableCredits === undefined) return { allowed: true, cost: 0 };

  const cost = input.launchCreditCost;
  if (cost == null) {
    return {
      allowed: false,
      code: "pricing_uncalibrated",
      reason: LAUNCH_BLOCK_REASON.pricing_uncalibrated,
    };
  }
  if (input.availableCredits < cost) {
    return {
      allowed: false,
      code: "credits_short",
      reason:
        input.creditBlockReason?.trim() ||
        "Not enough credits — ask your Karos team for a top-up.",
    };
  }
  return { allowed: true, cost };
}

/* ───────────────────────────── template registry ────────────────────────── */

/** Templates that may currently produce posts, in rotation order. */
export function activeTemplates(agent: Pick<ClientAgent, "templates">): ClientAgentTemplate[] {
  return [...agent.templates]
    .filter((t) => t.status === "active")
    .sort((a, b) => a.position - b.position || a.key.localeCompare(b.key));
}

/**
 * The rotation actually used for slot generation: the stored rotation filtered
 * to templates that still exist and are active, with any active template the
 * rotation forgot appended in position order. A rotation that silently drops a
 * template the client can see in the list would produce slots nobody asked for.
 */
export function effectiveRotation(
  agent: Pick<ClientAgent, "templates" | "rotation">,
): string[] {
  const active = activeTemplates(agent);
  const activeKeys = new Set(active.map((t) => t.key));
  const seen = new Set<string>();
  const rotation: string[] = [];
  for (const key of agent.rotation) {
    if (activeKeys.has(key) && !seen.has(key)) {
      seen.add(key);
      rotation.push(key);
    }
  }
  for (const template of active) {
    if (!seen.has(template.key)) {
      seen.add(template.key);
      rotation.push(template.key);
    }
  }
  return rotation;
}

/** The umbrella's slot mode. X-style umbrellas own no chain family. */
export function isOptionsMode(agent: Pick<ClientAgent, "chainFamily">): boolean {
  return agent.chainFamily == null;
}

/** The stable template key an options slot carries, so chips still have a label. */
export const OPTIONS_TEMPLATE_KEY = "daily-post";
