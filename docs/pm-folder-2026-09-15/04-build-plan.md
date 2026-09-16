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

## 2. What to add (not yet in any scope before this folder)

| Id | Item | Where |
|---|---|---|
| N1 | Connectors: token refresh (nothing works unattended without it), Meta version and metrics fixes, X threads and media, TikTok inbox mode, LinkedIn Community Management, Google Business Profile, the autopilot switch per client per platform, a vendor publisher (Ayrshare pilot) for the visual and video platforms. Items CN1 to CN12 in 03 Connectors | portal (OAuth, publish, metrics) + service (Ayrshare, platform reviews) + Albert (accounts, applications, autopilot defaults) |
| N2 | Sector overlays (L2) built at onboarding from the sector map; monthly refresh | portal (store, job) + engine (research) |
| N3 | Client layer (L3) from performance: outlier analysis, client rules with sample size and decay | portal |
| N4 | Sequencing: cadence from the calendar → stage, type, subject per slot | portal |
| N5 | Question gate: at most two questions per run, with a default; never on calendar runs | portal (UI, gate) + engine (raise the question) |
| N6 | Performance ingestion: followers and per-post metrics through connectors, scraping where not connected; what-works summary | portal + service (scraping provider) |
| N7 | Reporting and Home: search and AI visibility with rankings, reputation with a sentiment score, audience and growth, post performance, agent activity | portal |
| N8 | Humanizer: Rephrasy behind a per-client flag, blind test per pilot client | portal (client, harness) + service |
| N9 | Craft store: platform rules as data, ids, evidence counts; quarterly review job | portal |
| N10 | Engine page per product (steps, inputs read, outputs emitted, where A1 and A2 land), written by the engine's owners; 04's engine rows cite an engine step id the way portal rows cite a file and line | engine (Tomer, Shlomi) |
| N11 | 07 Pricing model rows renamed to the catalog's agents, one line naming the source of truth (repo constants vs the sheet) | Albert |
| N12 | Billing and plan selection: a plan field on the client, the credit allowance and the monthly cap read from it instead of the single 2600 constant, a plan picker as the last onboarding step, and the payment system behind it. This is what unblocks the credits rework flag | portal |

## 3. The evidence we have

The Craft pages (sourced, dated, hard rules separated from heuristics), the humanizer evaluation, the strategy template, the code audit in 02, the decisions log, and the feedback workbook. What we do not have yet: performance data of our own; every rule's lift (Craft 11, section 4) starts at zero evidence until connectors and ingestion run.

## 4. What Albert adds

- Examples on the agent pages: two or three target outputs per agent, and one "must never ship" example.
- Decisions: the five open items in 05. One is Albert's (the Campaign agent, O06), one is Albert with Tomer (O12), and three are Tomer and Shlomi's (O09, O10, O11).
- Accounts and applications only the company can open: X developer account on pay-per-use with a spend cap; Meta Business Verification and App Review; LinkedIn Community Management (registered entity, business email, the Karos Page's super admin); TikTok developer verification and the Content Posting audit; Google Business Profile API access (Karos's own profile verified 60+ days). Details and order in 03 Connectors section 8.
- Owners and sizes per item with Tomer and Shlomi; Jira tickets from the ids here.
- Pilot clients per platform for the blind tests and the first client layers.

## 5. Built here vs built by the developers

**Built here, with Claude Code cloud sessions on the portal repo** (reviewed in PRs, merged to prep): everything under "portal" above: the stores (subject table, feedback log, preferences, platform state, performance, craft rules), the run-context assembly and projection, the catalog bands and forms, the question gate UI, the goal rendering, connectors (OAuth, publish, metrics fetchers, the autopilot switch), the crons (ingestion, monthly loops), the slop lint and vendor clients, reporting and Home, the docs and the sheet, scripts and migrations.

**Built by the developers on other platforms:** the engine workflows (reading the new context, writing state back, emitting stage and goal, the humanizer call in the draft step, X text-only, Instagram format by performance, the topic pause, the three TikTok agents and their inputs), rendering and video tooling, the Reddit read path, the scraping provider integration, the platform app reviews and the Stripe integration.

**Rule:** a change that touches only this repo goes to a cloud session with a one-paragraph brief and the item id; a change that touches the engine goes to Tomer or Shlomi with the same id; both land in the same feedback row when tested.

Jira holds status (To Do, In Progress, Code Review, Prep = merged to main and on prep, Done = promoted to production); this file holds scope and why. Every ticket carries the item id from this file.
