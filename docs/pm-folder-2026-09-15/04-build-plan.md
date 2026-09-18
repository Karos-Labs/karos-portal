# Build plan

Status: draft 2026-09-15 · Owner: Albert · Changes when: a decision lands or an item ships. Items carry an id so the feedback sheet, Jira and this file point at the same thing.

## 0. What is in review right now

One pull request carries five changes, all portal-side, all green on typecheck and the full test suite: the Meta version pin and Instagram insights (CN2), token refresh for every connector (CN1), the engine-path setup gates (A3), the X thread and reply-link rendering (C3), and the removal of Facebook metrics (D26). Merging it deploys to prep.

## 0. The one ordering constraint

The credits rework (estimate, hold, settle to what a run actually costs us) is built and tested, and switched off behind `CREDITS_PLAN_V2_ENABLED`. It must stay off until N12 lands. The reason is not caution: the moment the flag is on, the first read of any client's credits doc in a new month grants them 2600 credits, because 2600 is the only allowance the code knows. A granted balance is never reduced. So switching it on before plans exist puts every client, including the $29 ones, on the Pro allowance permanently. Plan field first, then the flag.

## 0. Dates

- 2026-09-18 (Friday): flow, enrichment and five agents on prep.
- 2026-09-24: Meta Graph v20.0 sunsets (CN2); TikTok Community Guidelines revision takes effect (re-read the TikTok craft page).
- 2026-09-30: launch promised to investors.
- Every 60 days: LinkedIn re-consent per seat and page until partner refresh tokens exist (CN5).
- Two weeks from 2026-09-15: entity and bank account, then Stripe (D14).

## 1. What to integrate now

Ranked. "Where" says which codebase or service the work lives in: **portal** = the Next.js/Firestore repo (this can be built here with Claude Code cloud sessions); **engine** = agent-engine, Tomer and Shlomi; **service** = a third party we sign up to; **decision** = Albert.

| Id | Item | Why now | Where |
|---|---|---|---|
| A1 | Hand every run its live context: intake, voice profiles, learning log, prior drafts, subject table, feedback, craft layers. Today they are built and dropped at the deleted agent-service boundary | Nothing the portal learns reaches a run | portal (assemble, project) + engine (read) |
| A2 | Capture what a run produces back: state files, voice files, platform state, subject rows | The loop cannot close without it | engine (write) + portal (store) |
| A3 | Fix the LinkedIn, Newsletter and Blog setup gates on the engine path (**shipped, in review**) | A new client may be refused on every press | portal |
| B1 | Subject table: written at draft, review and posting; read by sequencing and research | Anti-repetition and reporting | portal |
| B2 | One feedback log across agents, and derived preferences written to the client (never-topics, likes, voice lessons) | Feedback never becomes rules today | portal |
| C1 | Strategy map per client per platform with a stage on every row | The topic pool with goals | portal (store) + engine (build at setup) |
| C3 | Goal, who it is for, why now on every output; remove account-manager and revision meta. The X thread and reply-link half is **shipped, in review**; the goal line still needs the engine to emit it | engine (emit) + portal (render) |
| F1–F3 | Catalog in three bands; three TikTok cards with their own forms; SEO/GEO and Reputation moved to Reporting; placeholders for coming-soon | Five agents on prep by Friday | portal |
| G3 | Instagram topic-first switch: manual run = client picks, calendar = autopilot | Settled | portal (gate UI) + engine (pause at topic) |
| K5 | Quality gate in drafting: slop lint, humanizer client, detector telemetry, checklist | "Not AI slop" | portal (lint module, clients) + engine (call in draft step) |

## 1.5 Owners and sizes (O11, settled 2026-09-18 as D44)

Sized against the code that is in `main` in all three repos on 2026-09-18 (karos-portal `9b9ab30`, agent-engine `1217cb4`, agent-middleware `1212825`), row by row, file by file — not against the row's own description, which in several places is a year behind the code. **S** is one day or less, **M** two to four, **L** five to ten, for one worker including tests and review. A blocked row is sized for what its own half costs *once the blocker lands*, with the blocker named; sizing a blocked row as "big" hides which half is actually big.

Owners follow §5's rule rather than being new decisions: portal rows go to a Claude Code cloud session reviewed by Shlomi, engine rows to Tomer and Shlomi, and the rows below that need an account, a vendor or a call are marked and are Albert's.

### Portal

| Id | Owner | Size | Against what |
|---|---|---|---|
| A1 | cloud · Shlomi | **L 5d — split** | `context-doc-projection.ts` projects context docs, brand and profile, and fires only from Regenerate and branding refresh, never from dispatch; the dispatch envelope carries `inputs` and nothing else. **A1a** project at dispatch with today's sources: M 3d, unblocked. **A1b** the remaining sources: S 1d each, blocked on B1, B2, N9 existing |
| A2 | cloud · Shlomi | **M 3d** | `learning-collect.ts` already calls the middleware's `collect`, fire and forget. D42 puts the store in the middleware, so this is calling it on the paths that matter and proving the read-back — not a new store |
| A3 | — | shipped | |
| B1 | cloud · Shlomi | **M 4d** | Nothing portal-side. `config.subject_rows` and `GET /clients/{slug}/learning/{platform}/subjects` already exist, so this is a writer at draft, review and posting plus a reader |
| B2 | cloud · Shlomi | **L 5d** | Four siloed per-product feedback collections. `learning-feedback.ts` already has the preferences read and write against the middleware with **no callers anywhere** — dead code waiting to be wired |
| C1 | cloud · Shlomi | **M 3d** (blocked: engine) | No strategy map or stage concept in the portal |
| C3 | — | portal shipped | goal line renders, including Instagram and TikTok. Engine emit is the rest |
| F1–F3 | — | shipped | |
| G3 | cloud · Shlomi | **M 3d** (blocked: engine) | Gate UI and the manual-versus-calendar rule. Untestable until a run can pause |
| K5 | cloud · Shlomi | **L 8d — split** | Nothing exists. **K5a** slop lint M 3d, unblocked, most value per day · **K5b** humanizer client = N8 · **K5c** detector telemetry M 2d |
| N1 | Albert (accounts) + cloud (code) | **L 10d+ — not one row** | CN1 and CN2 shipped; the other ten are paced by app reviews and developer accounts, not by code. Size per CN id |
| N2 | cloud · Shlomi | **M 3d** (blocked: engine) | Store and monthly job are portal; the overlay content is research |
| N3 | cloud · Shlomi | **M 4d** (blocked: N6 data) | `getClientPerformanceBenchmarks` is a flat top and bottom ranking recomputed per read — no outlier test, no persisted rules, no sample size, no decay |
| N4 | cloud · Shlomi | **M 3d** (blocked: B1, C1) | The calendar half is built (`run-cadence.ts`, `slot-plan.ts`, the slot horizon). Slots carry a date and a type and have no stage or subject to carry |
| N5 | cloud · Shlomi | **M 3d** (blocked: engine) | UI, the two-question cap and the never-on-calendar rule. `schedule-gate.ts` gates setup completeness, not questions |
| N6 | cloud · Shlomi | **S 2d** + one ops job | `/api/followers/sync` and `/api/analytics/sync` are in. Left: follower sources for Reddit, TikTok and primary LinkedIn, and a what-works summary. The daily Cloud Scheduler job is ops, minutes, and until it exists this row writes nothing |
| N7 | cloud · Shlomi | **L 6d** (partly blocked: N6 data) | Visibility tile and audience KPIs are in. Missing: reputation sentiment, a client-facing post-performance surface, client-facing agent activity |
| N8 | Albert (vendor) + cloud (code) | **M 3d** after signup | No code at all; the Rephrasy account gates the start |
| N9 | cloud · Shlomi | **L 5d** | The schema is fully specified in Craft 11 and none of it is code. Most of the 5d is the import script and getting the pages in faithfully |
| N12 | cloud · Shlomi | **M 4d** without Stripe, **L** with | `MONTHLY_ALLOWANCE = 2600` is hardcoded and the flag is a global kill switch, not a plan. The 4d — plan field, per-plan allowance and cap, picker — is the whole of what removes the ordering constraint at the top of this file, and it does not wait for the bank account |
| N13 | cloud · Shlomi | **M 4d** | Cheaper than it reads: the engine already fans out to one review gate and the routing entry exists. Missing is the button, the shared brief and the bundle screen |

### Engine

| Id | Owner | Size | Against what |
|---|---|---|---|
| A1 | Tomer/Shlomi | **shipped** (+S 1d) | `readLearningContext` — platform state, subject window, feedback, preferences, strategy map, craft — is called by all six publishing workflows. The eight non-publishing agents do not call it, and only Blog and Newsletter obviously should |
| A2 | Tomer/Shlomi | **shipped** (+S 1d) | `ledger.writeRunState` writes the run record and upserts platform state, idempotent on runId. Same six callers, same eight gaps |
| C1 | Tomer/Shlomi | **S 1d — or change the row** | `ensureStrategyMap` builds the map in one checkpointed call, but lazily on the first drafting run rather than at setup. Recommend changing this row to "on first use": a client who never runs an agent never pays for a map |
| C3 | Tomer/Shlomi | **S 2d — and narrow the row** | All six publishing agents emit the goal line. Of the seven that do not, only Blog and Newsletter produce something a client reads as a post; on the five report agents a goal line is noise |
| G3 | Tomer/Shlomi | **L 8d — the big one** | Topic selection is built and fully automatic. What does not exist anywhere in the engine is a way to stop a run and wait for a person: no gate, no suspend, no resume. This is a new capability, not a step in one agent, and it is the most under-sized item in this file |
| K5 | Tomer/Shlomi | **M 4d** + S | Instagram carries five real gates already; X, LinkedIn and Reddit carry none. Porting them is the 4d. The humanizer call is a day once N8's client exists |
| N2 | Tomer/Shlomi | **M 4d** | Storage is done (`config.craft_rules.sector`, D41 layering, admin bulk upsert). Missing is the research that fills it — L2 rules are hand-entered today |
| N5 | Tomer/Shlomi | **S 1d after G3** | It needs G3's suspend-and-resume and nothing else. **G3 and N5 are one capability wearing two ids** |
| N10 | Tomer/Shlomi | **L 6d — splittable** | No per-agent doc exists; `agents/README.md` is a stale stub. About half a day per agent, one agent per PR, starting with the six that already read and write the loop |

### Middleware

**Nothing here is unbuilt.** `config` already carries `subject_rows`, `client_preferences`, `learning_settings`, `client_feedback_log`, `run_feedback`, `platform_state`, `strategy_maps` and `strategy_map_rows`, `craft_rules` with D41's layering, and `run_state_records`; the endpoints for collect, preferences, subjects, strategy map and craft rules are live, and the C4 capability fields are first-class on the agents API. Size: 0. That is why B1 and B2 above are M and L rather than L and XL — they are wiring, not construction.

### What the sizes change about this file

1. **A1, A2, C1 and C3 are substantially done on the engine side** for the six agents that publish, and the middleware has no open row at all. §1 and §2 read as if none of that exists. The learning loop's remaining gap is almost entirely portal-side wiring.
2. **G3 and N5 are one capability** — suspend a run for human input — and together they are an L, not the M each row implies. Sequence G3 first and mark N5 as depending on it, or merge them.
3. **N6's scraping clause is closed by D43** and is struck from §2 and §5 in the same change as this section.
4. **N1 and K5 cannot be scheduled as single rows.** Split N1 per CN id and K5 into K5a/K5b/K5c.
5. **Almost nothing is waiting on Albert.** Only N1's accounts and N8's vendor. §4's "Nothing is waiting on Albert" is right, and the rest of §4 can say so more plainly.

### The unblocked portal order

**N6 remainder 2d → B1 4d → A1a 3d → N12 without Stripe 4d → K5a 3d → N13 4d.** About twenty days of work, so two to three weeks at one session — not one week. Everything else in §1 and §2 is blocked on the engine, on an account, or on data that does not exist yet.

## 2. What to add (not yet in any scope before this folder)

| Id | Item | Where |
|---|---|---|
| N1 | Connectors: token refresh (nothing works unattended without it), Meta version and metrics fixes, X threads and media, TikTok inbox mode, LinkedIn Community Management, Google Business Profile, the autopilot switch per client per platform, a vendor publisher (Ayrshare pilot) for the visual and video platforms. Items CN1 to CN12 in 03 Connectors | portal (OAuth, publish, metrics) + service (Ayrshare, platform reviews) + Albert (accounts, applications, autopilot defaults) |
| N2 | Sector overlays (L2) built at onboarding from the sector map; monthly refresh | portal (store, job) + engine (research) |
| N3 | Client layer (L3) from performance: outlier analysis, client rules with sample size and decay | portal |
| N4 | Sequencing: cadence from the calendar → stage, type, subject per slot | portal |
| N5 | Question gate: at most two questions per run, with a default; never on calendar runs | portal (UI, gate) + engine (raise the question) |
| N6 | Performance ingestion: followers and per-post metrics through connectors; what-works summary. **Connected platforms only — D43 closed the scraping half: where a client has not connected the account we record nothing and say so** | portal |
| N7 | Reporting and Home: search and AI visibility with rankings, reputation with a sentiment score, audience and growth, post performance, agent activity | portal |
| N8 | Humanizer: Rephrasy behind a per-client flag, blind test per pilot client | portal (client, harness) + service |
| N9 | Craft store: platform rules as data, ids, evidence counts; quarterly review job | portal |
| N10 | Engine page per product (steps, inputs read, outputs emitted, where A1 and A2 land), written by the engine's owners; 04's engine rows cite an engine step id the way portal rows cite a file and line | engine (Tomer, Shlomi) |
| N11 | 07 Pricing model rows renamed to the catalog's agents, one line naming the source of truth (repo constants vs the sheet) | Albert |
| N12 | Billing and plan selection: a plan field on the client, the credit allowance and the monthly cap read from it instead of the single 2600 constant, a plan picker as the last onboarding step, and the payment system behind it. This is what unblocks the credits rework flag | portal |
| N13 | Launch button: the client names one thing they are launching, and we run the relevant agents to produce a set of posts around it, reviewed together. Replaces the Campaign agent, which is unlisted (D40). The engine already fans out and reviews as one bundle; what is missing is the button, the shared brief and keeping it out of the agents catalog | portal (UI, brief) + engine (already fans out) |

## 3. The evidence we have

The Craft pages (sourced, dated, hard rules separated from heuristics), the humanizer evaluation, the strategy template, the code audit in 02, the decisions log, and the feedback workbook. What we do not have yet: performance data of our own; every rule's lift (Craft 11, section 4) starts at zero evidence until connectors and ingestion run.

## 4. What Albert adds

- Examples on the agent pages: two or three target outputs per agent, and one "must never ship" example.
- Decisions: O09, O10 and O11 were all settled on 2026-09-18, as D42, D43 and D44 in 05. **05's Open table is empty.** Sizes and owners for every row are in §1.5, and the two things still genuinely waiting on Albert are N1's platform accounts and N8's Rephrasy account — nothing else in §1 or §2 is.
- Accounts and applications only the company can open: X developer account on pay-per-use with a spend cap; Meta Business Verification and App Review; LinkedIn Community Management (registered entity, business email, the Karos Page's super admin); TikTok developer verification and the Content Posting audit; Google Business Profile API access (Karos's own profile verified 60+ days). Details and order in 03 Connectors section 8.
- Owners and sizes per item with Tomer and Shlomi; Jira tickets from the ids here.
- Pilot clients per platform for the blind tests and the first client layers.

## 5. Built here vs built by the developers

**Built here, with Claude Code cloud sessions on the portal repo** (reviewed in PRs, merged to prep): everything under "portal" above: the stores (subject table, feedback log, preferences, platform state, performance, craft rules), the run-context assembly and projection, the catalog bands and forms, the question gate UI, the goal rendering, connectors (OAuth, publish, metrics fetchers, the autopilot switch), the crons (ingestion, monthly loops), the slop lint and vendor clients, reporting and Home, the docs and the sheet, scripts and migrations.

**Built by the developers on other platforms:** the engine workflows (reading the new context, writing state back, emitting stage and goal, the humanizer call in the draft step, X text-only, Instagram format by performance, the topic pause, the three TikTok agents and their inputs), rendering and video tooling, the Reddit read path, the platform app reviews and the Stripe integration. (The scraping provider integration that stood here is closed by D43.)

**Rule:** a change that touches only this repo goes to a cloud session with a one-paragraph brief and the item id; a change that touches the engine goes to Tomer or Shlomi with the same id; both land in the same feedback row when tested.

Jira holds status (To Do, In Progress, Code Review, Prep = merged to main and on prep, Done = promoted to production); this file holds scope and why. Every ticket carries the item id from this file.
