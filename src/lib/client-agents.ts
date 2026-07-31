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

import type { ClientAgent, ClientAgentLaunchState, ClientAgentTemplate, Job } from "@/lib/types";
import { localYMD } from "@/lib/run-cadence";
import { agentKeyMatchesClientSlug, perClientAgentSlug } from "@/lib/custom-agent-launch";

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

/** ~How long a setup run takes, in the client's words. */
export const LAUNCH_ESTIMATE = "~20–40 min";

/**
 * Past this, a launch still sitting in `launching` is more likely stuck than
 * slow — the webhook never arrived, the service dropped the job, a deploy ate
 * the callback. Comfortably longer than the quoted window so a genuinely slow
 * setup is never called stuck (W7: staff get a reset either way; this only
 * decides whether the card says so out loud).
 */
export const LAUNCH_STUCK_MS = 60 * 60 * 1000;

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
  /**
   * The bound agent is a per-client instance belonging to a DIFFERENT client.
   * Both submit cores refuse this pair before any job row exists, so a launch
   * offered past it is an enabled button with a guaranteed server refusal.
   */
  | "wrong_client_binding"
  /** An intake-driven agent (X / LinkedIn / Reddit) has no stored intake yet. */
  | "intake_required"
  /** launchCreditCost is null — the price has not been calibrated (§6.3, Q10). */
  | "pricing_uncalibrated"
  /** A billable client actor cannot afford the launch. */
  | "credits_short";

export const LAUNCH_BLOCK_REASON: Record<
  Exclude<LaunchBlockCode, "intake_required" | "credits_short" | "wrong_client_binding">,
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

/**
 * The binding rung's line. Names the workspace the instance belongs to rather
 * than the reader's own slug: whoever sees this is looking at another client's
 * agent, and the fix is to use this client's own instance.
 */
export function bindingBlockReason(agentKey: string): string {
  return `This agent belongs to the "${perClientAgentSlug(agentKey)}" workspace — its playbook is baked under that client's folder, so it would draft the wrong company. Use this client's own agent.`;
}

export interface LaunchGateInput {
  launchState: ClientAgentLaunchState;
  /** Whether this client may run the bound agent at all (allowlist / activation). */
  granted: boolean;
  /**
   * customAgents.key of the bound lab agent, and this client's lab-repo slug.
   * Required, not optional: the binding rung is only load-bearing if every
   * caller supplies the pair, and a caller that could omit them would silently
   * skip the rung and paint an enabled button the server refuses.
   */
  agentKey: string;
  clientSlug?: string | null;
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
 *   2. binding   (a per-client instance runs only for its own client)
 *   3. intake gate (X / LinkedIn / Reddit — the existing hard gate)
 *   4. pricing gate  (billable client actors only)
 *   5. credits       (billable client actors only; the charge itself is the
 *                     server's business, this is the pre-flight twin)
 *
 * Order matters as much as the predicates: a client with no intake AND no
 * credits must be told about the intake first, because that is what the server
 * refuses on and it is the one they can fix themselves. The binding rung sits
 * above intake for the same reason in reverse — no amount of intake unblocks a
 * pair the submit core refuses on identity.
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
  // Ahead of the intake rung on purpose. A per-client instance paired with the
  // wrong client is refused by both submit cores before a job row exists, so
  // filling in intake would not unblock it — telling that reader to go and fill
  // a form first sends them to do work that changes nothing.
  if (!agentKeyMatchesClientSlug(input.agentKey, input.clientSlug)) {
    return {
      allowed: false,
      code: "wrong_client_binding",
      reason: bindingBlockReason(input.agentKey),
    };
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
  // Uncalibrated means "no price a human set" — which includes 0, a negative,
  // and a non-integer, not just null. Treating those as valid would charge
  // nothing, write NO ledger row (chargeClientCredits returns before the write
  // for amount ≤ 0), and still quote the client a price on the card: a free
  // launch that reads as paid and leaves no trace in the ledger it should be
  // reconcilable from. A price nobody consciously set is not a price.
  if (cost == null || !Number.isInteger(cost) || cost <= 0) {
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

/**
 * One row of the staff curation pane. Lives here (not beside the action) so
 * both the form and the server validator read the same shape — a "use server"
 * module may only export async functions, and a shared input type is not one.
 */
export interface ClientAgentTemplateInput {
  key: string;
  name: string;
  rationale?: string;
  status?: ClientAgentTemplate["status"];
}

/**
 * The umbrella's slot mode, read from the field the BIND set (W3).
 *
 * This used to answer `chainFamily == null`, which is true of the X agent AND
 * of every agent the family classifier could not place — a research agent, an
 * SEO agent, a freshly imported lab skill with an unfamiliar name. Those would
 * have been handed the daily pick-of-3 product (a picker with no candidates, a
 * "pick of 3" chip on every calendar day) purely because nobody could tell
 * what family they wrote into. Mode is now a decision, not a leftover.
 *
 * Absent ⇒ "single", the safe answer: a single-mode umbrella with an empty
 * rotation generates no slots at all, where a wrongly-inferred options mode
 * generates days the agent cannot fill.
 */
export function isOptionsMode(agent: Pick<ClientAgent, "slotMode">): boolean {
  return agent.slotMode === "options";
}

/** The stable template key an options slot carries, so chips still have a label. */
export const OPTIONS_TEMPLATE_KEY = "daily-post";

/* ─────────────────────── the roster card's status word ────────────────────── */

/**
 * Job statuses that mean a run actually LANDED something for this client.
 * `review` counts: the work exists and staff hold it, which is the fact
 * "has this agent ever produced for us" is asking about.
 */
const DELIVERED_JOB_STATUSES = new Set(["review", "approved", "delivered"]);

/**
 * Which agents have already delivered work for this client, by customAgentId.
 *
 * ONE answer for every surface. The roster card, the detail page's status strip
 * and `rosterStatus` itself all need "has this agent ever produced", and three
 * spellings of it is how a card ends up disagreeing with the page it opens.
 *
 * `agentIdByName` keeps runs fired before `customAgentId` existed attributable —
 * the same fallback join `agentProducedAssets` uses.
 */
export function deliveredAgentIds(
  jobs: Pick<Job, "status" | "external" | "customAgentId" | "agentName">[],
  agentIdByName: Map<string, string>,
): Set<string> {
  return new Set(
    jobs
      .filter((job) => job.external?.taskType === "custom" && DELIVERED_JOB_STATUSES.has(job.status))
      .map((job) => job.customAgentId ?? agentIdByName.get(job.agentName))
      .filter((agentId): agentId is string => Boolean(agentId)),
  );
}

export type RosterStatusTone = "live" | "attention" | "progress" | "idle" | "disabled";

export interface RosterStatus {
  tone: RosterStatusTone;
  label: string;
}

/**
 * The single status word a ROSTER card carries (CD-G1).
 *
 * The roster answers one question per agent — is this working for me right now?
 * — and nothing else. Everything that explains a status (the launch CTA, the
 * progress narration, the failure and its Contact-us row) lives on the agent's
 * detail page, which is why the card can afford to be one word.
 *
 * PRECEDENCE. A schedule refusal outranks "Live", inheriting F24/F129: an agent
 * whose every scheduled fire is being turned away is not live, whatever its
 * umbrella says, and painting it green because a database field says `live`
 * is the exact lie those two defects were about.
 *
 * "Live" is then either of the two things a client would call live: an umbrella
 * that has gone live, or — for an agent with no umbrella at all — a weekly
 * schedule that is actively producing. A granted agent that is neither is idle,
 * not broken, and says so.
 *
 * "NOT SET UP YET" IS A CLAIM ABOUT HISTORY, so it has to read history. An
 * unbound agent with no schedule but a shelf of delivered work was being called
 * "Not set up yet" while the strip beside it printed "Last delivered 7d ago ·
 * Deliverables 2" — one card contradicting itself in a single line. That agent
 * is not un-set-up; it is set up and idle, and it runs when somebody asks it to.
 * The distinction lives HERE rather than in the strip so the roster card and the
 * detail page cannot end up holding two different opinions of the same agent.
 */
export function rosterStatus(input: {
  /** Null for a granted agent with no umbrella bound. */
  launchState: ClientAgentLaunchState | null;
  /** The agent's weekly schedule refusal, already client-redacted. */
  scheduleRefusal?: string | null;
  /** True when a weekly schedule exists and is not paused. */
  scheduleActive?: boolean;
  /**
   * True when this agent has already landed work for this client — i.e. it has
   * plainly been set up, whatever it has bound. Resolved by the callers from
   * the job history through `deliveredAgentIds`, so every surface answers it
   * the same way.
   */
  hasDelivered?: boolean;
  /**
   * False when an admin has paused this agent (`CustomAgent.enabled`) — the
   * roster card must say "Coming Soon" rather than any live/progress/idle
   * word, whatever the umbrella or schedule underneath it looks like. This
   * outranks even a schedule refusal: a paused agent isn't "needing
   * attention", it simply isn't running for anyone right now. Defaults to
   * true so every existing caller (managed products, tests) is unaffected.
   */
  enabled?: boolean;
}): RosterStatus {
  if (input.enabled === false) return { tone: "disabled", label: "Coming Soon" };
  if (input.scheduleRefusal?.trim()) return { tone: "attention", label: "Needs attention" };

  if (input.launchState === null) {
    // No umbrella and no schedule firing: nobody has set this agent up for this
    // client yet, and its detail page says exactly that. The two must agree —
    // a roster promising "Ready to start" that opens onto "Not set up yet" is
    // a card that lied about the page behind it.
    if (input.scheduleActive) return { tone: "live", label: "Live" };
    return input.hasDelivered
      ? { tone: "idle", label: "Runs on request" }
      : { tone: "idle", label: "Not set up yet" };
  }

  switch (input.launchState) {
    case "live":
      return { tone: "live", label: "Live" };
    case "launching":
    case "curating":
      return { tone: "progress", label: "Setting up" };
    case "launch_failed":
      return { tone: "attention", label: "Setup needs attention" };
    case "not_launched":
      return { tone: "idle", label: "Not set up yet" };
  }
}
