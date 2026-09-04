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
import type { ProviderId } from "@/lib/models/usage-log";
import type { ChatModelKey } from "@/lib/ai/chat-models";

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

/* ── What a credit IS (credits rework, 2026-09) ───────────────────── */

/**
 * THE KILL SWITCH FOR THE WHOLE REWORK. Off unless `CREDITS_PLAN_V2_ENABLED=1`.
 *
 * WHY A FLAG AT ALL, when the maths is tested and the invariants hold: this
 * change moves real money in a live database, and local development points at
 * production Firestore. Nothing here is a schema migration that can be rolled
 * back with a deploy — a settlement writes a ledger row and moves a balance, and
 * `rollCreditWindows` tops a client up to 2600 the first time anybody so much as
 * READS their credits doc in a new month. Shipping that implicitly, on a merge,
 * is not a decision anyone gets to take back. So it ships dark and is turned on
 * deliberately, per environment, the same way `RUNWAY_AUTOGEN_ENABLED` and
 * `TASKMAP_AUTOGEN_ENABLED` already gate their own irreversible sweeps.
 *
 * WHAT "OFF" MEANS, precisely — the pre-rework product, with no residue. Every
 * WRITE this rework introduced is behind the flag, not merely every charge:
 *   - `creditDefaults()` returns the old 200/150/400, and `rollCreditWindows`
 *     neither migrates a doc's caps nor tops a balance up;
 *   - `settleJobCharge` / `settleChargeEntry` return without writing anything,
 *     so no ledger row of kind `"settlement"` can exist;
 *   - the reconcile route runs neither the unsettled-hold LISTING nor the
 *     `holdSettledAt` bookmark — bookmarking while dark would mark every
 *     delivered job "decided" before a single settlement could run, so flipping
 *     the flag on later would find an empty candidate set;
 *   - `chargeClientCredits` does not stamp `phase: "hold"`, and
 *     `stampChargeSettlesJob` does not stamp `settlesJobId`: nothing will settle
 *     those rows, so labelling them would be a claim the ledger cannot keep;
 *   - `estimateAgentRunCredits` returns the constant, so the hold is the price
 *     it has always been;
 *   - every price surface says "Costs N credits", with no hedge, and the staff
 *     cost-to-us block is not rendered or even sent to the browser.
 * The one thing that still happens under OFF is the agent-engine run cost being
 * persisted onto the job (and logged as usage). That is a MEASUREMENT — it
 * charges nobody, it closes the telemetry gap the rework needs whether or not
 * the rework is on, and having it already collected is what makes flipping the
 * flag an informed decision rather than a blind one.
 *
 * SERVER-READ ONLY, deliberately NOT `NEXT_PUBLIC_`. A public flag is baked
 * into the client bundle and cannot be flipped without a rebuild, which defeats
 * the point of a switch you might need to throw in a hurry. In a client
 * component `process.env.CREDITS_PLAN_V2_ENABLED` compiles to `undefined`, so
 * this would silently read OFF there and disagree with the server that rendered
 * the page — a hydration mismatch on a price. Client components therefore take
 * the answer as a BOOLEAN PROP threaded from their server page, never by calling
 * this. `credits.ts` stays client-safe because reading a missing `process.env`
 * key is not an error; calling this from the browser is just always false.
 */
export function isCreditsPlanV2Enabled(): boolean {
  return process.env.CREDITS_PLAN_V2_ENABLED === "1";
}

/**
 * Our own cost, in USD, that ONE credit recovers.
 *
 * THE RULING, and the arithmetic that pins it: a client account gets 2600
 * credits a month, and a month of 2600 credits must never cost Karos more than
 * $130. $130 ÷ 2600 = $0.05. There is no third number to choose — fix any two
 * of {allowance, ceiling, price} and the third follows — which is why this
 * constant is written as the quotient it is rather than as a rate someone
 * picked.
 *
 * This is what a credit COSTS US, not what it sells for. Margin is a
 * commercial decision made where the plan is priced; it is deliberately not
 * modelled here, because the guarantee this module has to keep is a spend
 * ceiling, and a ceiling has to be measured in the currency the spend happens
 * in.
 */
export const USD_PER_CREDIT = 0.05;

/**
 * Credits per USD of our own cost — the inverse of `USD_PER_CREDIT`, spelled
 * out because it is the multiple every settlement applies and a reader should
 * not have to divide by 0.05 in their head to check a ledger row. Pinned equal
 * to `1 / USD_PER_CREDIT` by credits.test.ts so the pair cannot drift.
 */
export const CREDITS_PER_USD = 20;

/**
 * One client account's monthly credit allowance. `MONTHLY_ALLOWANCE ×
 * USD_PER_CREDIT` is the $130 line, and credits.test.ts asserts that product
 * outright so the ceiling lives in code rather than in a ticket.
 *
 * It is BOTH the monthly cap and the monthly top-up target (see
 * `CREDIT_DEFAULTS` and `rollCreditWindows`): a cap alone would let a client
 * run out permanently, and a top-up alone would let a rollover balance spend
 * past $130 in one month. Together they say "2600 a month, every month,
 * neither more nor stockpiled".
 */
export const MONTHLY_ALLOWANCE = 2600;

/**
 * The floor on a settled run. `Math.ceil` already floors any non-zero cost at
 * 1, so this is really a statement about ZERO: a run we have no cost for is a
 * telemetry gap, not a free run, and the settlement path refuses to settle it
 * at all rather than settling it to nothing.
 */
export const MIN_SETTLED_CREDITS = 1;

/**
 * A settlement may not deduct more than this multiple of the estimate that was
 * held. One runaway run must not eat a client's month before anybody has
 * looked at it: past the cap we settle AT the cap, record the uncapped figure
 * on the ledger row and flag it (`settlementCapped`) for staff. The estimate
 * is self-calibrating (`estimateRunCredits`), so a product that keeps hitting
 * the cap re-prices itself upward within ten runs rather than staying capped
 * forever.
 */
export const SETTLEMENT_CAP_FACTOR = 2;

/**
 * Operations whose price is a MONETIZATION decision rather than a measure of
 * compute, and which therefore never settle against actual USD.
 *
 * - `seat_purchase` (`CREDIT_COSTS.employeeSeat`) buys a LinkedIn
 *   employee-advocacy seat. No model call happens; settling it would refund
 *   ~100 credits against $0 of tokens that were never spent.
 * - `agent_launch` keeps its admin-set price, which `calibrateLaunchPrice`
 *   already derives from a MEASURED cross-client USD ratio. Settling a setup
 *   per-run would replace one deliberate number with a per-client lottery —
 *   one client's unlucky setup costing 3× another's for the same product.
 * - `manual` is an admin grant/deduction. There is no run to measure.
 *
 * Everything else settles, including the small in-app actions: a copilot turn,
 * a Task Map refresh and an audience simulation all cost real tokens, and the
 * 1-credit floor is what keeps the cheapest of them from settling to nothing.
 */
export const UNSETTLED_OPERATIONS: ReadonlySet<CreditOperation> = new Set<CreditOperation>([
  "seat_purchase",
  "agent_launch",
  "manual",
]);

/**
 * Credits for a measured USD cost: `ceil(usd × 20)`, floored at one credit.
 *
 * THE ONLY PLACE THIS MULTIPLICATION HAPPENS. A second site computing
 * `usd * 20` inline is how a rounding rule quietly becomes two rounding rules,
 * so credit-attribution.test.ts source-scans for one.
 *
 * Rounds UP, deliberately and in Karos's favour by at most $0.05: the ceiling
 * this module guarantees is on OUR cost, and a floor would let a thousand
 * sub-cent actions accumulate real spend against zero credits.
 *
 * A non-finite or non-positive cost returns the floor rather than 0. Callers
 * must not reach here with "cost unknown" at all — see `settlementFor`, which
 * refuses that case outright — but if one does, charging the floor is the
 * honest failure and refunding the whole hold is not.
 */
export function creditsForUsd(usd: number): number {
  if (!Number.isFinite(usd) || usd <= 0) return MIN_SETTLED_CREDITS;
  return Math.max(MIN_SETTLED_CREDITS, Math.ceil(usd * CREDITS_PER_USD));
}

/** What a settlement resolved to, and whether the cap had to hold it back. */
export interface Settlement {
  /** Credits the run should have cost — what the client ends up charged. */
  credits: number;
  /** hold − credits. Positive hands credits back; negative takes more. */
  delta: number;
  /** True when `creditsForUsd(actualUsd)` exceeded the 2× cap and was clipped. */
  capped: boolean;
  /** The uncapped figure, recorded even when capped so staff see the real number. */
  uncappedCredits: number;
}

/**
 * Resolve one hold against what the run actually cost us.
 *
 * Pure and total: the caller decides WHETHER to settle (operation exempt?
 * charge already refunded? cost telemetry missing?) and this decides what the
 * settlement IS. Keeping the two apart is what lets the arithmetic be unit
 * tested without a Firestore fake anywhere near it.
 */
export function settlementFor(hold: number, actualUsd: number): Settlement {
  const uncappedCredits = creditsForUsd(actualUsd);
  const ceiling = Math.max(MIN_SETTLED_CREDITS, hold * SETTLEMENT_CAP_FACTOR);
  const credits = Math.min(uncappedCredits, ceiling);
  return { credits, delta: hold - credits, capped: uncappedCredits > ceiling, uncappedCredits };
}

/**
 * Flat credit prices per client-triggered AI action.
 *
 * THESE ARE ESTIMATES NOW (credits rework, 2026-09), and that is a change of
 * meaning rather than of value. Each still prices its action at dispatch — the
 * HOLD — and each is still the number a client is quoted before they press.
 * What changed is what happens after: the run reports what it cost us, and
 * `settlementFor` reconciles the hold to `ceil(actualUsd × 20)`. So a number
 * here is a starting quote and a fallback for a product with no measured
 * history, never the final word on a bill.
 *
 * They are kept as the FALLBACK rung of `estimateRunCredits`'s ladder rather
 * than deleted: a client running an agent for the first time has no median to
 * quote, and quoting nothing is worse than quoting the figure that has been
 * roughly right all year. Scaled to relative real cost (1 credit ≈ one
 * Haiku-sized call): a Sonnet task execution burns ~5× a chat message; a
 * global doc correction rewrites every context doc (~13 Sonnet calls) so it
 * costs 3× a task execution.
 */
export const CREDIT_COSTS = {
  /**
   * One copilot chat message on the default (Haiku) tier — the by-far-most-
   * common case: a quick Q&A turn. A `deep` turn (Sonnet, multi-step tool
   * orchestration — the copilot's three substantive proactive actions opt
   * into it) costs more: see `CHAT_MESSAGE_CREDITS` / `chatMessageCreditCost()`
   * below, which the chat route resolves through — always resolve through
   * that, never charge this flat rate for a `deep` turn. (This constant used
   * to be charged for every turn regardless of model — T-B23.)
   */
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

/* ── Per-model chat pricing (T-B23) ──────────────────────────────── */

/**
 * The two Claude tiers the copilot can actually run one turn on today — the
 * `deep` flag on the chat route's request body (a quick Q&A turn vs the three
 * substantive proactive actions that opt into multi-step tool orchestration).
 *
 * NOT `ModelTier` from `@/lib/ai/roles`: that type also carries `"caller"`,
 * which this file has no business modelling (a price table has nothing to
 * charge a caller-chosen tier that isn't one of these two), and it is a
 * Claude-only vocabulary — a model this table might one day price is not a
 * Sonnet/Haiku tier at all.
 */
export type ChatModel = "haiku" | "sonnet" | "gemini-flash";

/**
 * Per-model credit price for one copilot chat message.
 *
 * REPLACES A PRICE THAT DID NOT MOVE WITH THE MODEL. `CREDIT_COSTS.chatMessage`
 * has priced every copilot turn identically since before the chat route could
 * run on two different models — `deep` (Sonnet, multi-step tool
 * orchestration) was added later with no second price, so an in-depth Sonnet
 * turn and a one-line Haiku answer have always cost a client the same 1
 * credit. `haiku` here IS `CREDIT_COSTS.chatMessage` — nothing changes for
 * the default, by-far-most-common case. `sonnet` reuses
 * `CREDIT_COSTS.taskExecution` rather than a new number of its own: this
 * file's own scale already prices one Sonnet call at 5 Haiku-credits (see the
 * module doc above — "a Sonnet task execution burns ~5× a chat message" —
 * and `taskExecution`'s own doc: "the in-process single Sonnet/Haiku call
 * path"), so a deep chat turn is billed on that existing call, not a second
 * guess at what a Sonnet call is worth.
 *
 * SHAPE, because this pairs with S12 (the middleware-side pricing table this
 * ticket flags, Shlomi's repo — out of scope here). Keyed on `ProviderId`
 * (`@/lib/models/usage-log.ts`) — the SAME vocabulary `UsageLog.provider` /
 * `UsageLog.modelName` already use to cross the boundary between this repo's
 * real-dollar cost tracking and whatever tracks cost middleware-side —
 * rather than inventing a portal-only vendor enum, so a future
 * reconciliation diffs two same-shaped tables instead of translating between
 * naming schemes. Deliberately NOT keyed on `ai/provider.ts`'s `Vendor`
 * (anthropic vs vertex): that is which INFRASTRUCTURE served the call, and a
 * client's price must not move because Karos happened to route the same
 * Claude model through Vertex — see `usageFor()`'s own vendor/provider split
 * for the same reasoning applied to real-dollar cost.
 *
 * `google` and `openai` are reserved, empty, alongside `anthropic` — this is
 * the gap the ticket names ("no Gemini rows anywhere in the pricing table"):
 * adding a Gemini or GPT chat option is now a price DECISION recorded here,
 * not a table that has to be reshaped to fit a third provider. Deliberately
 * NOT populated with a guessed Gemini number: no Gemini vendor exists in
 * `ai/provider.ts` today (`capabilities.ts`'s `Vendor` is `"anthropic" |
 * "vertex"`, both Claude, and the chat route has no client-selectable Gemini
 * model to price), so there is no real call this file could price without
 * inventing one — exactly the placeholder-pricing failure
 * `CLIENT_PRICE_ROWS`'s own docstring already warns against for the
 * agent-setup row.
 */
export const CHAT_MESSAGE_CREDITS: Readonly<
  Record<ProviderId, Readonly<Partial<Record<ChatModel, number>>>>
> = {
  anthropic: {
    haiku: CREDIT_COSTS.chatMessage,
    sonnet: CREDIT_COSTS.taskExecution,
  },
  // T-B3 (SCRUM-246) landed the Gemini chat option this row was reserved for,
  // so it is no longer a future one — `gemini-flash` is now the DEFAULT model
  // for every non-deep copilot turn. Leaving `google` empty would make
  // `chatMessageCreditCost` throw on the most common path in the product.
  //
  // The number is `CREDIT_COSTS.chatMessage`: the SAME 1 credit a copilot
  // turn has cost since before the route could run on more than one model.
  // That is deliberately not a new price decision — a client's bill does not
  // move because Karos started routing the cheap path to a cheaper model, and
  // Gemini Flash costs Karos less than Haiku, so this cannot under-recover
  // against the tier it replaced. If Gemini's chat turn should be priced
  // BELOW a Haiku one, that is a real pricing decision and it belongs here,
  // made deliberately, not inherited from a merge.
  google: { "gemini-flash": CREDIT_COSTS.chatMessage },
  openai: {},
};

/**
 * The price row for a copilot turn, given the model T-B3's allowlist resolved.
 *
 * T-B23 originally shipped `chatModelFor(deep)`, which read `body.deep` and
 * mapped it to a tier itself. T-B3 (SCRUM-246) landed in the same round and
 * made that decision its own: `resolveChatModel()` in `ai/chat-models.ts` is
 * the ONLY thing allowed to turn a request body into a `{ vendor, modelId }`
 * pair, because `body.model` is untrusted browser input and that function
 * holds the mandatory server-side allowlist.
 *
 * So this takes the resolved KEY rather than the raw flag. Pricing is
 * downstream of routing, never a second opinion about it — a second function
 * reading `body.deep` would be a second place the allowlist can be forgotten,
 * and the charge could name a model the turn did not actually run on.
 *
 * Exhaustive over `ChatModelKey` by construction: adding an option to
 * `CHAT_MODEL_OPTIONS` without a price row here fails the type-check, which
 * is the same refuse-to-guess posture as `chatMessageCreditCost` throwing.
 */
export function chatPricingFor(key: ChatModelKey): { provider: ProviderId; model: ChatModel } {
  const ROWS: Readonly<Record<ChatModelKey, { provider: ProviderId; model: ChatModel }>> = {
    "gemini-flash": { provider: "google", model: "gemini-flash" },
    haiku: { provider: "anthropic", model: "haiku" },
  };
  return ROWS[key];
}

/**
 * Credits one copilot chat message costs, given which model actually serves
 * it. Throws rather than silently falling back to the flat rate — an
 * unpriced (model, provider) pair reaching a live charge is a wiring gap (a
 * new tier or provider added to the chat route without a row here), not a
 * runtime condition worth papering over with a guess. Mirrors
 * `models/usage-log.ts`'s `priceFor()`, which throws for the identical
 * reason on the real-dollar cost side.
 */
export function chatMessageCreditCost(model: ChatModel, provider: ProviderId = "anthropic"): number {
  const price = CHAT_MESSAGE_CREDITS[provider]?.[model];
  if (price == null) {
    throw new Error(
      `No credit price for chat model "${model}" under provider "${provider}". Add it to ` +
        `CHAT_MESSAGE_CREDITS.${provider} — there is deliberately no default.`,
    );
  }
  return price;
}

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
 * "about 25 credits" — a price QUOTED BEFORE a run, which is now an estimate
 * (credits rework, 2026-09).
 *
 * ONE HELPER RATHER THAN EIGHT INLINE "about"s, for the reason `creditsLabel`
 * itself exists: the surfaces that quote a price must not each get the hedge
 * right or wrong separately, and a reprice of the WORD is exactly as likely as
 * a reprice of the number. It wraps `creditsLabel` rather than re-spelling the
 * pluralisation, so "about 1 credit" cannot come out as "about 1 credits".
 *
 * "about", not "~" or "approx.": this is read by a client in a sentence, and
 * the two shorter spellings are a lab register. Never "tokens" — that word
 * belongs to PATs and LLM counts, and this is the phrase most tempted by it,
 * since the reason the price is an estimate IS token usage.
 */
export function estimatedCreditsLabel(amount: number): string {
  return `about ${creditsLabel(amount)}`;
}

/**
 * "18 credits (estimated 25)" — a price AFTER the run, on a ledger row or a run
 * history line, where both numbers matter: what the client actually paid, and
 * what they were quoted. Showing only the first makes a settled row look like a
 * reprice nobody announced; showing only the second is the old, wrong number.
 *
 * "estimated", not "est." — the row has the width, and an abbreviation on a
 * money line reads as jargon.
 */
export function settledCreditsLabel(actual: number, estimate: number): string {
  return `${creditsLabel(actual)} (estimated ${estimate})`;
}

/**
 * The one sentence that explains, wherever a price is quoted, why it is an
 * estimate — in the client's own terms and without naming tokens or dollars.
 *
 * Lives here beside the numbers rather than at each control, so the eleven
 * surfaces that quote a price cannot describe the same billing rule eleven
 * ways. No em dash (AF-8).
 */
export const ESTIMATED_PRICE_NOTE = "You're charged what the run actually uses.";

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
  if (!viewerIsBilled) return null;
  // HEDGED ONLY UNDER v2. All four of these presses settle to actual cost when
  // the rework is on, so the quote is an estimate and has to say so; with the
  // flag off the charge is exactly this figure and "about" would be a lie in
  // the other direction. Resolved here rather than at the control because these
  // helpers are already server-called (see the docstring above) — a client
  // component cannot read the flag, and must not try.
  return isCreditsPlanV2Enabled() ? estimatedCreditsLabel(amount) : creditsLabel(amount);
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

/**
 * One X "Propose accounts" / "Refresh proposal" press · proposeXRosterAction.
 *
 * A FOURTH quote, added by the flow audit (2026-09, R3): the press charges
 * `CREDIT_COSTS.chatMessage` — the nearest operation's rate, see the action's
 * own docstring — and quoted nothing, on a button a client re-presses to
 * refresh a list. It joins the three above rather than assembling the phrase at
 * the control for the reason stated there: the quote is read off the constant
 * the action charges from, so a reprice moves both together.
 */
export function xRosterProposalPrice(viewerIsBilled: boolean): string | null {
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
 *
 * NEITHER THE NEWSLETTER NOR THE BLOG IS IN THIS TABLE ANY MORE, and its price did not disappear
 * with it: it sat at 10, the work per issue did not change when the product
 * moved to the v2 custom agent, and they are now `NEWSLETTER_RUN_CREDITS` and
 * `BLOG_RUN_CREDITS` below. Re-adding a row here would give one product two
 * prices, and they would drift the first time either moved.
 */
export const TASK_EXECUTION_COSTS: Record<Exclude<ManagedTaskType, "custom">, number> = {
  /** Research + per-post VISUAL generation — media-heavy. */
  social_post: 15,
  /** Heaviest: full page build with brand kit + static build (~15–30 min). */
  landing_page: 20,
} as const;

/**
 * What one newsletter issue costs a billable client, on the v2 custom-agent path.
 *
 * THE PRICE THE MANAGED PRODUCT CHARGED, kept deliberately equal. The work per
 * issue did not change when the product moved off `TASK_EXECUTION_COSTS`, so a
 * client's bill must not either — and without an explicit default the submit
 * core would fall to the generic `CREDIT_COSTS.customAgentRun` rate, which is a
 * repricing nobody decided. `submitCustomAgentJob` applies it as the carried
 * default for the newsletter family; an admin's per-agent `creditCost` still
 * wins over it.
 *
 * It lives here rather than beside the other newsletter constants in
 * custom-agent-launch.ts (which re-exports it) because a price belongs with the
 * prices, and because the rate card below has to be able to quote it — which it
 * could not do from there, since that module already imports this one.
 */
export const NEWSLETTER_RUN_CREDITS = 10;

/**
 * What one blog article costs a billable client, on the v2 custom-agent path.
 *
 * THE PRICE THE MANAGED PRODUCT CHARGED, kept deliberately equal, for the reason
 * `NEWSLETTER_RUN_CREDITS` above states: the work per article did not change when
 * the product moved off `TASK_EXECUTION_COSTS`, so a client's bill must not
 * either, and without an explicit default the submit core would fall to the
 * generic custom-agent rate.
 *
 * ARGUABLY LOW NOW, and worth saying rather than quietly carrying: v2's writer
 * pays for real deep research at step 06 on top of the draft, which the managed
 * product did not do — the framework is explicit that "the blog pays for going
 * deep on one thing it found", against Ben's assumption that its research was
 * nearly free. Holding the price is the right default for a migration (a client's
 * bill must not move because we refactored), but this is the number to revisit
 * after a live month, not one to treat as settled.
 */
export const BLOG_RUN_CREDITS = 10;

/**
 * What one reputation pulse costs a billable client.
 *
 * NOT A CARRIED PRICE, unlike the two above, and that difference is the whole
 * note. The newsletter and the blog each replaced a managed product at a price a
 * client was already paying, so holding the number was the only honest option.
 * Reputation replaces nothing: there has never been a managed reputation task,
 * so this figure is a DECISION, and it should read as one.
 *
 * 25 is the generic `CREDIT_COSTS.customAgentRun` rate, chosen deliberately
 * rather than by omission. It is above the two carried tens because a pulse is a
 * heavier run than either: it reaches five external review surfaces (the only v2
 * agent with DYNAMIC egress rather than a finite host list), triages everything
 * new since the last pulse, and drafts a reply per review worth answering rather
 * than one deliverable per run. Setting it equal to the default also means the
 * submit core's fallback and this constant agree, so a future reprice of one
 * cannot silently diverge from the other without someone noticing here.
 *
 * Revisit after a live month, like its siblings. Unlike theirs, moving this one
 * does not change any client's existing bill.
 */
export const REPUTATION_RUN_CREDITS = 25;

/**
 * `CAROUSEL_RUN_CREDITS` used to live here, pricing the
 * karos-carousel-runner/-setup/-manager family. That family was retired in
 * full 2026-08-29 (SCRUM-377/T-B25a) — no engine equivalent was ever planned.
 * Removed from code and the db, do not reintroduce.
 */

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
  {
    label: "Copilot message",
    credits: CREDIT_COSTS.chatMessage,
    from: true,
    note: `up to ${chatMessageCreditCost("sonnet")} for an in-depth question`,
  },
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
  // Same treatment as the newsletter row below: still named and still 10 to the
  // client, though it is no longer a managed product.
  { label: "Blog article", credits: BLOG_RUN_CREDITS },
  // Still named and still 10, though it is no longer a managed product. Dropping
  // the row would have left the newsletter quoted only by the generic "Agent
  // run … from" line above — a client who buys one issue a week would have lost
  // the one place its price is stated outright, for an internal refactor.
  { label: "Newsletter issue", credits: NEWSLETTER_RUN_CREDITS },
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
export function clientPriceText(
  row: ClientPriceRow,
  opts?: { withUnit?: boolean; approx?: boolean },
): string {
  if (row.credits == null) return PER_AGENT_PRICE;
  const amount = opts?.withUnit ? creditsLabel(row.credits) : String(row.credits);
  // `from` already says the number is a floor, and "about, from 25" says two
  // hedges about one figure. The floor is the stronger claim, so it wins.
  if (row.from) return `from ${amount}`;
  return opts?.approx ? `about ${amount}` : amount;
}

/**
 * Applied to new clients on their first charge/grant (lazy doc creation).
 *
 * ALL THREE MOVED in the credits rework (2026-09): 200/150/400 → 2600/null/2600.
 * The allowance IS the cap and the cap IS the balance, so a fresh client starts
 * the month able to spend exactly their allowance and no more.
 *
 * The weekly cap is gone, not lowered. It was a burst limiter under a 400/month
 * ceiling; pro-rata under 2600 it would be ~600/week, and a client who wants to
 * run their whole month in week one is not abusing anything. A second cap is a
 * second denial message to explain, for no ceiling it enforces that the monthly
 * one does not. `ClientCredits.weeklyLimit` and `weekSpent` STAY — the field is
 * still honoured when an admin sets one deliberately (`setClientCreditLimits`),
 * and the week meter still shows spend — but nothing sets one by default.
 */
export const CREDIT_DEFAULTS = {
  startingBalance: MONTHLY_ALLOWANCE,
  /** Default weekly spend cap; null means uncapped, which is now the default. */
  weeklyLimit: null,
  /** Default monthly spend cap; null would mean uncapped. */
  monthlyLimit: MONTHLY_ALLOWANCE,
} as const;

/**
 * The defaults every `clientCredits` doc written before the credits rework
 * carries — the migration's "untouched" fingerprint.
 *
 * THERE IS NO BATCH MIGRATION SCRIPT, deliberately. Every read of a credits doc
 * already passes through `rollCreditWindows` (`getClientCredits` rolls on read,
 * and `assessCharge`/`applyCredit` roll inside their transactions), so the
 * cheapest safe migration is to do it there, per doc, on the next touch — the
 * same lazy-creation shape `defaultClientCredits` already uses for a client that
 * has never been charged.
 *
 * Matched by VALUE rather than applied blindly, because an admin-set cap is a
 * decision and this must not overwrite one: a doc still reading exactly 150/400
 * is one nobody has configured, and only that doc is migrated. A client whose
 * monthly cap an admin deliberately set to 400 keeps it, and staff can raise it
 * from the credits panel like any other.
 */
export const LEGACY_CREDIT_DEFAULTS = {
  startingBalance: 200,
  weeklyLimit: 150,
  monthlyLimit: 400,
} as const;

/**
 * The plan in force RIGHT NOW — the new one when `CREDITS_PLAN_V2_ENABLED=1`,
 * the pre-rework one otherwise.
 *
 * A FUNCTION, NOT A CONSTANT, because the answer depends on an env var and a
 * module-level constant would freeze whichever value was set when the module
 * first loaded — which in a test file is whatever the previous test left behind.
 * Every consumer of a default (`defaultClientCredits`, the migration, the
 * top-up) goes through here, so the switch cannot be half-thrown.
 */
export function creditDefaults(): {
  startingBalance: number;
  weeklyLimit: number | null;
  monthlyLimit: number | null;
} {
  return isCreditsPlanV2Enabled() ? CREDIT_DEFAULTS : LEGACY_CREDIT_DEFAULTS;
}

/**
 * The plan a credits doc is on. Bumped when the defaults themselves change, and
 * stamped on every doc the migration below touches so the value-matching heuristic
 * runs AT MOST ONCE per client — see `ClientCredits.planVersion`.
 */
export const CREDIT_PLAN_VERSION = 2;

/**
 * Bring a pre-rework credits doc onto the new plan, in place and idempotently.
 * Returns the SAME object when there is nothing to migrate, so the identity
 * check callers rely on ("did anything change?") still holds.
 *
 * Balance is deliberately NOT touched here — a top-up is a monthly event, not a
 * migration, and it belongs with the window roll below where the month key says
 * it is due.
 */
function migrateCreditPlan(credits: ClientCredits): ClientCredits {
  if (!isCreditsPlanV2Enabled()) return credits;
  if (credits.planVersion === CREDIT_PLAN_VERSION) return credits;
  // BOTH CAPS, OR NEITHER. The docstring above says an untouched doc is one
  // "still reading exactly 150/400", and checking the two independently did not
  // implement that sentence: a client whose monthly cap an admin had raised to
  // 900 still carried the default 150 weekly, so the weekly half fired and
  // silently removed a burst limiter on an account somebody had deliberately
  // configured. A doc with ANY admin fingerprint on its caps is a configured
  // doc, and the migration's business is only with the ones nobody has touched.
  //
  // It is still STAMPED either way, which is the point of stamping: a
  // half-legacy doc is recognised as "seen, decided, leave alone" and never
  // re-inspected, rather than being re-judged by this heuristic forever.
  const untouched =
    credits.weeklyLimit === LEGACY_CREDIT_DEFAULTS.weeklyLimit &&
    credits.monthlyLimit === LEGACY_CREDIT_DEFAULTS.monthlyLimit;
  return {
    ...credits,
    ...(untouched
      ? {
          weeklyLimit: CREDIT_DEFAULTS.weeklyLimit,
          monthlyLimit: CREDIT_DEFAULTS.monthlyLimit,
          // Entering the plan GRANTS this month's allowance, not just the cap
          // (product owner on prep, 2026-09-04: "they should see that they have
          // 2,600 credits"). Without this a migrated client kept their legacy
          // balance until the next month roll - the cap said 2600, the pill
          // said 195. Same `max` rule as the roll: a higher balance is never
          // clawed back. Only untouched docs: an admin-set cap is a decision,
          // and the top-up follows the cap that admin chose, on the next roll.
          balance: Math.max(credits.balance, MONTHLY_ALLOWANCE),
        }
      : {}),
    planVersion: CREDIT_PLAN_VERSION,
  };
}

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
  const plan = creditDefaults();
  return {
    clientId,
    balance: plan.startingBalance,
    weeklyLimit: plan.weeklyLimit,
    monthlyLimit: plan.monthlyLimit,
    weekKey: creditWeekKey(now),
    weekSpent: 0,
    monthKey: creditMonthKey(now),
    monthSpent: 0,
    updatedAt: now,
    // Born on the current plan, so the migration heuristic never inspects it.
    // Only under v2: stamping a doc created while the flag is OFF would tell a
    // later migration that a 200/150/400 doc had already been considered.
    ...(isCreditsPlanV2Enabled() ? { planVersion: CREDIT_PLAN_VERSION } : {}),
  };
}

/**
 * Reset week/month spend counters whose window key has rolled over, top the
 * balance up to the monthly allowance when the month rolled, and migrate a
 * pre-rework doc onto the new plan.
 *
 * ── THE MONTHLY TOP-UP (credits rework, 2026-09) ─────────────────────────────
 * `balance = max(balance, MONTHLY_ALLOWANCE)` on a month roll. Three things
 * that phrasing settles, each of which was a real option:
 *
 *   - NOTHING ROLLS OVER. A client who spent 100 of their 2600 starts the new
 *     month on 2600, not 5100. Rollover would let one month legitimately cost
 *     us far more than $130, which is the whole line this rework exists to
 *     hold.
 *   - NOTHING IS TAKEN AWAY. `max`, never assignment: a client sitting on 4000
 *     because an admin granted a paid top-up keeps all 4000. Robbing a client
 *     of credits they bought, in a function called "roll the windows", would be
 *     the worst possible place to hide that.
 *   - IT IS A CONSEQUENCE OF THE CALENDAR, NOT OF A CRON. This is the first
 *     monthly refill the product has ever had, and putting it behind a
 *     scheduled route would mean a missed tick silently costs a client their
 *     month. Computing it from `creditMonthKey` makes it true the moment anyone
 *     reads the doc, and PERSISTED by the first charge/grant of the new month
 *     (`assessCharge` and `applyCredit` both roll before they write) — the
 *     identical guarantee the spend counters have always had.
 *
 * Pure, so a read-only caller (`availableCredits`, `bindingCreditLimit`, the
 * balance pills) sees the topped-up figure immediately even before anything
 * writes it. That is the same read/write split the counters already have; the
 * displayed number and the number the next charge assesses against are computed
 * by this one function, so they cannot disagree.
 */
export function rollCreditWindows(credits: ClientCredits, now: number): ClientCredits {
  const migrated = migrateCreditPlan(credits);
  const weekKey = creditWeekKey(now);
  const monthKey = creditMonthKey(now);
  const weekRolled = weekKey !== migrated.weekKey;
  const monthRolled = monthKey !== migrated.monthKey;
  if (!weekRolled && !monthRolled) return migrated;
  return {
    ...migrated,
    weekKey,
    weekSpent: weekRolled ? 0 : migrated.weekSpent,
    monthKey,
    monthSpent: monthRolled ? 0 : migrated.monthSpent,
    // Gated: under the old plan there was never a monthly refill, and adding
    // one on a merge would hand every client in the product a free month.
    balance:
      monthRolled && isCreditsPlanV2Enabled()
        ? Math.max(migrated.balance, MONTHLY_ALLOWANCE)
        : migrated.balance,
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
 * Pure settlement application: move the balance by `delta` and move the hold's
 * window spend the OPPOSITE way, scoped to the windows the hold accrued in.
 *
 * A SETTLEMENT IS NEITHER A REFUND NOR AN ADJUSTMENT, which is why it cannot
 * reuse `applyCredit` (credits rework, 2026-09):
 *
 *   - `"refund"` only ever hands credits BACK; a settlement can go either way,
 *     and `applyCredit`'s refund branch would subtract a negative from
 *     `weekSpent` (i.e. add to it) only after `Math.max(0, …)` had already made
 *     the arithmetic mean something else.
 *   - `"adjustment"` moves the balance WITHOUT touching window spend. A
 *     settlement that took more credits and left `monthSpent` alone would let a
 *     client spend past 2600 while the monthly cap read as unbreached — the
 *     exact ceiling this rework exists to keep.
 *
 * `chargedAt` is the hold's own `createdAt`, and the window guards are the same
 * ones `applyCredit`'s refund branch uses: a settlement landing after a month
 * rollover corrects nothing in the NEW month, because the spend it is
 * correcting was never counted there. The credits still move on the balance —
 * only the window bookkeeping is scoped.
 *
 * CAPS ARE NOT RE-CHECKED, and that is deliberate. The work is already
 * delivered; refusing the settlement would either strand the difference or
 * retry forever. A settlement is allowed to push `balance` negative and
 * `monthSpent` past the cap; the NEXT charge is then correctly denied by
 * `assessCharge` through the existing `insufficient_balance` path, with no new
 * UI state, and `availableCredits` already floors at 0 so no pill renders a
 * negative. `SETTLEMENT_CAP_FACTOR` is what bounds how far past zero one run
 * can push it.
 */
export function applySettlement(
  current: ClientCredits,
  delta: number,
  now: number,
  chargedAt: number,
): ClientCredits {
  const rolled = rollCreditWindows(current, now);
  const next: ClientCredits = { ...rolled, balance: rolled.balance + delta, updatedAt: now };
  if (creditWeekKey(chargedAt) === rolled.weekKey) {
    next.weekSpent = Math.max(0, rolled.weekSpent - delta);
  }
  if (creditMonthKey(chargedAt) === rolled.monthKey) {
    next.monthSpent = Math.max(0, rolled.monthSpent - delta);
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
