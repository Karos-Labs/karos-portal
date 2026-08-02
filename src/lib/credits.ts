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

import type {
  AppUser,
  ClientCredits,
  CreditOperation,
  JobRunType,
  ManagedTaskType,
} from "@/lib/types";

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

/* ── Client-facing price copy ────────────────────────────────────── */

/**
 * "1 credit" / "5 credits" — a credit price, pluralised off its own number.
 *
 * PLURALISED BECAUSE THE NUMBER MOVES. `audience-simulation.tsx` built
 * "N credits" unconditionally, so a reprice of `taskExecution` to 1 would have
 * shown every client "Each run costs 1 credits." — and its test asserted
 * equality with the same constant, so it would have stayed green through the
 * bug. The webhook's refund events already pluralise this way
 * (`credit${amount === 1 ? "" : "s"}`); this is that shape, in one place, so the
 * surfaces below cannot each get it right or wrong separately.
 *
 * SCOPE, so this is not read as more than it is: it is the spelling used by the
 * callers that call it. Other surfaces still assemble the phrase inline — the
 * webhook's two event strings among them — and this function does not reach
 * them. `grep -rn "} credits" src` is the sweep.
 *
 * Never "tokens": that word is already claimed by PATs and LLM token counts.
 */
export function creditsLabel(amount: number): string {
  return `${amount} credit${amount === 1 ? "" : "s"}`;
}

/**
 * What ONE PRESS of a metered control costs the reader looking at it, or null
 * when it costs them nothing.
 *
 * `viewerIsBilled` is meant to be `isBillableClientActor()` for the session that
 * will do the pressing, so that a viewer who is never charged is quoted NO price
 * rather than a wrong one — the same gate the agent run dialog's own "Costs N
 * credits." line uses. It has to be resolved on the server and passed down: a
 * client component cannot ask who is signed in.
 *
 * TWO OF THREE CALLERS PASS THAT; `simulationPrice` DOES NOT, and the docstring
 * used to claim otherwise. `taskMapRefreshPrice` and `insightsRefreshPrice` are
 * handed `isBillableClientActor(user)` from a server component.
 * `simulationPrice`'s one caller (audience-simulation.tsx) is four prop-hops
 * below its server pages — AssetDetailModal ← run-calendar / archive-view /
 * clip-gallery / outputs-hub — and receives only `viewerIsClient`, which every
 * mount derives from a ROLE test. Both are booleans, so nothing catches the
 * swap.
 *
 * WHAT THAT COSTS TODAY: an admin in "View as Client" reads "Each run costs 5
 * credits." for a press that charges them nothing. It is stated here rather than
 * papered over, and it has no client-facing direction — no billed actor is ever
 * left un-quoted, and no client is shown a price they will not pay. Whether
 * View-as-Client SHOULD quote the client's price (it is a preview of the
 * client's screen, so arguably yes) or nothing (matching the other two) is a
 * product call, not one to settle inside a helper — so the prop stays honestly
 * named and the divergence is written down.
 *
 * Module-private: the three named quotes below are the surface, and exporting a
 * fourth, un-called way to spell a price would be a shared rule nothing asks.
 */
function pressPrice(amount: number, viewerIsBilled: boolean): string | null {
  return viewerIsBilled ? creditsLabel(amount) : null;
}

/**
 * The three previously-free surfaces a client presses that now charge on press,
 * each quoted from THE SAME CONSTANT ITS SERVER ROUTE CHARGES FROM. That
 * pairing is the whole point of these living here rather than at the controls:
 * a reprice moves the constant, and the quote moves with it.
 *
 * An unannounced charge is worse than an unmetered one — the client learns the
 * price from their balance — so each of the three announces at its control.
 */

/** One Audience Simulation press · POST /api/clients/[id]/simulate. */
export function simulationPrice(viewerIsBilled: boolean): string | null {
  return pressPrice(CREDIT_COSTS.taskExecution, viewerIsBilled);
}

/** One copilot "Refresh Task Map" press · GET /api/tasks/generate-swarm. */
export function taskMapRefreshPrice(viewerIsBilled: boolean): string | null {
  return pressPrice(CREDIT_COSTS.taskExecution, viewerIsBilled);
}

/** One AI Insights "Refresh" press · GET /api/clients/[id]/insights?force=1. */
export function insightsRefreshPrice(viewerIsBilled: boolean): string | null {
  return pressPrice(CREDIT_COSTS.chatMessage, viewerIsBilled);
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
    reason: `You've reached your plan's ${args.seatLimit}-seat limit. Adding another employee seat is a one-time ${cost}-credit charge. Top up credits or upgrade your plan to continue.`,
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

/* ── The rate card ───────────────────────────────────────────────── */

/**
 * One row of the price list a client reads.
 *
 * `credits` is null ONLY where this module has no constant to quote, which
 * today is the one-time agent setup charge: its price is per agent
 * (`CustomAgent.launchCreditCost`) and there is deliberately NO default, so a
 * null here means "ask the agent", never "free". `note` says where the real
 * figure is; nothing in this file may fill one in.
 */
export interface ClientPriceRow {
  /** Sentence case, the client's word for the thing being bought. */
  label: string;
  /** Credits per unit, or null when the price is per agent (see above). */
  credits: number | null;
  /** The number is a FLOOR — a per-agent override can sit above it. */
  from?: boolean;
  /** Short parenthetical: what makes this charge unusual, or where its real price lives. */
  note?: string;
}

/**
 * THE price list — the two surfaces that quote the WHOLE list both render this
 * array: the client's rate card (components/credits-panel.tsx) and the
 * copilot's system prompt (api/clients/[id]/chat). They each kept their own
 * copy until 2026-08-01 and both left the SAME entry out: `agent_launch`, the
 * one-time agent setup charge, which is the largest single thing a client is
 * billed for. The copilot's block ends with "never invent credit figures beyond
 * these", so with setup missing it answered a setup question with the per-run
 * price or not at all. Two lists could each be completed; one list can only be
 * completed once.
 *
 * SCOPE, so this is not read as more than it is. It is the list, not every
 * quote: individual controls still price themselves at the point of the press
 * (the three pressPrice helpers above, the run dialog's "Costs N credits", the
 * launch card's one-time figure, the panel's own three-item teaser). Those quote
 * ONE price each, from these same constants, and this array does not reach them.
 *
 * WHAT A ROW IS: a priced unit, not a ledger operation. The small in-app AI
 * helpers (audience simulation, task map refresh, insights refresh, company
 * description, X account suggestions) all bill `ai_tool` at a rate that already
 * appears here, so they add charges rather than prices — and that is not left to
 * a reader's word: credit-attribution.test.ts asserts every CREDIT_COSTS rate is
 * quoted somewhere on this list, so a reprice that strands one fails.
 *
 * Every number is read off the constants above, so a reprice moves the card and
 * the copilot together and neither can quote a stale figure. The one row with
 * no number says so — see ClientPriceRow.
 */
export const CLIENT_PRICE_ROWS: readonly ClientPriceRow[] = [
  { label: "Copilot message", credits: CREDIT_COSTS.chatMessage },
  { label: "Correct one document", credits: CREDIT_COSTS.targetedCorrection },
  { label: "Correct every document", credits: CREDIT_COSTS.globalCorrection },
  {
    label: "Agent setup",
    credits: null,
    // Reads in both registers, which is the point of one list: on the card it
    // sits in brackets after the label, and in the copilot's prompt it is the
    // whole of what the model may say about a figure it has not been given.
    // "per agent" is deliberately not repeated from the price cell.
    note: "one-time, when an agent is first set up for you. Its own page shows the price",
  },
  {
    label: "Agent run",
    credits: CREDIT_COSTS.customAgentRun,
    from: true,
    note: "each agent shows its own price",
  },
  { label: "Blog article", credits: TASK_EXECUTION_COSTS.blog_article },
  { label: "Newsletter issue", credits: TASK_EXECUTION_COSTS.newsletter_issue },
  { label: "Social posts", credits: TASK_EXECUTION_COSTS.social_post },
  { label: "Landing page", credits: TASK_EXECUTION_COSTS.landing_page },
  { label: "Other task execution", credits: CREDIT_COSTS.taskExecution },
  {
    label: "Extra LinkedIn seat",
    credits: CREDIT_COSTS.employeeSeat,
    note: "one-time, beyond your plan's seats",
  },
];

/** What a priced-per-agent row prints instead of a number. */
const PER_AGENT_PRICE = "set per agent";

/**
 * The price side of a rate-card row, spelled once so the two surfaces cannot
 * disagree about how a floor or a per-agent price reads.
 *
 * `withUnit` adds the word "credits" for prose readers (the copilot prompt);
 * the card's price column leaves it off because its own heading already says
 * credits. Both branches go through the same three cases, which is the point.
 */
export function clientPriceText(row: ClientPriceRow, opts?: { withUnit?: boolean }): string {
  if (row.credits == null) return PER_AGENT_PRICE;
  const amount = opts?.withUnit ? creditsLabel(row.credits) : String(row.credits);
  return row.from ? `from ${amount}` : amount;
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
  insufficient_balance: "Not enough credits. This action costs",
  weekly_limit: "Weekly credit limit reached (",
  monthly_limit: "Monthly credit limit reached (",
};

/**
 * A denial's clause separator, flattened away entirely, so that a message
 * MINTED UNDER ANY PAST HOUSE STYLE still reads as a credit denial.
 *
 * There have been three. The line carried a spaced hyphen until 2026-07-31,
 * an em dash until 2026-08-03, and a period since (AF-8: "Why is there an M
 * dash? We don't use those"). These messages are STORED as well as returned —
 * the scheduler writes its refusal into the agent row's lastError — so rows
 * written under all three spellings are in the database right now. If this
 * stops recognising them, clientSafeRefusal collapses the one refusal a client
 * is MEANT to read into the generic paraphrase.
 *
 * Hence separator-agnostic rather than "normalise to the current spelling":
 * both sides are reduced to the words, which is the part that has not changed
 * and the part the prefix match is actually about. Case is folded with them,
 * because the word after the separator was lowercase under the dash spellings
 * and is capitalised under this one.
 */
function denialKey(text: string): string {
  return text
    .replace(/\s*[-–—]\s+/g, " ")
    .replace(/\.\s+/g, " ")
    .toLowerCase();
}

/** True when `message` is one of the three assessCharge denials, verbatim. */
export function isCreditDenialMessage(message: string): boolean {
  const normalized = denialKey(message);
  return Object.values(CREDIT_DENIAL_PREFIX).some((prefix) =>
    normalized.startsWith(denialKey(prefix)),
  );
}

/**
 * One short line per denial code, for PRE-flight UI (a disabled Run button)
 * rather than the post-failure denial above. Each names the reset that actually
 * unblocks it: a weekly or monthly cap is not fixed by a top-up, so telling a
 * capped client to ask for more credits is worse than saying nothing.
 */
/**
 * When each capped window unblocks itself, as a clause. CREDIT_BLOCK_REASON is
 * composed from these so a meter's reset note and the denial line beside a dead
 * Run button cannot drift apart: there is one sentence about when a cap lifts,
 * and both surfaces render it. Windows roll at 00:00 UTC (creditWeekKey is an
 * ISO week, creditMonthKey a calendar month), so the day is fixed, not computed.
 */
export const CREDIT_WINDOW_RESET = {
  weekly_limit: "resets Monday",
  monthly_limit: "resets on the 1st",
} as const;

export const CREDIT_BLOCK_REASON: Record<CreditDenialCode, string> = {
  insufficient_balance: "Not enough credits. Ask your Karos team for a top-up.",
  weekly_limit: `Weekly limit reached, ${CREDIT_WINDOW_RESET.weekly_limit}.`,
  monthly_limit: `Monthly limit reached, ${CREDIT_WINDOW_RESET.monthly_limit}.`,
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
        `${CREDIT_DENIAL_PREFIX.insufficient_balance} ${creditsLabel(amount)} and ` +
        `${rolled.balance} ${rolled.balance === 1 ? "is" : "are"} left. Ask your Karos team for a top-up.`,
    };
  }
  if (rolled.weeklyLimit != null && rolled.weekSpent + amount > rolled.weeklyLimit) {
    return {
      ok: false,
      code: "weekly_limit",
      message:
        `${CREDIT_DENIAL_PREFIX.weekly_limit}${rolled.weekSpent} of ${rolled.weeklyLimit} used). ` +
        `It resets on Monday, or ask your Karos team to raise the limit.`,
    };
  }
  if (rolled.monthlyLimit != null && rolled.monthSpent + amount > rolled.monthlyLimit) {
    return {
      ok: false,
      code: "monthly_limit",
      message:
        `${CREDIT_DENIAL_PREFIX.monthly_limit}${rolled.monthSpent} of ${rolled.monthlyLimit} used). ` +
        `It resets on the 1st, or ask your Karos team to raise the limit.`,
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

/* ── Ledger presentation (§6.2) ───────────────────────────────────── */

/**
 * Human label per ledger operation.
 *
 * Ledger rows have always rendered their free-text `reason`, which is composed
 * at each charge site ("Agent setup · Instagram Agent", "Task execution · …").
 * That reads fine one row at a time and is useless for grouping: two charges of
 * the same kind can carry different prose, so nothing can bucket spend without
 * re-parsing English. These labels are the stable name of the KIND, which is
 * what a breakdown groups by; the reason line stays as the detail beneath it.
 */
export const CREDIT_OPERATION_LABEL: Record<CreditOperation, string> = {
  agent_run: "Agent runs",
  chat_message: "Copilot",
  task_execution: "Task runs",
  doc_correction: "Document corrections",
  custom_agent_run: "Agent runs",
  agent_launch: "Setup",
  seat_purchase: "Seats",
  ai_tool: "AI tools",
  manual: "Adjustments",
};

/**
 * The bucket a charge belongs to in the per-agent breakdown (§6.2a).
 *
 * `custom_agent_run` covers both a schedule firing and a client pressing Run,
 * and the two are worth telling apart — one is the pace they chose, the other
 * is spend they initiated. The job's `runType` is what separates them, so a row
 * whose job has been deleted (or predates run-type stamping) honestly falls
 * back to the undifferentiated "Agent runs" rather than guessing.
 *
 * "UNDIFFERENTIATED" AND "NOT A RUN AT ALL" ARE TWO ANSWERS, and collapsing
 * them into one `other` bucket is what made a whole client's breakdown read
 * "Other usage". runType is stamped only by callers that pass it, so every run
 * fired before it existed — and every run through the scheduler core that still
 * does not pass it — lands here; telling a client that the twelve agent runs
 * they paid for were "other usage" is less true than saying they were runs
 * whose kind we did not record. `other` now means what its label says: spend
 * that is not an agent run (copilot, task executions, corrections, seats).
 */
export type CreditBucket = "setup" | "scheduled" | "manual" | "runs" | "other";

export function creditBucketFor(
  operation: CreditOperation,
  runType?: JobRunType | null,
): CreditBucket {
  if (operation === "agent_launch") return "setup";
  if (operation === "custom_agent_run" || operation === "agent_run") {
    if (runType === "scheduled") return "scheduled";
    if (runType === "manual_template" || runType === "manual") return "manual";
    return "runs";
  }
  return "other";
}

export const CREDIT_BUCKET_LABEL: Record<CreditBucket, string> = {
  setup: "Setup",
  scheduled: "Scheduled runs",
  manual: "Runs you started",
  // NOT "Agent runs". Sitting in the same row as "Scheduled runs" and "Runs you
  // started" it reads as their TOTAL, not as the residual — so a client seeing
  // Scheduled 25 · Started 25 · Agent runs 50 naturally reads 25+25 inside the
  // 50, and the row looks like it double-counts and fails to add up. The bucket
  // split is right; the WORD was more general than the data it labels, which is
  // an over-broad label — the same defect as an over-specific one, pointed the
  // other way. This says what is actually known: a run whose kind was not
  // recorded.
  runs: "Runs (kind not recorded)",
  other: "Other usage",
};
