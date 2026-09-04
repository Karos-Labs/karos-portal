# Credits: cost-based pricing design

Audit + implementation design for the product owner's ruling:

> 2600 credits per client account per month; each agent run costs what it costs us
> in tokens; a client on 2600 credits must never cost more than $130 in a month;
> prices shown per run are ESTIMATES, and the real deduction is our cost × the
> credit multiplier.

Repo: `/Users/albertkattan/Karos Labs CMO/.claude/worktrees/instagram-post-ordering-5c8eaa`
(read-only audit, nothing changed). All line numbers are from the worktree as read.

---

## 0. The arithmetic, confirmed against the code

$130 ÷ 2600 credits = **$0.05 of our cost per credit**, i.e. **20 credits per USD**.
So `credits = ceil(actualUsd × 20)`. The ruling's own two numbers pin it exactly; there
is no third constant to derive.

The existing constants are **already roughly on that scale for the heavy runs**, which is
the strongest confirmation available:

| Constant | Value | Implied our-cost @ 20cr/$ | What the code says the real cost is |
|---|---|---|---|
| `CREDIT_COSTS.customAgentRun` (`src/lib/credits.ts:73`) | 25 | $1.25 | "Opus, 10–35 min, research + media renders" (`credits.ts:69-72`); `TASK_EXECUTION_COSTS`' docstring says a product run is **"~$0.50–2"** (`credits.ts:374-376`) |
| `TASK_EXECUTION_COSTS.landing_page` (`credits.ts:387`) | 20 | $1.00 | "full page build … ~15–30 min" |
| `TASK_EXECUTION_COSTS.social_post` (`credits.ts:385`) | 15 | $0.75 | "research + per-post VISUAL generation" |
| `NEWSLETTER_RUN_CREDITS` / `BLOG_RUN_CREDITS` (`credits.ts:406`, `:425`) | 10 | $0.50 | bottom of the stated band; `BLOG_RUN_CREDITS`' own docstring already flags itself as **"arguably low now"** |
| `REPUTATION_RUN_CREDITS` (`credits.ts:448`) | 25 | $1.25 | five external review surfaces + a reply per review |

$1.25 sits in the middle of the band the file itself documents. **20 credits/USD is
therefore a confirmation of the ruling, not a correction of it** — for agent runs.

Where it is *not* confirmed, and these are the two corrections:

1. **The small in-app actions over-recover by 4–25×.** `CREDIT_COSTS.chatMessage = 1`
   (`credits.ts:54`) implies $0.05. The default chat model is now `gemini-flash`
   (`credits.ts:161`) at $0.30/$2.50 per 1M (`src/lib/models/usage-log.ts`,
   `MODEL_PRICING_BY_VENDOR.google`); a 3k-in/500-out turn is ≈ $0.0022 — 23× under
   the implied price. `CREDIT_COSTS.taskExecution = 5` (`credits.ts:61`) implies $0.25 for
   one Sonnet call; a 10k-in/2k-out Sonnet call at $3/$15 per 1M is ≈ $0.06 — 4× under.
   **This is harmless under the design below**, because `ceil(usd × 20)` has a floor of
   1 credit: everything under $0.05 actual settles to exactly 1 credit. But it means the
   `taskExecution`-priced presses (audience simulation, Task Map refresh — both
   `CREDIT_COSTS.taskExecution`, see §1.3) will *drop* from 5 credits to 1–2 once settled.
   That is a real, intended repricing and Albert should know it is coming.
2. **`CREDIT_COSTS.employeeSeat = 100` (`credits.ts:81`) is not a compute cost at all.**
   It is a monetization SKU ("one additional LinkedIn employee-advocacy seat"). It must be
   **exempted by name** from the multiplier rule, or the design will try to settle a seat
   purchase against $5.00 of tokens that were never spent.

**The budget guarantee.** Under settle-to-actual, "2600 credits ⇒ ≤ $130" is true *by
construction* for every credit a client is charged. The $130 line can only be breached by
spend that never reaches the ledger — see the two leaks in §2.6.

---

## 1. Current model

### 1.1 Balance, starting balance, caps

`ClientCredits` (`src/lib/types.ts:2589-2601`), stored in `clientCredits`, doc id = clientId
(`src/lib/data.ts:118`), created lazily on first charge or grant.

```
clientId, balance, weeklyLimit|null, monthlyLimit|null,
weekKey, weekSpent, monthKey, monthSpent, updatedAt
```

Defaults, `CREDIT_DEFAULTS` (`src/lib/credits.ts:577-583`):

| | value |
|---|---|
| `startingBalance` | **200** |
| `weeklyLimit` | **150** |
| `monthlyLimit` | **400** |

Windows are UTC keys: ISO week `creditWeekKey` (`credits.ts:591`, resets Monday 00:00 UTC)
and calendar month `creditMonthKey` (`credits.ts:603`, resets on the 1st). `rollCreditWindows`
(`credits.ts:624`) zeroes only the counter whose key rolled; `getClientCredits`
(`data.ts:2869`) rolls on read.

**Balance is a prepaid pool that never refills.** There is no monthly grant, anywhere: the
cron routes are `intel-report-schedule`, `run-scheduled`, `runway`, `daily-digest`,
`scheduler`, `cleanup-logs`, `publish`, `insights`, `tasks/auto-generate`,
`ingest/fireflies`, `agent-service/reconcile`, `agent-engine/reconcile`, `credits/reconcile`,
`analytics/sync` — none of them touches balance. The only top-up is an admin pressing
"grant" (`adjustCreditsAction`, `src/lib/actions/credit-actions.ts:17-43`).

Spendable = `availableCredits()` (`credits.ts:854`) = `min(balance, weeklyLimit − weekSpent,
monthlyLimit − monthSpent)`, floored at 0. That is the number every balance pill renders
(`sidebar.tsx:687`, `client-rail.tsx:201`, `clients-grid.tsx:569`, `credits-panel.tsx:196`).

Caps are admin-set via `setCreditLimitsAction` → `setClientCreditLimits`
(`credit-actions.ts:52-71`, `data.ts:3009`), edited in `credits-panel.tsx:154`.

### 1.2 Who is charged

`isBillableClientActor()` (`credits.ts:30-34`): `role === "CLIENT_USER" && !impersonatedBy`.
Staff, cron and admin "View as Client" never charge. `ScheduledRun.billClientCredits`
(`types.ts:1526`) can flip a schedule's fires to client-billed
(`src/app/api/run-scheduled/route.ts:279`).

### 1.3 Every price constant, and where it is shown

All in `src/lib/credits.ts` unless stated.

| Constant | Value | Charged at | Shown at |
|---|---|---|---|
| `CREDIT_COSTS.chatMessage` | 1 | `api/clients/[id]/chat/route.ts:258` (via `chatMessageCreditCost`) | `credits-panel.tsx:190`; `CLIENT_PRICE_ROWS` row "Copilot message" (`credits.ts:519`) |
| `CREDIT_COSTS.taskExecution` | 5 | `api/clients/[id]/simulate/route.ts:158`; `api/tasks/generate-swarm/route.ts:95`; `actions/execution-actions.ts:60` | `audience-simulation.tsx:105,127`; `refresh-task-map-button.tsx:60,82`; card row "Other task execution" (`credits.ts:551`) |
| `CREDIT_COSTS.targetedCorrection` | 2 | `actions/intel-actions.ts:116` | `correct-info-modal.tsx:141`; card row (`credits.ts:524`) |
| `CREDIT_COSTS.globalCorrection` | 15 | `actions/intel-actions.ts` | card row (`credits.ts:525`) |
| `CREDIT_COSTS.taskAssist` | 1 | `actions/task-actions.ts:162` | (folded into `ai_tool`) |
| `CREDIT_COSTS.customAgentRun` | 25 | `jobs/submit-custom.ts:622` (generic fallback) | `custom-agents.tsx:2607`; `live-card.tsx:292`; `agent-detail-panel.tsx:186`; `legacy-agent-panel.tsx:186`; card row "Agent run · from" (`credits.ts:537`) |
| `CREDIT_COSTS.employeeSeat` | 100 | `actions/seat-actions.ts:125` | `linkedin-seats-workspace.tsx:234,240`; card row (`credits.ts:553`) |
| `CHAT_MESSAGE_CREDITS` | haiku 1 / sonnet 5 / gemini-flash 1 | `chat/route.ts:258` | card row note (`credits.ts:522`) |
| `TASK_EXECUTION_COSTS.social_post` | 15 | `taskExecutionCost()` (`credits.ts:462`) | card row (`credits.ts:549`) |
| `TASK_EXECUTION_COSTS.landing_page` | 20 | same | card row (`credits.ts:550`) |
| `NEWSLETTER_RUN_CREDITS` | 10 | `submit-custom.ts:614` (carried default) | card row (`credits.ts:548`) |
| `BLOG_RUN_CREDITS` | 10 | `submit-custom.ts:616` | card row (`credits.ts:543`) |
| `REPUTATION_RUN_CREDITS` | 25 | `submit-custom.ts:618` | (generic "Agent run" row) |
| `CustomAgent.creditCost` (per-agent override) | admin-set | `submit-custom.ts:622` | `custom-agents.tsx:3082` editor; `agent-studio.tsx:87`; `engine-agent-card.tsx:83` |
| `CustomAgent.launchCreditCost` (one-time setup) | admin-set, **no default** | `submit-custom.ts` via `input.charge` (`:224`) | `launch-card.tsx:137`; `custom-agents.tsx:3105` editor; `agent-economics.tsx:107` |
| `DynamicAgentSpec.creditsCost` | admin-set | `submit-custom.ts:1031` (frozen in `specSnapshot`) | `dynamic-agent-intake-form.tsx:313`; `agent-studio-list.tsx:111`; `general-settings-form.tsx:133` |
| `plannedTaskExecutionCost()` (`src/lib/execution-engine.ts:99`) | resolves `taskExecutionCost()` per task | `actions/task-actions.ts:162`; `actions/execution-actions.ts:60` (called at `:122` manual start, `:334` adjustments) | card row "Other task execution" |

Four further charge sites the table above does not price separately, all flat:
`x-agent-actions.ts:334` (X account suggestions, `chatMessage`),
`competitor-actions.ts:408` (website lookup, `taskAssist`),
`task-actions.ts:357` (AI plan) and `:436` (custom task ingestion), both `taskAssist`.

Price *copy* is centralised: `creditsLabel()` (`credits.ts:243`), the four `pressPrice`
quotes (`credits.ts:293,298,303,317`), `CLIENT_PRICE_ROWS` (`credits.ts:517`) +
`clientPriceText()` (`credits.ts:570`) rendered by both `credits-panel.tsx:248-272` and
the copilot system prompt (`chat/route.ts:405-423`), and `CreditPriceNote`
(`credit-price-note.tsx:49-52`, "Costs {price}" / "The client is charged {price}").

### 1.4 When the charge happens

**Always upfront, before the work.** Three mechanisms:

1. **Durable jobs** — `chargeClientCredits` inside `submitCustomAgentJob`
   (`src/lib/jobs/submit-custom.ts:620-643`), *after* `createJob` and *before* dispatch.
   `runCost` resolution, `submit-custom.ts:613-622`:
   ```
   input.charge?.amount                                   // explicit (launch charge)
   ?? (agent.creditCost                                   // admin per-agent override
       ?? carriedDefault                                  // newsletter/blog/reputation family
       ?? CREDIT_COSTS.customAgentRun)                    // generic 25
      × multiplier                                        // batch outputs, clamped per agent
   ```
   Dynamic Agent Studio: `specSnapshot.creditsCost`, charged once at job creation
   (`submit-custom.ts:1017-1043`), never re-charged on retry/resume (keyed on `jobId`).
   On a credit denial the job doc is deleted (`:637`).
2. **In-request model calls** — `chargeClientModelCall` /
   `withClientModelCharge` (`src/lib/client-model-charge.ts:95`, `:196`), the single seam
   for copilot, insights, simulate, Task Map, corrections, task assist, execution.
   Charges, runs, and refunds if the call throws. `refundOnce` (`:163`) guards against
   double-refund on a stream emitting two error parts.
   `client-model-charge-boundary.test.ts:97` asserts **every client-reachable model call
   routes through one of these** — a real structural guarantee the settlement design can
   lean on, because it means there is no fourth, unmetered charge path to find.
3. **Scheduler fires** — a second direct `chargeClientCredits` at
   `src/lib/agent-service/run-custom-agent.ts:242`, before the service submit, with the job
   deleted on `CreditError`. Same shape as (1) but a separate call site, so **settlement has
   to be wired into both**.

**Nothing anywhere charges on completion.** `submit-custom.ts:1017` states it as a
decision: *"fixed credit price, taken from the SNAPSHOT and charged ONCE at job creation.
Token-based variable pricing is out of scope."* That sentence is what this design reverses.

### 1.5 Failure, cancel, refund

`refundJobCharge` (`src/lib/credit-reconcile.ts:215`) refunds the newest unpaired charge
filed under a job/task key. Idempotency is a **deterministic ledger doc id**
`refund_<chargeEntryId>` (`credit-reconcile-shared.ts:10`) written with `tx.create()`, so a
charge can be refunded at most once regardless of retries or concurrent reconcilers.

Refund fires from:

| Trigger | Site |
|---|---|
| any non-`done` webhook status (failed / cancelled / dead_letter) | `api/agent-service/webhook/route.ts:560-570` — **before the single-use claim**, and a failed refund returns 503 to keep the delivery in the service's retry queue |
| a `done` run that produced **zero deliverables** | `webhook/route.ts:1936-1943` (job is then corrected to `failed`) |
| asset creation threw | `webhook/route.ts:1892-1896` |
| submit to agent-service threw | `submit-custom.ts:764` (refund *before* flipping to failed) |
| agent-engine run failed / blocked_intake | `src/lib/agent-engine/reconcile.ts:241-243` (`held` deliberately does **not** refund) |
| topic-guardrail violation | rides the generic non-`done` path — `docs/dynamic-agent-guardrails.md:108-109` |
| task-dispatched run failed or produced nothing | `src/lib/task-sync.ts:295` (keyed on `taskId`) |
| agent unavailable / dispatch failed / in-process execution failed | `src/lib/execution-engine.ts:251,289,339,457` |
| scheduler submit failed after charge | `src/lib/agent-service/run-custom-agent.ts:325` |
| stuck job / task crash sweep | `/api/credits/reconcile` (`route.ts:38`, `STALE_AFTER_MS` = 30 min) → `reconcileStuckTaskExecution` (`credit-reconcile.ts:244`) / `reconcileStuckJob` (`:309`); both exclude anything with a `serviceJobId` |
| in-request model call threw | `withClientModelCharge` catch (`client-model-charge.ts:212`) |
| in-request call **succeeded but produced nothing** | ~15 inline sites: `insights/route.ts:254,315`; `simulate/route.ts:173,192`; `generate-swarm/route.ts:159` (`created === 0`); `intel-actions.ts:140,162,668,893`; `task-actions.ts:509` (queue at capacity), `:520` (duplicate); `competitor-actions.ts:419`; `x-agent-actions.ts:375,387,399`; `seat-actions.ts:125` |

`applyCredit(…, "refund", …)` (`credits.ts:826-845`) hands back window spend **only to the
windows the original charge accrued in**, scoped by `chargedAt`.

The inline refunds have **no idempotency key at all** — `creditClientCredits` writes an
auto-id doc (`data.ts:2977`), which is exactly why `refundOnce` (`client-model-charge.ts:163`)
exists as a per-run guard. Only the `refundJobCharge` family gets the deterministic id. The
settlement design must therefore key off the *charge* row, never off "has this job been
refunded before" reasoning that only holds for the job path.

Two timing details worth pinning: insights charges **only on `?force=1`**
(`insights/route.ts:100`), and audience simulation charges **a flat 5, not per persona**
(`simulate/route.ts:155-163`) — so a 6-persona simulation settling to actual will move
substantially more than a 1-persona one.

### 1.6 What actual-cost data we have per run

| Path | Field | Unit | Populated? |
|---|---|---|---|
| agent-service (all custom agents, managed products, Dynamic Agent Studio) | `payload.usage.totalCostUsd` → `Job.external.totalCostUsd` (`types.ts:1113`) | USD | **Yes**, written at `webhook/route.ts:2078`; also `agent-service/reconcile-job.ts:82`. Optional in the schema (`webhook/route.ts:163`) |
| same | `payload.usage.models[modelId].{inputTokens,outputTokens,cacheRead…,cacheCreation…,costUsd}` | tokens + USD | **Yes** (`webhook/route.ts:162-176`), summed at `:2000-2001`, re-logged per model to `usageLogs` at `:2185` |
| Dynamic Agent Studio, per step | `dynamic_run.steps[].usage` | tokens + USD | **Yes**, one `usageLogs` row per step (`webhook/route.ts:2240`) |
| every in-app model call (copilot, insights, simulate, corrections, task map, branding, swarm, SEO/GEO…) | `usageLogs.estimatedCostUsd` (`models/usage-log.ts:44`), computed by `computeCostUsd(vendor, modelId, in, out, webSearch)` from `MODEL_PRICING_BY_VENDOR` | USD | **Yes**, 25+ `logUsage` call sites; carries `clientId`, `jobId`, `operation` |
| **agent-engine products** | `AgentEngineRunRecord.totalCostUsd` (`agent-engine/read-run.ts:29`) and per-step `costUsd` (`:76`) | USD | **Read live and rendered** (`agent-engine-run-panel.tsx:75,88`) but **NEVER persisted** — `syncJobFromAgentEngine` writes only status/error/assetIds (`agent-engine/reconcile.ts:209-213`), and **no `logUsage` call exists on this path at all**. This is the one real telemetry gap. |

Pricing itself is strict: `priceFor()` **throws** `PricingLookupError` on an unknown
`(vendor, modelId)` pair — there is deliberately no `_default` row (`usage-log.ts`, the AU70
note). `logUsage` catches it, writes cost 0 and sets `pricingUnresolved: true`
(`services/logger.ts:158-180`), so "we don't know" stays distinguishable from "free".

### 1.7 Ledger schema

`CreditLedgerEntry` (`types.ts:2636-2678`), collection `creditLedger` (`data.ts:119`),
append-only, retained (unlike `usageLogs`, purged after 30 days):

```
id, clientId, delta (signed: −charge, +grant/refund), balanceAfter,
kind: "grant"|"charge"|"refund"|"adjustment",
operation: CreditOperation (types.ts:2605-2632),
reason (free text ≤120 chars), agentId?, jobId?, actorUid, actorName?, createdAt,
modelName?, provider?      // T-B23, the join key to real-dollar cost
```

`jobId` is a **pairing key**, not always a Job id — a board-task dispatch files the charge
under the *task* id (`credit-reconcile.ts` docstring on `refundJobCharge`).

Reporting over it is already pure and tested in `src/lib/credit-reporting.ts`:
`summarizeClientSpend` (credits, per agent × bucket), `summarizeAgentEconomics`
(**USD, from `job.external.totalCostUsd`**), `calibrateLaunchPrice`. Rendered by
`credits-panel.tsx:365-389` (client, credits) and `agent-economics.tsx` (staff, USD,
hard-gated on `viewerIsStaff` at `:51`).

---

## 2. Gap analysis vs the ruling

### 2.1 Fixed price vs actual cost

Every price today is a constant or an admin-typed number. Nothing anywhere reads a run's
actual cost back into a charge. `submit-custom.ts:1017` rules token-based pricing out of
scope in so many words. **The whole delta of this ticket is the reconcile step.**

The *machinery* for it, however, is almost entirely built:

- actual USD per run is already captured and stored (`job.external.totalCostUsd`);
- `credit-reporting.ts` already aggregates it into USD-per-run averages;
- `calibrateLaunchPrice` already converts a measured USD ratio into a suggested credit
  price and refuses to invent one when the sample is empty (`credit-reporting.ts`,
  `CALIBRATION_MIN_SAMPLES = 3`) — this is exactly the shape §3(c) needs, one level down;
- `refundJobCharge` already demonstrates the idempotent-settlement pattern (deterministic
  doc id + `tx.create()`).

### 2.2 2600/month vs current defaults

| | today | ruling |
|---|---|---|
| starting balance | 200 | — (balance and allowance are not the same thing today) |
| monthly cap | 400 | **2600** (6.5×) |
| weekly cap | 150 | undecided — 2600/4.345 ≈ 598/wk pro-rata |
| refill | none, ever | monthly |

Two mechanisms could carry "2600 per month" and the code has both: `balance` (a pool) and
`monthlyLimit` (a window cap). They are checked in that order by `assessCharge`
(`credits.ts:778-804`) and `bindingCreditLimit` (`credits.ts:731-738`). Picking one is
Q1 in §5.

### 2.3 Where estimates would be shown

Every surface in the §1.3 table that today prints an exact number becomes an estimate. The
copy work is small because it is centralised — `creditsLabel()`, `CreditPriceNote`, and the
run-dialog line at `custom-agents.tsx:2607` cover most of it. The two full rate-card
renderers (`credits-panel.tsx:248-272` and `chat/route.ts:405-423`) both read
`CLIENT_PRICE_ROWS`, so one change to `clientPriceText()` moves both, and
`credit-attribution.test.ts:386-407` already asserts neither keeps a private copy.

### 2.4 Is actual USD available, per product?

| Product / action | Actual USD available? | If not, how to estimate |
|---|---|---|
| agent-service custom agents (X, LinkedIn, Reddit, newsletter, blog, reputation) | **Yes** — `job.external.totalCostUsd` | — |
| Dynamic Agent Studio | **Yes**, run-level and per-step | — |
| managed products (`social_post`, `landing_page`) | **Yes**, same webhook path | — |
| **agent-engine products** | **No, not persisted.** The engine knows (`read-run.ts:29`) but karosCMO never stores it and never logs usage | **Fix, don't estimate**: persist `view.run.totalCostUsd ?? totalStepCostUsd(view.steps)` onto `job.external.totalCostUsd` in `syncJobFromAgentEngine` (`agent-engine/reconcile.ts:209`) — a 3-line change on data already in hand |
| copilot chat | **Yes** — `usageLogs` rows at `chat/route.ts:840,1659` carry `clientId` | — (settles to 1 credit anyway, see §0) |
| Task Map refresh | **Yes** — `agent-swarm.ts:292` | — |
| AI insights | **Yes** — `insights/route.ts:262,323` | — |
| corrections | **Yes** — `intel-actions.ts:145,587` | — |
| audience simulation | **Yes** — `simulation-engine.ts:333,419` | — |
| LinkedIn seat purchase | **N/A — no compute.** Exempt from the multiplier by name | — |

**Conclusion: no product needs a token×price-table estimate as a substitute for actual
cost.** Every path either reports USD already or is one small write away from doing so.
Estimation is only needed for the *pre-press quote* (§3c), never for the charge.

The one honest hole is `pricingUnresolved` rows (`usage-log.ts`, `logger.ts:158`): an
unpriced `(vendor, modelId)` pair costs 0. A settlement must treat "cost unknown" as
**"do not settle — keep the estimate"**, never as "$0, refund everything". Same posture the
codebase already takes everywhere else about this flag.

### 2.5 Reconciling estimates with the two-audience split

`credit-reporting.ts`'s module docstring is explicit: *"Nothing in this module estimates,
extrapolates or fills a gap."* Estimates must therefore live in a **new** pure function, not
inside `summarizeAgentEconomics`, or that contract breaks.

### 2.6 The two leaks that can breach $130 regardless

1. **Unbilled spend that still costs us.** Staff-fired runs, `View as Client` runs, and any
   `ScheduledRun` with `billClientCredits !== true` (`types.ts:1526`,
   `run-scheduled/route.ts:279`) burn real dollars and write **no ledger row**. The credit
   cap cannot see them. `settings/page.tsx:645` even tells staff so: *scheduled runs never
   charge the client; model spend is internal and appears in no ledger.* For a client whose
   agents are on staff-run schedules, the credit ceiling guarantees nothing about the $130.
2. **Refunded-but-real spend.** A failed run refunds the client fully
   (`webhook/route.ts:560`) but the tokens it burned are gone. `summarizeAgentEconomics`
   deliberately excludes failed/cancelled jobs from its averages
   (`credit-reporting.ts`, `FAILED_STATUSES`) — correct for *calibration*, wrong for a
   *budget watch*. The $130 monitor in §3(e) must count failures.

Both are monitoring problems, not charging problems, and §3(e) is where they land.

---

## 3. Design

### (a) Constants

New block in `src/lib/credits.ts`, immediately above `CREDIT_DEFAULTS` (`:577`):

```ts
/** Our cost, in USD, that one credit is meant to recover. $130 ÷ 2600. */
export const USD_PER_CREDIT = 0.05;

/** Credits per USD of our own cost. The inverse of USD_PER_CREDIT, spelled out
 *  because it is the multiplier every settlement applies. */
export const CREDIT_MULTIPLIER = 1 / USD_PER_CREDIT; // 20

/** One client account's monthly credit allowance. 2600 × $0.05 = the $130 line. */
export const MONTHLY_ALLOWANCE = 2600;

/** Never settle a run below one credit: ceil() already floors at 1 for any
 *  non-zero cost, and a zero-cost settlement is a telemetry gap, not a free run. */
export const MIN_SETTLED_CREDITS = 1;

/** A settlement may not exceed this multiple of the held estimate without staff
 *  review. Protects a client from one runaway run eating their month. */
export const SETTLEMENT_CAP_FACTOR = 2;

/** Operations whose price is a monetization decision, not a compute cost.
 *  These are never settled against actual USD. */
export const UNSETTLED_OPERATIONS: ReadonlySet<CreditOperation> =
  new Set(["seat_purchase", "manual", "agent_launch"]);

/** credits = ceil(our USD cost × CREDIT_MULTIPLIER), floored at MIN_SETTLED_CREDITS. */
export function creditsForUsd(usd: number): number {
  if (!Number.isFinite(usd) || usd <= 0) return MIN_SETTLED_CREDITS;
  return Math.max(MIN_SETTLED_CREDITS, Math.ceil(usd * CREDIT_MULTIPLIER));
}
```

`agent_launch` is in `UNSETTLED_OPERATIONS` because §6.3's whole design
(`credit-reporting.ts`, `calibrateLaunchPrice`; `docs/qa-sweep-2026-07/phase3-design.md:673`)
already prices setup from a *measured cross-client ratio* set deliberately by an admin.
Settling it per-run would silently replace that ruling. Flag as Q4 if Albert wants it in.

**Mapping onto the caps.** `CREDIT_DEFAULTS` (`credits.ts:577-583`) becomes:

```ts
export const CREDIT_DEFAULTS = {
  startingBalance: MONTHLY_ALLOWANCE,   // 200 → 2600
  weeklyLimit: null,                    // 150 → uncapped (see Q2)
  monthlyLimit: MONTHLY_ALLOWANCE,      // 400 → 2600
} as const;
```

Recommended shape (Q1): **`monthlyLimit` is the allowance; `balance` is a top-up pool that
sits on top of it.** A new monthly cron `/api/credits/allowance` sets
`balance = max(balance, MONTHLY_ALLOWANCE)` on the 1st (UTC, matching `creditMonthKey`) —
no rollover of the allowance, but a paid top-up survives. `assessCharge` needs no change:
it already checks balance then weekly then monthly, in that order (`credits.ts:778-804`),
and `bindingCreditLimit` (`credits.ts:724`) already mirrors that ladder exactly so the
pre-flight line names the same limit the denial will.

### (b) Two-phase charge: hold → settle

**Phase 1, HOLD (unchanged code path).** `chargeClientCredits` at dispatch, `amount` =
the estimate. Two new optional fields on `CreditLedgerEntry` (`types.ts:2636`):

```ts
/** "hold" — an estimate taken upfront, awaiting settlement against actual cost.
 *  "settlement" — the adjustment that reconciled a hold. Absent on every entry
 *  written before this existed and on every operation in UNSETTLED_OPERATIONS,
 *  both of which are treated as final. */
phase?: "hold" | "settlement";
/** Settlements only: the hold this reconciles, and what actually happened. */
settlesEntryId?: string;
estimateCredits?: number;
actualUsd?: number;
```

Additive and optional, so **no existing row changes and no migration reads one.**

**Phase 2, SETTLE.** New module `src/lib/credit-settle.ts`, deliberately mirroring
`credit-reconcile.ts` (which the codebase already treats as the home for out-of-band
credit transactions):

```ts
export function settlementEntryIdFor(chargeEntryId: string): string {
  return `settle_${chargeEntryId}`;
}

export async function settleJobCharge(
  ledgerKeys: string[],        // same list shape refundJobCharge takes, same reason
  actualUsd: number,
  reason: string,
): Promise<{ settled: boolean; from?: number; to?: number; delta?: number }>;
```

One Firestore transaction:

1. read every `creditLedger` row where `jobId == key` (same query `readRefundableCharge`
   uses, `credit-reconcile.ts`);
2. find the newest `kind === "charge"` row that is **neither refunded
   (`refund_<id>` exists) nor settled (`settle_<id>` exists)**. If it was refunded, return
   `{settled:false}` — a refunded run must never settle. This mutual exclusion is the single
   most important invariant in the design;
3. skip if `charge.operation` is in `UNSETTLED_OPERATIONS`;
4. `to = min(creditsForUsd(actualUsd), hold × SETTLEMENT_CAP_FACTOR)`;
   `delta = hold − to` (positive ⇒ refund the difference, negative ⇒ deduct the extra);
5. if `delta === 0`, still `tx.create()` the settlement row with `delta: 0` so the hold is
   marked settled and never re-attempted;
6. apply the new `applySettlement` to `clientCredits` and `tx.create()` the settlement row
   at `settle_<chargeEntryId>`. `tx.create()` on a deterministic id makes a concurrent
   duplicate abort the whole transaction rather than double-settle — exactly the guarantee
   `stageRefundWrites` relies on (`credit-reconcile.ts`).

**`applySettlement` (new, in `credits.ts` beside `applyCredit` at `:826`).** A settlement is
*not* a refund and *not* an adjustment, and must not reuse either:

```ts
export function applySettlement(
  current: ClientCredits,
  delta: number,     // + = hand back, − = take more
  now: number,
  chargedAt: number, // the hold's createdAt — scopes the window correction
): ClientCredits
```

Balance moves by `+delta`; **window spend moves by `−delta`**, scoped to the hold's own
week/month keys (the same guard `applyCredit`'s refund branch uses, `credits.ts:836-842`).
This is the piece `applyCredit` cannot do today: its `"adjustment"` kind moves balance
without touching window spend, so a settlement top-up would under-count against the monthly
cap and quietly let a client exceed 2600.

**Caps are NOT re-checked on a settlement top-up.** The work is already delivered; failing
the settlement would either strand the difference or, worse, retry forever. A top-up is
allowed to push `balance` negative and `monthSpent` past `monthlyLimit`. The *next* charge
is then correctly denied by `assessCharge` (`credits.ts:778`) with the existing
`insufficient_balance` message and the existing `CREDIT_BLOCK_REASON` line — no new UI state.
Cap the exposure with `SETTLEMENT_CAP_FACTOR` and surface it (below).

**Over-cap settlements need staff review.** When `creditsForUsd(actualUsd) > hold × 2`, we
settle at the cap and write the *uncapped* figure into the settlement row's `actualUsd`,
plus a job event: `Settled at the 2× cap — this run cost $X, above its Y-credit estimate.`
That is a signal that an estimate is stale, which §3(c) then self-corrects.

**Ledger `reason` copy** (≤120 chars, the existing limit):
`Run settled · est 25 → actual 18 · Instagram Agent`.

**Where settlement is called:**

| Path | Site | Cost source |
|---|---|---|
| agent-service | `api/agent-service/webhook/route.ts`, immediately after the `updateJob` at `:2078` and after the zero-deliverable correction has decided the final status | `payload.usage.totalCostUsd` |
| agent-service poll reconcile | `src/lib/agent-service/reconcile-job.ts:82` | `remote.usage.totalCostUsd` |
| agent-engine | `src/lib/agent-engine/reconcile.ts:209`, after persisting the cost (§2.4) and only for `update.status === "review"` | `view.run.totalCostUsd ?? totalStepCostUsd(view.steps)` |
| in-app model calls | `src/lib/client-model-charge.ts` — new `settleClientModelCall(call, chargedAt, actualUsd)`, and `withClientModelCharge`'s `run` gains an optional `ctx.settle(usd)` | the same figure the site already hands `logUsage` |

The webhook settlement lands **after** the single-use claim, so a crash between the two
loses it. That is acceptable *because* the sweep below retries it — the same
belt-and-braces the refund already has (`webhook/route.ts:552-559` explains why the refund
instead runs before the claim; settlement cannot, since it needs the post-claim final status).

**Sweep.** Extend `/api/credits/reconcile` with `listUnsettledHolds()`: jobs that are
terminal `review`/`done`, carry `external.totalCostUsd`, whose newest charge has neither a
`refund_` nor a `settle_` sibling, older than ~15 min. Re-calls `settleJobCharge`. Because
the settlement id is deterministic, the sweep is safe to run forever.

### (c) Self-calibrating estimates

New pure function in `src/lib/credit-reporting.ts` (kept out of `summarizeAgentEconomics`
for the reason in §2.5), or in `credits.ts` if it must stay import-free:

```ts
export const ESTIMATE_WINDOW = 10;        // last N settled runs
export const ESTIMATE_MIN_SAMPLES = 3;    // below this, fall back

export interface RunEstimate {
  credits: number;
  /** true when it came from the family default, not from measurement. */
  fallback: boolean;
  samples: number;
}

export function estimateRunCredits(input: {
  /** Newest-first actual USD of settled, successful runs of this agent for this client. */
  recentUsd: readonly number[];
  /** agent.creditCost ?? carriedDefault ?? CREDIT_COSTS.customAgentRun. */
  fallbackCredits: number;
}): RunEstimate;
```

**Median, not mean** — one runaway run must not move a client's quoted price. Sorted
middle of `recentUsd.slice(0, ESTIMATE_WINDOW)`, then `creditsForUsd(median)`. Under
`ESTIMATE_MIN_SAMPLES`, return the fallback with `fallback: true`. Never invent a number
from an empty sample — the same refusal `calibrateLaunchPrice` already makes
(`credit-reporting.ts`, "returns nulls rather than a fallback").

**Ladder, per client per agent:** this client's last N settled runs of this agent → *all
clients'* last N for the same agent → the family default constant → `customAgentRun`. Rungs
2–4 keep a brand-new client from being quoted nothing.

**Data source:** `job.external.totalCostUsd` filtered by `customAgentId` + `clientId` +
non-failed status — the jobs the agent page already loads for `AgentEconomicsCard`
(`agent-economics.tsx`, mounted from `control-room.tsx:135`), so no new read on the hot
path. `runCost` then becomes the estimate wherever it is passed down today
(`clients/[id]/agents/[agentId]/page.tsx:331,1199`).

**The hold stays the estimate.** Reserving the estimate — not a padded figure — keeps the
existing insufficient-balance UX honest, and the cap in §3(b) bounds the downside.

### (d) UI copy

| Where | Today | Becomes |
|---|---|---|
| `credit-price-note.tsx:49-52` | `Costs {price}` | `Costs about {price}` / `The client is charged about {price}` |
| `custom-agents.tsx:2607` run dialog | `Costs {creditsLabel(n)}.` | `Costs about {creditsLabel(n)}. You're charged what the run actually uses.` |
| `agent-detail-panel.tsx:186`, `live-card.tsx:292`, `legacy-agent-panel.tsx:186` | `Costs {n} credits` | `About {n} credits` |
| `credits-panel.tsx:190` mini card, `:248-272` full card | exact figures | `clientPriceText()` gains `approx?: boolean` → prints `~25`; header note "Prices are typical. You're charged what a run actually uses." |
| ledger row `credits-panel.tsx:400` | `{e.reason}` | settlement rows render `Charged {to} credits (est. {estimateCredits})` from the new fields; hold rows unchanged |
| run history / job page | — | one line per settled run: `Charged 18 credits · estimated 25` |
| `chat/route.ts:405-423` copilot prompt | exact | same list, with a sentence that these are typical and the charge follows real usage |

**One new helper, not eight inline strings**, matching `creditsLabel()`'s own docstring
about the surfaces "not each getting it right or wrong separately" (`credits.ts:233-241`):

```ts
export function estimatedCreditsLabel(amount: number): string {
  return `about ${creditsLabel(amount)}`;
}
export function settledCreditsLabel(actual: number, estimate: number): string {
  return `${creditsLabel(actual)} (est. ${estimate})`;
}
```

`credit-attribution.test.ts:379` asserts price copy never says "tokens" — the new strings
must keep that, and `credits-ux.test.ts` asserts no dashes in denial copy (AF-8).

### (e) Staff/admin: watching the $130 line

**Per-client, on the Credits panel, staff-gated** (the same `viewerIsStaff` hard gate
`agent-economics.tsx:51` uses — a client must never see our raw cost; that gate is
described there as the *structural* guarantee on top of the positional one):

```
Cost to us this month     $61.40 of $130
Client charged            1,228 of 2,600 credits
```

Both figures from data already in hand:

- **charged credits** = `credits.monthSpent` (already on the panel at `:211-222`);
- **cost to us** = Σ `job.external.totalCostUsd` for this client's jobs in the current
  `creditMonthKey` **including failed and cancelled ones** (§2.6.2) **plus** Σ
  `usageLogs.estimatedCostUsd` for `clientId` in the month, for the in-app calls.
  A new pure `summarizeClientMonthlyCost({ jobs, usageRows, monthKey })` in
  `credit-reporting.ts`; it must skip `pricingUnresolved` rows and say how many it skipped,
  never silently count them as $0.

**The alert.** `MONTHLY_COST_ALERT_FRACTION = 0.8`. When month-to-date actual USD exceeds
`0.8 × MONTHLY_ALLOWANCE × USD_PER_CREDIT` ($104), the panel shows a warning row and the
client appears flagged in `clients-grid.tsx` beside the existing `LOW_CREDIT_THRESHOLD`
badge (`clients-grid.tsx:569-576`). Because failures and unbilled staff runs are counted,
this figure can legitimately exceed `monthSpent × $0.05` — the gap between the two lines
**is** the leak in §2.6, and showing them side by side is what makes it visible.

**The existing report is the calibration check.** `scripts/dump-agent-cost-report.ts:101`
reads `usageLogs` directly (`orderBy timestamp desc, limit 5000`) and sums the stored
`estimatedCostUsd` (`:68,:137`) — **Karos cost only; it never touches the credit ledger.**
That makes it the natural side-by-side for shadow mode (§3f): run it against the settlement
log and the gap is the repricing, in dollars, before anyone is billed differently.

**Cross-client:** one column on `/admin/analytics` (which already has the `usageLogs`
aggregation machinery, `admin/analytics/page.tsx:257-260`, `data-analytics.ts:265-299`) —
cost-to-us this month per client vs their allowance. Note the page's own truncation warning
at `:480-484`: the ranking there is a partial log scan, so the per-client budget figure must
come from a complete query, not that aggregate.

### (f) Migration

- **Ledger:** untouched. Every existing row has no `phase`, which reads as final and is
  never settled. `settleJobCharge` only ever acts on rows it can pair, and refuses any row
  already carrying a `refund_` sibling.
- **Balances/caps:** one idempotent script, `scripts/set-monthly-allowance.ts`, following
  the existing `scripts/dump-agent-cost-report.ts` env/admin-init pattern: for every
  `clientCredits` doc, set `monthlyLimit = 2600`, `weeklyLimit = <Q2>`, and
  `balance = max(balance, 2600)` — **max, never assignment**, so a client holding a paid
  top-up is not silently robbed. Clients with no doc get it lazily from the new
  `CREDIT_DEFAULTS` on their first charge, as today.
- **Watch out:** `clients/[id]/page.tsx:310-312` computes `hasBillingConfigured` by
  comparing the doc against `CREDIT_DEFAULTS`. Changing the defaults flips that signal for
  every client at once. Either pin it to the old triple or re-derive it.
- **In-flight jobs at cutover:** a job charged under the old constants settles under the new
  rule and is refunded the difference. That is the correct direction (clients get money
  back). No special case needed.
- **Rollout order:** persist agent-engine cost → land settlement behind a
  `CREDITS_SETTLEMENT_ENABLED` flag (default OFF) → run a week in shadow mode (write the
  settlement row with `delta: 0` and log what it *would* have been) → compare against
  `dump-agent-cost-report.ts` → enable → then raise the allowance and switch the UI copy.
  Shadow mode is what makes the "prices drop 4–25× on the small actions" finding in §0
  a measured fact before any client sees it.

---

## 4. Exact changes, tests, risks

### 4.1 Files and functions

| File | Change |
|---|---|
| `src/lib/credits.ts` | Add `USD_PER_CREDIT`, `CREDIT_MULTIPLIER`, `MONTHLY_ALLOWANCE`, `MIN_SETTLED_CREDITS`, `SETTLEMENT_CAP_FACTOR`, `UNSETTLED_OPERATIONS`, `creditsForUsd()`, `applySettlement()`, `estimatedCreditsLabel()`, `settledCreditsLabel()`. Change `CREDIT_DEFAULTS` (`:577-583`). Add `approx` to `clientPriceText()` (`:570`) |
| `src/lib/types.ts` | `CreditLedgerEntry` (`:2636`) += `phase?`, `settlesEntryId?`, `estimateCredits?`, `actualUsd?` |
| `src/lib/credit-settle.ts` | **New.** `settlementEntryIdFor()`, `settleJobCharge()`, `listUnsettledHolds()`. Mirrors `credit-reconcile.ts` read-then-write + `tx.create()` structure |
| `src/lib/credit-reconcile-shared.ts` | Add `newestSettleableCharge()` beside `newestUnrefundedCharge()` (`:25`) — must exclude both refunded and settled |
| `src/lib/data.ts` | New `applySettlementToCredits()` transactional writer beside `creditClientCredits` (`:2952`); `listCreditLedgerByJobIds()` for the sweep |
| `src/app/api/agent-service/webhook/route.ts` | Call `settleJobCharge` after the `updateJob` at `:2078`, gated on final status `done` |
| `src/lib/agent-service/reconcile-job.ts` | Same call after `:82` |
| `src/lib/agent-engine/reconcile.ts` | **Persist** `external.totalCostUsd` in the `updateJob` at `:209`; then settle when `update.status === "review"` |
| `src/lib/client-model-charge.ts` | `settleClientModelCall()`; `ctx.settle(usd)` on `withClientModelCharge` (`:196`) |
| `src/app/api/credits/reconcile/route.ts` | Sweep unsettled holds |
| `src/app/api/credits/allowance/route.ts` | **New** monthly cron: `balance = max(balance, MONTHLY_ALLOWANCE)` |
| `src/lib/credit-reporting.ts` | `estimateRunCredits()`, `summarizeClientMonthlyCost()` |
| `src/lib/jobs/submit-custom.ts` | `runCost` (`:613-622`) reads the estimate; the decision comment at `:1017` must be rewritten, not left contradicting the code |
| `src/lib/agent-service/run-custom-agent.ts` | the scheduler's own charge at `:242` takes the estimate too — **the second charge path, easy to miss** |
| `src/lib/execution-engine.ts` | `plannedTaskExecutionCost` (`:99`) becomes the estimate for board-task dispatches |
| `src/lib/task-sync.ts` | `:295` already refunds a zero-deliverable task run; must not settle a charge it refunded |
| `src/components/credits-panel.tsx` | Estimate copy; settlement ledger rows; staff cost-to-us row + 80% alert |
| `src/components/credit-price-note.tsx` | "about" |
| `src/components/custom-agents.tsx` | `:2607` run dialog; `:2076-2124` weekly schedule estimate |
| `src/components/client-agents/{agent-detail-panel,live-card,legacy-agent-panel}.tsx` | "About N credits" |
| `src/app/api/clients/[id]/chat/route.ts` | `:405-423` prompt copy |
| `src/app/(app)/clients/[id]/page.tsx` | `:310-312` `hasBillingConfigured` vs the new defaults |
| `scripts/set-monthly-allowance.ts` | **New** migration |

### 4.2 Tests to add

- `credit-settle.test.ts` — the settlement arithmetic table (est 25 / actual $0.90 → 18,
  refund 7; est 25 / actual $2.00 → 40, deduct 15; est 25 / actual $4.00 → capped at 50);
  `creditsForUsd` floor and ceiling; `UNSETTLED_OPERATIONS` skipped.
- `credit-settle-idempotency.test.ts` — settling the same charge twice writes one row;
  a charge already refunded is never settled; a charge already settled is never refunded.
  (Mirror `credit-reconcile.test.ts`'s existing shape.)
- `credits.test.ts` — extend `applyCredit`'s block (`:209-222`) with `applySettlement`:
  window spend moves opposite to balance, **only** in the hold's own windows; a top-up
  crossing a month boundary does not inflate the new month.
- `credit-attribution.test.ts` — extend `:318` ("reads every figure off a pricing constant")
  and `:339` ("leaves no client-billable rate off the card") to the new constants;
  assert `MONTHLY_ALLOWANCE × USD_PER_CREDIT === 130` so the $130 line is pinned in code.
- `priced-press-announce.test.tsx` / `intake-press-announce.test.tsx` — the four
  `pressPrice` quotes now say "about"; keep the "never says token" assertion (`:111`).
- New `credit-estimate.test.ts` — median not mean; under `ESTIMATE_MIN_SAMPLES` falls back
  and says so; an empty sample never invents a number.
- Webhook: a `job.completed` redelivery settles once (extend the existing
  `webhook-zero-deliverable-refund.test.ts` / `webhook-step-usage-log-dedup.test.ts` fixtures,
  which already carry `usage.totalCostUsd`).
- `agent-engine/reconcile` — `totalCostUsd` is persisted onto `job.external`.

**Tests that will break and must be updated deliberately, not silenced.** These pin the
current fixed prices, so each one is a decision to re-record:

| Test | What it pins |
|---|---|
| `client-model-metering.test.ts:126,153,201,227,311,335,418,483,502,513,528,541,561` | the exact amount each live route/action charges and refunds — the broadest surface |
| `client-agent-rows.test.ts:1492-1504` | `launchCost === 500`, `runCost === 25` |
| `blog-agent-v2.test.ts:54`, `newsletter-agent-v2.test.ts:62,269`, `reputation-agent-v2.test.ts:73` | 10 / 10 / 25, and the `submit-custom` fallback expression |
| `credit-attribution.test.ts:74,354` | `UNIT = CREDIT_COSTS.customAgentRun`; every rate must appear on a price row |
| `agent-library-launch-price.test.tsx:132` | library row prints `creditsLabel(CREDIT_COSTS.customAgentRun)` verbatim |
| `seat-architecture.test.ts:7,17,33` | seat cost + refusal copy — must stay **unchanged** (`UNSETTLED_OPERATIONS`) |
| `submit-dynamic-agent.test.ts:152`, `dynamic-agent-charge-once.test.ts:97,116` | charged exactly once at snapshot price; retry/resume never re-charges — **the settlement must not break this**, it adds a second row of a different `phase`, not a second charge |
| `scheduled-run-billing.test.ts:57` | who pays per `billClientCredits` |
| `chat-route-model-pricing.test.ts:48-49` | a **source-scan** that the chat route charges via `chatMessageCreditCost`, not a literal — a good model for a new source-scan asserting no site computes `usd * 20` inline instead of calling `creditsForUsd` |
| `credit-reconcile.test.ts:182,185,193,218` | refund amounts and the no-double-refund guarantee |
| `webhook-zero-deliverable-refund.test.ts:152`, `task-sync-zero-deliverable.test.ts:23,66` | refund plumbing at 25 / 5 |

### 4.3 Risks

| Risk | Mitigation |
|---|---|
| **Double charging.** A settlement top-up applied twice | Deterministic `settle_<chargeEntryId>` + `tx.create()`, the identical guarantee `refund_<chargeEntryId>` already gives (`credit-reconcile-shared.ts:10`) |
| **Refund + settlement on the same charge.** A failed run refunded 25, then settled to 18 → client credited 32 for a run that produced nothing | The single hardest invariant. `newestSettleableCharge` must read the `refund_<id>` doc **inside the same transaction** (a `tx.get`, not a pre-read) and abort. Test it explicitly, in both orders |
| **Webhook retries.** The sender abandons at 30s while the re-host budget is longer (`webhook/route.ts` comment at the advisory pre-filter), so redelivery is routine, not rare | Settlement sits after the single-use claim, so a redelivery short-circuits at "Already processed"; the reconcile sweep is the real retry. Do **not** move settlement before the claim — it needs the post-claim final status (the zero-deliverable branch corrects `done` → `failed` at `:1936`) |
| **Race with the transactional charge.** A concurrent hold and a settlement on the same `clientCredits` doc | Both are single-doc Firestore transactions on `clientCredits/{clientId}`; Firestore serialises them. `applySettlement` must be computed *inside* the transaction from the freshly-read doc, never from a value read outside — the same discipline `chargeClientCredits` (`data.ts:2901-2914`) already follows |
| **Negative balance after settlement.** A run costing 3× its estimate can drive a client below zero | Bounded by `SETTLEMENT_CAP_FACTOR = 2`. Negative balance is *allowed* and blocks the next charge through the existing `insufficient_balance` path — no new UI state, and `availableCredits()` already floors at 0 (`credits.ts:858`) so no pill renders a negative |
| **Cost telemetry absent or unresolved.** `totalCostUsd` missing, or `pricingUnresolved` | Do not settle. Keep the estimate. Never treat missing cost as $0 — `credit-reporting.ts` already states this rule for its own averages, and it is the same rule here |
| **Estimates drift into a feedback loop.** Estimate feeds the hold; the hold caps the settlement at 2×; a persistently under-estimating agent keeps hitting the cap and never learns | The estimate is computed from **actual USD** (`job.external.totalCostUsd`), never from settled credits, so the cap cannot suppress its own input. Worth an explicit test |
| **In-request calls have no refund idempotency key.** The ~15 inline "produced nothing" refunds write auto-id ledger docs (`data.ts:2977`); nothing marks the charge as refunded | Settlement for in-request calls must be driven from the **charge row's own `settle_<id>` doc**, and `settleClientModelCall` must only be reachable from the success branch of `withClientModelCharge` — never paired with `ctx.refund` on the same run. Enforce with the `refundOnce`-style single-shot guard, not by convention |
| **The $130 line is not actually enforced** for staff-run schedules and failed runs (§2.6) | The §3(e) monitor shows both lines side by side; the gap between them is the leak, and it is visible rather than assumed |
| **A client's bill moves without warning.** Every `taskExecution`-priced press drops 5 → 1–2 | Shadow mode (§3f) measures it first; the direction is in the client's favour on almost every action |

---

## 5. Open questions for Albert

1. **Is 2600 the balance, the monthly cap, or both?** Recommended: `monthlyLimit = 2600`
   is the allowance, and a monthly cron tops `balance` up to 2600 with **no rollover** of
   unused allowance, while a paid top-up above 2600 survives (`max`, not assignment). Say
   if unused credits should roll over instead — it changes the cron from `max(balance, 2600)`
   to `balance += 2600`, and rollover means a client can eventually spend far more than $130
   in one month.
2. **Keep the weekly cap?** Today it is 150/wk against a 400/mo cap — a real burst limiter.
   Pro-rata it would be ~600/wk. Recommended: **drop it** (`weeklyLimit: null`) and let the
   monthly allowance be the only gate, because a client who wants to run their whole month
   in week one is not abusing anything and a second cap is a second denial message to
   explain. If you want it kept, name the number.
3. **Does the setup / launch charge settle to actual, or stay the measured admin-set price?**
   Recommended: **stays**, because the §6.3 calibration machinery already prices it from
   measured cross-client USD deliberately (`credit-reporting.ts`, `calibrateLaunchPrice`).
   Settling it per-run would make one client's unlucky setup 3× another's.
4. **Do you want the small actions repriced downward?** Under settle-to-actual, an audience
   simulation and a Task Map refresh go from 5 credits to 1–2, and a copilot message stays
   at 1. That is more generous than today by ~4×. If you want the small actions to keep
   recovering overhead rather than raw tokens, they should be added to `UNSETTLED_OPERATIONS`
   and stay flat.
5. **Should a client ever see a settlement that took *more*?** The design deducts the
   difference and shows `Charged 40 credits (est. 25)`. The alternative is to never charge
   above the estimate and eat the overage. Cheaper to build, more expensive to run, and it
   breaks the $130 guarantee.
6. **Is $130 a per-client ceiling or an average across clients?** The design treats it as
   per-client. If it is an average, the alert in §3(e) should be a portfolio figure and the
   per-client cap can be looser.

---

## Executive summary

1. The ruling's arithmetic is confirmed by the code: $130 ÷ 2600 = **$0.05 per credit**,
   so **credits = ceil(our USD × 20)**.
2. That multiplier is already roughly what the heavy agent-run prices imply — 25 credits ⇒
   $1.25, inside the "~$0.50–2 per product run" band `credits.ts:374-376` already documents.
3. It is *not* what the small actions imply: a 1-credit copilot turn implies $0.05 against
   ~$0.002 actual, and a 5-credit Task Map refresh implies $0.25 against ~$0.06.
4. Today every price is a fixed constant charged **upfront**; `submit-custom.ts:1017` rules
   token-based pricing out of scope in so many words. Nothing settles against actual cost.
5. Current defaults are `startingBalance 200 / weekly 150 / monthly 400` — the monthly cap
   must go to **2600**, and **no monthly refill exists anywhere today**; it is new work.
6. Actual USD per run **is already captured** for every agent-service run
   (`job.external.totalCostUsd`) and for every in-app model call (`usageLogs.estimatedCostUsd`).
7. The single telemetry gap is **agent-engine**: the engine reports `totalCostUsd`, the
   portal renders it live, and `syncJobFromAgentEngine` never stores it. Three-line fix.
8. Design is a **two-phase charge**: hold the estimate at dispatch (existing code), then
   settle to `ceil(actualUsd × 20)` on completion, capped at 2× the hold.
9. Idempotency reuses a pattern already in the repo: a deterministic ledger doc id
   `settle_<chargeEntryId>` written with `tx.create()`, exactly as `refund_<chargeEntryId>`
   works today. The critical new invariant is that a charge is **either refunded or settled,
   never both**.
10. Estimates self-calibrate from the **median** of the last 10 settled runs of that agent
    for that client, falling back to the family default and refusing to invent a number from
    an empty sample — the same posture `calibrateLaunchPrice` already takes.
11. `$130` is guaranteed by construction for charged credits, but **two leaks bypass it**:
    staff-fired and `billClientCredits: false` scheduled runs write no ledger row, and
    refunded failures burn real tokens. The staff panel shows "cost to us this month vs
    $130" beside "credits charged" so the gap is visible rather than assumed.
12. Land it in order: persist agent-engine cost → settlement behind a flag in shadow mode
    for a week → compare against `dump-agent-cost-report.ts` → enable → raise the allowance
    → change the client-facing copy to "about N credits".

---

Written to
`/private/tmp/claude-501/-Users-albertkattan-Karos-Labs-CMO--claude-worktrees-instagram-post-ordering-5c8eaa/cdf3554f-eb4b-4145-babb-1262ff4f23f8/scratchpad/credits-design.md`
