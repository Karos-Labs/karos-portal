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

import type { AppUser, ClientCredits } from "@/lib/types";

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
  /** One karos_managed task execution (also adjustment re-runs + autopilot items). */
  taskExecution: 5,
  /** Targeted correction of a single context document. */
  targetedCorrection: 2,
  /** Global correction — rewrites every context doc for the client. */
  globalCorrection: 15,
  /** Small Haiku task helpers: AI execution plan, custom-task classification. */
  taskAssist: 1,
} as const;

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
        `Not enough credits — this action costs ${amount} credit${amount === 1 ? "" : "s"} and ` +
        `${rolled.balance} ${rolled.balance === 1 ? "is" : "are"} left. Ask your Karos team for a top-up.`,
    };
  }
  if (rolled.weeklyLimit != null && rolled.weekSpent + amount > rolled.weeklyLimit) {
    return {
      ok: false,
      code: "weekly_limit",
      message:
        `Weekly credit limit reached (${rolled.weekSpent} of ${rolled.weeklyLimit} used). ` +
        `It resets on Monday — or ask your Karos team to raise the limit.`,
    };
  }
  if (rolled.monthlyLimit != null && rolled.monthSpent + amount > rolled.monthlyLimit) {
    return {
      ok: false,
      code: "monthly_limit",
      message:
        `Monthly credit limit reached (${rolled.monthSpent} of ${rolled.monthlyLimit} used). ` +
        `It resets on the 1st — or ask your Karos team to raise the limit.`,
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
