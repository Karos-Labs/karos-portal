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
  launch_in_flight: "Setup is already running. This page updates itself when it finishes.",
  already_live: "This agent is already set up.",
  pricing_uncalibrated: "Launch pricing for this agent is being finalized. Ask your Karos team.",
};

/** The intake rung's line, naming the page that unblocks it. */
export function intakeBlockReason(intakeLabel: string): string {
  return `Setup needs your ${intakeLabel}: this agent is built from it.`;
}

/**
 * The binding rung's line. Names the workspace the instance belongs to rather
 * than the reader's own slug: whoever sees this is looking at another client's
 * agent, and the fix is to use this client's own instance.
 */
export function bindingBlockReason(agentKey: string): string {
  return `This agent belongs to the "${perClientAgentSlug(agentKey)}" workspace. Its playbook is baked under that client's folder, so it would draft the wrong company. Use this client's own agent.`;
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
        "Not enough credits. Ask your Karos team for a top-up.",
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
 * What the JOBS say about delivered work — the two identities a delivered custom
 * job can be attributed by, and nothing about any particular agent.
 *
 * HALF AN ANSWER, and named so. "Has this agent delivered?" is asked by the
 * roster and by the agent detail page, and neither may ask it here: a lab
 * import is written with `jobId: null`, so it produces no job and is invisible
 * to this join. Under the old name (`deliveredAgentIds`) both surfaces read it
 * as the whole answer, and an agent whose entire history was imported went
 * missing from its client's roster while its posts sat in their Workspace.
 *
 * The whole answer is `agentsWithDeliveredWork` in agent-detail-archetypes.ts —
 * this join plus the asset attribution rungs — and it is the ONLY caller of this
 * function. Anything else calling it is re-opening that gap.
 *
 * FACTS, NOT A RESOLVED SET, and that is the whole change of shape. This used to
 * take an `agentIdByName` map and return resolved agent ids, which made one
 * agent's answer depend on the OTHER agents the caller asked about: a map keyed
 * on a display name holds one entry per name, so of two agents sharing a name
 * only the last was attributable by the name rung. The roster asks about its
 * whole candidate list (shadowing applies) and the detail page about one agent (a
 * single-entry map, so it cannot), and the two therefore returned different
 * answers for the SAME agent — the exact disagreement the shared function exists
 * to remove. Returning the jobs' own facts leaves the per-agent read independent,
 * so a list read is N single reads.
 *
 * `names` is the pre-`customAgentId` fallback and holds the recorded name
 * VERBATIM, where `agentProducedAssets` compares case-insensitively and trimmed.
 * A job whose recorded name differs only in case therefore counts as delivered
 * work through the asset rungs and not through this one. Worth closing, but not
 * by normalising on one side only: the caller compares `agent.name` against this
 * set, and a fold applied here and not there would simply move which spellings
 * miss.
 *
 * Only a job with NO `customAgentId` feeds `names`, which reproduces the
 * `customAgentId ?? name` fallback chain exactly. Feeding every job's name in
 * would credit an agent for a run whose own binding names a DIFFERENT agent that
 * happens to share its display name — a mis-credit, and a widening of what both
 * surfaces answered before.
 */
export interface JobDeliveredWork {
  /** `customAgentId` of every agent with a delivered custom job. */
  ids: Set<string>;
  /** Verbatim `agentName` of delivered custom jobs that carry no `customAgentId`. */
  names: Set<string>;
}

export function jobDeliveredWork(
  jobs: Pick<Job, "status" | "external" | "customAgentId" | "agentName">[],
  opts: {
    /**
     * Leave out `review` — jobs staff are still holding, whose every asset
     * `getClientArchiveAssets` drops.
     *
     * Pass this for a CLIENT viewer. Without it a run in review lists the agent
     * on the client's roster while the page under it is empty, which is the
     * defect the roster fix exists to remove rather than a milder version of it.
     * Staff keep `review`, because a run awaiting their own review is precisely
     * the thing they need to see.
     */
    excludeInReview?: boolean;
  } = {},
): JobDeliveredWork {
  const ids = new Set<string>();
  const names = new Set<string>();
  for (const job of jobs) {
    if (job.external?.taskType !== "custom") continue;
    if (!DELIVERED_JOB_STATUSES.has(job.status)) continue;
    if (opts.excludeInReview && job.status === "review") continue;
    if (job.customAgentId) {
      ids.add(job.customAgentId);
      continue;
    }
    // A job with neither a binding nor a recorded name is dropped rather than
    // guessed at. Read defensively even though `agentName` is typed as required:
    // this runs over whatever Firestore actually holds.
    if (typeof job.agentName === "string" && job.agentName !== "") names.add(job.agentName);
  }
  return { ids, names };
}

/**
 * Which agents' MOST RECENT finished run failed, by customAgentId.
 *
 * The sibling of `jobDeliveredWork`, over the same job population and the same
 * name fallback, because it answers the other half of the same question. The
 * roster's status word was built from four inputs — launch state, schedule
 * refusal, schedule active, delivered — and NONE of them can see a run that
 * failed at the agent service: `schedule.lastError` only ever records a
 * SUBMIT-time refusal (out of credits, a cap, a missing intake, the service
 * down), while a run that submits cleanly and then fails writes `job.error`
 * through the webhook and never touches the schedule row. So the pilot client's
 * Instagram Agent carried a green "Live" badge whose only run, two days
 * earlier, read "Failed".
 *
 * THE ORDERING RULE, and it is the whole helper:
 *
 *  1. Only the most recent run with a VERDICT counts. An old failure followed
 *     by a later success is not "needs attention" — it is an agent that had a
 *     bad day and then worked, and a badge that remembers the failure forever
 *     is the stale-refusal defect wearing a different hat.
 *  2. A run still in flight (queued/running) carries no verdict and is skipped
 *     rather than treated as a success. Skipping is deliberate: a retry running
 *     right now does not mean the last failure is fixed, so the previous
 *     verdict stands until the retry produces one of its own — the same call
 *     `deriveAgentHealth` makes when it reports "retrying" rather than
 *     "healthy".
 *  3. A CANCELLED run is skipped too. Somebody stopped it by hand; that says
 *     nothing about whether the agent works, so it may neither raise attention
 *     nor clear a failure that came before it.
 *
 * Ties (two verdicts on the same millisecond, which submission timestamps make
 * all but impossible) resolve to the failure, so the answer never depends on
 * the order the jobs happened to arrive in.
 *
 * SCOPE OF "EVERY SURFACE AGREES": the ORDERING RULE above is shared, and that is
 * what the callers were disagreeing about. `agentIdByName` is still the caller's
 * map, and a map keyed on a display name holds one entry per name — so for two
 * agents sharing one, a roster (which builds the map over its whole list) and a
 * detail page (which builds it for one agent) can still differ on a run fired
 * before `customAgentId` existed. `jobDeliveredWork` had the same hole and no
 * longer does; this one is knowingly left, because closing it means deciding how
 * a latest-verdict comparison merges two attribution keys, which is its own
 * change with its own tests rather than a rename.
 */
export function lastRunFailedAgentIds(
  jobs: Pick<Job, "status" | "external" | "customAgentId" | "agentName" | "createdAt" | "runType">[],
  agentIdByName: Map<string, string>,
  /**
   * Staff see every run; a client sees neither launch runs nor test runs, so
   * neither may move a client's badge. Without this a staff member testing an
   * agent would put "Needs attention" on the client's card, pointing at a run
   * the client cannot see and did not cause — the badge crying wolf, which is
   * worse than the silence it replaced. Same predicate as the run list uses
   * (client-agent-rows.ts, `staff || (runType !== "launch" && !== "test")`);
   * the two must agree or the card and the list behind it tell different
   * stories.
   */
  opts: { staff: boolean },
): Set<string> {
  const latest = new Map<string, { at: number; failed: boolean }>();
  for (const job of jobs) {
    if (job.external?.taskType !== "custom") continue;
    if (!opts.staff && (job.runType === "launch" || job.runType === "test")) continue;
    const failed = job.status === "failed";
    // Everything that is neither a landing nor a failure — queued, running,
    // cancelled — is not a verdict and does not take part in the comparison.
    if (!failed && !DELIVERED_JOB_STATUSES.has(job.status)) continue;
    const agentId = job.customAgentId ?? agentIdByName.get(job.agentName);
    if (!agentId) continue;
    const seen = latest.get(agentId);
    if (!seen || job.createdAt > seen.at || (job.createdAt === seen.at && failed)) {
      latest.set(agentId, { at: job.createdAt, failed });
    }
  }
  return new Set(
    [...latest].filter(([, verdict]) => verdict.failed).map(([agentId]) => agentId),
  );
}

/**
 * How long a stored schedule refusal keeps forcing "Needs attention".
 *
 * `PlannedScheduledRun.lastError` clears only on the next CLEAN fire, so on a
 * weekly cadence a refusal that a top-up fixed an hour later kept telling the
 * client their agent needed them for up to seven more days. Three days is
 * chosen against that cadence from both ends: comfortably shorter than the
 * longest gap between fires (weekly), so a stale refusal can never sit out a
 * whole cycle; and long enough to survive a weekend, so a Friday-evening
 * refusal is still on the card on Monday morning when somebody is there to act
 * on it.
 *
 * Ageing out is not forgetting. Nothing is written — this is a read-path
 * window — so a refusal that is still true is re-raised by the very next
 * refused fire (within a day for a daily schedule), and the refusal text and
 * its "Last tried" stamp stay on the staff surfaces that render them
 * regardless of age.
 */
export const SCHEDULE_REFUSAL_FRESH_MS = 3 * 24 * 60 * 60 * 1000;

export type RosterStatusTone = "live" | "attention" | "progress" | "idle" | "disabled";

export interface RosterStatus {
  tone: RosterStatusTone;
  label: string;
  /**
   * The operational truth behind a word that does not come from this agent's own
   * machinery — today only the AF-5 rung, where "Live" is claimed on the strength
   * of content already on the client's calendar rather than on a schedule that is
   * firing.
   *
   * STAFF SURFACES ONLY. It is set unconditionally (the function has no viewer
   * argument and does not want one: the CLIENT-FACING word is the same for both
   * readers by ruling, and a status that changed shape per viewer is how two
   * surfaces come to disagree). Callers decide whether to paint it, and the
   * client's branches do not.
   */
  staffNote?: string;
}

/**
 * Why a client-facing "Live" is being claimed for an agent whose own schedule is
 * not firing (AF-5). Operator voice: it names the cause and the evidence, because
 * the person reading it is the one who would otherwise open a ticket about a
 * green badge on a paused schedule.
 */
export const IMPORTED_CONTENT_STAFF_NOTE =
  "Schedule is not firing. The client-facing status reads Live because upcoming content for this agent is already on their calendar, produced internally.";

/**
 * Whether a stored schedule refusal is recent enough to still be the client's
 * current state. Blank is not a refusal; an UNDATED one is kept, because every
 * writer sets `lastErrorAt` in the same patch as `lastError` (the scheduler
 * routes, and planned-run-actions clears both together), so a refusal with no
 * timestamp is a row we cannot age rather than one we know to be old — and
 * hiding an alarm we cannot date is the wrong way to be wrong.
 *
 * A PAUSED SCHEDULE HAS NO CURRENT REFUSAL, and that rule lives here now.
 * `lastError` is cleared in exactly three places — a clean fire, a resume to
 * active, and a configure save — and pausing is none of them, so a refusal
 * survives the pause that answers it and keeps badging the agent. Every caller
 * had spotted that and written `schedule?.status === "active" ? lastError :
 * null` into its own arguments; the rule written three times is the rule the
 * fourth caller forgets, so the callers now hand over the refusal and the
 * status and this decides.
 *
 * Keyed to `=== false`, so a caller that does not know the status still gets
 * the alarm. That is the loud direction on purpose: an unanswerable "is it
 * paused?" must not silence a refusal.
 */
function refusalIsCurrent(input: {
  scheduleRefusal?: string | null;
  scheduleRefusalAt?: number | null;
  scheduleActive?: boolean;
  now?: number;
}): boolean {
  if (!input.scheduleRefusal?.trim()) return false;
  if (input.scheduleActive === false) return false;
  if (input.scheduleRefusalAt == null) return true;
  return (input.now ?? Date.now()) - input.scheduleRefusalAt < SCHEDULE_REFUSAL_FRESH_MS;
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
 * A FAILED LAST RUN outranks "Live" for the same reason and closes the other
 * half of it. The refusal rung can only see a fire the scheduler turned away
 * BEFORE a job existed; a run that submits cleanly and then fails at the agent
 * service is invisible to it, which is how the pilot client's Instagram Agent
 * came to show a green "Live" badge two days after its only run failed. The
 * verdict comes from `lastRunFailedAgentIds`, which every call site shares so
 * the card and the page it opens cannot hold two opinions of the ordering rule.
 * It is a STAFF rung only — see `viewerIsStaff`, and AF-14 — because the green
 * badge it was written to correct is on a staff surface, while on a client's it
 * asks them to attend to a failure that is ours.
 *
 * Both rungs say "Needs attention" — one phrase, deliberately. The roster
 * answers "is this working for me right now", and "no" is one answer however it
 * got there; WHY is the detail page's job. A second phrase here would also be a
 * second label map, and those are a standing defect class in this codebase.
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
 *
 * LIVE MEANS LIVE (AF-5), and it is the last rung on purpose. Albert: "it should
 * still show that it's live even though we're creating it internally… if there's
 * items on the calendar like Instagram or TikTok items, it should show us live."
 * A stream whose posts Karos produces by hand and imports has no cron of its own
 * — its `clientAgents` row may never have been launched and its schedule may be
 * paused for exactly that reason — so every rung above answers "idle" for an
 * agent the client can plainly see filling their calendar next week.
 *
 * It is applied to the IDLE OUTCOME rather than written into each idle branch,
 * which is what keeps it from becoming a fourth way to outrank an alarm. A
 * refusal, a failed last run, a launch in flight and a failed launch all decide
 * before it and are untouched by it: the ruling is that we stop calling a
 * producing agent idle, not that we start calling a broken one live. The staff
 * note rides along so the surfaces that carry operator state can say why the word
 * disagrees with the schedule row underneath it.
 */
export function rosterStatus(input: {
  /** Null for a granted agent with no umbrella bound. */
  launchState: ClientAgentLaunchState | null;
  /**
   * The agent's schedule refusal, already client-redacted — passed RAW, as
   * stored. Callers used to null it out themselves for a paused schedule;
   * `refusalIsCurrent` owns that rule now, so hand it over unfiltered or the
   * rule exists in two places again.
   */
  scheduleRefusal?: string | null;
  /**
   * When that refusal was recorded (PlannedScheduledRun.lastErrorAt). Past
   * SCHEDULE_REFUSAL_FRESH_MS it stops forcing the badge — see that constant
   * for why, and note that nothing is written to make it so.
   */
  scheduleRefusalAt?: number | null;
  /**
   * True when a recurring schedule exists and is not paused. Read twice: it is
   * the "Live" rung for an agent with no umbrella, AND the freshness test's
   * pause rule (a refusal from before a pause is not the current state).
   */
  scheduleActive?: boolean;
  /**
   * True when this agent has already landed work for this client — i.e. it has
   * plainly been set up, whatever it has bound. Resolved by the callers through
   * `agentsWithDeliveredWork` (jobs AND the asset attribution rungs), so the
   * roster card and the page it opens answer it the same way. A job-only read
   * here is the defect that hid every lab-import-only agent.
   */
  hasDelivered?: boolean;
  /**
   * True when this agent COULD be run right now — both readiness questions
   * answered yes (its intake is saved AND, where the family has one, its one-time
   * stand-up run has happened). Resolved by the caller from the same
   * `AgentSetupState` the run gate reads, so the word on the badge and the state
   * of the button beneath it come off one answer.
   *
   * Optional, and absent means "do not know": a caller that cannot answer it gets
   * the old delivered-work-only behaviour rather than a guess.
   */
  readyToRun?: boolean;
  /**
   * True when this agent's most recent run WITH A VERDICT failed. Resolved by
   * the callers through `lastRunFailedAgentIds` — the ordering rule lives there,
   * not here, so no surface holds an opinion of its own about what "failed last"
   * means. That helper's doc states where the shared answer stops.
   */
  lastRunFailed?: boolean;
  /**
   * False when an admin has paused this agent (`CustomAgent.enabled`) — the
   * roster card must say "Coming Soon" rather than any live/progress/idle
   * word, whatever the umbrella or schedule underneath it looks like. This
   * outranks even a schedule refusal: a paused agent isn't "needing
   * attention", it simply isn't running for anyone right now — and it outranks
   * the AF-5 upcoming-content rung for the same reason. Defaults to true so
   * every existing caller (managed products, tests) is unaffected.
   */
  enabled?: boolean;
  /**
   * Whether the reader is STAFF — the gate on the `lastRunFailed` rung, and the
   * only thing on this input that asks who is looking.
   *
   * AF-14 is absolute: "clients never see failed runs." The failed-last-run rung
   * was added for the roster card that sat green above a run history whose last
   * row read Failed, which is a STAFF complaint about a STAFF surface — but it
   * was wired for both readers, so a production fire that failed at the agent
   * service put "Needs attention" on the client's card. That badge asks the
   * client to do something about an internal failure they cannot see, did not
   * cause and have no lever over, and it does it on exactly the agents AF-5 is
   * about: a stream we produce internally, whose posts are sitting on their
   * calendar, is not something the client needs to attend to.
   *
   * A SCHEDULE REFUSAL IS NOT AFFECTED and still outranks Live for everyone
   * (F24/F129). The two are different facts: a refusal is the scheduler turning a
   * fire away for a reason the client owns (out of credits, an empty intake), and
   * telling them is the whole point. A run that submitted cleanly and then broke
   * is ours.
   *
   * DEFAULTS TO FALSE, which skips the rung — the quiet direction, opposite to
   * `refusalIsCurrent`'s. The two defaults are chosen against their own failure
   * modes: an undatable refusal that goes unsaid leaves a client stuck with no
   * idea why, while an internal failure shown to a client is the thing AF-14
   * forbids outright. Every staff call site passes it, and `lastRunFailedAgentIds`
   * already takes the same `staff` flag, so the pair travels together.
   */
  viewerIsStaff?: boolean;
  /**
   * True when this agent's stream has content on the client's calendar for a day
   * that has not happened yet (AF-5). Resolved by the callers through
   * `agentsWithUpcomingContent`, which walks the SAME attribution rungs
   * `agentsWithDeliveredWork` does, so "whose stream is this" is one answer here
   * as everywhere else.
   *
   * A BOOLEAN, and that is the whole contract. How many items, which days and
   * what they say are the calendar's business; this surface may only know that
   * the client has some. Anything richer crossing the RSC boundary would publish
   * the batch shape on a page whose entire job is to not (A3/A4).
   */
  hasUpcomingContent?: boolean;
  /** Clock, for the refusal's freshness window. Defaults to now. */
  now?: number;
}): RosterStatus {
  // An admin's pause outranks everything — refusal, failed run, AF-5 — because
  // a paused agent isn't in any of those states: it simply isn't running for
  // anyone right now, and "Coming Soon" is the one honest word for that.
  if (input.enabled === false) return { tone: "disabled", label: "Coming Soon" };
  const status = rosterStatusCore(input);
  // The AF-5 rung. Only an IDLE outcome is eligible: see the doc above for why
  // this may not reach past an alarm or a launch narration.
  if (status.tone !== "idle" || !input.hasUpcomingContent) return status;
  return { tone: "live", label: "Live", staffNote: IMPORTED_CONTENT_STAFF_NOTE };
}

/** The four original rungs — see `rosterStatus` for the ordering rules. */
function rosterStatusCore(input: {
  launchState: ClientAgentLaunchState | null;
  scheduleRefusal?: string | null;
  scheduleRefusalAt?: number | null;
  scheduleActive?: boolean;
  hasDelivered?: boolean;
  readyToRun?: boolean;
  lastRunFailed?: boolean;
  viewerIsStaff?: boolean;
  now?: number;
}): RosterStatus {
  const attention: RosterStatus = { tone: "attention", label: "Needs attention" };
  if (refusalIsCurrent(input)) return attention;
  // A failed last run outranks Live, but never the launch states: `launching`
  // and `curating` are a NEWER event than any finished run and the launch card
  // is already narrating them, and `launch_failed` is the same alarm in more
  // specific words. Replacing either with the generic phrase would lose
  // information, not add it.
  //
  // STAFF ONLY (AF-14) — see `viewerIsStaff` for why a client's badge may not be
  // moved by a run that broke on our side of the wire.
  if (
    input.lastRunFailed &&
    input.viewerIsStaff &&
    input.launchState !== "launching" &&
    input.launchState !== "curating" &&
    input.launchState !== "launch_failed"
  ) {
    return attention;
  }

  if (input.launchState === null) {
    // No umbrella and no schedule firing: nobody has set this agent up for this
    // client yet, and its detail page says exactly that. The two must agree —
    // a roster promising "Ready to start" that opens onto "Not set up yet" is
    // a card that lied about the page behind it.
    if (input.scheduleActive) return { tone: "live", label: "Live" };
    // "Runs on request" is about CAPABILITY, and delivered work is only one way
    // to prove it. This used to be `hasDelivered` alone, so an agent that was
    // fully stood up and had simply never been asked for anything read "Not set
    // up yet" — the one state where that phrase is actively wrong, because the
    // reader has finished setting it up and the page underneath is offering them
    // a Run button. It was invisible on X (delivered twice) and was going to
    // greet the first LinkedIn client the moment their stand-up run finished.
    //
    // `readyToRun` is the second proof, and it is deliberately the CONJUNCTION of
    // both readiness questions (intake saved AND stood up) resolved by the caller
    // from the same AgentSetupState the run gate reads. An agent still waiting on
    // either one keeps "Not set up yet", because for it the phrase is true.
    return input.hasDelivered || input.readyToRun
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
