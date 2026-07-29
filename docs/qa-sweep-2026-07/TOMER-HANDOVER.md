# Tomer handover — QA sweep 2026-07

> **Status: v3 — 2026-07-28, every `file:line` re-read against HEAD `9e7c46e`.**
> Section numbers are stable anchors — later updates append or amend inside
> sections, never renumber them. Every code reference is file + symbol; **the
> agent-service contract seams in §4 additionally carry `file:line`**, because you
> have to build a payload against them without reading the repo. v3 re-derived
> **every** line number in this document mechanically (file exists · line in range
> · the named symbol within ±10 lines) after the Tomer merge, the Reddit e15
> landing and the CD-I1 archetype wave moved most of them. If one has drifted
> since, the symbol beside it is still the re-locator. Everywhere else the rule
> stands: symbols, not lines.

| Version | Date | State of campaign when written |
|---|---|---|
| v1 (draft) | 2026-07-28 | Phase 1 merged · CALENDAR merged · DOCS merging · AGENTS / SEO / WORKSPACE / rest in flight · Phase 3 not started (`phase3-design.md` did not exist yet) |
| v2 | 2026-07-28 | All Phase-2 clusters merged · Phase 3 WP-0…WP-9 merged · CD-G wave (G1–G11) merged · Albert-match review run · CD-H mop-up (H1–H8) merged at `f7a126b` · 879 tests green. Phase-3 §8.3 seams T1–T7 became real |
| **v3 (this)** | **2026-07-28** | **Everything above, plus the Tomer merge (origin/main: Reddit agent e15, runway autogen, per-client binding), the two audit passes, the admin Ops Import extraction, and the CD-I1 archetype wave (three agent detail shapes + staff roster parity).** v2's line numbers were written before all of that; **v3 is a citation-correctness pass** — claims re-verified, every `file:line` machine-checked. Suite is now **1,281 tests across 93 files, green at `9e7c46e`** |

**Audience:** Tomer, doing the final integration mile (agent-service runtime,
GCP infra, connectors) — plus Albert for the ops steps in §2. Read §1 to
orient, §6 before touching any code, then work §2–§5. If you only have an hour:
**§4.1 (the metadata contract you build against) and §4.8 (T1–T7)**.

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
| `phase3-design.md` | **The launch-vs-runs architecture** (F148 umbrella) — data model, state machine, slots, credits split, §8 agent-service contract, §9 backfill spec, §10 work packages, §12 Albert rulings + open questions. Written after v1 of this doc; §4 below is its Tomer-facing extract. |
| `master-plan.md` | Phasing model, cluster map, deferred-to-Tomer criteria. |
| `team-design.md` | The verification system (below). |
| `fixer-brief.md` | Standing brief every fixer follows — §6 of this doc distills its hazards. |

Albert's directives kept arriving during execution (five batches). Batches 3–5
live in `rescopes.md` as **CD-G1…CD-G11**, the post-wave Albert-match review's
mismatch list as **CD-H1…CD-H8**. Where those disagree with the PDF or with
`phase3-design.md` §7.1, they win.

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

### 1.4 Phase 2 — subsystem clusters (ALL MERGED — amended for v2)

Every cluster named in v1 as "in flight" has since merged and passed the §1.5
gate: **CALENDAR** (`f811c08`), **DOCS**, **AGENTS**, **SEO**, **WORKSPACE**
(`567305a`, a hand-verified 7-file conflict resolution + a second independent
lens pass), **COPILOT**, **DASHBOARD**, **CREDITS**, **SHELL**. Anywhere v1 said
"arrives with the AGENTS merge" or "in flight at draft time", **it has landed** —
those sentences below have been corrected in place rather than deleted, so you
can see what moved.

At HEAD the ledger carries **no OPEN engineering rows** — 158 RESOLVED, 2
RESOLVED-PARTIAL. What remains open, re-counted against `LEDGER.md` at HEAD:
three OPS-PENDING rows (**F127, F33, F130** — §2), **one DEFERRED-TOMER row
(F150**, video ingestion = CD-D1/T5 — §3.2), two OPEN ops/loop items (**CD-C1,
CD-G7**), one OPEN-ALBERT ruling (**CD-H2** — the 1280×800 rail fit), and the
rest of the §4 seams. *Ledger rows are cited by id, never by line: the tables are
keyed on the id in column one and rows get inserted above yours.*

### 1.5 The verification system every merged fix passed

1. **Deterministic gates** — `npx tsc --noEmit` · `npm run build` ·
   `npx vitest run`. That was **879 tests across 71 files at `f7a126b`**; the
   Tomer merge, the audit passes and CD-I1 have since grown it to **1,281 tests
   across 93 files, green at `9e7c46e`**. The count is itself a gate — if your
   branch reports fewer files, you dropped one in a merge.
2. **Three adversarial Opus lenses**, each prompted to refute the fix:
   *risk* (blast radius: credits, roles, webhook contracts, Firestore writes),
   *drift* (matches the prescribed fix + call directives, guard zones intact),
   *mock-client* (browser-only walk of the live flow vs the PDF screenshot).
   Any red = bounce to the fixer (the "bounce" commits above).
3. **Fable orchestrator review** of every diff, then serial merge.

Trust implication for you: a RESOLVED row means the symptom was re-verified in
a running portal, not just code-reviewed. The bounce commits are part of each
finding's fix — don't cherry-pick a fix commit without its bounces.

Phase 3 and the CD-G wave added a fourth step: an **Albert-match lens** that
re-reads his verbatim words against localhost after a wave merges. It is what
produced CD-H; assume any future wave earns one too.

### 1.6 Phase 3 + the CD-G / CD-H waves (merged — new in v2)

This is the work v1 could not describe, and it is most of what you inherit.

- **Phase 3 (`phase3-design.md`) designed and built the launch-vs-runs model**:
  new collections `clientAgents` (parent umbrella), `agentSlots` (the calendar
  plan), `clientAgentFeedback` (two-level feedback); a launch state machine
  (`not_launched → launching → curating → live`, plus `launch_failed`); a
  client-billed **launch** priced separately from a **run**; per-slot notes; and
  the X agent's daily 3-option picker. Merged as WP-0 through WP-9 with three
  lens rounds (`af08a9d`, then `687b728` "Phase 3 merged — 872 tests").
- **CD-G wave** (`rescopes.md`, third–fifth Albert batches): the agents roster
  became cards-only, with a **full-page per-agent detail route** (CD-G1); client
  blurbs rewritten concrete (CD-G2); "one agent per platform" copy killed and
  Bind demoted to staff plumbing (CD-G3); staff sidebar restored to baseline
  (CD-G4); Regenerate admin-only + a dashboard entry point (CD-G5); **F124
  reverted by Albert** (CD-G6); the copilot dock pinned bottom/full-width
  (CD-G8) and dismissible at narrow width with the chrome relocated into
  Company (CD-G9); board toolbar straightened (CD-G10); swatches copy their hex
  (CD-G11).
- **Albert-match review** then walked his verbatim feedback against localhost
  and produced the **CD-H mop-up** (H1–H8, merged `a2aeb31` + `f7a126b`): tiles
  first under Overview, sidebars stop scrolling, competitor ↗ fallback, 375px
  clipping, client-shell narrow parity, breakpoint-gated Company sheet, a
  cosmetic set, and **CD-H8** — the legacy "live schedule but no umbrella" agent
  detail page stopped being a stub.
- **CD-G7 fleet completion refresh** (data, not code) is the one wave still
  OPEN: `scripts/refresh-export.ts` → per-client proposal JSON →
  `scripts/refresh-apply.ts --apply`. §2.9. It is where the pipeline bugs in
  §4.13 were discovered.

---

## 2. Ops runbook (Albert or Tomer)

Standing rule for everything in this section: **the dev `.env.local` points at
production Firestore.** Every script in `scripts/` is dry-run by default,
writes only with `--apply`, and is guarded by `require.main === module`.
Read the printed plan before applying. Nothing here was run by the agents.

**The OPS-PENDING inventory at HEAD**, in the order it should be run:

| # | Step | Blocks | Owner |
|---|---|---|---|
| §2.1 | `backfill-agent-blurbs.ts --apply` | F127 | Albert |
| §2.2 | `backfill-asset-titles.ts --apply` | F33 | Albert |
| §2.8 | run `scripts/backfill-client-agents.ts` per client (written, never run) | Phase 3 on existing clients | Albert |
| §2.9 | `refresh-apply.ts --apply` per client (CD-G7) | fleet data quality | Albert |
| §2.10 | set `creditCost` + `launchCreditCost` per agent in the admin editor | F130, and every client Launch button | Albert (admin UI, no script) |
| §2.11 | `grant-all-agents.ts` sanity pass + the fill-only manual profile edits | roster completeness | Albert |
| §2.4 | credit reload + SEO/GEO regenerate | C2 | Albert |
| §2.5 | Hello-account password rotation | D3 | Albert |

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

**Amended for v2 (CD-G2).** The blurbs were rewritten to Albert's pattern —
concrete and short ("Improve your Instagram reach with a daily post, different
templates, and an agent that scans"), no lab vocabulary. Two things changed:

- The script's `BLURBS` table (`scripts/backfill-agent-blurbs.ts:105`, 10
  entries) now has a **runtime twin in app code**: `src/lib/agent-blurbs.ts`
  (`PRODUCT_BLURBS`:36, `BLURBS`:54 — 17 entries, a superset). The resolver
  `clientAgentBlurb` (`agent-blurbs.ts:155`) prefers a curated `clientBlurb`,
  then product type, then an identity match, then an honest contentless
  fallback. So **the roster and detail pages read correctly today even before
  the script runs** — the backfill now only persists the copy.
- The two tables are hand-maintained twins (documented at
  `backfill-agent-blurbs.ts:13-27`). **Edit both or they drift.** Note the
  retraction inside that comment: **a `scripts/` file _can_ import `@/`** — tsx
  resolves the alias through tsconfig paths, and `scripts/backfill-client-agents.ts`
  imports the production helpers directly. The blurb tables stay twins only
  because they are keyed differently (this one on the agent KEY, the runtime one
  on the full identity string). Prefer a shared import whenever the logic is
  actually shareable.

### 2.2 `scripts/backfill-asset-titles.ts` — WRITTEN (v1 said it wasn't)

**Correction:** v1 called this a placeholder. It exists at HEAD (128 lines) and
F33 is OPS-PENDING on running it. It rewrites only assets whose title is
character-for-character their job's `"<Agent> - <Client>"` title — a deliberately
conservative match (`backfill-asset-titles.ts:17-20`, enforced at :100-114) so a
hand-edited title is never touched. `--apply` at :84, `require.main` guard at :123.

```bash
npx tsx scripts/backfill-asset-titles.ts
npx tsx scripts/backfill-asset-titles.ts --apply
```

Going forward the defect is fixed at the source: the webhook strips the suffix
via `assetTitleFromJobTitle` (`webhook/route.ts:388`, imported at :4, shared
definition in `src/lib/job-title.ts`). The old code looked for an em dash while
every builder wrote a hyphen, so it had never once fired.

### 2.3 Everything in `scripts/` at HEAD (14 files, same convention)

Sweep-relevant: `backfill-agent-blurbs.ts` (§2.1), `backfill-asset-titles.ts`
(§2.2), `refresh-export.ts` + `refresh-apply.ts` (§2.9), `grant-all-agents.ts`
(§2.11), `clear-ai-processing-lock.ts` (§2.4).

Pre-sweep maintenance: `backfill-branding.ts`, `backfill-client-agents.ts`,
`dedupe-competitors.ts`, `import-lab-client.ts`, `migrate-legacy-roles.ts`,
`purge-orphaned-client-docs.ts`, `redate-content-calendar.ts`,
`schedule-approved-assets.ts`.

**The convention is now enforced across all 14, not just the sweep-era ones.**
Every script that can write to Firestore takes `--apply` and does nothing
without it, prints a one-line banner naming the mode, and is wrapped in
`if (require.main === module)`. Three of them used to write on a bare
`npx tsx` run — `backfill-branding.ts` had no argument parsing at all and
rewrote branding for EVERY client, `clear-ai-processing-lock.ts` cleared the
lock unconditionally, and `schedule-approved-assets.ts` applied by default
behind an inverted `--dry`. **The old spellings `--execute`, `--dry` and
`--dry-run` no longer exist**; if you have a runbook or shell history using
them, the run is now a harmless dry run and the banner will say so. Firestore
init also moved inside `main()` in the four scripts that opened a connection
merely by being imported. `refresh-export.ts` is read-only and takes no mode
flag.

**Written but never run: `scripts/backfill-client-agents.ts` (§2.8).** The code
is merged; the migration is an ops step Albert performs per client.

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
| `AGENT_SERVICE_URL` | `http://localhost:8080` | Unset hides the managed-agents UI entirely. F34 fixed the *copy*, not the gate — so an unset URL still means an empty agents surface, it just says so honestly now. |
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

Still true at HEAD: `liveIngestEnabled()` is
`src/lib/integrations/analytics-providers.ts:41-43`, gating on
`process.env.ANALYTICS_LIVE_INGEST === "1"` (:42), enforced at :217 and :468.

### 2.8 `scripts/backfill-client-agents.ts` — WRITTEN, NOT YET RUN

**Changed in v3: the script now exists** (`scripts/backfill-client-agents.ts`).
It is code-merged and ops-pending — the LEDGER discipline F127's blurb backfill
follows. Nothing has been written to Firestore by it.

Phase 3's whole model hangs off two new collections. Every *new* umbrella is
created through the UI, but **no existing client has one** until this runs, so
slots, template streams, per-template feedback, per-slot notes and the options
picker stay dark for pre-Phase-3 clients. A client with a live weekly schedule
and no umbrella (the flagship Instagram case) gets the **legacy branch** of the
detail page instead — see §4.14. CD-H8 built that branch precisely to make this
gap survivable, and its own comment says so (`legacy-agent-panel.tsx`).

```bash
npx tsx scripts/backfill-client-agents.ts                          # whole fleet, plan only
npx tsx scripts/backfill-client-agents.ts --client=<id>            # one client, plan only
npx tsx scripts/backfill-client-agents.ts --client=<id> --apply    # writes
npx tsx scripts/backfill-client-agents.ts --client=<id> --apply --stamp-jobs
npx tsx scripts/backfill-client-agents.ts --client=<id> --apply --delete   # rollback
```

**Dry run is the default.** The plan prints per client — every umbrella it would
create with its launch state and the evidence for it, every template it would
seed, every slot with the day it is fitted to, and an anomalies list. Read that
before `--apply`; the credentials in `.env.local` point at production.

What it will not do, by construction:

- **Never re-dates an asset.** §9 step 4 fits slots to the dates assets already
  have (bucketed in the schedule's zone, the F108 contract). Read §4.10 before
  changing it — a naive implementation collides with the chain planner.
- **Never touches an existing umbrella.** A doc that exists is skipped whole,
  not topped up: it may have been curated, and a half-merge would be
  unexplainable. Redo one with `--delete --client=<id>` first.
- **Never invents a template.** An asset whose stream cannot be derived is
  reported as an anomaly and left alone.
- **Never stamps `runType` on legacy jobs** (heuristic launch-detection is
  unreliable). `--stamp-jobs` writes `clientAgentId` only, for grouping.
- **X umbrellas get no templates and no retroactive option slots** — the daily
  pick has no template streams, and options generate forward-only from the
  first batch that lands after go-live.

`--delete` requires `--client` and refuses to roll back the fleet at once. It
removes only umbrellas it created (`createdBy: "backfill"`) plus their slots,
and clears the two nullable linkage fields it wrote.

The planning half is a pure exported function (`planClient`,
`scripts/backfill-client-agents.ts:136`) covered by 16 unit tests against
fixtures (`src/lib/__tests__/backfill-client-agents.test.ts`), so the decision
that reaches production is checkable without a database. It imports the app's own helpers — identity mapping,
template derivation, day-key bucketing, deterministic doc ids — rather than
restating them, because a backfill that classified an asset differently from the
app would build a registry the app then disagreed with.

### 2.9 CD-G7 fleet completion refresh — `refresh-export.ts` → `refresh-apply.ts`

Two-step, per client, and the only sanctioned write path for the fleet data
completion pass. Albert authorized these writes explicitly.

```bash
npx tsx scripts/refresh-export.ts --out=/abs/dir [--client=<id>]   # read-only dump
# a refresh team produces <client>.proposal.json against docs/qa-sweep-2026-07/refresh/BRIEF-TEMPLATE.md
npx tsx scripts/refresh-apply.ts --file=/abs/proposal.json --client=<id>          # dry run
npx tsx scripts/refresh-apply.ts --file=/abs/proposal.json --client=<id> --apply  # writes
```

**Read this before citing the script: `scripts/refresh-apply.ts` is no longer
where the rules live.** At HEAD it is a **184-line adapter** — argument parsing,
`.env.local` loading, Firestore reads, one batched commit, and printing. Every
fence was extracted verbatim into **`src/lib/refresh-apply-core.ts` (993 lines,
pure: no firebase, no `server-only`, no fs, no `process`)** so the CLI and the
admin Ops Import page enforce ONE implementation instead of a drifting copy. The
script's own header says so at `scripts/refresh-apply.ts:11-15`. Its three moving
parts: `validateProposal` at :122, `formatPlanLines` at :132, and `buildWriteOps`
→ `batch.commit()` at :163-170.

`--client` is **mandatory and single**: refused outright without it
(`refresh-apply.ts:61-69`), then cross-checked in the core against the proposal's
own `clientId` (`refresh-apply-core.ts:783-785`) and client name (:789-795).
Writes land as one atomic batch per client over `clientContextDocs`,
`clientCompetitors`, and one `clients` doc.

The completion semantics are **enforced in code, not merely documented**
(`refresh-apply-core.ts:15-28`): nothing is ever deleted; a doc may not shrink
below the floor (`SHRINK_FLOOR` :115 = 10%, relaxed to `SHRINK_FLOOR_APPROVED`
:117 = 50% only with a written reason) and may never lose a `## ` section;
competitor fields may not be blanked; brand colors need 3–4 unique hexes with
sequential `dominanceRank` (:691) and `usagePct` summing to exactly 100 (:711);
**every other client profile field is fill-only**. That last rule is why §2.11
exists. One more fence worth knowing: `LEGAL_TIERS` (:55) is the docType→tier
no-leak table — it is what stops `client-guidelines` or `action-plan` being
written at tier `"client"` and published to the portal.

That shared core is what the **admin Ops Import page** (`/admin/ops`) runs — the
same import without the CLI, plus the SEO/GEO and posts halves. See
[refresh/OPS-IMPORT.md](./refresh/OPS-IMPORT.md) for the inbox layout
(`OPS_IMPORT_DIR`), what each button does, and the provenance rule that keeps a
hand-imported SEO/GEO snapshot from reading as a fresh machine capture.

### 2.10 Per-agent pricing — the F130 decision Albert has to make in the UI

F130 ("every agent priced identically at 25 credits per output") is OPS-PENDING,
not code-pending: the flat price is gone from the code and the per-agent fields
exist, but **nobody has set them**. Both live in one admin-only surface,
`AgentEditorModal` (`src/components/custom-agents.tsx:1812`, mounted at :593-594
and reachable only behind the two `isAdmin` gates at :452 — "New agent" — and
:545 — the per-card "Edit" button):

| Field | Editor | Persisted by | Validation |
|---|---|---|---|
| `creditCost` — credits per run | `custom-agents.tsx:1985-1999` ("Credits per run") | `custom-agent-actions.ts:152`/:188 (`requireAdmin` at :134/:168) | non-negative integer, :97 |
| `launchCreditCost` — one-time setup price | `custom-agents.tsx:2008-2023` ("Credits for setup (one time)"; the §6.3 rationale is the comment at :2001-2007) | same | whole number > 0, :101; **and strictly greater than the effective run cost**, :109 |

**Until `launchCreditCost` is set, clients cannot launch that agent at all.**
That is deliberate (ruling Q10): `evaluateLaunchGate`
(`src/lib/client-agents.ts:276`) returns `pricing_uncalibrated` at :322-325
(code declared :195, client-facing reason :208) and the card paints a disabled
CTA with the reason, rather than billing a number nobody chose.
Staff launches are free and proceed — they are how you accumulate the
measurements. The staff economics card then shows the measured setup-vs-run USD
ratio and a suggested price (`src/components/client-agents/agent-economics.tsx`,
fed by `getLaunchCalibrationAction` :6 and rendered :105-147; computed by
`calibrateLaunchPrice` in `src/lib/credit-reporting.ts:198`, which deliberately
excludes untyped legacy jobs at :194-196).

### 2.11 Roster grants + the fill-only manual edits

- **`scripts/grant-all-agents.ts`** (104 lines) implements CD-G3's "they should
  be able to run every single agent if they want to": it adds every enabled agent
  to each client's `customAgentIds`, additively and de-duplicated
  (`grant-all-agents.ts:81-89`, the set union at :86), skipping disabled agents
  (:52). The revoke flag is
  **`--revoke-ids=a,b`** (:38-39, applied :71-79) — note it is *not* a bare
  `--revoke`. A grant pass already ran (`27e89e6`); re-run it after importing any
  new lab agent.
- **Fill-only fields need a human.** The refresh will not overwrite a profile
  field a human already set; it skips-and-reports instead
  (`refresh-apply-core.ts:626` for profile fields, :645 for social links — both
  push onto `plan.skippedProfile`, printed by `formatPlanLines` at :983). Branding
  fill fields take the same treatment, silently, at :744-750. The refresh teams
  found the fields that are simply *empty* fleet-wide and cannot be sourced
  automatically:
  - **Typography** — `fontHeading` / `fontBody` are unset for 4+ clients
    (`BRANDING_FILL_FIELDS`, `refresh-apply-core.ts:80`). Either put them in the
    proposal JSON before `--apply`, or type them into the client's branding
    surface afterwards.
  - **Karos Labs' own guideline** — "no bright accents" is a house rule that
    exists nowhere in the stored branding doc. Add it to `guidelines` (also a
    fill-only field) so generation stops proposing them.

---

## 3. Infra

### 3.1 Cloud Run: `after()` background work needs CPU

**Re-verified at HEAD and still true.** `cloudbuild.yaml`'s `cloud-run-deploy`
step (lines 125–153, args block :128-152) carries `--min-instances=1` (:137),
`--max-instances=10` (:138), `--memory=1Gi` (:139), `--cpu=1` (:140),
`--timeout=300` (:141), `--concurrency=80` (:142) — and **no CPU-allocation flag
of any kind**. Several merged
fixes run follow-up work in Next.js `after()` — the DOCS cluster's sibling-tier
correction propagation, the webhook's usage logging (`webhook/route.ts:596-609`),
and UI copy that says generation "continues in the background". Under
request-based billing the CPU is throttled once the response is sent, so all
`after()` work is best-effort. **Add `--no-cpu-throttling` to the deploy args**
(instance-based billing) or move those jobs to Cloud Tasks/Scheduler. Related:
the 20-minute stale-lock self-heal (§2.4) is the safety net when background
work is killed mid-cycle.

Note this got *more* load-bearing since v1: several Phase-3 side effects in the
webhook (chain reflow, options assignment, launch-state advance, task sync) are
deliberately best-effort after the single-use claim — see §4.1. They run inline,
not in `after()`, so they are safe from throttling; but the usage logger is not.

### 3.2 Video deliverables — GCP block storage (F150 / CD-D1)

Plan agreed on the call: videos live in GCP block storage; the agent service
fetches from there; **no media in git**. Split of labor:

- **Portal side — LANDED (v1 said OPEN).** The field is
  **`Asset.videoUrl?: string | null`** (`src/lib/types.ts:459`, with a doc
  comment at :450-458 marking the GCP wiring as yours). The detail modal renders
  `<video controls poster preload="metadata">` at
  `src/components/asset-detail-modal.tsx:271-280`, fed by `assetVideos(asset)`
  (:198). The resolver `assetVideos` (`src/lib/asset-images.ts:102-128`) reads
  three sources in order: `asset.videoUrl` (:112), `meta.videos` (:114), then
  `meta.files` / `meta.artifacts` (:118-125). A second surface renders it at
  `src/components/task-ticket-modal.tsx:133`.
  **So: drop a URL into `videoUrl`, or ship a `video/*` artifact through the
  normal webhook path, and it plays.** CD-D1 stays OPEN only for your half.
- **Tomer side:** the actual GCP bucket, upload path, and the agent-service
  fetch. The portal will not sign URLs or proxy bytes until you decide the
  access model (public bucket vs signed URLs — signed URLs will need a
  server-side signer beside the existing Admin-SDK credentials). Note the
  webhook re-hosts client-facing artifacts into our own storage today, with a
  25 MB per-file / 150 MB per-delivery budget (`webhook/route.ts:34-35`) — video
  will blow through that, which is exactly why it goes to block storage instead.
- ~~Known duplication to resolve while in there~~ — **DONE, v1 is now wrong.**
  The `liMedia` filter was extracted to `assetLiMedia(meta)` at
  `src/lib/asset-images.ts:146-162`; both call sites are now four-line wrappers
  (`asset-detail-modal.tsx:141-144`, `asset-card.tsx:466-469`). Edit the helper,
  not the components.

### 3.3 TikTok connector (CD-D2 / call directive D2)

Blocked on TikTok verifying the Karos Labs account — nothing code-side can
unblock it. Current portal state: TikTok OAuth wiring exists
(`TIKTOK_CLIENT_KEY`/`TIKTOK_CLIENT_SECRET` in `.env.example`, brand styling
in `src/components/integrations-tab.tsx`), and **CD-D2 is now RESOLVED** — the
portal shows the TikTok agent's connector state as
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
The ledger now carries **exactly one `DEFERRED-TOMER` row — F150** (in
`LEDGER.md`; video clip ingestion, the portal render half shipped — see §3.2/T5).
Everything
else was tracked as a CD item or a P3 round-deferral, so **this section is still
the authoritative list**, and v2 expanded it from 7 subsections to 15.

### 4.1 Launch-vs-runs — THE METADATA CONTRACT (built; v1's placeholder replaced)

Phase 3 shipped. Everything v1 flagged as "to be designed" now exists and is
running, so this subsection is no longer a placeholder — it is the payload spec.

**The one-paragraph model:** each client-facing content agent gets a per-client
umbrella (`clientAgents`). It is launched once (a paid setup/research run that
designs the client's template set), then runs recurringly — one run per template
stream, or, for X, one batch sliced into daily 3-option picks. A calendar plan
(`agentSlots`) holds intent (template + day + optional note) independently of
whether content exists yet, which is what makes directive A3 structural.

#### 4.1a What we send you — `metadata`, and the four keys that matter

Every custom-agent submit funnels through one core:
**`submitCustomAgentJob` in `src/lib/jobs/submit-custom.ts:144`**. It builds the
outbound `metadata` object at **`submit-custom.ts:367-387`**. Values are always
strings (your schema is `z.record(z.string(), z.string())`).

| Key | Emitted at | Values | Meaning |
|---|---|---|---|
| `platform_job_id` | `submit-custom.ts:378` | our job id | Always present. The webhook's fallback identity — see 4.1c. |
| `karos_task_id` | :379 | task id | Present when a board task dispatched the run. |
| `karos_job_token` / `karos_mcp_url` | :380 | signed token / URL | Job-scoped MCP callback credential. |
| **`karos_run_type`** | **:384** | `launch` \| `scheduled` \| `manual_template` \| `manual` | How the run was initiated. Union at `src/lib/types.ts:387`. Absent ⇒ legacy/untyped. |
| **`karos_client_agent_id`** | **:385** | umbrella doc id | Which per-client umbrella this run belongs to. |
| **`karos_template_key`** | **:386** | template key | Which template stream this run produces. |
| **`karos_slot_id`** | — | — | **DESIGNED, NOT EMITTED.** Still zero occurrences in `src/` at HEAD. See §4.9. |

These same three values are also stamped on our own job doc
(`submit-custom.ts:302-304`), and **the job doc wins over the echo** on the way
back — the metadata is the fallback for jobs written before the fields existed.

**Reserved keys.** `RESERVED_METADATA` (`submit-custom.ts:68-76`) lists the seven
keys the core owns. Caller-supplied keys go FIRST in the literal so the core's
own routing can never be shadowed, and a caller passing a reserved key through
`extraMetadata` has it **dropped, not silently overridden** (:375-377, rationale
:368-374) — deliberate, so the mistake is visible in the payload rather than
fatal. `extraMetadata` is the sanctioned door for anything new
(`SubmitCustomAgentInput.extraMetadata`, :107 — and its own doc comment at
:102-106 already names slot ids and revision targets as what belongs there).

**What we need from you: echo `metadata` back verbatim on the webhook.** That
round-trip is the entire contract. It is already proven in production by the
`platform_job_id` fallback path, so this is a statement of the existing
behavior, not a request for a change.

#### 4.1b What you send us — the webhook payload

`/api/agent-service/webhook` — `src/app/api/agent-service/webhook/route.ts`.
Schema at **`route.ts:108-122`**; HMAC verified fail-closed (:136-149 — with
`AGENT_WEBHOOK_SECRET` unset **every** request is rejected 503).

Status mapping is at **`route.ts:38-45`**: `done → review`, `failed`/
`dead_letter → failed`, and **`cancelled → cancelled`** — a deliberate stop is
not a breakage, and the badge, the progress strip and every failure count tell
them apart (finding F30).

#### 4.1c Response codes — what each one means for your retry queue

This matters more than anything else in this section, because the claim is
single-use and your retries are the only safety net:

| Code | Emitted at | Your move |
|---|---|---|
| 503 "Webhook not configured" | `route.ts:138` | Our secret is unset. Retry after we fix env. |
| 401 | :148 | Signature/timestamp rejected. Do not retry blindly. |
| 400 | :155, :159 | Malformed JSON or payload shape. **Retrying will not help.** |
| 404 "No matching platform job" | :188 | Submission race — we haven't persisted `serviceJobId` yet. **Retry**; the window closes long before your schedule runs out. |
| **503 "Refund write failed — retry delivery"** | **:209** | A failed run's credit refund did not write. **Retry** — the deterministic `refund_<chargeEntryId>` ledger id makes redelivery safe after a half-applied attempt. |
| **503 "Template lookup failed — retry delivery"** | **:234-237** | We could not resolve the template stream. **Retry.** |
| 200 `{ok:true, skipped:true, reason:"Already processed"}` | :250 | The atomic claim was already taken. Stop retrying — this is success. |
| 200 `{ok:true, job_id, status}` | :611 | Processed. |

The two 503s exist because of one rule: **anything that can throw must happen
BEFORE the single-use claim** (`claimExternalJobCompletion`, :248). Both the
refund (:202-211) and the template lookup (:224-243) were deliberately hoisted
above it, and both fail the delivery rather than proceeding, because after the
claim a redelivery short-circuits on "Already processed" and the damage is
permanent. If you add work to this handler, keep that ordering.

#### 4.1d What the webhook does with your metadata

- **Template stamping.** The key is read from our job doc first, the echo second
  (`route.ts:227`), then **whitelisted against the umbrella's own template
  registry and fenced by client** (:229-243 — `umbrella.clientId === job.clientId`
  at :239). Only a surviving match is written onto the asset as
  `templateKey`/`templateName` (:421-428). Managed catalog products take
  precedence, since a managed product *is* its own template (:421-422). This is
  the join the archive groups by and the chip the calendar paints; before it, per-
  template runs produced posts with no template at all.
- **Launch runs** (`karos_run_type === "launch"` **and** a client-agent id,
  :263-264): deliverables are created with `meta.launchDeliverable = true` and
  `meta.clientAgentId` (:408), **chain reflow is skipped entirely** (:443), and
  the umbrella is advanced by `applyLaunchOutcome` (:528-542) — `launching →
  curating`, or `→ launch_failed`. If a client-facing `templates.json` artifact
  is present it is captured off the bytes already fetched (:329-331, capped
  20 KB) and seeds the template registry — **that is seam T1**, and it is
  optional: staff curation works without it.
  The flag is written **on the asset** rather than inferred later, so the
  exclusion survives whatever status or date the asset ends up with; it is
  enforced server-side in `getClientLibraryAssets`
  (`src/lib/asset-visibility.ts:16`, predicate `isLaunchDeliverable` :40-42).
- **Options-batch slot assignment (X).** When an X drafts batch lands, its days
  are sliced into daily 3-option picks: `syncOptionsFromBatchAsset`
  (`route.ts:464`, implementation `src/lib/client-agent-slots.ts:215`). Read the
  comment at `client-agent-slots.ts:193-214` — the first implementation hung this
  off the horizon generator, which was the wrong seam and made the feature
  reachable in theory only. It is **fenced by client** (umbrellas looked up by
  the job's own client, :226) and **idempotent** (assignment never touches a day
  that already has options), which is what makes it safe to run *after* the
  single-use claim. Best-effort by design: a failure retries on the next batch.
- **Chain reflow** for everything else (`route.ts:444`), also best-effort — see
  §4.10 for why that is currently a hazard rather than a nicety.

#### 4.1e The rest of the model, unchanged from v1 but now real

- **Catalog:** `src/lib/agent-service/products.ts` (four managed lab products) +
  the `customAgents` collection (lab-repo skills, granted per client via
  `client.customAgentIds`, run as task_type `"custom"`).
- **Mark-as-posted (extend, don't reinvent):** `MarkPostedRow` was **extracted
  out of the modal** into `src/components/mark-posted-row.tsx:21` (v1's pointer
  is stale) → `markAssetPostedAction` (`src/lib/actions/asset-actions.ts:259`).
  Mounted in the detail modal (`asset-detail-modal.tsx:374`) and on the calendar
  day card (`run-calendar.tsx:546`). Client-callable by design, gated server-side
  to approved/scheduled/delivered, raced against the publish cron via the publish
  claim.
- **Cost split (A5) — built.** See §4.12 for the vocabulary you will see in the
  ledger and on jobs.
- **Churn guard you must never break:** clients must not be able to tell content
  is pre-generated internally (directive A3). This is now structural, not
  copy-deep: the client projection of a slot returns **intent only** — template
  key, day, whether the day has passed — and deliberately no asset id and no
  content (`upcomingSlots`, `client-agent-slots.ts:265-285`, read the comment).
  Launch runs are hidden from clients' run lists (`client-agent-rows.ts:100`) and
  from the archive (`tasks-body.tsx:139`). If you add a surface, add it to that
  list.

### 4.2 Managed-products retirement (F39/F45 — DONE, commit `fbecbbf`)

Orchestrator ruling: the dead managed-products UI is deleted while the
`submitManagedJob` CORE is preserved — the execution-engine task-board path
still runs the four catalog products.

**Amended for v2: the deletion has landed.** `src/components/managed-products.tsx`
and `src/components/client-managed-agents.tsx` were both removed in **`fbecbbf`**
("retire dead managed-products UI (capability lives on task board)"). Restoration
= `git revert fbecbbf`. **Amended again for v3:** the explanatory comment v2
pointed at in the agents page is gone too — that page was rewritten wholesale by
CD-G1 and again by CD-I1, and a search for "managed-products" in
`src/app/(app)/clients/[id]/agents/page.tsx` now returns nothing. The one residue
left in the tree is a stale mention of "the managed-products UI" in a deploy-step
comment, **`cloudbuild.yaml:149`**.

Under Phase 3 the managed-product run UI returned inside the unified
launch-vs-runs model — never as the old four cards. Do not resurrect the deleted
components when wiring the service.

### 4.3 Reddit agent — LANDED (v2's "when it lands" is obsolete)

**Rewritten for v3. Do not build any of this: it exists.** v2 was written on a
tree where the Reddit surfaces genuinely did not exist, and its advice was
"re-apply these patterns when you land it". The agent landed while this document
was being written, in **`ddcef3e`** ("hook up the Reddit agent (e15) at the
X/LinkedIn standard", #25, arriving through the `origin/main` Tomer merge
`10b5f09`/`90dc90e`), and the sweep's own render rules were then applied to it in
**`77df660`** (ruling 3). What v2 said was struck (F38 whole, the Reddit clauses
of F28/F46/F70, F35's binding half) was struck against the *old* tree; those
findings have since been re-applied against the real surfaces — see `b949563`
(F27) and `4757ffd` (F38/F35).

The surfaces at HEAD:

| Piece | File | Notes |
|---|---|---|
| Parser | `src/lib/reddit-drafts.ts` (376 lines), `parseRedditDrafts` at :289 | Pure and client-safe — that is what lets the archetype code re-parse |
| Reader | `src/components/reddit-drafts-review.tsx` (511), `RedditDraftsBatch` at :449 | |
| Intake | `src/components/reddit-agent-intake.tsx` (408) | Route: `src/app/(app)/clients/[id]/reddit-agent/page.tsx` (48) |
| Actions | `src/lib/actions/reddit-agent-actions.ts` (242) | Reply length cap at :213 |
| Run context | `src/lib/agent-service/reddit-agent-context.ts` (317) | Applies the per-subreddit promo/removal rules before a run |
| Connector | `src/lib/integrations/reddit.ts` (+ `REDDIT_CLIENT_ID`/`SECRET`) | Pre-existed |
| Canonical spec | `docs/reddit-agent-portal.md` (207) | Pins the DRAFTS.md structure the parser reads, and the client/ vs internal/ artifact split |
| Tests | `src/lib/__tests__/reddit-drafts.test.ts`, `reddit-intake-guards.test.ts` | |

The patterns v2 told you to apply were applied, at these exact seams — read them
before extending, because a fourth agent should copy this, not invent:

1. **Drafts reader — the third sniff slot exists.** `AssetDetailModal` sniffs
   LinkedIn first, then Reddit, then X: `asset-detail-modal.tsx:128` gates on
   `!liBatch && content?.includes("# Reddit answer drafts")` and renders
   `RedditDraftsBatch` at :299. `AssetCard` does the same at :448 / :717. The
   order discipline is still load-bearing — LinkedIn's "## Account" headings
   contain the X sniff's "# Account " substring.
2. **Draft titles** go through `laneLabel` (`src/lib/draft-lane-label.ts`) and
   `stripInlineMarkdown` at the render boundary, exactly as F70 prescribed for X
   and LinkedIn: `reddit-drafts-review.tsx:228` (thread title / lane fallback),
   :248, :251, :268, :288, :493. **The reply body and the disclosure are
   deliberately NOT stripped** — Reddit renders markdown natively, and those two
   are what the client actually posts.
3. **Intake copy** mirrors the X/LinkedIn pages and carries F28's correction
   about where drafts actually live.
4. **Run status labels** go through `JOB_STATUS_META` (§6.5):
   `reddit-agent-intake.tsx:345` renders `<JobStatusBadge>`, and
   `RedditRunRowView.status` is typed `JobStatus` (:57) so a raw-string row
   cannot compile again.
5. **Reply-cap economics (F27)** was re-checked against the real product and
   capped server-side in `b949563`. Reddit is **one draft per run, daily** per
   Albert's lightweight-scope ruling — not a weekly batch, and not the
   35-replies-a-week the sweep branch promised.
6. **Draft-only is structural, not a setting.** There is no posting code path:
   Reddit stays out of `PUBLISHABLE_PLATFORMS`, and a Reddit folder maps to
   `note` rather than `social_post` (pinned by `platforms-publishable.test.ts`).
   Every draft is a reply to an existing thread, so the hand-off copies the reply
   and opens the thread — there is no compose deep link to prefill.
7. **Under CD-I1 the Reddit agent is the `daily_finder` archetype**
   (`src/lib/agent-archetype.ts:92`), so its detail page is
   `src/components/client-agents/daily-finder-panel.tsx`, which re-renders
   `RedditDraftsBatch` at :59 and :179. §4.14.
8. Integration standard for the next one: `docs/agent-integration-playbook.md`,
   plus `docs/reddit-agent-portal.md` and the e13 reference
   (`docs/x-agent-portal.md`).

### 4.4 F107 — Publish Now on every deliverable surface (CLOSED)

F107's calendar surface is RESOLVED: staff-gated `PublishNowRow` in
`AssetDetailModal` (`asset-detail-modal.tsx:369`, component at :417, composed
with `MarkPostedRow` at :374 — Publish Now = staff push through our API,
MarkPostedRow = client attestation), with `connectedPlatforms` threaded
staff-only through the calendar RSC payload (`connectedPlatformsByClient`
computed at `src/app/(app)/calendar/calendar-body.tsx:383-385`, passed at :449 →
`run-calendar.tsx:912`).

The assets list was fixed too: `src/components/assets-view.tsx` declares the prop
(:35), types it (:49) and spreads it into `<AssetCard>` (:124-126), fed from
`src/app/(app)/assets/page.tsx:51` (`pushablePlatformsByClient`) → :63.

**Amended for v3 — the last file is closed.** v2 said the job detail page was
still unfixed. It was fixed in **`386e5b4`** ("fix(qa-F107): show Publish Now on
the job detail page"): `src/app/(app)/jobs/[id]/page.tsx` now imports
`pushablePlatformsByClient` (:16), resolves this job's client's platforms
(:37, with the F107 rationale in the comment at :32-36) and spreads
`connectedPlatforms` into `<AssetCard>` (:74). Nothing is owed here.
`AssetCard` still treats the prop as optional (declared :418, typed `?:` at :423,
defaulting to `[]` at `asset-card.tsx:479` and :942), so a **new** surface that forgets to
thread it will silently hide Publish Now rather than crash — that is the trap to
remember, not an open item.

### 4.5 `publishAssetNowAction` — no idempotency ledger

Pre-existing, logged by the CALENDAR risk lens, **re-verified unchanged at
HEAD**: `publishAssetNowAction` (`src/lib/actions/asset-actions.ts:336-393`)
claims the asset atomically (`claimAssetForPublish`, :362), but on platform
failure it releases the claim (:371) and records only `publishError` (:376) —
no attempt log, no idempotency key toward the platform API.
`publishAssetToPlatform` (`src/lib/integrations/publishers.ts:312`) carries none
either, and the cron mirrors the same shape (`src/app/api/publish/route.ts:130,161`).
Fine at today's volume; if you scale real platform pushes, add an attempt record
/ idempotency key before retry loops exist.

### 4.6 Corrections vs standalone condensation (F77 residual)

Client doc corrections enter generation via the internal source only. A
standalone condensation pass (`refreshClientContextDocsAction` in
`src/lib/actions/intel-actions.ts`) would MISS accumulated corrections — still
true at HEAD, and it applies to you: **if you wire any new pipeline that
regenerates client-tier docs, corrections must be injected there too.**

Read this together with §4.13.1. The `stripPreamble` corruption bug that entry
described is **fixed and retired** — do not go looking for it. What is still
open there is narrower and lives in the same files: `stripTrailingMetaCommentary`
is wired at the condensation boundary only, so the four `stripPreamble` calls in
`src/lib/intel/pipeline.ts` store the model's output unscrubbed. Anyone going in
to wrap those is already in the right file to handle the corrections injection
above.

### 4.7 `applyGlobalDocCorrectionAction` — do not mount as-is

**Re-verified at HEAD — all three halves still true.**
`src/lib/actions/intel-actions.ts:656-666` exports `applyGlobalDocCorrectionAction`
(inner `applyGlobalDocCorrection` :668-731) with **zero callers anywhere in
`src/`** — the only other mentions in the repo are in this document. It charges
unconditionally at :685 and then skips the per-doc write when content is
unchanged (:697-705) **without refunding**: exactly the shape F74 fixed on the
targeted path. The pattern to port sits 200 lines above it in the same file —
`{ changed }` at :468, the "you have not been charged" branch at :472-475, and
`refundDocCorrection` at :519. If anything ever mounts it, port that first.

### 4.8 T1–T7 — the agent-service seams (from `phase3-design.md` §8.3)

Nothing in Phase 3 *waits* on these: every one has a working degraded mode, and
all seven degraded modes are what is running at HEAD. Verified against code.

| # | Seam | Our side (built, verified) | What you wire |
|---|---|---|---|
| **T1** | **Structured launch output** — setup runs emit a client-facing `templates.json`, `[{key, name, rationale}]`, keys kebab-case per the lab item-folder convention | Webhook captures it off bytes already fetched: `route.ts:329-331` (predicate `isLaunchTemplatesArtifact`, `src/lib/jobs/launch-outcome.ts`), seeds the registry via `applyLaunchOutcome` (`route.ts:530`). **Only for launch runs**, so a normal run shipping a `templates.json` cannot reseed a registry. Degraded mode: staff curate by hand. | Lab setup skills emit the file; the service passes it through as an ordinary artifact (it may already — it *is* just an artifact) |
| **T2** | **Launch progress events** — a `job.progress` webhook variant `{job_id, stage, detail?}` | Not accepted yet: the schema is `z.literal("job.completed")` (`route.ts:109`), so a progress event 400s today. Adding it is additive — a new discriminated variant plus a `JobRunEvent` append. `LaunchProgressCard` (`src/components/client-agents/launch-card.tsx`) then upgrades from 2 stages to real ones. | Service emits progress callbacks at research/template checkpoints |
| **T3** | **Day-of single-output generation** — task accepts `template_key` + `count: 1`, produces exactly one on-template post | We already send the pinned prompt + `karos_template_key` (§4.1a) and the webhook stamps the result (`route.ts:421-428`). Missing on our side: per-slot firing (§4.9). | Lab engine honors single-slot mode — today it batches. Confirm per product |
| **T4** | **Note revision as a cheap light run** | Portal fallback is a full custom run, behind a flag; today a note is applied by a **human** — the copy says so and must keep saying so (`src/lib/slot-notes.ts:63-76`) | A dedicated revise skill / task param |
| **T5** | **Video deliverables (F150 / CD-D1)** | **Landed portal-side** — `Asset.videoUrl` (`types.ts:459`), `<video controls>` (`asset-detail-modal.tsx:271-280`), resolver `assetVideos` (`asset-images.ts:102-128`). F150 is the one `DEFERRED-TOMER` row in the ledger | GCP block storage + upload path; service fetches from storage. §3.2 |
| **T6** | **TikTok connector** | CD-D2 pending-verification chip, RESOLVED, decoupled from launch | TikTok app verification + connector. §3.3 |
| **T7** | **X daily 3-option generation** — "produce exactly 3 distinct option drafts for `<date>`", consuming the pick/edit/posted learning log | Picker, telemetry and learning-log serialization are **live** (§4.12, `option-picker.tsx`, `slot-option-actions.ts`, `src/lib/agent-service/x-agent-context.ts`). The interim **batch-slicing** selector is what runs today: a weekly batch lands and `syncOptionsFromBatchAsset` slices it across days (§4.1d) | Lab X skill gains a native daily-options mode + the pick-history optimization contract; the slicer then retires |

### 4.9 Per-slot cron firing + `karos_slot_id` — NOT BUILT (Tomer seam)

The design's highest-fidelity path, and the one thing the slot model is still
missing. Today:

- The scheduled cron is **`src/app/api/run-scheduled/route.ts`** (there is no
  `src/app/api/cron/` directory; registered in `vercel.json:16-17` at
  `*/5 * * * *`). It drains `listDuePlannedScheduledRuns(now, 25)`
  (`run-scheduled/route.ts:40`) and loops **one job per schedule row** (:69,
  submit at :72), stamping `runType: "scheduled"` (:88) and `clientAgentId` (:89)
  when the row carries one.
- **It never iterates `agentSlots` and never sends `karos_slot_id`.** A grep for
  `karos_slot_id` across `src/` still returns nothing at HEAD. The key is
  *reserved by intent only* — `SubmitCustomAgentInput.extraMetadata`
  (`submit-custom.ts:102-106`) names slot ids as what belongs there — but no
  caller passes one, and `RESERVED_METADATA` does not list it.
- The webhook therefore has **no slot branch**. `phase3-design.md` §8.2 specifies
  one: a slot-linked run should stamp `templateKey`/`templateName` from metadata
  (that half is built), link `assetId`/`jobId` onto the slot, and **skip reflow
  in favor of pinning `scheduledAt` to the slot's day** (that half is not).

What this blocks — **slot-note consumption paths 1 and 2**. `src/lib/slot-notes.ts`
is explicit about it (read the header comment, :9-13): three paths exist in the
design, in declining fidelity — (1) day-of generation receives the note as a
`context_file`, (2) a revision pass rewrites an already-generated draft, (3) a
human applies it. **Only path 3 ships**, and the client-facing echo string is
worded to promise exactly that and nothing more (`slotNoteEcho`, :73-76:
"Noted — your Karos team factors this into that day's post."). If you build
per-slot firing, paths 1 and 2 open up — **and the copy must change with them,
in that order.** Copy that implies the agent already read the note, while a
human is still the mechanism, is the same class of lie the sweep spent 137
findings removing.

Build order when you get here: per-slot cron firing (emit `karos_slot_id` via
`extraMetadata`) → webhook slot branch → T3 single-output mode → then the copy.

### 4.10 `matchAssetsToSlots` + `reflowClientChain` — two planners, one calendar

**The most dangerous item in this document.** Land these together or not at all.

`src/lib/slot-plan.ts` is a pure, well-tested module. Two of its exports are
**dead code with passing tests**:

| Symbol | Line | Callers |
|---|---|---|
| `matchAssetsToSlots` | `slot-plan.ts:269` | **none outside tests** |
| `validateSlotReorder` | :350 | **none outside tests** |
| `applySlotMatches` (the write twin) | `src/lib/data-client-agents.ts:262` | **none anywhere** |

Wired and working, for contrast: `generateSlotHorizon` (`slot-plan.ts:125`) and
`slotScheduleFor` (:64) via `ensureSlotHorizon`
(`src/lib/client-agent-slots.ts:94`), `reorderTemplateKeys` (`slot-plan.ts:379`)
via `client-agent-run-actions.ts:252`, and `assignOptionRefs`
(`slot-plan.ts:423`) via `client-agent-slots.ts:177`.

Meanwhile **`reflowClientChain` (`src/lib/chain.ts:22`, a 35-line file) has zero
slot awareness** — no reference to `AgentSlot`, `agentSlots`, `dateKey` or
`clientAgentId` anywhere in it. It lists a client's assets, plans the one-post-
per-day chain, and applies the assignments. Its callers:
`webhook/route.ts:444`, `asset-chain-actions.ts:29`, `lab-output-actions.ts:281`
— **none of them fences off a live umbrella's family.**

The contract that should stop the collision already exists as a *comment*:
`ClientAgent.chainFamily` (`src/lib/types.ts:1713`) says "while it is live, the
slot planner owns this family for this client and plain reflow must not re-date
its assets" — but the field is read only by `agent-identity-map.ts:138`, for
labeling. Nothing enforces it. (Don't confuse it with `chainFamilyFor(type)` in
`src/lib/post-chain.ts:62`, which maps an asset TYPE to a family and is wired
everywhere — the enforcement gap is in the umbrella-level field.)

So: wire `matchAssetsToSlots` on its own and every webhook delivery, import and
staff reflow will re-date the assets the slot planner just placed — the two
planners fight, and the client watches their calendar shuffle. **Requirements:**

1. Land the matcher, its write twin, and a `chainFamily` exclusion in
   `reflowClientChain` **in one change**.
2. Exercise it against **real client data**, not fixtures — the fixtures pass
   today and told us nothing.
3. Honor the invariant the tests do encode: **no asset is ever moved to a past
   day**, and per-template `deriveOrderKey` order is preserved.

### 4.11 Calendar slot rendering — nothing renders a slot outside the week strip

Re-verified at HEAD. The **`AgentSlot` type** is used in six non-test files, all
under `src/lib/` — `types.ts` (the interface, :1808), `slot-plan.ts`,
`client-agent-slots.ts`, `data-client-agents.ts`, `slot-notes.ts`, plus a comment
mention in `client-agents.ts`. **Still zero type usages in `src/components/` or
`src/app/`.**

*Grep warning, new in v3:* a plain `grep -r AgentSlot src` now returns eleven
files, because the action names contain the string — `pickAgentSlotOptionAction`,
`setAgentSlotNoteAction`, `getAgentSlot`, `updateAgentSlot`,
`claimAgentSlotOptionPick`. Those are calls, not the type. Grep for
`AgentSlot[,>\s]` or check the import if you want the real answer.

Components consume a flattened, server-redacted projection instead —
`ClientAgentCardRow["week"]` (`src/components/client-agents/types.ts:71-84`),
built at `src/lib/client-agent-rows.ts:440` from `upcomingSlots`
(called :346, `WEEK_STRIP_DAYS = 7` at :49).

The only surface that paints slots is **`WeekStrip`
(`src/components/client-agents/live-card.tsx:248`)**. **Changed since v2:**
`ClientAgentLiveCard` was deleted from that file, so the week strip's *only*
mount is now the agent detail panel (`agent-detail-panel.tsx:263`, imported :10);
`StaffSlotNotes` (`live-card.tsx:331`) mounts beside it at
`agent-detail-panel.tsx:268`. Siblings: `slot-note-modal.tsx:57`,
`option-picker.tsx:50`.

**The client calendar has no slot concept at all** — a case-insensitive search
for "slot" in `src/app/(app)/calendar/calendar-body.tsx` and `page.tsx` returns
nothing. Consequences:

- Slots are visible on the agents surface but not on the calendar, which is
  where a client actually looks at their month.
- **Paused-grey depends on this.** `calendar-body.tsx:233` filters
  `scheduledRuns` to `status === "active"`, so a paused schedule vanishes
  entirely rather than greying. You cannot grey what you do not render — build
  calendar slot rendering first, and it depends in turn on §4.10.

### 4.12 Credits, run types, and the ledger vocabulary you will see

Built by WP-6; here is what the data looks like so you can read it.

- **`JobRunType`** — `src/lib/types.ts:387`: `"launch" | "scheduled" |
  "manual_template" | "manual"`, stored on the job at `Job.runType`
  (`types.ts:396`, optional — **legacy jobs have none, deliberately**: heuristic
  launch-detection is unreliable, so analytics buckets them honestly as "before
  run-type tracking"). Stamped by four paths: `run-scheduled/route.ts:87`
  (`scheduled`), `client-agent-actions.ts:324` (`launch`),
  `client-agent-run-actions.ts:146` and :167 (`manual_template`),
  `custom-agent-actions.ts:373` (`manual`). Three paths deliberately do **not**
  stamp: the task engine (`execution-engine.ts:266`), the MCP tool
  (`mcp/tools.ts:334`), and the managed-product path, which has its own submit
  core and its own `createJob` (`submit-managed.ts:118`).
- **`CreditOperation`** — `src/lib/types.ts:1390-1406`: `agent_run` (legacy),
  `chat_message`, `task_execution`, `doc_correction`, `custom_agent_run`,
  **`agent_launch`** (:1403), `seat_purchase` (:1405), `manual`.
- **`agent_launch` is charged in exactly one place**: the shared submit core,
  `chargeClientCredits` at `src/lib/jobs/submit-custom.ts:325`, with the
  operation coming from the caller's `charge` override
  (`submit-custom.ts:328`). The only caller that sets it is
  `submitClientAgentLaunchAction` (`client-agent-actions.ts:248`), whose
  `charge` literal is at `client-agent-actions.ts:328-330`. It is gated by
  `isBillableClientActor(user)` (`submit-custom.ts:323`), so staff and
  impersonated launches never charge, and a `CreditError` deletes the job
  (`submit-custom.ts:339-340`) so no orphan survives. Because it uses the same jobId
  pairing as a normal run, **the webhook's failure refund hands launch credits
  back with no extra code** (`route.ts:202-211`).
- **Two label maps exist, and the live one is the bucket map.**
  `CREDIT_OPERATION_LABEL` (`src/lib/credits.ts:431`, `agent_launch: "Setup"` at
  :437) currently has **no production consumer** — the credits panel renders
  `CREDIT_BUCKET_LABEL` (`credits.ts:466-471`) via
  `creditBucketFor(operation, runType)` (:453-464, `agent_launch → "setup"` at
  :457). Buckets are `setup | scheduled | manual | other`. If you add an
  operation, add it to both or the panel will silently bucket it as "other".

### 4.13 Pipeline bugs found by the CD-G7 refresh — code fixes still owed

The fleet refresh (§2.9) fixes **data**. Of the three code defects v2 listed
here, **one is fixed on this branch** and two remain. Whoever runs the next
intel pass needs the two below, plus the narrower residual left behind by the
first.

1. **`stripPreamble` document corruption — FIXED, do not re-report.**
   v2 described this as live: a frontmatter-fence misdetection in
   `stripPreamble` that made `^---` match any line start, so the first Markdown
   horizontal rule in the leading 400 characters was taken for an opening fence
   and every section above it — the H1 *and* the first `##` — was sliced away on
   every Regenerate.

   It is closed. `src/lib/text-utils.ts` now anchors **every** step to the start
   of the document, and admits a `---` pair as frontmatter only when the lines
   between the fences actually read as YAML (`looksLikeYamlBlock`, which rejects
   headings, table rows, blockquotes and bare prose). The whole-document code
   fence is only unwrapped when it demonstrably wraps the document, and the H1
   strip no longer deletes a `# ` line found anywhere in the body. The function
   is **idempotent** — running it on its own output is a no-op — which is what
   makes the condenser's retry path safe to re-run.
   `src/lib/__tests__/text-utils.test.ts` pins this: **35 tests** at HEAD
   (`stripPreamble` at `text-utils.ts:52`, `looksLikeYamlBlock` at :20, applied
   :90), 20 of which were red before the fix.

   **What is still owed here is narrow.** The trailing meta-commentary scrubber
   `stripTrailingMetaCommentary` (`src/lib/text-utils.ts:167`) is wired at the
   **condensation** boundary only — `intel/condense.ts:90` and :116, i.e. the
   client-tier path. The **pipeline** side has no scrubber at all: all four
   `stripPreamble` calls in `src/lib/intel/pipeline.ts` (:592, :595, :701, :708)
   store the model's output unscrubbed, and :595 is where **internal-tier docs**
   are written. So a doc that ends in "If you intended a different template…"
   is cleaned on the client tier and kept on the internal one. Wrapping those
   four sites the way condense.ts already does is the fix; mind that
   `stripPreamble` is idempotent but `stripTrailingMetaCommentary` should still
   be applied once, at the same boundary, not sprinkled through callers.
2. **Leaked LLM meta-commentary reaches the RENDERER unscrubbed.** Note the
   scope change from v2: a scrubber now exists (see the residual in 1 above),
   but it runs at write time on one path only, and nothing filters at render.
   The other defenses are prompt instructions (`intel/brain.ts:184`,
   `intel/pipeline.ts:518`), which are not enforcement. The nearest thing to a
   render-time scrubber, `isInternalLine` (`src/lib/doc-render.ts:164`), is
   invoked **only** from the one-line teaser `toPlainSummary` (:195, call at
   :223) — `renderFullDoc` (:459) and `parseDocSections` (:236) never call it, so
   meta-commentary already sitting in a stored body still renders verbatim to
   the client.
3. **The palette extractor is unreliable and unvalidated.** Stored palettes
   matched no live-site hex for the clients examined. `gatherSiteIntelligence`
   (`src/lib/branding.ts:326`) asks a model to *report* nav/hero/CTA colors as
   **free text** — the labelled report format it demands is spelled out at
   :355-364 (`NAV_BG:` / `HERO_BG:` / `CTA_BUTTON_BG:` …); that text is fed into
   a prompt and a second model call emits the palette (`generateObject`, :716
   and :737). Validation is format-only — `normalizeHex` (:21) expands 3-digit
   and strips alpha, and :752 falls back to the raw lowercased string when it
   rejects. **Nothing compares the returned hexes against anything observed on
   the site.** The one genuinely observed source, `extractColorsFromSvg` (:202,
   logo SVG only), is passed as advisory prompt text (:541-547). The
   anti-hallucination rules in the schema (:433-437, "CRITICAL RULES") are
   prose, not code. Until this is fixed, brand colors need the human gate the
   refresh core enforces (§2.9).

### 4.14 The route map — roster, detail, and the legacy branch

CD-G1 split the agents surface in two; **CD-I1 then split the detail page three
ways by archetype and gave staff the same roster+detail shape**. Knowing which
page and which archetype a client lands on explains most "why does this client
not have X" questions.

- **Roster** — `src/app/(app)/clients/[id]/agents/page.tsx` (417 lines: client
  branch :63-235, staff branch :237-417 — the staff all-in-one card grid was
  retired for roster parity in `f656481`). Cards are built by
  `src/components/client-agents/roster.tsx` (`ClientAgentRoster` :51, mounted
  :225 and :403) and the whole card is a `<Link>` to the detail route
  (`roster-card.tsx:54-55`). **There is no Run button on a roster card** — by
  ruling, and structurally: `AgentRosterEntry` (`roster.tsx:15`) carries no gate,
  no template and no run payload, so the card could not offer one.
- **Detail** — `src/app/(app)/clients/[id]/agents/[agentId]/page.tsx` (769
  lines), `ClientAgentDetailPage` at :135, a server component. Auth/redirect
  :140-147, a 7-way parallel fetch :159-169, a grant-or-earned 404 gate for
  client viewers :172-183, row projection via `toClientAgentRows` :213-232, blurb
  via `clientAgentBlurb` :239-243, delivered work from :245. This page is "the
  agent's home" per Albert.
- **The archetype fork (CD-I1, new in v3).** `agentArchetype({key, name})`
  (`src/lib/agent-archetype.ts:90-99`, union at :42) resolves the page into one
  of `template_calendar` (the default and today's shape), `clip_maker`, or
  `daily_finder` (which is where the Reddit agent lands, §4.3). It is read at
  `page.tsx:266` and branches the hero (:646-651), the deliverables heading
  (:316) and the archive list (:592). The per-archetype view builders live in
  `src/lib/agent-detail-archetypes.ts` — `agentProducedAssets` :47,
  `deliverableStamp` :82, `finderDays` :118, `buildClipMakerView` :193,
  `buildDailyFinderView` :269. **Three page shapes asking "what did this agent
  make" three different ways is three chances to credit a post to the wrong
  agent (F147), which is why the join lives in one module.**
- **The hero states are chosen by ternary. The one to know is the third:**
  **`page.tsx:512` — `) : status.tone === "live" ? (`** is the **legacy branch**:
  a client with a firing weekly schedule but **no `clientAgents` umbrella**
  (i.e. every pre-Phase-3 client, until §2.8 runs). It renders
  `LegacyAgentPanel` (:523,
  `src/components/client-agents/legacy-agent-panel.tsx`, 197 lines), which CD-H8
  built out from a stub: **Create-new-post** priced button (:113-132) with
  painted refusal reasons (:133-150), **pace controls** (:149-171 →
  `AgentScheduleModal` at :183-193, `paceOnly` for clients at :190). The
  deliverables list is rendered by the page, not the panel
  (`[agentId]/page.tsx:588-626`). Its gate is server-side:
  `evaluateLegacyRunGate` (`src/lib/client-agent-runs.ts:320`), called at page
  :370-376. **Deliberately absent** (documented at
  `legacy-agent-panel.tsx:47-51`): template rows, week strip, per-template
  feedback, slot notes — all umbrella-gated. **The backfill script (§2.8) is the
  real fix; this panel is the bridge.**
- **Fifteen** components now live under `src/components/client-agents/` (v2 said
  thirteen; CD-I1 added the archetype set) — `roster.tsx` + `roster-card.tsx`,
  `launch-card.tsx` (pre-live states), `live-card.tsx` (exports
  `TemplateRows`/`OptionsRow`/`WeekStrip`/`StaffSlotNotes`; `ClientAgentLiveCard`
  itself has since been deleted), `agent-detail-panel.tsx`,
  `legacy-agent-panel.tsx`, **`archetype-cards.tsx`**, **`clip-gallery.tsx`**,
  **`daily-finder-panel.tsx`**, `client-agents-section.tsx` (staff),
  `agent-economics.tsx` (staff USD + launch calibration), `feedback-modal.tsx`,
  `option-picker.tsx`, `slot-note-modal.tsx`, `types.ts`.

### 4.15 `assignOptionRefs` — webhook-driven steady state, plus a go-live catch-up

Small but easy to misread, because it moved during the build.

- **Steady state is the webhook.** Each incoming X batch is sliced across the
  plan at the moment it lands: `webhook/route.ts:464` →
  `syncOptionsFromBatchAsset` (`client-agent-slots.ts:215`) →
  `assignOptionsForUmbrella` (:155) → `assignOptionRefs` (`slot-plan.ts:423`).
- **Go-live has a separate catch-up path** for a batch that already existed
  before the umbrella went live: `ensureSlotHorizon`
  (`client-agent-slots.ts:94`) calls `latestXBatchAsset` (:250) once, at :128-129.
- **Why not the horizon generator**: the first implementation hung assignment off
  `ensureSlotHorizon`, whose other callers are template-gated — and an options
  umbrella has no templates by design. So week 1 got refs only by luck and week 2's
  batch, the recurring one the product actually runs on, was never sliced at all.
  The comment at `client-agent-slots.ts:193-214` records this; don't undo it.
- Day boundaries come from the **schedule's** IANA zone, not the container's
  (:164-170) — the F108 contract (§6.4). On a UTC container a Tel Aviv client's
  "today" starts hours earlier.

### 4.16 SEO/GEO methodology v2 — the question-count contract (CD-J1)

Yours because **re-captures run in the service environment**, not from a laptop:
the capture makes live Anthropic + OpenAI + Gemini calls, so the contract below is
enforced in code but only ever *exercised* where those keys live. A run that
violates it is a capture bug, not a display bug.

**The plan.** Every capture emits exactly **20 questions**: 16 category + 4
branded, split by intent — 6 discovery, 5 comparison, 5 problem, 3 brand,
1 navigational. `INTENT_QUOTA` (`src/lib/seo-geo.ts`) is the single source; the
totals (`PLANNED_CATEGORY_QUESTIONS` / `PLANNED_BRANDED_QUESTIONS` /
`PLANNED_QUESTIONS_TOTAL`) are derived from it, never restated. It is
category-heavy on purpose: every client-vs-competitor number in the product is
computed on category questions alone (CD-B3), so that block is the measurement and
the branded four are a control answering "do the engines know this brand at all?".

**Why it exists.** Before v2 the quota was a ceiling only — it took *up to* its
share of whatever the drafter returned, so a thin pool shipped a short set. Clients
were measured on 8+12, 4+11, 5+6. Every client-facing ratio hangs off those
denominators, so no two clients' scores were comparable and "named in 0 of 12" had
no fixed meaning.

**What a capture MUST emit** (`SeoGeoInsights`):

| Field | Contract |
|---|---|
| `promptSet` | exactly 20 questions, the frozen set. This is the denominator for everything below. |
| `methodologyVersion` | `SEO_GEO_METHODOLOGY_VERSION` (`"q2-2026-07-29"`). Absent = pre-v2 capture; the UI reads it by its own rules and never reinterprets it. |
| `pipelineVersion` | `SEO_GEO_PIPELINE_VERSION` (`"2026-07-29"`). Anything else renders under the CD-B4 legacy banner. |
| `categoryPresence` / `brandPresence` | `{ named, measured, total }`. **`total` = planned (16 / 4), `measured` = how many at least one engine answered, `named` ⊆ measured.** `measured` is optional *only* for pre-v2 records. |

**The denominator rule — the one that is easy to regress.** A question no engine
answered is **not** a question we didn't ask. `computePresence` takes `promptSet`
and counts a dead question as planned-but-not-measured; it must never derive its
universe from the probes alone, which is what silently shrank denominators before
(a capture failure *raised* the visible score). Read every bucket through
`presenceCounts()`, which applies the legacy reading in one place.

**Enforcement.** `buildQuestionSet(pool, gazetteer, templates)` fills the plan from
the model pool first and pads short blocks from a deterministic template bank
(`questionTemplates` in `src/lib/intel/seo-geo.ts`), accepting a template only into
the slot `classifyIntent` agrees it belongs to — so the emitted shape and the intent
tags shown in the report cannot drift apart. The fallback set is built from the same
bank and plan, so a degraded run has the same shape as a healthy one. An
under-filled run logs `[seo-geo] Question plan under-filled for <clientId>` with the
shape it actually emitted: **that line in the service logs is the signal that a
client's denominators are off-standard.** Pinned by `src/lib/__tests__/seo-geo.test.ts`
("the question plan is fixed, deterministic and category-heavy").

**Changing the plan later.** Edit `INTENT_QUOTA`, bump
`SEO_GEO_METHODOLOGY_VERSION` **and** `SEO_GEO_PIPELINE_VERSION`, and leave old
snapshots alone — they keep rendering under their own stamp. Do not retro-fit new
maths onto old captures (CD-B4); a re-capture is how a client moves to the new plan.

**Also in CD-J1, for context when you read that code:** presence scores render as a
percentage with the counts in a click-through popover (`score-popover.tsx`);
`computeRosterSharePct`'s category predicate is now a required argument; a
staff-only banner flags a tracked roster that shares nobody with the brands the
engines named (`buildRosterSanity` — suggests, never mutates); and `REC_COPY`
client strings are held to a no-jargon/no-thresholds bar by two tests, with the
technical phrasing living on the staff-only gap block.

**Three rules that exist because old snapshots outlive the code that wrote them.**
Everything below was a live defect on a real client page, and each will come back
the moment someone reads a stored field as if a current pipeline had written it.

1. **Plan copy is frozen at capture, so re-resolve it at render.**
   `recommendations[]` is persisted, so improving `REC_COPY` only ever helped
   clients captured afterwards — a July-22 snapshot still served the engineering
   labels the table exists to replace. `resolveRecCopy(recId, stored?)` is the one
   resolver, used by `buildRecommendations` at capture and by `healRecommendations`
   at render. Ids are stable, which is what makes retroactive healing possible —
   **do not rename a REC_COPY key**, it orphans both the copy and the approval.
   Healing runs at the SERVER boundary (`SeoGeoPlan`), not in the client leaf, so
   the raw strings never enter the RSC payload.
2. **Label a legacy snapshot; never relabel it.** `categoryMetrics` falls back to a
   record's full-set figures when it has no `category` field. That fallback is
   correct and stays. What must not happen is calling those numbers "category" —
   that is how one page showed four contradictory denominators (the full prompt
   count and the all-probe count both wearing a category label). Take the noun from
   `buildMeasurementBasis(insights)`, which decides structurally, not from a version
   string. The legacy banner keys on three independent signals: pipeline stamp,
   methodology stamp, and that structural check.
3. **Absent is not zero.** `citationSummary` is optional because captures predating
   it carry none. Reading a missing field as `?? 0` is what made the panel report
   "we couldn't measure any answers this run" next to "3 of 5 AI engines measured".
   Any new optional field on this record inherits the same rule: distinguish
   *not recorded* from *measured as none* before writing copy about it.

**Reading a snapshot's age off its denominator.** `citationSummary.totalMeasuredAnswers`
tells you which code wrote a snapshot, which is the fastest triage there is:

- **60** (= 20 questions × 3 engines) → pre-CD-B3. The summary counted EVERY probe,
  branded questions included.
- **48** (= 16 category questions × 3 engines) → current. `computeCitationSummary`
  takes `categoryProbes` only.

This was checked because two different clients rendered an identical "11 of 60" and
that looked like cross-client contamination. **It is not** — audited and cleared: the
`clientSeoGeo` doc id is derived from the payload's own `clientId`, the importer
refuses a bundle whose `clientId` differs from its target, `refresh-apply-core.ts`
touches SEO/GEO not at all, no script writes the collection, and there is no render
cache or fallback snapshot object outside tests. `brandCited` is keyed strictly to
the client's own `gazetteer.clientDomain`, so the numerator cannot be
client-independent by construction.

The shared value is a property of the legacy maths: on a pre-CD-B3 snapshot the
count is dominated by the client citing its OWN domain on branded prompts ("what is
X", "X reviews"), which is engine behaviour rather than category performance, so it
converges near (branded questions × engines) for any client with a live website. Two
clients matching is expected. Re-capture is the decisive test — if a post-CD-B3
snapshot still reads "of 60" when it should read "of 48", that IS new evidence.

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
   (`calendar-body.tsx:233` filters to `status === "active"`), and resume lives
   only on the AI Agents page. Phase 3's default answer is Q7 — hide future
   slots from clients, grey them for staff — but it is **blocked on §4.11**:
   nothing renders a slot on the calendar to grey.
4. **Attention-count inflation (post-F97):** the dashboard attention row folded
   in every draft. **Resolved by WP-5's archive rework** — clients no longer see
   drafts at all (`isInClientArchive`, `asset-visibility.ts:101`, the draft
   rejection at :106; the three rules are documented :50-64), so the count no
   longer inflates. Kept here as history because §5.2's copy debt references it.
5. **`ANALYTICS_LIVE_INGEST`** — §2.7.
6. **The X learning-log window — OPEN RULING, needed before WP-9 runs at volume.**
   The learning log that teaches the X agent a client's taste is capped at
   **`FEEDBACK_ROWS_PER_ACCOUNT = 30`**
   (`src/lib/src/lib/agent-service/x-agent-context.ts:45`, applied :75) — and the window
   is **per account bucket, not per client**, fed newest-first from
   `listXDraftFeedback` (called :156; defined `data.ts:2348-2356`, the
   newest-first sort at :2355).
   Each daily pick auto-writes the **two** unpicked options as `not_posted` rows
   (`src/lib/actions/slot-option-actions.ts:166-179`, literal at :175), and
   marking the winner posted writes a third (`recordPostedOptionFeedback`,
   `asset-actions.ts:408-420`, invoked from `markAssetPostedAction` at :312). So
   the real burn is **up to 3 rows/day**, not the 2 the ruling assumed. For a
   single-account client all three land in the same `"company"` bucket and
   **exhaust the 30-row window in ~10 days**, evicting genuine client feedback —
   the signal the log exists to carry.
   Options, in the orchestrator's order of preference: raise the cap; split the
   auto-log into its own stream so it cannot evict human feedback; or decay
   auto-rows faster than human ones. **This is a product call, not an
   engineering one** — it decides what the agent remembers about a client.
7. **P3 deferrals worth Albert's eyes** (from the WP-4+ round): clients lost the
   cross-agent "recent runs" list (runs now live per-agent on detail pages —
   acceptable under CD-G1, but it was a real surface); and the client run gesture
   takes **no attachments**, since the generic dialog's picker is now unreachable
   for clients. If client attachments matter, that needs a design call.

### 5.2 Accepted residuals (logged, deliberate — do not "fix" in passing)

- **F24 partial coverage:** `schedule.lastError` covers submit-time refusals
  only; a run that submits and then fails at the agent service (webhook
  reports failure) still shows a green Live badge until the run-history work
  (F29/F132, AGENTS) surfaces last-run outcome. Also: a stale `lastError`
  only clears on the next clean fire — up to a week of false "Needs
  attention" on weekly cadence.
- **F108 residuals:** legacy zone-less schedule rows keep old behavior until
  re-saved (by design); posts / past-runs / today-highlight still bucket in
  the runtime-local zone. `dayKey` (`src/components/run-calendar.tsx:108`) takes
  the zone as an *optional* second argument, and only the planned-run call site
  passes one (:603); the posts call site does not (:612). That optionality is
  the residual — re-verified at HEAD.
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
- **F37 — RESOLVED except the `/clients` server-side scan.** The rescope
  recorded this residual and v2 lost it. The employee-visibility LEAK is
  closed: `src/app/(app)/clients/page.tsx` now fences its `counts` map to the
  visible-client set before it crosses to `ClientsGrid`, the same skip `/jobs`
  uses, so an employee's RSC payload no longer carries the ids, volumes or
  `lastRunAt` of clients outside their assignment. What remains is
  PERFORMANCE, not exposure: the page still runs unfiltered `listAssets()` and
  `listJobs()` (`clients/page.tsx:13-14`) and reduces in memory (:36-38) to print
  two numbers per card. Replacing both with a server-side `count()` per visible
  client is the open work.
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

**Added in v2 (Phase 3 / CD-G / CD-H):**

- **Slot notes are human-applied only** — paths 1 and 2 are unbuilt (§4.9). The
  copy is deliberately worded to promise a human; changing the copy before the
  mechanism would be a regression, not an improvement.
- **The options picker runs on a sliced weekly batch**, not on day-of
  generation (seam T7). Churn-honest because option texts cross the RSC boundary
  only on their own day, but it is the degraded mode.
- **Paused umbrellas cannot grey on the calendar** — §4.11, blocked twice over.
- ~~**`ScheduledRunsCard` toggle/delete are still silent.**~~ **CLOSED — v2 is
  wrong at HEAD.** It was fixed in `5d2355f` ("surface errors and confirm deletes
  on the settings schedule rows", F110). `ScheduledRunRow`
  (`src/components/scheduled-runs.tsx:50`) now carries per-row `busy`/`error`
  state (:52-54); **`onToggle` (:56-76) and `onDelete` (:78-95) each wrap the
  action in `try`/`catch`, capture `{ error }`, and render it at :163**, and the
  delete asks for confirmation first (`confirmingDelete`, :54). The rationale is
  the comment at :40-49. The legacy `/api/scheduler` route (121 lines) is hardened
  the same way: cron auth :32-33 (`requireCronSecret`, imported :11),
  `Promise.allSettled` :48, a structured
  `{processed, fired, skipped, failed, results}` response :114-120. The create
  path's own error state is `ScheduledRunsCard` :180, rendered :347. **Nothing
  here is owed.**
- **`asset-card.tsx` still calls `markAssetPostedAction` inline** — `handleMarkPosted`
  at :603, the call at :607 — rather than using the extracted `MarkPostedRow`.
  Harmless, but it is a third code path to the same action.
- **Environmental, report-only:** a 10px right gutter persists wherever classic
  scrollbars are enabled (`scrollbar-gutter: stable`). The forced root scrollbar
  was removed as ruled, so macOS gets true edge-to-edge; other platforms are
  unchanged in substance. Needs Albert's eye on his own machine.
- **Pre-existing `react-hooks` purity lint errors** (`Date.now()` in the agents
  page and `launch-card.tsx`) pre-date this wave — end-loop sweep.

### 5.3 Finding-shaped gaps logged for end-loop triage (no PDF number)

- ~~Legacy `/api/scheduler` + `ScheduledRunsCard`~~ — **fully closed**, see §5.2.
- ~~`src/components/client-home.tsx` is still dead code at HEAD~~ — **DELETED,
  and the entry is retired.** It went in **`94ffa14`** ("drop dead ClientHome and
  the unreachable run-gate fallback", #23), which also removed the only caller
  that shipped an intake gate with no inline payload — so the run dialog's
  navigate-away setup panel and `AgentDataButton`'s anchor variant went with it.
  **Do not resurrect it.** The live client dashboard component is the separate
  `src/components/client-home-overview.tsx`; don't confuse the two names.
- `client-guidelines` is a permanently dead `DOC_TABS` row (internal-only
  tier, `pickDoc` never surfaces it).
- `AiProcessingBanner` mounts only on dashboard/settings — on other client
  routes the only regenerate signal is a greyed button.
- Impersonated writes log `actorRole` as CLIENT_USER (all impersonated
  writes, pre-existing).
- SEO Approve → `logActivity` is unbounded/no-dedupe and client-callable
  (self-inflicted scope only).
- **Copilot: both of the two are now closed** (v2 listed one as live).
  - *Benchmarks — FIXED.* The fetch is still unscoped
    (`getClientPerformanceBenchmarks` in the parallel block,
    `src/app/api/clients/[id]/chat/route.ts:84`) but a provenance filter now
    sits between it and the prompt: rows whose `source !== "live"` are dropped
    for `CLIENT_USER` and `sampleSize` is recomputed (:220-226, rationale
    :213-219, consumed :251-254).
  - *Branding write — FIXED (035a2f6), and the remaining path is ACCEPTED.*
    v2 described `update_branding_guidelines` as registered ungated, so a
    billed `CLIENT_USER` could push free-form chat text into the
    **internal-tier** branding doc. That is closed:
    `src/lib/copilot-tool-access.ts` strips the tool out of a client session's
    registry entirely (`copilotToolsFor` :84, the primary fence — an unlisted
    tool cannot be called; the exclusion is stated at :29) and
    `brandingToolRefusal` (:133, message `BRANDING_TOOL_REFUSAL` :101) refuses
    inside `execute` as defence in depth. `e440f0b` later inverted the fence from
    a denylist to an **allowlist**, so a newly added tool is client-invisible
    until someone lists it. Impersonation does not lift it: an admin in "View as
    Client" arrives as a `CLIENT_USER` and is denied, the same line
    `isBillableClientActor` draws for credits.

    **What remains is the sanctioned rail path, and pass 2 ruled it correct —
    do not "fix" it.** A client CAN still change their own branding, through
    BrandColorsSection → BrandingModal → `saveBrandingGuidelinesAction`
    (`src/lib/actions/branding-actions.ts:47`). That is a different act from
    the one v2 flagged, on three counts: it **authorizes** (`requireClientAccess`
    at `branding-actions.ts:51`); it **protects the internal field** — `usagePct`
    is the agency's mix guidance, stripped at the RSC boundary by
    `toClientBrandingView` (`src/lib/client-visibility.ts:23`, applied :106) so it
    never reaches the browser, and re-applied from storage on save by
    `preserveInternalUsage` (**`branding-actions.ts:28`**, called :58 — v2 put
    this function in the wrong file), matched on hex first and position second,
    so a client reordering swatches cannot blank the agency's numbers; and it is
    **audited** — every
    save writes a `BRANDING_UPDATED` activity log naming the actor and role.
    A client owning their own colors is the product working; what §6.6 forbids
    is an *unauthorized, unaudited* write into internal-tier content, which is
    what the chat tool was and the rail is not.
- **`assignOptionRefs`/`matchAssetsToSlots` dead-code pairs** — §4.10, §4.15.
- The non-docked floating `ChatbotWidget` branch is **still unreachable at HEAD**
  — both call sites pass `docked` (`copilot-dock.tsx:184`, :234), so
  `floatingPosition` (`chatbot-widget.tsx:623`, defaulted :636) and the
  `{!docked && …}` bubble at :688 are dead. End-loop deletion, found during CD-G8.
- ~~`src/components/theme-toggle.tsx` became unreferenced…~~ — **DONE. The file
  no longer exists**; it was deleted in the same commit that relocated the chrome
  (`f254d20`, CD-G9c). The live component is
  `src/components/theme-switch.tsx:9` (`ThemeSwitch`), mounted in `sidebar.tsx`
  (:347, :637, :720), `client-rail.tsx:319` and `account-menu.tsx:86`.
- ~~`calendar-body.tsx` ~:178 falls back to `agent.description` for a blurb~~ —
  **CLOSED.** The calendar surface routes client viewers through
  `clientAgentBlurb` in both places it needs a blurb: the schedule dialog's agent
  options (`calendar-body.tsx:216-218`, with the payload-leak rationale at
  :205-207) and the scheduled-run chips (:241-247, rationale :236-240). Staff
  still get `clientBlurb || description` at :247 — that is correct, the manifest
  is theirs to read. Resolver: `src/lib/agent-blurbs.ts:155`.
- **Feedback-list gaps** (from the WP-2/WP-3 lens round, accepted for now): the
  200-row feedback cap counts resolved rows and no delete exists, so the copy can
  advise an impossible action; and Withdraw renders as "Resolved" in the list.

---

## 6. Environment & conventions crash course

Read this before your first commit. These are the rules the whole campaign
enforced; breaking them will fail the same review gates.

### 6.1 CLAUDE.md hard rules (the app's constitution)

- **All Firestore access is server-side** through `src/lib/data.ts` (Admin
  SDK). The browser uses Firebase only for auth; `firestore.rules` denies all
  direct client access.
- **All writes go through server actions** in `src/lib/actions/*` — 36 domain
  modules. **There is no `src/lib/actions.ts`**: the `@/lib/actions` import that
  CLAUDE.md and half the components use resolves through the directory index,
  `src/lib/actions/index.ts:5` onwards. Each domain file carries its own
  `"use server"`, so the re-exports stay server actions. Each authorizes via
  `getCurrentUser()` /
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

`src/lib/seo-geo.ts` is CRLF and contains a literal NUL byte — it is the
Map-key separator in the question-row builder's `byKey` map
(`` `${p.prompt}\0${p.engine}` ``). `grep`/`rg` treat the file as binary
and **silently return nothing** — a plain grep for a symbol defined there
reports false "zero matches / zero importers". Use:

```bash
LC_ALL=C grep -an "buildRecommendations" src/lib/seo-geo.ts
```

Re-verified at HEAD: 81,811 bytes, 1,632 CRLF pairs, **2 NUL bytes**, both the
Map-key separator (`seo-geo.ts:1379` sets, :1384 gets; the map is built at :1378).
A plain `grep -n "byKey" src/lib/seo-geo.ts` still exits 1 with **zero output**,
and a recursive grep over `src/lib/` silently omits the file entirely. Only
`grep -a` surfaces it. (Counting the NULs from zsh needs `python3` or
`tr -dc '\000'` — a NUL cannot survive in `argv`, so passing one to `grep` gives
a false negative.)

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

`src/components/job-status.tsx:9-20` exports `JOB_STATUS_META` (tone + label per
`JobStatus`) and `JobStatusBadge` (:22). **Every** surface that shows run state
goes through it — printing raw `job.status` puts the database enum ("review") in
front of a client, which is exactly findings F41/F120. Do not add a second
label map; re-verified at HEAD, there still isn't one (the other status maps in
the tree are different domains: `Asset["status"]`, `TaskStatus`, `BoardStatus`).
**`cancelled` has landed** (`job-status.tsx:19`, `JobStatus` declared at
`src/lib/types.ts:209` with the member and its rationale at :215-222): terminal,
distinct from `failed`, because a cancel is not a failure (F30). The webhook maps
it explicitly (`route.ts:44`, inside `STATUS_MAP` :38-45).

The credit vocabulary has the same choke-point discipline but **two** maps —
see §4.12 before adding an operation.

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
  `npm run build` · `npx vitest run` (**1,281 tests / 93 files green at
  `9e7c46e`**; it was 879 / 71 at `f7a126b` — if your branch reports fewer files,
  you dropped one in a merge).
- Guard zones still standing: no AI Insights rework beyond listed defects
  (directive B5); never expose content pre-generation (A3/A4).

### 6.8 The ordering rule inside the webhook (new in v2)

If you touch `/api/agent-service/webhook` for any reason, internalize this
before you type: **`claimExternalJobCompletion` is single-use.** Everything that
can throw and must not be lost — the failure refund, the template lookup — is
deliberately hoisted **above** the claim and fails the delivery with a 503 so
your retry queue re-drives it. Everything after the claim (chain reflow, options
assignment, launch-state advance, task sync) is **best-effort by construction**
and must swallow its own errors, because a redelivery will short-circuit on
"Already processed" and never run it again. Adding a throwing call below the
claim is how you lose a client's deliverable. Full map in §4.1c.

### 6.9 Zones, one last time

Every day-boundary computation in the slot system reads the **schedule's stored
IANA zone**, never the container's. Slot horizon, options assignment
(`client-agent-slots.ts:164-170`) and note eligibility all follow §6.4. On a UTC
Cloud Run container a Tel Aviv client's "today" starts hours earlier, and reading
it in the wrong zone silently skips the day they are actually living in — no
error, no log, just a missing post.

### 6.10 The browser floor: regex lookbehind (F126)

The portal's inline-markdown renderers use **regex lookbehind** — `(?<!\w)` /
`(?<=…)` — to keep `_snake_case_` identifiers from turning into italics:

- `src/components/ai-insights.tsx:201` (module-scope literal, the F126 fix)
- `src/lib/doc-render.ts:307`, `:310` (inside `stripInlineMarkdown`; the comment
  at :303 explains why the `(?<!\w)`/`(?!\w)` pair is there)
- `src/components/client-documents.tsx:149`, `:152`

Lookbehind is a **parse-time** feature. An engine that does not support it
throws a SyntaxError while parsing the module, not when the regex runs — so
there is no graceful degradation and no try/catch that helps: the chunk fails
to load and the user gets a **blank page**, not a mis-rendered italic.

**The floor this sets: Safari 16.4 (March 2023).** Chrome/Edge 62+ and Firefox
78+ have had it for years; Safari was the laggard. iOS is the case that matters,
since iOS Safari's version is tied to the OS.

This was accepted deliberately for this portal (staff and a small set of client
users, all on current browsers) — it is documented here as the explicit floor,
not as a defect. Two consequences worth knowing:

1. **Do not add lookbehind to a NEW module without checking this line first.**
   The blast radius is whatever route that module is in, and the failure looks
   like a broken deploy rather than a browser-support problem.
2. If the floor ever has to drop, the fix is a capture-and-check rewrite (match
   the preceding character into a group and test it in the replace callback),
   not a polyfill — lookbehind cannot be polyfilled, because the failure is in
   the parser.

---

*Refresh protocol: when a wave merges, update §1.4/§1.6, re-tag §4 items whose
ledger rows changed, move closed §5 items to §5.2 with their commit, and add a
changelog row. Keep section numbers stable — append (§4.16, §2.12) rather than
renumber. When you close a §4 seam, say so in place with the commit rather than
deleting the entry: half this document's value to the next reader is knowing
what used to be true.*

*And re-check the line numbers. v3 found that **ten of fourteen** spot-checked
`file:line` citations had gone stale in a single wave — a doc that points you at
the wrong line is worse than one that points at a symbol. The rule that survived:
**cite a line only for code, never for a `LEDGER.md`/`rescopes.md` row** (those
are keyed by id, and rows get inserted above yours), and always keep the symbol
beside the number so the reader can re-locate it when it drifts anyway.*

**Section list (v3):**
§1 State of the branch (1.1 campaign · 1.2 ledger · 1.3 Phase 1 · 1.4 Phase 2 ·
1.5 verification system · **1.6 Phase 3 + CD-G/CD-H**) ·
§2 Ops runbook (2.1 blurbs · 2.2 asset titles · 2.3 scripts inventory ·
2.4 credits + regenerate · 2.5 password · 2.6 agent-service env ·
2.7 ANALYTICS_LIVE_INGEST · **2.8 backfill-client-agents (built, unrun)** ·
**2.9 CD-G7 refresh** · **2.10 per-agent pricing** · **2.11 grants + fill-only**) ·
§3 Infra (3.1 CPU throttling · 3.2 video/GCP · 3.3 TikTok) ·
§4 Deferred seams (**4.1 the metadata contract** · 4.2 managed-products retired ·
**4.3 Reddit — LANDED, not a seam** · **4.4 Publish Now — CLOSED** ·
4.5 publish idempotency · 4.6 corrections vs
condensation · 4.7 global correction action · **4.8 T1–T7** ·
**4.9 per-slot cron + slot notes** · **4.10 the two planners** ·
**4.11 calendar slot rendering** · **4.12 credits/runType vocabulary** ·
**4.13 pipeline bugs** · **4.14 route map + legacy branch** ·
**4.15 assignOptionRefs**) ·
§5 Residuals + product decisions (5.1 Albert sign-offs incl. **the X
learning-log ruling** · 5.2 accepted residuals · 5.3 end-loop gaps) ·
§6 Conventions (6.1 CLAUDE.md · 6.2 NUL grep · 6.3 worktree fork · 6.4 timezone ·
6.5 JOB_STATUS_META · 6.6 sanitize at the boundary · 6.7 working style ·
**6.8 webhook ordering** · **6.9 zones** · **6.10 browser floor (lookbehind)**).
