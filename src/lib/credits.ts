/**
 * Karos CMO — client credit pricing + window accounting (pure, client-safe).
 *
 * Credits are the client-facing usage currency: AI actions initiated by
 * CLIENT_USER accounts (copilot messages, task executions, doc corrections)
 * charge a client's balance; staff-initiated work is agency overhead and
 * never charges. Admins grant credits and set weekly/monthly spend caps per
 * client (the anti-spam rate limit).
 *
 * This module is intentionally pure (no Firestore, no server-only imports) so
 * client components can show run costs and unit tests can cover the maths.
 * The transactional balance mutations live in src/lib/data.ts.
 */

import type { AppUser, ClientCredits, ManagedTaskType } from "@/lib/types";

/**
 * True when this actor's AI actions should charge the client's balance:
 * a real client user, not staff and not an admin in "View as Client" mode
 * (impersonated sessions carry `impersonatedBy` and never spend real credits).
 */
export function isBillableClientActor(
  user: Pick<AppUser, "role" | "impersonatedBy">,
): boolean {
  return user.role === "CLIENT_USER" && !user.impersonatedBy;
}

/* ── Pricing ─────────────────────────────────────────────────────── */

/**
 * Flat credit prices per client-triggered AI action. Scaled to relative real
 * cost (1 credit ≈ one Haiku-sized call): a Sonnet task execution burns ~5× a
 * chat message; a global doc correction rewrites every context doc (~13
 * Sonnet calls) so it costs 3× a task execution.
 */
export const CREDIT_COSTS = {
  /** One copilot chat message (Sonnet, up to 6 tool steps). */
  chatMessage: 1,
  /**
   * BASELINE karos_managed task execution — the in-process (single Sonnet/Haiku
   * call) path only. Tasks dispatched to a managed product cost more: see
   * TASK_EXECUTION_COSTS / taskExecutionCost() — always resolve through that,
   * never charge this flat rate for a product run.
   */
  taskExecution: 5,
  /** Targeted correction of a single context document. */
  targetedCorrection: 2,
  /** Global correction — rewrites every context doc for the client. */
  globalCorrection: 15,
  /** Small Haiku task helpers: AI execution plan, custom-task classification. */
  taskAssist: 1,
  /**
   * One custom-agent run on the agent service (Opus, 10–35 min, research +
   * media renders — the real cost is task_execution × dozens). Default only:
   * admins can override per agent via CustomAgent.creditCost.
   */
  customAgentRun: 25,
  /**
   * One additional LinkedIn employee-advocacy seat beyond the plan's included
   * limit. A ONE-TIME charge per seat added over the limit — it is not a
   * subscription and does not recur. (An earlier "≈ $29/mo equivalent" note
   * here is what seeded the client-facing copy that sold this one-off charge
   * as a monthly price.)
   */
  employeeSeat: 100,
} as const;

/** Client-facing weekly estimate for a recurring custom-agent schedule. */
export function scheduledAgentWeeklyCost(
  costPerOutput: number,
  postsPerWeek: number,
  outputsPerRun: number,
): number {
  const posts = Math.max(1, Math.round(postsPerWeek));
  const outputs = Math.max(1, Math.round(outputsPerRun));
  return Math.max(0, Math.round(costPerOutput)) * posts * outputs;
}

/* ── LinkedIn employee-advocacy seats ────────────────────────────── */

/** Seats included free in the base plan when a client has no explicit limit set. */
export const DEFAULT_LINKEDIN_SEAT_LIMIT = 2;

export interface SeatAdditionAssessment {
  /** Whether the seat may be added right now. */
  allowed: boolean;
  /** Whether adding it requires spending credits (i.e. it's beyond the plan limit). */
  requiresCharge: boolean;
  /** Credits it costs (0 when within the plan). */
  cost: number;
  /** Set when blocked — a human-readable upgrade prompt. */
  reason?: string;
}

/**
 * Pure monetization gate for adding a LinkedIn employee seat. Seats within
 * `seatLimit` are free; the first seat at/over the limit costs `seatCost` credits
 * (the "explicit charging ledger event"). When the client can't afford it, the
 * addition is blocked with an upgrade prompt. `billable` = false (staff/admin
 * operating the account) bypasses the charge entirely.
 */
export function evaluateSeatAddition(args: {
  currentSeatCount: number;
  seatLimit: number;
  availableCredits: number;
  seatCost?: number;
  billable?: boolean;
}): SeatAdditionAssessment {
  const cost = args.seatCost ?? CREDIT_COSTS.employeeSeat;
  const withinPlan = args.currentSeatCount < args.seatLimit;
  if (withinPlan) return { allowed: true, requiresCharge: false, cost: 0 };

  // Beyond the plan limit.
  if (args.billable === false) {
    // Staff/admin managing the account — allowed without a charge.
    return { allowed: true, requiresCharge: false, cost: 0 };
  }
  if (args.availableCredits >= cost) {
    return { allowed: true, requiresCharge: true, cost };
  }
  return {
    allowed: false,
    requiresCharge: true,
    cost,
    reason: `You've reached your plan's ${args.seatLimit}-seat limit. Adding another employee seat is a one-time ${cost}-credit charge — top up credits or upgrade your plan to continue.`,
  };
}

/**
 * Per-product execution prices for task runs dispatched to the agent service.
 * Scaled to real compute: a product run is a full sandboxed agent session
 * (research + generation, ~$0.50–2), not one model call — text-only products
 * sit at 2× the baseline, media-heavy generation higher still.
 */
export const TASK_EXECUTION_COSTS: Record<Exclude<ManagedTaskType, "custom">, number> = {
  /** Text + research (markdown/HTML article). */
  blog_article: 10,
  /** Text + research + HTML render (dark/light variants). */
  newsletter_issue: 10,
  /** Research + per-post VISUAL generation — media-heavy. */
  social_post: 15,
  /** Heaviest: full page build with brand kit + static build (~15–30 min). */
  landing_page: 20,
} as const;

/**
 * Resolve what one task execution costs given the product that will actually
 * run it. No product (in-process generic path) or "custom" (custom agents
 * have their own per-agent pricing) ⇒ the flat baseline.
 */
export function taskExecutionCost(productType?: ManagedTaskType | null): number {
  if (!productType || productType === "custom") return CREDIT_COSTS.taskExecution;
  return TASK_EXECUTION_COSTS[productType] ?? CREDIT_COSTS.taskExecution;
}

/** Applied to new clients on their first charge/grant (lazy doc creation). */
export const CREDIT_DEFAULTS = {
  startingBalance: 200,
  /** Default weekly spend cap; null would mean uncapped. */
  weeklyLimit: 150,
  /** Default monthly spend cap; null would mean uncapped. */
  monthlyLimit: 400,
} as const;

/* ── Spend windows ───────────────────────────────────────────────── */

/**
 * ISO-8601 week key of a timestamp, UTC — e.g. "2026-W28".
 * Weekly caps reset when the key rolls over (Monday 00:00 UTC).
 */
export function creditWeekKey(ts: number): string {
  // ISO week: shift to the Thursday of the current week, whose year is the ISO year.
  const d = new Date(ts);
  const day = d.getUTCDay() || 7; // Mon=1 … Sun=7
  const thursday = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + (4 - day));
  const isoYear = new Date(thursday).getUTCFullYear();
  const yearStart = Date.UTC(isoYear, 0, 1);
  const week = Math.ceil(((thursday - yearStart) / 86_400_000 + 1) / 7);
  return `${isoYear}-W${String(week).padStart(2, "0")}`;
}

/** Calendar-month key of a timestamp, UTC — e.g. "2026-07". Monthly caps reset on the 1st. */
export function creditMonthKey(ts: number): string {
  const d = new Date(ts);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** Fresh credits doc for a client that has never been charged or granted. */
export function defaultClientCredits(clientId: string, now: number): ClientCredits {
  return {
    clientId,
    balance: CREDIT_DEFAULTS.startingBalance,
    weeklyLimit: CREDIT_DEFAULTS.weeklyLimit,
    monthlyLimit: CREDIT_DEFAULTS.monthlyLimit,
    weekKey: creditWeekKey(now),
    weekSpent: 0,
    monthKey: creditMonthKey(now),
    monthSpent: 0,
    updatedAt: now,
  };
}

/** Reset week/month spend counters whose window key has rolled over. */
export function rollCreditWindows(credits: ClientCredits, now: number): ClientCredits {
  const weekKey = creditWeekKey(now);
  const monthKey = creditMonthKey(now);
  if (weekKey === credits.weekKey && monthKey === credits.monthKey) return credits;
  return {
    ...credits,
    weekKey,
    weekSpent: weekKey === credits.weekKey ? credits.weekSpent : 0,
    monthKey,
    monthSpent: monthKey === credits.monthKey ? credits.monthSpent : 0,
  };
}

/* ── Charge / credit assessment ──────────────────────────────────── */

export type CreditDenialCode = "insufficient_balance" | "weekly_limit" | "monthly_limit";

/**
 * The opening words of each denial message, one per code. assessCharge builds
 * its messages from these, so anywhere that has only the stored string — the
 * scheduler writes a refusal, not a code — can still tell a real credit denial
 * from an arbitrary error by an exact prefix rather than a keyword guess. A
 * loose /credit|limit|cap/ test would pass e.g. a GCP "Quota exceeded … limit"
 * string straight through to a client card.
 */
export const CREDIT_DENIAL_PREFIX: Record<CreditDenialCode, string> = {
  insufficient_balance: "Not enough credits - this action costs",
  weekly_limit: "Weekly credit limit reached (",
  monthly_limit: "Monthly credit limit reached (",
};

/** True when `message` is one of the three assessCharge denials, verbatim. */
export function isCreditDenialMessage(message: string): boolean {
  return Object.values(CREDIT_DENIAL_PREFIX).some((prefix) => message.startsWith(prefix));
}

/**
 * One short line per denial code, for PRE-flight UI (a disabled Run button)
 * rather than the post-failure denial above. Each names the reset that actually
 * unblocks it: a weekly or monthly cap is not fixed by a top-up, so telling a
 * capped client to ask for more credits is worse than saying nothing.
 */
export const CREDIT_BLOCK_REASON: Record<CreditDenialCode, string> = {
  insufficient_balance: "Not enough credits — ask your Karos team for a top-up.",
  weekly_limit: "Weekly limit reached — resets Monday.",
  monthly_limit: "Monthly limit reached — resets on the 1st.",
};

/**
 * Which limit the server would cite when refusing a charge of `cost` — so the
 * pre-flight line names the SAME limit the eventual denial does.
 *
 * This mirrors assessCharge's ladder EXACTLY: it is not an argmin over the
 * three remaining balances but the first of them, in the server's own order,
 * that `cost` does not fit under. Order matters — with balance=5, weekLeft=2,
 * monthLeft=400 and cost=10 the argmin (weekLeft) says "weekly", but the server
 * refuses on the balance first, so a "resets Monday" line would send the client
 * to wait a week for a block a top-up fixes. `cost` is required for the same
 * reason: whether the weekly cap binds before the balance depends on it.
 */
export function bindingCreditLimit(
  credits: ClientCredits,
  cost: number,
  now?: number,
): CreditDenialCode {
  const rolled = now != null ? rollCreditWindows(credits, now) : credits;
  // Same predicates as assessCharge, same sequence (balance → weekly → monthly).
  if (rolled.balance < cost) return "insufficient_balance";
  if (rolled.weeklyLimit != null && rolled.weekSpent + cost > rolled.weeklyLimit) {
    return "weekly_limit";
  }
  if (rolled.monthlyLimit != null && rolled.monthSpent + cost > rolled.monthlyLimit) {
    return "monthly_limit";
  }
  // Nothing binds at this cost — callers only surface a reason once spend is
  // already blocked, so this is a safe default rather than a reachable state.
  return "insufficient_balance";
}

/** The line to show beside a run control that a charge of `cost` has blocked. */
export function creditBlockReason(credits: ClientCredits, cost: number, now?: number): string {
  return CREDIT_BLOCK_REASON[bindingCreditLimit(credits, cost, now)];
}

/**
 * Thrown by the data layer when a charge is denied. `message` is written for
 * the client user; callers surface it verbatim (job error, 402 body, {error}).
 */
export class CreditError extends Error {
  readonly code: CreditDenialCode;
  constructor(code: CreditDenialCode, message: string) {
    super(message);
    this.name = "CreditError";
    this.code = code;
  }
}

export type ChargeAssessment =
  | { ok: true; next: ClientCredits }
  | { ok: false; code: CreditDenialCode; message: string };

/**
 * Pure charge evaluation: rolls spend windows, then checks balance and the
 * weekly/monthly caps. Returns the updated doc or a denial with a
 * client-readable message. The Firestore transaction persists `next` verbatim.
 */
export function assessCharge(
  current: ClientCredits,
  amount: number,
  now: number,
): ChargeAssessment {
  const rolled = rollCreditWindows(current, now);
  if (amount <= 0) return { ok: true, next: { ...rolled, updatedAt: now } };

  if (rolled.balance < amount) {
    return {
      ok: false,
      code: "insufficient_balance",
      message:
        `${CREDIT_DENIAL_PREFIX.insufficient_balance} ${amount} credit${amount === 1 ? "" : "s"} and ` +
        `${rolled.balance} ${rolled.balance === 1 ? "is" : "are"} left. Ask your Karos team for a top-up.`,
    };
  }
  if (rolled.weeklyLimit != null && rolled.weekSpent + amount > rolled.weeklyLimit) {
    return {
      ok: false,
      code: "weekly_limit",
      message:
        `${CREDIT_DENIAL_PREFIX.weekly_limit}${rolled.weekSpent} of ${rolled.weeklyLimit} used). ` +
        `It resets on Monday - or ask your Karos team to raise the limit.`,
    };
  }
  if (rolled.monthlyLimit != null && rolled.monthSpent + amount > rolled.monthlyLimit) {
    return {
      ok: false,
      code: "monthly_limit",
      message:
        `${CREDIT_DENIAL_PREFIX.monthly_limit}${rolled.monthSpent} of ${rolled.monthlyLimit} used). ` +
        `It resets on the 1st - or ask your Karos team to raise the limit.`,
    };
  }
  return {
    ok: true,
    next: {
      ...rolled,
      balance: rolled.balance - amount,
      weekSpent: rolled.weekSpent + amount,
      monthSpent: rolled.monthSpent + amount,
      updatedAt: now,
    },
  };
}

/**
 * Pure balance credit: grants and adjustments just move the balance; refunds
 * also hand back window spend so a failed run doesn't eat the weekly cap.
 * `amount` may be negative only for kind="adjustment" (admin correction).
 *
 * `chargedAt` (refunds only) is when the original charge happened — spend is
 * handed back only to windows the charge actually accrued in, so a refund
 * landing after a week/month rollover doesn't erase the new window's spend.
 */
export function applyCredit(
  current: ClientCredits,
  amount: number,
  kind: "grant" | "refund" | "adjustment",
  now: number,
  chargedAt?: number,
): ClientCredits {
  const rolled = rollCreditWindows(current, now);
  const next: ClientCredits = { ...rolled, balance: rolled.balance + amount, updatedAt: now };
  if (kind === "refund") {
    const at = chargedAt ?? now;
    if (creditWeekKey(at) === rolled.weekKey) {
      next.weekSpent = Math.max(0, rolled.weekSpent - amount);
    }
    if (creditMonthKey(at) === rolled.monthKey) {
      next.monthSpent = Math.max(0, rolled.monthSpent - amount);
    }
  }
  return next;
}

/**
 * Credits actually spendable right now: the balance clipped by whatever
 * remains under the weekly/monthly caps. Use for pre-flight UI gates so a
 * capped-out client isn't shown a green Run button that will be denied.
 * Omit `now` when the doc's windows are already current (e.g. it came from
 * getClientCredits, which rolls them on read).
 */
export function availableCredits(credits: ClientCredits, now?: number): number {
  const rolled = now != null ? rollCreditWindows(credits, now) : credits;
  const weekLeft = rolled.weeklyLimit != null ? rolled.weeklyLimit - rolled.weekSpent : Infinity;
  const monthLeft = rolled.monthlyLimit != null ? rolled.monthlyLimit - rolled.monthSpent : Infinity;
  return Math.max(0, Math.min(rolled.balance, weekLeft, monthLeft));
}
