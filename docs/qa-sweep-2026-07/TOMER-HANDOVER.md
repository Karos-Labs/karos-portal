# Tomer handover — QA sweep 2026-07

> **Status: DRAFT v1 — 2026-07-28.** Written mid-campaign (Phase 2, wave A) and
> refreshed as later phases land. Section numbers are stable anchors — later
> updates append or amend inside sections, never renumber them. Every code
> reference is file + symbol (never line numbers — they rot); every claim below
> was verified against the working tree on the date in the changelog row.

| Version | Date | State of campaign when written |
|---|---|---|
| v1 (this draft) | 2026-07-28 | Phase 1 merged · CALENDAR cluster merged · DOCS cluster merge in progress · AGENTS / SEO / WORKSPACE / remaining clusters in flight · Phase 3 not started (`phase3-design.md` does not exist yet) |

**Audience:** Tomer, doing the final integration mile (agent-service runtime,
GCP infra, connectors) — plus Albert for the ops steps in §2. Read §1 to
orient, §6 before touching any code, then work §2–§5.

---

## 1. State of the branch

Branch: `claude/karos-portal-qa-feedback-7efbdf`, forked from `main` at
`bdb5f23`. Everything below merged serially into this one integration branch;
parallel fixers work in isolated worktrees and never push.

### 1.1 What this campaign is

A 137-finding QA sweep of the client portal (Daniel's 27 Jul PDF, live-portal
screenshots) plus Albert's call directives from 2026-07-27. All campaign state
lives in `docs/qa-sweep-2026-07/`:

| File | What it is |
|---|---|
| `LEDGER.md` | **Single source of truth.** One row per finding + a CD table for call-directive items with no finding number. |
| `rescopes.md` | Orchestrator rulings accumulated during execution. **Overrides the PDF specs** — re-pointed fixes, struck clauses, composition rules, accepted residuals. If a finding appears here, this wins. |
| `inventory/findings-p*.md` | Full spec per finding (`## F<n>` entries), verified field-by-field against the PDF. Tail of `findings-p161-199.md` = killed-claims list + colophon. |
| `inventory/screenshots/` | 87 annotated live-portal screenshots, `F<n>.png`. |
| `call-directives-2026-07-27.md` | Albert's lettered directives (A architecture, B SEO, C ops, D Tomer/infra, E context). |
| `master-plan.md` | Phasing model, cluster map, deferred-to-Tomer criteria. |
| `team-design.md` | The verification system (below). |
| `fixer-brief.md` | Standing brief every fixer follows — §6 of this doc distills its hazards. |

### 1.2 How to read LEDGER.md

Status values: `OPEN` · `IN-PROGRESS` · `RESOLVED` · `OPS-PENDING` (code
merged, a human ops step remains — the step is in §2) · `DEFERRED-TOMER`
(yours; every such row gets a §4 entry with seams) · `STRUCK` (claim did not
survive verification — evidence in `rescopes.md`). A row flips to RESOLVED only
after the full gate in §1.5. Track A/B labels are the PDF's own split (A =
polish, B = behavior/architecture) and drive reviewer attention, not phasing.

### 1.3 Phase 1 — blocker wave (merged, complete)

Commit range `b92de80..f8805c3` (`f8805c3` = "Phase 1 complete" marker).
All 8 blockers, each its own fixer + full gate, merged serially:

| Finding | Fix commit(s) | Merge |
|---|---|---|
| F1 — SEO/GEO action plan remounted for clients (`SeoGeoActionPlan` ← `buildRecommendations` in `src/lib/seo-geo.ts`) | `b92de80` | `36a5200` |
| F46 — per-draft pick/post/skip reader mounted in `AssetDetailModal` (`src/components/asset-detail-modal.tsx`) | `271c381` | `1df1ae2` |
| F47 — deliverables rendered, not dumped (`renderAssetBody` / `AssetContentBody`) | `29f8c81` + bounce `b8c91ce` | `1df1ae2` |
| F97 — dashboard attention row truthful, deep-links `/tasks?tab=archive` | `350a1a2` | `66a5941` |
| F125 — AI Insights: no briefing from demo metrics for clients | `6c4b2c0` + bounce `0194bff` | `955fe61` |
| F24 — failed schedule no longer shows green "Live" | `6643acf` + bounce `3b36122` | `6aad905` |
| F131 — "Run now" disabled beside a blocked setup chip | `cff5c1a` + bounce `344a97d` | `6aad905` |
| F127 — clients read `clientBlurb`, never the lab skill manifest | `da22c18` + bounce `812b517` | `6aad905` |

All RESOLVED except **F127 = OPS-PENDING** on the backfill script run (§2.1).

### 1.4 Phase 2 — subsystem clusters (in progress at draft time)

- **CALENDAR — merged** (`f811c08`, fixes `14e7510..dce2bc7` + 3 verifier
  bounces `22c495b`/`aceb6da`/`90dbbdc`): F107, F108, F151, F109, F110, F111,
  F112, F142 all RESOLVED (some with accepted residuals — §5.2).
- **DOCS — merge in progress** in the integration worktree as this draft is
  written (F86 tier-clamp bounce accepted; expect F74–F86/F138–F140 rows to
  flip shortly after this draft).
- **AGENTS, SEO, WORKSPACE, COPILOT, DASHBOARD, CREDITS, SHELL — in flight**
  in fixer worktrees. Where this doc says "arrives with the AGENTS merge",
  the current integration branch does **not** have it yet.

### 1.5 The verification system every merged fix passed

1. **Deterministic gates** — `npx tsc --noEmit` · `npm run build` ·
   `npx vitest run`.
2. **Three adversarial Opus lenses**, each prompted to refute the fix:
   *risk* (blast radius: credits, roles, webhook contracts, Firestore writes),
   *drift* (matches the prescribed fix + call directives, guard zones intact),
   *mock-client* (browser-only walk of the live flow vs the PDF screenshot).
   Any red = bounce to the fixer (the "bounce" commits above).
3. **Fable orchestrator review** of every diff, then serial merge.

Trust implication for you: a RESOLVED row means the symptom was re-verified in
a running portal, not just code-reviewed. The bounce commits are part of each
finding's fix — don't cherry-pick a fix commit without its bounces.

---

## 2. Ops runbook (Albert or Tomer)

Standing rule for everything in this section: **the dev `.env.local` points at
production Firestore.** Every script in `scripts/` is dry-run by default,
writes only with `--apply`, and is guarded by `require.main === module`.
Read the printed plan before applying. Nothing here was run by the agents.

### 2.1 `scripts/backfill-agent-blurbs.ts` — required to finish F127

Why: agent cards/run dialogs used to render `description` — the lab repo's own
skill manifest — straight to clients. `clientBlurb` is now the client-facing
field; agents imported before it existed have none and **fall back to the
manifest until this runs**. Code is merged; the ledger row stays OPS-PENDING
until:

```bash
npx tsx scripts/backfill-agent-blurbs.ts            # dry run — prints the plan
npx tsx scripts/backfill-agent-blurbs.ts --apply    # writes clientBlurb only
```

Things to know before running:

- **Instagram/TikTok match ordering warning:** blurbs are matched on the agent
  KEY (never the display name), first hit wins. The combined
  `karos-instagram-tiktok-content-agent` contains both "instagram" and
  "tiktok" and must be caught by its own exact-key pattern before either
  single-platform pattern — the BLURBS table in the script is ordered for
  this. If you add patterns, keep specific keys above broad ones.
- Agents no pattern matches are **reported, not guessed at** — the dry run
  prints them. For each unmatched agent either add a pattern or write the
  blurb by hand in the admin agent editor.
- `description` is never touched; agents that already have a `clientBlurb`
  are skipped. Blurbs are lint-checked against `LAB_JARGON_RE` (the same
  gate as `src/lib/agent-service/custom-agent-import.ts`).

### 2.2 `scripts/backfill-asset-titles.ts` — NOT YET WRITTEN

Placeholder. F33 (every deliverable titled "<Agent name> - <Client name>") is
with the in-flight AGENTS cluster; if its fix needs a backfill of existing
asset titles, the script lands here under the same dry-run convention. At
draft time no such file exists in `scripts/` — refresh this row when the
AGENTS cluster merges.

### 2.3 Other scripts in `scripts/` (pre-sweep maintenance, same convention)

`backfill-branding.ts`, `clear-ai-processing-lock.ts` (§2.4),
`dedupe-competitors.ts`, `import-lab-client.ts`, `migrate-legacy-roles.ts`,
`purge-orphaned-client-docs.ts`, `redate-content-calendar.ts`,
`schedule-approved-assets.ts`. None are part of this sweep's pending ops, but
they're the house style any new migration must follow.

### 2.4 Credit reload + SEO/GEO regenerate (call directive C2)

Human step because it needs real credits. Order matters — regenerate charges
nothing (admin-triggered) but the pipeline dies without API budget:

1. **Reload credits:** admin → client settings page → credits panel →
   `adjustCreditsAction` (`src/lib/actions/credit-actions.ts`, admin-only,
   whole-number grant with note; ledger entry written transactionally in
   `src/lib/data.ts`). There is no self-serve top-up — this is the only path.
2. **Regenerate SEO/GEO:** admin → client Documents → Regenerate
   (`RegenerateModal` in `src/components/client-documents.tsx` →
   `generateIntelReportAction` in `src/lib/actions/intel-actions.ts`). Re-runs
   the whole Intel pipeline including the SEO/GEO capture (needs
   `OPENAI_API_KEY` + `GEMINI_API_KEY`; a missing key degrades that engine to
   UNAVAILABLE, non-fatal).
3. If a run dies mid-cycle the `isAiProcessing` lock self-heals after
   `AI_PROCESSING_LOCK_STALE_MS` (20 min, `src/lib/constants.ts`); to clear it
   sooner: `npx tsx scripts/clear-ai-processing-lock.ts "<client name or id>"`.

Context: snapshots captured before the 2026-07-23/24 redeploy are unreliable
(call directive B4); regeneration is what replaces them. The SEO cluster is
separately marking pre-cutoff snapshots stale in the UI.

### 2.5 Password rotation (call directive D3)

Rotate the **Hello email account** password (`hello@karoslabs.com` — the
`ADMIN_EMAIL` / `EMAIL_FROM` identity, also the account that mails Pitch by
Deel their daily posts). Pure ops, zero code. Not automated on purpose.

### 2.6 Agent-service env for local dev

Without these, the portal runs but: staff Agents page shows "Agent service not
configured", the client lens shows an empty agent list, and no live run states
are constructible (this is why F24/F131 were verified by code lenses — noted
in the ledger header). From `.env.example`:

| Var | Local dev value | Notes |
|---|---|---|
| `AGENT_SERVICE_URL` | `http://localhost:8080` | Unset hides the managed-agents UI entirely (F34's misleading empty state — AGENTS cluster is fixing the copy, not the gate). |
| `AGENT_SERVICE_TOKEN` | `dev-token` | Sent as `X-Karos-Service-Token`; must match an entry in the service's `AGENT_SERVICE_TOKENS`. |
| `AGENT_SERVICE_AUDIENCE` | empty locally | Prod only — enables the Cloud Run IAM ID token alongside the app token. |
| `AGENT_WEBHOOK_SECRET` | `dev-webhook-secret` | HMAC for `/api/agent-service/webhook`; comma-separated for rotation; **receiver rejects everything when unset**. |
| `AGENT_SERVICE_CALLBACK_URL` | usually unset | Falls back to `NEXT_PUBLIC_APP_URL`; it's the base the service posts webhooks back to. |
| `MCP_JOB_TOKEN_SECRET` | optional | Signs job-scoped MCP tokens for mid-run `/api/mcp` callbacks; falls back to the first `AGENT_WEBHOOK_SECRET`. |
| `AGENTS_REPO_GITHUB_TOKEN` | `gh auth token` | Read access to karos-agents; enables the staff "Import lab outputs" flow. |

The service itself lives in `agent-service/` (own `DEPLOY.md`, Makefile,
docker-compose). Prod wiring is already in the portal's `cloudbuild.yaml`
deploy step (secrets `agent-service-tokens` / `agent-webhook-secret`,
substitution `_AGENT_SERVICE_URL`).

### 2.7 `ANALYTICS_LIVE_INGEST` — open question for prod

`liveIngestEnabled()` in `src/lib/integrations/analytics-providers.ts` gates
live per-post metric fetching on `ANALYTICS_LIVE_INGEST === "1"`; off/absent =
deterministic mock metrics. **If it is unset in the GCP runtime, every
analytics record is mock**, and after F125 the mock gate means every client
sees the "connect a social account" empty state even with channels connected
(observed on Karos Labs: Google/LinkedIn/YouTube show CONNECTED while insights
says connect — consistent with the flag being unset). Decision needed
(Albert/Tomer): flip it on in prod once real platform tokens exist, or accept
the connect-state copy until then. Nobody on the sweep could see the GCP env
to confirm the current value.

---

## 3. Infra

### 3.1 Cloud Run: `after()` background work needs CPU

`cloudbuild.yaml` (`cloud-run-deploy` step) currently deploys with
`--min-instances=1` (already present — keeps one instance warm) but **without
`--no-cpu-throttling`**. Several merged fixes run follow-up work in Next.js
`after()` — e.g. the DOCS cluster's sibling-tier correction propagation, and
UI copy that says generation "continues in the background". Under
request-based billing the CPU is throttled once the response is sent, so all
`after()` work is best-effort. **Add `--no-cpu-throttling` to the deploy args**
(instance-based billing) or move those jobs to Cloud Tasks/Scheduler. Related:
the 20-minute stale-lock self-heal (§2.4) is the safety net when background
work is killed mid-cycle.

### 3.2 Video deliverables — GCP block storage (F150 / CD-D1)

Plan agreed on the call: videos live in GCP block storage; the agent service
fetches from there; **no media in git**. Split of labor:

- **Portal side (this campaign builds it):** render/URL plumbing against a
  storage-URL field on assets. F150 is OPEN with the WORKSPACE cluster at
  draft time — refresh here with the field name + component seam when it
  lands.
- **Tomer side:** the actual GCP bucket, upload path, and the agent-service
  fetch. The portal will not sign URLs or proxy bytes until you decide the
  access model (public bucket vs signed URLs — signed URLs will need a
  server-side signer beside the existing Admin-SDK credentials).
- Known duplication to resolve while in there: the ~20-line LinkedIn media
  artifact filter (`liMedia`, durable re-hosted artifacts only) is duplicated
  verbatim in `src/components/asset-card.tsx` and
  `src/components/asset-detail-modal.tsx` — extract a shared helper as part
  of the video work; until then any change must edit both.

### 3.3 TikTok connector (CD-D2 / call directive D2)

Blocked on TikTok verifying the Karos Labs account — nothing code-side can
unblock it. Current portal state: TikTok OAuth wiring exists
(`TIKTOK_CLIENT_KEY`/`TIKTOK_CLIENT_SECRET` in `.env.example`, brand styling
in `src/components/integrations-tab.tsx`), and CD-D2 (AGENTS cluster, OPEN at
draft time) makes the portal show the TikTok agent's connector state as
**"pending verification" rather than pretending**. Two cautions from
`.env.example` that apply to you when verification lands:

- `TIKTOK_RESEARCH_API_APPROVED` must stay unset until TikTok confirms the
  elevated product — flipping it early makes the platform reject the entire
  OAuth request, breaking the already-working base connection for every
  client (same trap as `META_ADVANCED_ACCESS_APPROVED`).
- The TikTok agent itself rides the unified launch-vs-runs model (§4.1), as a
  1-template agent — don't build it a bespoke surface.

---

## 4. Deferred / Tomer-bound items — exact seams

Per `master-plan.md`, a finding is deferred to you only if it needs external
credentials/infra we don't hold, changes the agent-service runtime contract
beyond the portal's side of the webhook, or Albert deferred it on the call.
At draft time **no ledger row carries DEFERRED-TOMER yet** — the items below
are the known Tomer-bound work from the call directives and orchestrator
rulings; the ledger rows will be re-tagged as clusters close.

### 4.1 Launch-vs-runs model — agent-service seams (Phase 3 will refine)

The call's core product decision (directives A1–A5; findings F147/F148): every
client-facing content agent becomes parent (platform agent per client) +
children (template streams), with a one-time **launch** (setup/research)
phase and a recurring **runs** phase. **Phase 3 designs and builds the portal
side; `phase3-design.md` did not exist when this draft was written — treat
this subsection as a placeholder to be replaced by that design's contract.**
What is fixed today, and where the runtime seams are:

- **Submit path:** `submitManagedJobAction`
  (`src/lib/actions/external-job-actions.ts`) and the custom-agent path
  (`src/lib/actions/custom-agent-actions.ts`) both funnel into the shared
  `submitManagedJob` core (`src/lib/jobs/submit-managed.ts`) — the same core
  the task-board execution engine (`src/lib/execution-engine.ts`) and the MCP
  `submit_job` tool use. Any launch-vs-run distinction the service needs
  (e.g. a `phase: "launch" | "run"` field) enters here.
- **Result path:** `/api/agent-service/webhook`
  (`src/app/api/agent-service/webhook/route.ts`) — creates all deliverables
  as `status: "draft"` and mirrors runs into `jobs` with agentId
  `"agent-service"`. Archive=posted-only (directive A4) is built against
  this: drafts are staff-facing until approval.
- **Catalog:** `src/lib/agent-service/products.ts` (the four managed lab
  products) + the `customAgents` collection (lab-repo skills, granted per
  client via `client.customAgentIds`, run as task_type `"custom"`).
- **Mark-as-posted building block (extend, don't reinvent):** `MarkPostedRow`
  in `src/components/asset-detail-modal.tsx` → `markAssetPostedAction`
  (`src/lib/actions/asset-actions.ts`) — deliberately client-callable, gated
  server-side to approved/scheduled/delivered, races guarded against the
  publish cron via the publish claim. Directive A4's flow terminates here.
- **Cost split (A5):** credits pricing maths is pure in `src/lib/credits.ts`
  (client-safe), transactional charge/grant in `src/lib/data.ts`. The
  launch-cost vs run-cost split (CD-A5) will extend these — no flat
  "25 credits per output" anywhere when done (F130).
- **Churn guard you must never break:** clients must not be able to tell
  content is pre-generated internally (directive A3) — no payload, copy, or
  timing signal that content exists before its calendar day.

### 4.2 Managed-products retirement (F39/F45 — signed off, lands with AGENTS merge)

Orchestrator ruling: the dead managed-products UI is deleted
(`src/components/managed-products.tsx`, `src/components/client-managed-agents.tsx`,
the `submitManagedJobAction` UI wiring and the dead jobPreviews block) while
the `submitManagedJob` CORE is preserved — the execution-engine task-board
path still runs the four catalog products. **At draft time the files still
exist on the integration branch; the deletion arrives with the AGENTS cluster
merge.** Restoration = `git revert` of that retirement commit. Under Phase 3
the managed-product run UI returns inside the unified launch-vs-runs model —
never as the old four cards. Do not resurrect the deleted components when
wiring the service.

### 4.3 Reddit agent — re-application notes for when it lands

The sweep PDF was taken on a tree carrying a Reddit agent this repo never had.
Verified via `git log --all -S"parseRedditDrafts"`: the surfaces never existed
here. What exists today: the OAuth connector `src/lib/integrations/reddit.ts`
(+ `REDDIT_CLIENT_ID`/`SECRET`), and a "Reddit Agent" record in the
`customAgents` collection (staff library card only — consistent with the lab
import). Struck clauses: F38 whole (phantom pairing-refusal premise), the
Reddit clauses of F28/F46/F70, and F35's binding-display half.

**When you (or a later campaign) land the Reddit agent, re-apply these
established patterns instead of inventing new ones:**

1. **Drafts reader — third sniff slot:** `AssetDetailModal` and `AssetCard`
   run content sniffs in a fixed order (LinkedIn first — its "## Account"
   headings contain the X sniff's "# Account " substring — then X), rendering
   `LiDraftsBatch` / `XDraftsBatch` in place of the caption. Add
   `parseRedditDrafts` + `RedditDraftsBatch` as the third sniff in BOTH
   components, same order discipline. Documented in F46's commit `271c381`.
2. **Draft titles:** strip/translate lab-internal vocabulary ("Avenue 3 ·
   News-reaction…") at the reader render boundary, the way F70's fix does in
   `src/components/x-drafts-review.tsx` / `li-drafts-review.tsx`.
3. **Intake copy:** mirror the corrected X/LinkedIn intake pages
   (`src/components/x-agent-intake.tsx`, `linkedin-agent-intake.tsx`) — F28
   rewrote where drafts actually live; there is no `reddit-agent-intake.tsx`
   today, so build it from those.
4. **Run status labels:** consume `JOB_STATUS_META` (§6.5) — never print raw
   `job.status`.
5. **Reply-cap economics (F27) and empty-input refusal (F36):** re-check both
   against the Reddit product's real cadence config before exposing schedule
   UI — the 35-replies-a-week overpromise was real on the sweep branch.
6. Integration standard: follow `docs/agent-integration-playbook.md` and the
   e13 X-agent reference (`docs/x-agent-portal.md`).

### 4.4 F107 part 1 — Publish Now unreachable from the assets list (open)

F107's calendar surface is RESOLVED: staff-gated `PublishNowRow` in
`AssetDetailModal` (composed with `MarkPostedRow`: Publish Now = staff push
through our API, MarkPostedRow = client attestation), with
`connectedPlatforms` threaded staff-only through the calendar RSC payload
(`connectedPlatformsByClient` in `src/app/(app)/calendar/calendar-body.tsx`).
**Still open (WORKSPACE wave B owns it):** the staff assets list never passes
`connectedPlatforms` into `AssetCard` — verified at draft time:
`src/components/assets-view.tsx` and the job detail page
(`src/app/(app)/jobs/[id]/page.tsx`) don't fetch/pass it, so the prop
defaults empty and `PublishNowRow` never renders there. The seam is ready:
`AssetCard` already accepts optional `connectedPlatforms` and forwards it to
the modal. If wave B doesn't close it, close it during integration.

### 4.5 `publishAssetNowAction` — no idempotency ledger

Pre-existing, logged by the CALENDAR risk lens: `publishAssetNowAction`
(`src/lib/actions/asset-actions.ts`) claims the asset atomically
(`claimAssetForPublish`), but on platform failure it releases the claim and
records only `publishError` — no attempt log, no idempotency key toward the
platform API. Fine at today's volume; if you scale real platform pushes,
add an attempt record / idempotency key before retry loops exist.

### 4.6 Corrections vs standalone condensation (F77 residual)

Client doc corrections enter generation via the internal source only. A
standalone condensation pass (`refreshClientContextDocsAction` in
`src/lib/actions/intel-actions.ts`) would MISS accumulated corrections —
noted for Phase 3: if you or Phase 3 wire any new pipeline that regenerates
client-tier docs, corrections must be injected there too.

### 4.7 `applyGlobalDocCorrectionAction` — do not mount as-is

`src/lib/actions/intel-actions.ts` exports `applyGlobalDocCorrectionAction`
with **zero UI callers** at draft time. It repeats the exact
charge-without-`{changed}`-flag shape F74 fixed on the targeted-correction
path (client billed even when the correction was a no-op). If anything ever
mounts it, port F74's `{changed}` + refund pattern first.

---

## 5. Known accepted residuals & pending product decisions

### 5.1 Product sign-offs needed from Albert (not engineering calls)

1. **F77 correction authority + caps:** client corrections are treated as
   "ABSOLUTE GROUND TRUTH" over generation **including internal-only docs**
   (action-plan / client-guidelines premises are steerable by client free
   text). No length cap, no expiry, no supersede logic — corrections
   accumulate (newest 100) and inflate every future pipeline run at Karos's
   token cost. This matches the pre-existing `applyDocCorrections` design,
   but it deserves a conscious yes/no (and, if no: cap + expiry are cheap).
2. **Branding tier lag:** branding writes now deterministically target the
   internal tier; the client-tier Branding doc lags until the next
   condensation run. Accept, or trigger condensation on branding save.
3. **Paused-schedule visibility:** PAUSED schedules vanish from the calendar
   (it filters to `status === "active"`), and resume lives only on the AI
   Agents page. Product call: show paused rows greyed on the calendar?
4. **Attention-count inflation (post-F97):** the dashboard attention row now
   folds in every draft — "Needs your attention: 21 items" is possible.
   Spec-sanctioned, dissolves with archive=posted-only (F149/A4), but worth
   Albert's eyes with that work.
5. **`ANALYTICS_LIVE_INGEST`** — §2.7.

### 5.2 Accepted residuals (logged, deliberate — do not "fix" in passing)

- **F24 partial coverage:** `schedule.lastError` covers submit-time refusals
  only; a run that submits and then fails at the agent service (webhook
  reports failure) still shows a green Live badge until the run-history work
  (F29/F132, AGENTS) surfaces last-run outcome. Also: a stale `lastError`
  only clears on the next clean fire — up to a week of false "Needs
  attention" on weekly cadence.
- **F108 residuals:** legacy zone-less schedule rows keep old behavior until
  re-saved (by design); posts / past-runs / today-highlight still bucket in
  the runtime-local zone (`dayKey` in `src/components/run-calendar.tsx` only
  gets a zone for planned runs).
- **F109 half:** a run in review has zero client-visible assets (webhook
  creates drafts; clients don't see drafts), so the client-side Review
  affordance appears only post-approval. Dissolves with F149/A4.
- **F110 shape (shipped deliberately):** pause is available to clients
  (`canManageRuns`), delete stays staff-only; server gate matches
  (`aceb6da`).
- **F47 copy debt:** the "lands in your archive as soon as the run finishes"
  sentence becomes false when archive=posted-only lands — tracked under
  F149/A4, don't patch separately.
- **Teaser filters (CALENDAR):** `INTERNAL_TOKEN_RE` fail-closed can blank a
  legitimate 8+-digit-number line, and `INTERNAL_KEY_LINE_RE` drops legit
  "Source:" caption lines — teasers only, modal unaffected. Revisit only on
  client complaint.
- **F81 propagation window:** sibling-tier doc propagation runs in `after()`
  — a seconds-long stale-copilot window (minutes-to-never on Cloud Run until
  §3.1 is fixed).
- **F86 behavior change:** a client with no client-tier docs now gets "No
  documents to summarize yet." instead of an internal-derived brief —
  correct, but visible on mock-client walks.
- **F125 behavior change:** analytics rows only from non-integrated platforms
  → digest empties → panel falls back to the pipeline summary. Honest.
- **F138 export parity:** exported PDFs omit placeholder-only sections
  (matches the drawer) — client-visible change, accepted.
- **F1 trade-offs:** client action plan caps at 10 rows, no channel filter
  chips, no found/goal expander (prescribed swap; log, don't restore).
- **Cosmetic, end-loop candidates:** X-draft metadata renders literal
  single-asterisk emphasis; `renderAssetBody` flattens ALL-CAPS section
  labels to paragraphs; hard-wrapped (~100-col) source keeps mid-sentence
  line breaks.

### 5.3 Finding-shaped gaps logged for end-loop triage (no PDF number)

- Legacy `/api/scheduler` + `ScheduledRunsCard`
  (`src/components/scheduled-runs.tsx`, client settings page) share the
  silent-failure shape F110 fixed elsewhere, on the `scheduledRuns`
  collection.
- `src/components/client-home.tsx` is dead code (zero importers) carrying a
  stale approval-lie string — slated for end-loop deletion; **do not revive**.
- `client-guidelines` is a permanently dead `DOC_TABS` row (internal-only
  tier, `pickDoc` never surfaces it).
- `AiProcessingBanner` mounts only on dashboard/settings — on other client
  routes the only regenerate signal is a greyed button.
- Impersonated writes log `actorRole` as CLIENT_USER (all impersonated
  writes, pre-existing).
- SEO Approve → `logActivity` is unbounded/no-dedupe and client-callable
  (self-inflicted scope only).
- Copilot chat route feeds **unscoped** benchmark records into the
  credit-charged client prompt, and can write free-form guidelines text into
  the INTERNAL branding doc (`src/app/api/clients/[id]/chat/route.ts`,
  branding tool-call branch) — COPILOT cluster owns both; if still open at
  final handover they move to §4.

---

## 6. Environment & conventions crash course

Read this before your first commit. These are the rules the whole campaign
enforced; breaking them will fail the same review gates.

### 6.1 CLAUDE.md hard rules (the app's constitution)

- **All Firestore access is server-side** through `src/lib/data.ts` (Admin
  SDK). The browser uses Firebase only for auth; `firestore.rules` denies all
  direct client access.
- **All writes go through server actions** in `src/lib/actions/*` (barrel:
  `src/lib/actions.ts`), each authorizing via `getCurrentUser()` /
  `requireStaff()` / `requireAdmin()`. A server action is a public network
  endpoint — **the UI is never the guard**.
- **Timestamps are epoch millis** (`number`), everywhere.
- **Credits vocabulary:** never the word "token" for credits (tokens = PATs
  and LLM token counts). Only `isBillableClientActor()`
  (`src/lib/credits.ts`) sessions get charged — staff and admin
  View-as-Client are free.
- UI primitives from `src/components/ui.tsx`; icons via
  `src/components/icon.tsx` (lucide v1 — no brand icons).
- **This is not the Next.js you know:** Next 16, breaking changes — read
  `node_modules/next/dist/docs/` before writing framework-adjacent code.
- The removed in-app agent systems (builder agents, `lib/agents` engine,
  intel system agent, content-engine e12, newsletter e11) stay removed.

### 6.2 The NUL-byte grep hazard (this one bites silently)

`src/lib/seo-geo.ts` is CRLF and contains a literal NUL byte (a map-key
separator near the killedReasons map). `grep`/`rg` treat the file as binary
and **silently return nothing** — a plain grep for a symbol defined there
reports false "zero matches / zero importers". Use:

```bash
LC_ALL=C grep -an "buildRecommendations" src/lib/seo-geo.ts
```

Do NOT "fix" the line endings or the NUL — it is load-bearing data.

### 6.3 The worktree-fork-from-main hazard

New `.claude/worktrees/*` fork from **main**, not the integration branch. A
fixer that builds on main silently lacks every sweep merge. Step 0 of every
worktree session:

```bash
git merge-base --is-ancestor 36a5200 HEAD && echo ok
# not ok → git reset --hard claude/karos-portal-qa-feedback-7efbdf
```

(`36a5200` = the first Phase-1 merge.) Also: worktrees lack `node_modules` —
clone it from the main checkout with `cp -Rc` (APFS clone; do not symlink).

### 6.4 F108 timezone contract (all schedule-writing code)

Schedule **intent** is wall-clock + IANA zone; `nextRunAt` is a **derived**
epoch-millis value. `src/lib/run-cadence.ts` is the single Intl-based zone
implementation (`zonedWallToUtc`, `localYMD`, `isValidTimeZone`,
`computeNextRunAt`, `runtimeTimeZone`). Any surface that creates or edits a
schedule must pass the stored zone through — accepted-and-ignored zone
arguments were explicitly banned in the CALENDAR merge. Watch the two
spellings: planned runs use `timeZone`
(`src/lib/actions/planned-run-actions.ts`), custom-agent cadences use
`RunCadence.timezone` (`src/lib/types.ts`). Legacy rows without a zone keep
runtime-local behavior until re-saved (§5.2).

### 6.5 `JOB_STATUS_META` — the one status-label choke point

`src/components/job-status.tsx` exports `JOB_STATUS_META` (tone + label per
`JobStatus`) and `JobStatusBadge`. **Every** surface that shows run state goes
through it — printing raw `job.status` puts the database enum ("review") in
front of a client, which is exactly findings F41/F120. Do not add a second
label map. The AGENTS merge adds a `cancelled` status: terminal, distinct
from `failed` (a cancel is not a failure — F30).

### 6.6 Sanitize at the server boundary, not at render

Established in wave 1, enforced since: client viewers must not **receive**
internal strings, even invisibly — filtering happens in the RSC payload /
server action / route response, never by hiding at render. Examples already
in the codebase: staff-only `connectedPlatforms` threading in
`calendar-body.tsx`; the internal-line filters in `doc-render.ts`
(`toPlainSummary`, `stripInlineMarkdown`); the F76 route filter on context
docs. If a client's browser can see it in the payload, it's shipped.

### 6.7 Working-style rules that kept the campaign safe

- PDF/finding line numbers come from the sweep branch
  (`claude/portal-bug-sweep-abcd41`) and are stale — **re-locate by symbol**;
  if a cited surface doesn't exist, suspect a sweep-branch phantom (§4.3)
  before building it.
- `rescopes.md` overrides the PDF spec wherever they disagree.
- Data migrations are scripts in `scripts/` with dry-run default, `--apply`
  gate, and a `require.main === module` guard — **never run automatically,
  never written inline in app code**, because dev credentials point at
  production Firestore.
- Verification gates before any merge: `npx tsc --noEmit` ·
  `npm run build` · `npx vitest run`.
- Guard zones still standing: no AI Insights rework beyond listed defects
  (directive B5); never expose content pre-generation (A3/A4).

---

*Refresh protocol: when a cluster merges, update §1.4, re-tag §4 items whose
ledger rows changed, move closed §5 items to §5.2 with their commit, and add
a changelog row. Keep section numbers stable.*
