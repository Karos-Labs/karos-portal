# Re-scopes & intel accumulated during execution

Living file — cluster fixers MUST read the entries for their findings before
starting. Updated by the orchestrator after each verification gate.

## After F1 merge (b92de80) — SEO cluster impact
- **F9**: do NOT target presenter.ts:749 anymore. The client path is now
  SeoGeoActionPlan ← buildRecommendations (src/lib/seo-geo.ts:986), which falls
  back to the raw engineering label for the ~22 ids REC_COPY doesn't cover — F9's
  symptom survives there. Fix = extend REC_COPY coverage (or a safe generic title)
  for uncovered ids. The GapView.description clause of F9 is now staff-only work.
- **F7**: part 2 (Approve control) satisfied by F1. Part 1 (agent-handoff chip)
  must NOT be built into gap-list.tsx (staff-only now) — if client-visible handoff
  is wanted it belongs on SeoGeoActionPlan rows. Decide at cluster time.
- **F4**: part 2 satisfied. Part 1 ("Karos can apply this fix automatically" string,
  presenter.ts:694) still real but staff-only exposure now — fix the copy, severity
  effectively lower.
- **F3 / F16**: surfaces demoted to staff-only by F1; still fix (raw model prose,
  mis-filed filter chip in gap-list.tsx:18-22) but client-trust urgency gone.
- **CD-B4**: F1's fixer added a narrow planPendingRefresh guard (recommendations
  empty + gaps non-empty). CD-B4's fixer should GENERALIZE this into the proper
  stale-snapshot treatment, not add a second mechanism. Copy nit: guard text
  narrates product history ("before we started writing the plan in plain English")
  — neutralize when CD-B4 lands.
- Known client-facing trades made by F1's prescribed swap (log, don't "fix" back):
  max 10 rows, no channel filter chips, no found/goal expander for clients.
- seo-geo-panel.tsx line numbers below ~:381 shifted ~+12 (F5 re-locate).
- seo-geo.ts is CRLF with a literal NUL at ~:1154 (map-key separator) — rg treats
  as binary; use grep -a. Pre-existing; do not "fix" line endings.

### Risk-lens watch-items from F1 (non-blocking, inherited by clusters)
- SeoGeoPanel's `isClientViewer` prop defaults false (fail-open toward staff view).
  Fine with today's single call site; SEO cluster: consider making it required.
- F9 fixer: do NOT re-swap the panel back to gap rendering (F1 BLOCKER wins).
- Approve → logActivity is unbounded/no-dedupe and directly callable by clients
  (self-inflicted scope only). Pre-existing pattern; note for SHELL/CREDITS review.
- Impersonated writes log actorRole as CLIENT_USER (pre-existing, all impersonated
  writes) — candidates for a small fix in SHELL cluster or handover note.
- True-empty state copy is staff-voiced third person ("this brand") — copy pass
  with F9's REC_COPY work.
- grep on src/lib/seo-geo.ts REQUIRES `LC_ALL=C grep -a` (NUL byte) — plain grep
  silently returns nothing; false "zero importers" hazard for all agents.

## After F46/F47 (271c381, 29f8c81) — AGENTS + WORKSPACE cluster impact
- **RULING (orchestrator): Reddit clauses STRUCK from F28, F46, F70** — verified
  via `git log --all -S"parseRedditDrafts"`: those surfaces never existed in this
  repo (sweep ran on a tree carrying a Reddit agent ours lacks; only the OAuth
  connector src/lib/integrations/reddit.ts exists here). Any other finding citing
  reddit-drafts/reddit-agent-intake surfaces: verify existence first, strike if
  absent, log in ledger notes. TOMER-HANDOVER must record: when the Reddit agent
  lands, re-apply the established patterns (third sniff slot in
  asset-detail-modal.tsx documented in F46's commit; F70's title fix at the
  reader render boundary; F28's intake copy).
- F27 (Reddit reply-cap) / F36 (Reddit Start-run): same existence check applies —
  AgentScheduleModal may still carry Reddit cadence config even without the drafts
  surfaces; fix what exists, strike what doesn't.

### AGENTS-cluster composition rules (from F24/F131/F127 verification)
- **F129**: status strip has prior claimants — F24's refusal line renders first
  when schedule.lastError set; F131's chip already links to setup. Reuse
  blockedSetup/setupTargetFor; add a "refusal" tier to F129's precedence list;
  do NOT add a second setup link.
- **F25**: reuse the `viewer={{name,email}}` prop F24 added (don't add
  userName/userEmail props). When deleting the disabled-button `title`
  (pointer-events-none makes it unreachable), render BOTH credits and setup
  reasons as visible lines. Consider structured denial codes (CreditError.code)
  while building blockReason — replaces F24's string matching durably.
- **F128**: must also cover clientBlurb and the unclamped Modal description.
- **F24 partial-coverage note (ledger)**: lastError covers submit refusals only;
  a run that submits then FAILS at the agent service (webhook failed) still shows
  green Live. Surface last-run outcome via F29/F132 run-history work.
- Finding-shaped gap (log for end-loop triage): legacy /api/scheduler +
  ScheduledRunsCard have the same silent-failure shape on the scheduledRuns
  collection — no PDF finding covers it.
- **F127 ops dependency**: code alone doesn't clear the symptom — existing agents
  render manifest via fallback until scripts/backfill-agent-blurbs.ts --apply is
  run (Albert/ops sign-off, like C2 credit reload). Ledger: F127 → "code merged,
  ops pending" not RESOLVED.
- Stale lastError never clears on client-side setup completion (only next clean
  fire) — up to a week of false "Needs attention" on weekly cadence. Accepted for
  Phase 1; candidates: clear on intake save (F25/F129 territory) or on schedule
  edit.
- **Phase 3 building block**: AssetDetailModal already contains MarkPostedRow →
  markAssetPostedAction (gated approved/scheduled/delivered). A4's mark-as-posted
  flow should extend this, not invent a new one.
- **F47 ledger note**: took the copy option; the draft-filter option is actively
  wrong today (webhook creates ALL deliverables as status "draft" —
  webhook/route.ts:346). Archive=posted-only arrives with Phase 3 (A4).
- looksLikeMarkdown sniff + AssetContentBody (doc-render.ts) now exist with unit
  tests — reuse for any other raw-text rendering findings (F57, F83, F89 family).
- F47 ledger tag: "resolved phase 1; copy revisit under F149/A4" — the new
  'lands in your archive as soon as the run finishes' sentence becomes false once
  archive = posted-only. F149 spec additions: per-batch mark-as-posted rule
  (MarkPostedRow + per-draft outcome buttons will coexist once staff approve a
  batch), and the F97 attention-row overstatement.
- F150 note: the ~20-line liMedia artifact filter is duplicated verbatim in
  asset-card.tsx and asset-detail-modal.tsx — extract a shared helper when doing
  video work, edit both until then.
- RESOLVED by bounce commit b8c91ce: renderAssetBody (no preamble strip) vs
  renderFullDoc (context docs, still strips); blockquotes live on BOTH paths now;
  `---` renders as <hr> including in context docs (small visual change to
  client-documents rendering — expected). DOCS cluster: use renderAssetBody for
  asset-ish content, renderFullDoc for context docs; regression tests pin the
  split.
- **Dead code confirmed**: src/components/client-home.tsx has zero importers
  (ClientHome symbol unused). Remove in end-loop cleanup pass — contains a stale
  approval-lie string (F47 class) that must not resurface via revival.

## After F97 (350a1a2) — DASHBOARD cluster impact
- progress-view.tsx tabs are now URL-driven (?tab=), set via history.replaceState
  (deliberate: router.replace would re-run all force-dynamic server fetches per
  click). Deep links to /tasks?tab=archive work — reuse for F64/F65 (task
  notifications landing on wrong board tab).
- clients/[id]/page.tsx lost the `jobs` prop on ClientHomeOverview — F99/F124
  fixers will see a trivial conflict; theirs wins on content, keep the prop drop.
- Client-reachable /assets redirect (assets/page.tsx:24) still drops status
  filters for any OTHER link — known, untouched; relevant to SHELL cluster.
- **F64 param collision (WORKSPACE cluster, act on it)**: F97 claimed `?tab=` on
  /tasks for board/activity/archive. F64's prescribed `/tasks?tab=client` deep link
  must use a DIFFERENT key (`?owner=client`) and TasksBoard must ignore unknown
  values. Do not re-key F97's tabs.
- F99 cites progress-view.tsx:42-67 for the segmented control — shifted to ~68-95
  after F97; re-locate, don't copy the wrong hunk.
- F66 composes: extend F97's /tasks?tab=archive with &status=draft seeding per its
  own spec. Locked/future-dated drafts read as "in review" in the attention row —
  slight overstatement that F149/A4 dissolves; log under F149, don't patch now.
- Risk watch-items (F97): (a) same-route soft-nav desync — client-rail:72 and
  notification-bell:260/292 navigate to /tasks without ?tab=, leaving tab state
  stale vs URL; a useEffect sync on searchParams closes it — fold into F64/F66
  work. (b) attentionCount now folds in every draft → "Needs your attention: 21
  items" inflation possible — PRODUCT NOTE for Albert, spec-sanctioned but worth a
  look with F149/A4. (c) consider <Suspense> around ProgressView if force-dynamic
  is ever dropped.

## After F125 (6c4b2c0) — DASHBOARD cluster impact
- insights route now: mock data + client viewer → plain-text needs-connection
  response (no LLM call, X-Insights-State header); digest filtered to usable
  integrations; admin View-as-Client sees the client empty state (fidelity choice
  — staff must exit impersonation for demo prose).
- Behavior change: analytics rows only from non-integrated platforms → digest
  empties → panel falls back to pipeline summary. Honest; noted for mock-client
  regression walks.
- F100/F126 untouched (Phase 2), B5 guard respected.
- Walk observations for DASHBOARD cluster: (a) STAFF lens shows "DEMO DATA" badge
  with an empty 92px card body (insights route returns 200 empty for staff on
  Karos Labs) — staff-only, non-blocking, fix alongside F124/F99. (b) "3 pending
  tasks" count appears to include a Done card and disagrees with the filter chips
  — check against F17/F124 scope, else log as new. (c) Karos Labs shows
  Google/LinkedIn/YouTube CONNECTED while insights says "connect a social
  account" — consistent with ANALYTICS_LIVE_INGEST unset (all records mock);
  env question for TOMER-HANDOVER. (d) Recent-activity rows all link to the
  generic archive, not the specific deliverable — candidate polish with F66.
- Bounced once (drift lens): mock gate must be computed on scopedRecords, not the
  unfiltered set — correction pending in fixer worktree.
- **F145 fixer note**: F125 scopes the briefing to `integrationIsUsable` platforms,
  so a dead-token channel's rows silently vanish from the digest — same pathology
  F145 fixes elsewhere. When fixing F145, consider including needsReconnect
  platforms in connectedPlatforms and letting the mock-gate carry honesty ("LinkedIn
  data is stale — reconnect").
- F126: renderInline moved 139→164; F100's cited :97 is already US spelling (moved
  to :108) — re-locate by symbol.
- Risk-lens watch-items (F125): (a) COPILOT cluster — chat route feeds UNSCOPED
  benchmark records into the credit-charged client prompt (chat/route.ts:74 →
  data.ts:1062-1069): mock metrics still narratable in chat; fold into F95/F89
  family work. (b) listClientIntegrations decrypts OAuth tokens into route memory —
  never stringify integrations into any prompt. (c) If ANALYTICS_LIVE_INGEST is
  unset in prod, ALL records are mock → every client sees the connect empty state
  even with channels connected; copy nuance + env question for TOMER-HANDOVER.
  (d) Staff with zero usable integrations lose the demo briefing + badge (falls to
  pipeline branch) — minor, note only.

## Wave-1 closing walk residuals (assign in wave B/C)
- x-drafts-review draft metadata renders literal single-asterisk emphasis
  ("*How Brands Grow*") — F70's owner (WORKSPACE) should render or strip inline
  emphasis at the reader boundary. One occurrence in 9.8k chars; low.
- renderAssetBody flattens ALL-CAPS section labels (ABOUT THIS DRAFT / HOW TO
  POST…) into body-size <p> — markers stripped but hierarchy flat. DOCS cluster:
  consider promoting recognized label lines to headings.
- Hard-wrapped source text (~100 cols) keeps mid-sentence line breaks in rendered
  deliverables — cosmetic; consider soft-unwrap in renderAssetBody paragraphs.
- LOCAL ENV: AGENT_SERVICE_URL/TOKEN unset in .env.local → staff agents page shows
  "Agent service not configured", client lens shows empty state; F24/F131 live
  states not constructible locally. F34's misleading empty-state copy confirmed
  live (dashboard says "20 agent runs" while agents page claims none happened) —
  AGENTS cluster has F34; handover env note added.
- customAgents collection contains a "Reddit Agent" record (staff library card)
  even though portal Reddit surfaces don't exist — consistent with lab import;
  no action, context for AGENTS/TOMER.

## Wave A mid-flight coordination (orchestrator rulings)
- **F135 re-pointed AGENTS** (second move): the "estimated weekly cost line" is
  custom-agents.tsx:691, not schedule-run-modal.tsx (phantom citation). AGENTS
  implements pluralisation of runs+outputs; custom-agents.tsx:461 "credits per
  output" belongs to F130 (also AGENTS).
- **F107 (CALENDAR) approved approach**: staff-gated Publish Now added in
  asset-detail-modal.tsx (composed WITH MarkPostedRow — Publish Now = staff push,
  MarkPostedRow = client attestation, must not preempt §A4); connectedPlatforms
  threaded calendar-body → run-calendar staff-only in RSC payload. Verifier
  checklist: requireStaff end-to-end on publishAssetNowAction; no new client
  payload fields. **Still open for WORKSPACE (wave B): F107 part 1** — pass
  connectedPlatforms into AssetCard from assets-view.tsx:113 and
  jobs/[id]/page.tsx:61, else Publish Now never appears on the staff assets list.
- **F110 re-pointed CALENDAR (final)**: fix lives in run-calendar.tsx (+
  calendar-body.tsx:71); custom-agents.tsx togglePause (~:790 post-AGENTS) is the
  reference pattern only. My AGENTS reassignment was wrong — primary-file matrix
  keyed off the reference citation.
- AGENTS F30 introduced a "cancelled" JobStatus; calendar-body.tsx:18
  PAST_JOB_STATUSES gained it (one line, AGENTS-made, CALENDAR rebase-aware).
  All clusters: treat "cancelled" as terminal/past, distinct from "failed" —
  touches job-status.tsx maps (F41 AGENTS / F120 SHELL must include it).

## CALENDAR cluster report highlights (pre-verification)
- F108 TZ contract: schedule intent = wall clock + IANA timeZone; nextRunAt =
  derived epoch millis; run-cadence.ts exports the single Intl zone
  implementation. ALL clusters creating/editing schedules must pass the stored
  zone. AGENTS asked to send viewer timeZone from the client schedule dialog.
- F151: toPlainSummary/stripInlineMarkdown now in doc-render.ts;
  JOB_STATUS_META exported from job-status.tsx — F41 (AGENTS) and F120 (SHELL)
  MUST consume that map, not re-invent (includes "cancelled" as terminal).
- New defect (product decision for Albert): PAUSED schedules vanish from the
  calendar (filtered to status==="active"); resume exists only on AI Agents.
  End-loop triage.
- New defect (pre-existing, handover): publishAssetNowAction releases its claim
  on failure with only publishError recorded — no attempt log/idempotency key.
- F110 deviation pending drift ruling: pause extended to clients
  (canManageRuns), delete stays staff.
- **F38 STRUCK** (orchestrator, on AGENTS evidence): perClientAgentSlug /
  agentKeyMatchesClientSlug never existed here; submit-custom.ts has no
  per-client agent binding, so the "guaranteed refusal pairing" premise is false.
  Sweep-branch phantom.
- **F35 half-N/A**: binding display impossible (see F38); delivered half = staff
  hub badges "Needs X/LinkedIn agent data" before brief-writing.
- **MERGE INSTRUCTION (orchestrator executes)**: planned-run-actions.ts will
  conflict between AGENTS (9-line no-consumer optional timeZone field) and
  CALENDAR (full F108 implementation). CALENDAR wins WHOLESALE (interface+body);
  keep AGENTS' custom-agents.tsx call-site timeZone argument. Post-merge check:
  timeZone must be CONSUMED (recompute path), not accepted-and-ignored.
- **F39/F45 RETIRE signed off** (orchestrator): dead managed-products UI deleted
  (managed-products.tsx, client-managed-agents.tsx, submitManagedJobAction, the
  jobPreviews dead block); submitManagedJob CORE preserved (execution-engine
  task-board path still runs the four catalog products). Restoration = git revert
  of the retirement commit. Phase 3: managed-product run UI returns under the
  unified launch-vs-runs model, never as the old four cards. TOMER-HANDOVER must
  carry this note.

## DOCS cluster report highlights (pre-verification)
- New defect (whoever wires it): applyGlobalDocCorrection repeats F74's
  charge-without-changed-flag shape; currently zero callers. Do not mount
  without an F74-style {changed} + refund.
- client-guidelines is a permanently dead DOC_TABS row (tier internal-only,
  pickDoc never surfaces it) — end-loop cleanup or product call.
- AiProcessingBanner only mounts on dashboard/settings; after F78 the only
  regenerate progress signal on other /clients/[id]/* routes is a greyed button
  — candidate: mount banner in client layout (end-loop or DASHBOARD).
- PRODUCT CALL for Albert: branding writes now deterministically target the
  internal tier; client-tier Branding doc lags until next condensation run.
- F77 corrections enter generation via the internal source only; standalone
  condensation (refreshClientContextDocsAction) would miss them — noted for
  Phase 3 / handover.
- Wave-A base hazard RESOLVED: all four fixers self-reset to integration head;
  fixer-brief now carries Step 0. Future spawns must verify ancestry of 36a5200.

## CALENDAR verification rulings (lens pair complete)
- **F120 (SHELL) MUST consume JOB_STATUS_META** exported by job-status.tsx (F151
  created it) — do not add a second JOB_STATUS_LABEL map. Include "cancelled"
  (F30) as terminal.
- **F107 ledger**: "resolved via calendar surface; assets-list Publish Now still
  unreachable" — WORKSPACE wave B owns part 1 (connectedPlatforms into AssetCard
  from assets-view.tsx:113 / jobs/[id]/page.tsx:61); no other finding owns it.
- **F109 ledger**: partially resolved for client lens — a run in review has zero
  client-visible assets (webhook creates drafts; clients don't get drafts), so
  the client Review affordance only appears post-approval. Dissolves with
  F149/A4.
- **F108 ledger**: legacy zone-less rows keep old behavior until re-saved (by
  design); posts/past-runs/today-highlight still bucket runtime-local (residual
  half, low).
- Merge conflict map (orchestrator executes): job-status.tsx (AGENTS F30
  "cancelled" row + CALENDAR MAP→JOB_STATUS_META rename — keep BOTH);
  calendar-body.tsx (F30 PAST_JOB_STATUSES + CALENDAR imports — keep both);
  planned-run-actions.ts (CALENDAR wholesale, keep AGENTS custom-agents call-site
  arg; verify timeZone consumed); task-ticket-modal.tsx + integrations-tab.tsx
  (different regions, low risk).
- Known cosmetic (accepted): INTERNAL_TOKEN_RE fail-closed can blank legitimate
  8+digit-number lines from run teasers; INTERNAL_KEY_LINE_RE drops legit
  "Source:" caption lines from teasers (modal unaffected). Revisit only if
  clients complain.
- Watch-items logged, not bounced: PublishNowRow status gate broader than map
  filter (unreachable today); dayKey/timeStr lack isValidTimeZone guard
  (unreachable — action boundary validates); past-day prefill forces
  cadence-once discoverable only on submit; ~30 extra tab stops on staff
  calendar empty cells.

## DOCS verification rulings (drift lens complete; risk lens pending)
- Bounced: F86's generateDocSummaryAction tier fallback (client could summarize
  internal text via direct action call, uncharged) + same-shape check on
  generateClientBriefAction.
- **COPILOT cluster notes**: F89's cited client-documents.tsx:341 moved to
  ~:552/:559 (re-locate by symbol); renderSectionBody now has ####, links with
  isSafeHref scheme guard, indented bullets — F89 needs NO third renderer;
  copilot answers will emit real target=_blank anchors (scheme-guarded).
  F95's creditsAppendix shifted ~+6 (re-locate by symbol). F81's copilot half
  (copilot-context.ts prefer-internal + dedupe) is now a NO-OP for CLIENT_USER
  (F76 route filter) — still fix it (don't depend on a filter in another file),
  but client-trust urgency gone.
- **SHELL cluster notes**: F119 must ALSO cover the new DOCS-added instances
  (client-documents.tsx:461-463 date+version subline; Rebuilding row
  ~:1057-1061). F146 data.ts regions disjoint from DOCS edits.
- Ledger notes: F138 — exported PDFs now omit placeholder-only sections (drawer
  parity; unprescribed but consistent; client-visible change). F81 — sibling-tier
  propagation runs in after(): seconds-long stale-copilot window accepted
  (alternative = holding the modal on a second model call). F77 — prompt-injection
  surface accepted by design (client corrections are ABSOLUTE GROUND TRUTH per
  the existing applyDocCorrections framing; tier separation intact).
- End-loop quality nits: DocOverlay unmemoized double render; parseDocSections
  multi-line lead-in duplication (unreachable with shipped templates).

## DOCS risk-lens rulings
- F86 UNSAFE confirmed by both lenses (tier tampering) — bounce in progress;
  bounce addendum: isSafeHref protocol-relative tightening + stale comment.
- **PRODUCT SIGN-OFF NEEDED (Albert)**: (1) F77 gives client corrections
  "ABSOLUTE GROUND TRUTH" authority over generation INCLUDING internal-only docs
  (action-plan, client-guidelines premises steerable by client free text); no
  length cap, no expiry, no supersede logic — corrections accumulate (newest
  100) and inflate every future pipeline run at Karos's cost. Working as the
  existing applyDocCorrections design intended, but deserves a conscious yes/no.
  (2) Branding writes target internal tier deterministically (client-tier lags
  until condensation).
- End-loop hardening candidates: applyTargetedDocCorrectionAction authorizes by
  clientId only, tier-blind (unreachable today, load-bearing gate);
  correction-text length cap; AiProcessingBanner in client layout.
- TOMER-HANDOVER infra: cloudbuild.yaml lacks --no-cpu-throttling / min-instances
  — after() background work ("continues in the background" copy) is best-effort
  on Cloud Run until that's set. Stale-lock self-heal window is 20 min.
- chat/route.ts:237 lets client copilot write free-form guidelines text into the
  INTERNAL branding doc (pre-existing, now deterministic) — COPILOT cluster
  should look at it with F81's copilot half.
- F86 bounce accepted (9af2dd3): tier validated + clamped to "client" for
  CLIENT_USER, tier pushed into the query, no cross-tier fallback.
  generateClientBriefAction clamped for ALL callers (fixer's call, accepted —
  the brief renders to the client whoever triggers it). BEHAVIOR CHANGE to
  watch on mock-client walks: a client without client-tier docs now gets
  "No documents to summarize yet." instead of an internal-derived brief.

## SEO cluster report highlights (pre-verification)
- PRODUCT NOTE for Albert: SEO_GEO_PIPELINE_VERSION stamp means EVERY existing
  snapshot is unstamped → shows the legacy/stale banner until regenerated
  (surfaces the C2 credit-reload + regenerate ops step in-product). Honest —
  this wave changed how scores are computed (category-only denominator) — but a
  visible cluster-wide UI change. Pairs with CD-B3.
- **F5 (WORKSPACE wave B) MUST re-locate by symbol**: seo-geo-panel.tsx grew
  ~400 lines; cited :381 grid is now ~:583, FOUR grid sites (:460, :518, :583,
  :590). Do not trust the PDF line number.
- New defect (log): discoverAnswerBrands reads full answer corpus incl.
  branded-question answers into a model prompt — counting was scoped (CD-B3),
  extraction was not. Future prompt-scoping work: keep counting and extraction
  separate. Not client-visible today.
- CD-B2: fixer also removed now-dead not-wired tier / engineFlagPrefill /
  unwiredRequestPrefill / unwired banner (shipping dead client copy = F7/F152
  defect class) — pending drift ruling on the scope.

## AGENTS cluster drift rulings (26/26 ALIGNED)
- **F120 (SHELL) → NO-OP**: F41 renders JobStatusBadge + re-typed row status to
  JobStatus, covering every surface F120 cites (x-agent-intake:686,
  linkedin-agent-intake:638; Reddit N/A; agent-intake-views.ts is a phantom).
  F120 fixer must add NOTHING and must NOT mint JOB_STATUS_LABEL. Ledger F120 as
  resolved-by-F41.
- **F104 (CREDITS) MUST consume CREDIT_BLOCK_REASON + bindingCreditLimit()** (F25
  added them to credits.ts with the exact "resets Monday"/"resets on the 1st"
  strings and a signature mirroring availableCredits so badge/reason can't
  disagree). Do NOT mint a third phrasing.
- Ledger statuses: F130 → OPS-PENDING (per-agent prices set by admin; card shows
  25 until then). F33 → OPS-PENDING (backfill-asset-titles.ts written, dry-run,
  NOT run). F37 → RESOLVED-except /clients server-side scan (needs count()
  helpers — end-loop or handover). F29 → RESOLVED (partial-approval count
  precision dissolves under F149/A4). CD-D2 → connector half RESOLVED, agent
  representation → Phase 3.
- F130 dual-meaning flag for CD-A5/Phase 3: creditCost means per-RUN on the card
  and per-OUTPUT in the schedule dialog (chargeMultiplier=outputsPerRun) —
  accurate per surface, inconsistent across them; Phase 3 analytics/credit split
  should resolve.
- End-loop nits: submit-managed.ts:17 stale docstring (mentions retired
  submitManagedJobAction); CancelRunControl "Credits returned" copy odd for
  staff-fired uncharged runs; F128 Disclosure-deviation + F25 CD-B2 deferral
  absent from commit bodies (reporting lapse, code correct).

## AGENTS risk-lens bounces (2 UNSAFE + 1 regression)
- F25 argmin/ladder mismatch → bindingCreditLimit must take cost + match
  assessCharge order; pass now to creditBlockReason + availableCredits.
- F34 raw AGENT_SERVICE_* env strings reach clients on outage → client-safe map
  at action boundary.
- F32 removed modal height cap entirely → restore bounded min(…,1100px).
- Logged non-blocking (end-loop / handover): F37 clients/page.tsx:14-20 ships
  unfenced count map to employees (guard-zone "fence cross-client views" — one
  line: skip !nameById.has(clientId)); F31 4s poll runs full run duration
  (10-20min) doing listJobs+buildAgentSetup; F36 all-optional brief silently
  substitutes quickStarts[0] into the CHARGED prompt; F27 stored schedules
  above 5 replies not retro-clamped; submit-custom.ts:178 independent cap of 10;
  several job writes omit updatedAt; F134 regex misses [Person]/[person's]
  capitalized/possessive; CheckCircle2 (custom-agents.tsx:1042) not in lucide
  1.21 → silent Sparkles fallback (pre-existing).

## Albert directives 2026-07-28 (sidebar review on localhost)
- CD-E1: "Agent-specific documents" (client-documents.tsx ~:1068-1100, renders
  when clientId set — SAME on main; conditional mount explains the
  appears/disappears confusion) → REMOVE the section. Agent data intake stays
  reachable via AI Agents cards (F131 chip / F35 hub badges). SHELL wave C.
- CD-E2: brand colors → up to 3-4 colors, each with an INTERNAL usage-percentage
  (staff catalog; clients see swatches only). Data model: extend client
  brandColors; keep pencil editor; percentages staff-only in payload (boundary
  rule). SHELL wave C.
- CD-E3: sidebar NO-SCROLL contract — nav (Dashboard/AI Agents/Calendar/
  Workspace), client chip, DOCUMENTS (compact rows, simpler icons ok),
  COMPETITOR TRACK, BRAND COLORS, footer must fit the viewport with no
  scrollbar at common laptop heights; fixed layout, no overflow scroll. CD-E1's
  removal buys room. SHELL wave C (client-rail.tsx free after CREDITS merges).
- Phase-3 design v2 committed: launch client+staff triggered, client-billed
  gated-until-priced (Q10 pending Albert veto), per-agent pricing, X daily
  3-option slots with pick/edit/post telemetry (WP-9, seam T7).
- F53 split executed: WORKSPACE did linkedin-seats-workspace.tsx:126; credits.ts
  half (reason template :122 + stale comment :58-62 + F71 hyphen) handed to
  CREDITS with test note (seat-architecture.test.ts). Ledger F53 flips only when
  BOTH halves merge.

## Albert directives 2026-07-28 (second batch)
- CD-F1 fleet regenerate (Albert-authorized, execute at end-loop): build
  scripts/regenerate-all-clients.ts — enumerate clients, per-client
  runOnboardPipeline-equivalent honoring the per-client AI-processing lock,
  concurrency-limited (2-3), dry-run default + --apply, per-client
  success/failure + USD report. Execution order: after Wave C + end-loop pass 1,
  AFTER Albert tops up the Anthropic API key (C2). Est. ~$8-9/client. On credit
  errors: stop and surface, don't retry-storm.
- CD-F2 favicons: sidebar Competitor Track rows Okara.ai + ploy.ai render the
  generic building icon while others show real favicons — fix favicon
  resolution (likely missing domain/favicon field or failed fetch; add
  domain-based fallback e.g. google s2 service, cache result). SHELL wave C
  (sidebar files). Also part of end-loop visual pass: "everything looks good".

## DASHBOARD cluster report highlights (pre-verification)
- F123 (SHELL) resolved-by-F99 (the raw-count card deleted; hint now "Last run
  9h ago") — SHELL adds nothing, pending drift confirmation.
- Real bug found+fixed: failed insight streams returned 200-empty and POISONED
  the digest cache (empty text stored, replayed forever). isCacheable guard +
  poisoned-entry-as-miss self-heal + onError logging.
- Client dashboard is now TABBED (Overview → Performance / Search & AI
  visibility segmented control) — Albert will see a layout change on localhost
  at merge.
- SHELL notes: F122 capitalize("linkedin")→"Linkedin" confirmed live on
  channels card; icon-name misses (CheckCircle2/CheckCircle absent in lucide
  1.21) in integrations-tab:274/594, client-home-overview:69, tasks-board →
  fold into F63 (WORKSPACE owns F63; send if still open).
- Walk observation (b) diagnosis: pending-count mismatch is BOARD-side
  (owner-tab chips count completed tasks; Done column) — tasks-board =
  WORKSPACE F136/F72 territory; client-home-overview karos_managed
  overstatement folds into F149/A4 notes.
- F63 completeness ledger: WORKSPACE sweep (36 sites, 4947e51) + DASHBOARD already-done (client-analytics via F145/4d88b0a, verified) + AGENTS 3-site micro-commit (in flight). Flip F63 only when the AGENTS micro-commit merges.

## DASHBOARD lens results + bounce
- F145 route half UNSAFE (bounced): my needsReconnect-into-connectedPlatforms
  ruling had an unexamined side effect — stale-platform live rows could unbadge
  a mock briefing. Remedy: staleSet folded into engagementIsMock predicate.
  RULING AMENDED: stale channels ride the digest for staleness REPORTING but
  never vouch for freshness.
- F126 residuals bounced as follow-up (nested/triple/__ emphasis + underscore
  token-eating via assetLabel).
- Logged conscious trades: CD-B4 banner covers scores above the fold; tabbed
  panel content relies on the capture strip for dating. Dashboard lost its only
  /clients/[id]/agents link (Agent activity card deleted per F99) — SHELL nav
  review should restore an agents affordance somewhere sensible (fits CD-E3
  sidebar work: AI Agents nav item already exists — verify sufficiency, else
  add link in summary row hint).
- F97-class soft-nav desync applies to the new /clients/[id] ?tab= — fold into
  the same one-useEffect fix class (SHELL or end-loop).

## CREDITS lens results + bounces
- F103 bounced: three-bucket ruling (healthy cards + needs-reconnect cards +
  no-doc-at-all collapsed; connectedCount = usable only).
- F105 bounced: thrown server-action errors are MASKED in prod (repo-documented)
  → convert integration actions to return-as-data or always-fallback.
- COPILOT queue addition: chat/route.ts:164 injects raw credits.balance into the
  system prompt ("Current balance: N") — fourth surface undoing F102 in
  conversation; fold into F95 credits-appendix work.
- F53 merge check: verify BOTH linkedin-seats-workspace instances (:126 and
  :155) drop $29/mo when WORKSPACE merges.
- Accepted: F104 static reset clause (no computed dates — single-phrasing rule);
  admin sees client blocked strip + support button (nit, end-loop).
- Browser-floor note (handover): F126 fix uses regex lookbehind in a module-scope literal — parse-throws (blank page) below Safari 16.4 (Mar 2023). Acceptable for this portal; document as the explicit browser floor.

## WORKSPACE lens results — 4 bounces (2 serious)
- **F55 PROVEN UNAUTHENTICATED XSS** in oauth-popup.ts: JSON.stringify does not
  escape < or /, so </script> in error_description executes; reachable pre-CSRF
  at callback/route.ts:289-291. Fix = \u003c escaping in both script builders.
  PRE-EXISTING sink (lifted from the callback), centralized+multiplied by F55 —
  means the DEPLOYED app has this today. TOMER-HANDOVER must flag it as a
  ship-blocker for the current production build, not just this branch.
- **F149 churn-guard violation**: locked future assets could be marked posted
  (redaction preserves status, drops publishMode; no server future-date guard)
  → client could unlock the whole pre-generated batch. Fix at BOTH layers.
- F56: card gate is render-only; clientKeyId ships in every client RSC payload
  via the whole-Client prop → client-safe projection required. (Rotate path and
  group-admin widening refuted clean and scoped correctly.)
- F53: second instance at linkedin-seats-workspace.tsx:155 still live.
- Flags bounced too: F69 raw error text into client Activity tab; F62 competitor
  rows bleed across clients (no key={clientId}).
- Refuted clean: F61 refunds, F48/F58 batch (transaction-gated, no double
  charge), F64/F66 param keys, F63 completeness, F5 container queries, F68
  fencing.
- Logged for end-loop/handover: listReviewJobsForClients unbounded scan; staff
  task feed limit-200 fetch-then-filter (employee under-report); F66 impossible
  status options; F51 notification vs F149 archive (Phase 3).

## WORKSPACE merge (567305a) — 7-file conflict resolution, hand-verified
Both sides preserved in every case:
- credits.ts / x-agent-intake / linkedin-agent-intake: HEAD copy (newer,
  approval-gated) + F71 em dashes re-applied on top.
- seo-geo-panel: DASHBOARD SeoGeoScores extraction KEPT + F5 container queries
  re-applied (4 sites) — both fixes live.
- settings/page: CREDITS F103 tabs KEPT + F56 gate (isStaff||isGroupAdmin) and
  canRotate re-applied to teamSection.
- layout: UNION — CREDITS spendable/correctionPricing AND WORKSPACE
  toClientPortalView; projection verified reaching BOTH ClientRail and
  AiProcessingBanner.
- integrations-tab: CD-D2 pending-verification KEPT + F55 ungated hint applied +
  CREDITS three-bucket ChannelSection KEPT + F5 grid restored.
Gates after: tsc clean, build clean, 634 tests / 53 files.
PHASE 2 FIXING COMPLETE — 9/9 clusters merged.

## Second independent WORKSPACE lens (PASS, no bounces)
Cross-validated the first lens: independently re-derived the F55 XSS and F149
churn hole before finding them already fixed. Two gaps raised:
- F100: verified COMPLETE on the integration branch (lens read its pre-merge
  worktree; only a code comment in fireflies/route.ts remains, which F100
  excludes by rule).
- F107 part 1: genuinely open - CLOSED by orchestrator directly (assets-view +
  assets/page thread connectedPlatformsByClient; calendar builder shape reused).
  jobs/[id] detail page not threaded: single-job staff view, left for end-loop.
Non-blocking noted: F68 employee task feed fetch-200-then-filter; F136 tabCounts
excludes completed (benign).

## COPILOT cluster report (pre-verification)
- F87 deviation: took the stop-asking-for-a-URL branch, NOT wiring Anthropic
  server-side web_search/web_fetch — those bill per search OUTSIDE the 1-credit
  copilot message price. PRODUCT DECISION for Albert if he wants real competitor
  web research in the copilot: it needs a pricing model first.
- F95: appendix says PER RUN (post-F40 reality), not the spec's per output.
- Folded fix: mock analytics rows no longer feed the credit-charged client
  prompt (F125 risk watch-item (a) closed).
- Reported, not fixed (end-loop candidates): copilot branding tool lacks
  logActivity + has no length cap on guidelines (same bloat/injection shape as
  F77 corrections; NOT privilege escalation — the settings action already allows
  the same write); proactive-assistant Scenario B still claims an external
  footprint scan from world knowledge (F87 pathology on the task-map path);
  copilot-context TOOLS block says two tools, route registers four (understates,
  harmless); streaming markdown flicker on unclosed ** (resolves on completion);
  sheetOpen persists across reload on mobile.
- campaign-engine.ts is owned by no cluster; F92 edits landed there by necessity.

## Phase 3 WP-0/WP-1 landed (pre-verification)
- New pure modules: client-agents.ts (gate ladder evaluateLaunchGate shared by
  action+card), slot-plan.ts, agent-identity-map.ts (F147 resolver);
  data-client-agents.ts sibling (data.ts was hands-off; data-analytics.ts
  precedent). 69 new tests, 703 total.
- Refund coverage verified by builder: newestUnrefundedCharge filters
  kind===charge, so agent_launch is refunded by the EXISTING webhook path.
- Deferred deliberately: the §2 server guard refusing client runs while an
  umbrella is not live — would create an F131-class enabled-button/server-refuses
  state before WP-2 renders the paired disabled control. Interim: not-yet-live
  umbrellas drop their run cards entirely. WP-2 must land the guard WITH the card.
- Seam constraint added: T1 templates.json must be a CLIENT-FACING artifact
  (webhook only fetches those); launch brief states the contract in-band so the
  lab skill carries it. T2 (progress events) → strip is time-split until wired.
- chainFamilyForAgent is module-local; WP-8 backfill will need it exported.
- WP-4 must read slots directly (slot instants use zonedWallToUtc per F108),
  not re-derive days from scheduledAt.

## SHELL cluster complete + Albert directives verified live
- CD-E3 MEASURED: before 892px content / 621px body (271px overflow). After:
  staff 583/645 (+62 headroom) at 1280x800, 583/745 at 1440x900; client rail
  599/651 and 599/751. No scrollbar either lens. overflow-y-auto kept as an
  unreachable safety net.
- CD-F2 root cause: ClientCompetitor.url is optional and routinely absent on
  report-sourced rows; domainFromName/brandFaviconUrl added (strict
  single-dotted-token regex so "Acme Inc." cannot fetch a stranger icon).
  Okara.ai + ploy.ai confirmed live. Orchestrator applied the same name= prop to
  the 4 seo-geo-panel BrandFavicon sites.
- CD-E2: usagePct stripped at the boundary (toClientBrandingView), staff-only
  editor with a usage-total check, server-side merge so a client edit cannot
  blank the mix. NOT written into context docs. NOTE: mcp/tools.ts:129 returns
  full brandingGuidelines to PAT callers so usagePct rides along (staff-only
  surface) — end-loop consideration.
- F113 ruled resolved-by-F60 (ClientContextBar already gives every staff member
  a labelled exit); what was KEPT is picker parity for employees. Albert
  independently rejected the duplicate nav button; both removals converged.
- F119 blocked clause + CD-F2 panel props closed by orchestrator (0a518dd).
- Dead but harmless: NotificationBell variant="row" branch now has no call site.

## Phase 3 WP-0/WP-1 MERGED (717 tests)
All 5 lens defects + W2/W5 fixed. D1 regression test verified by temporarily
restoring the old predicate (it failed, as required) — the bug window was wider
than the lens described: ANY draft dated later than 11:00 local today stayed a
candidate while already unlocked for the client since local midnight.
Remaining WP-2..WP-9 obligations carried forward:
- WP-2 must land the §2 guard rail (refuse client runs while not live) WITH
  the paired disabled control.
- W1 batch.create for slots; W3 isOptionsMode conflation; W4 agentKeySlug lossy;
  W6 bind-time warning for already-producing agents; W7 reset for stuck
  launching; W8 option label from optionRefs.length.
- D3 note: error redaction is broader than launch-only (all client-visible job
  errors now go through clientSafeRefusal) — accepted, same leak same door.

## Albert directives 2026-07-28 (third batch — AI Agents surface rework + sidebar + dashboard revert)

Source: two localhost review messages (screenshots: staff sidebar side-by-side,
chip ↗ zoom, client dashboard stat row, AI Agents header, Client agents bind UI).
These OVERRIDE the PDF and phase3-design §7.1 where they conflict.

### CD-G1 — Agents roster → full-page detail (rescopes WP-2's client surface)
- The roster card carries NO "Run Now" button. A card is: agent name/mark,
  short blurb, live/not-live status. Hover = clear click affordance; click
  opens a FULL PAGE (`/clients/[id]/agents/[agentId]` route), never a popup.
- The detail page is the agent's home: overview + what it produces, live
  status, its template set, "Create new post" (the run gesture, with cost,
  where context explains what it does), two-level feedback (agent + template),
  documents this agent produced, the data/context the client gave it,
  connectors helping it, and the schedule/pace controls (Adjust pace moves
  here). Phase3 §7.1 card states 1-5 map onto this page, not onto roster cards.
- Verbatim: "they can just click on it, and then it opens… over the whole
  page. That whole page should be like the Instagram Agent."

### CD-G2 — Blurbs: concrete, salesy-short, no buzzwords
- Pattern: "Improve your Instagram reach with a daily post, different
  templates, and an agent that scans." Kill "Master Content Social Skill"-style
  naming in client copy. Draft all 7 in scripts/backfill-agent-blurbs.ts
  (--apply stays Albert-gated; roster falls back to these in code until run).

### CD-G3 — "One agent per platform this client buys" copy DIES
- All current agents are granted to all clients (27e89e6 applied). The bind
  dropdown + that section header confused Albert on sight. Bind stays as staff
  plumbing but demoted (small control, honest label like "Bind a lab agent for
  setup"); the client-visible framing is simply the roster of their agents.
- Verbatim: "They should be able to run every single agent if they want to."

### CD-G4 — Staff sidebar (sidebar.tsx, NOT client-rail): top block = baseline
- All prior CD-E3 top-block restoration landed in client-rail.tsx; Albert's
  screenshots are the STAFF shell's client-context rail. In sidebar.tsx:
  logo block, nav spacing, and the client chip row must match the baseline
  (36a5200) measurement-for-measurement down to the DOCUMENTS header;
  DOCUMENTS and below keep the approved compaction.
- Chip ↗ opens the client's actual WEBSITE (external, new tab) — not
  /clients/[id] (nav's Dashboard already goes there in client view).
- Every Competitor Track row gets the same ↗ to the competitor's site;
  hover trash is preserved exactly as before.

### CD-G5 — Regenerate is admin-only + gets a dashboard-view button
- Schedule/Regenerate in the docs header: confirmed admin-only (already
  gated by isAdmin) — real clients must never see them; verify impersonation.
- ADD a Regenerate entry point on the staff client dashboard view: it
  regenerates docs + SEO/geo intel, so it belongs at client level, not
  buried in the docs header only. Same modal/action, admin-gated.

### CD-G6 — F124 REVERTED by Albert (dashboard first view)
- "Why did you change the first view? … Now it looks super messy." The
  SummaryStat collapse is struck; restore the baseline (36a5200) counter
  tiles on the client dashboard. F99's tab-position fix STAYS. F124 →
  STRUCK-BY-ALBERT in the ledger.

### CD-G7 — Fleet refresh is a COMPLETION pass, run internally (reshapes CD-F1)
- One parallel team per client. NOT from scratch: keep existing data,
  complete + update it (new doc structures, SEO/geo, competitors, brand
  colors w/ percentages). Done by local Claude agents using the same
  processes/prompts as the pipeline — NOT via the external Anthropic-API
  regenerate path (no key top-up needed). Writes land in Firestore via a
  dry-run-default --apply script so localhost shows the result. Runs LAST,
  after CD-G1..G6 merge. Albert authorized the writes explicitly.

### Phase 3 WP-2/WP-3 lens bounces (D1-D7) — dispatched with CD-G1 to the same builder
- D1 HIGH: task-board/copilot dispatch path bypasses the §2 guard rail —
  TASK_ENGINE_ACTOR is a synthetic KAROS_ADMIN, so a client-charged run of a
  non-live umbrella proceeds unguarded (execution-actions.ts →
  execution-engine.ts). The guard must key on the BILLED actor, not the
  dispatching actor.
- D2: setPlannedRunStatusAction lets a client re-arm the schedule on a
  non-live umbrella.
- D3: Adjust-pace modal copy states the batch shape = churn tell → rewrite
  within A3/A4 (orchestrator ruling: the modal may name pace, never
  generation batching).
- D4: 200-row feedback cap counts resolved rows; no delete exists; copy
  advises an impossible action.
- D5: 500-char feedback cap not re-applied at context_files injection.
- D6: options card promises the WP-9 picker before it exists.
- D7: Withdraw renders as "Resolved" in the feedback list.

## Final alignment audit — Albert mandate 2026-07-28 ("did we complete everything, are we good")
Runs AFTER the CD-G fixers merge, their lenses pass, and the CD-G7 fleet
completion refresh lands. Scope (two consecutive clean passes required):
1. Every LEDGER row — all 137 findings + every CD item — re-verified against
   the branch: RESOLVED means the fix is demonstrably on HEAD (file:line
   evidence), STRUCK means Albert's overrule is documented in rescopes,
   OPS-PENDING items are enumerated in the final report with exactly what
   Albert must run/decide.
2. Guard zones re-walked: no AI Insights rework beyond listed defects, no
   pre-generation exposure to clients (A3/A4), CLAUDE.md conventions held.
3. Rescopes supremacy: where rescopes.md overrode the PDF, the audit checks
   the RULING, not the original spec (F124 is the canonical example).
4. Screenshot cross-check: inventory before-images spot-checked against the
   live localhost surfaces for the highest-traffic pages.
5. TOMER-HANDOVER.md reconciled against final HEAD — every deferred seam
   named there must still be real, every new seam (Phase 3 detail routes,
   CD-G7 data shapes) added.

### CD-G8 — Copilot dock: fixed to the bottom, full width to the right, no gaps (Albert, third batch addendum)
- Screenshots (staff shell, narrow viewport): the AI COPILOT strip floats
  mid-page with content visible BELOW it, and neither the strip nor the
  expanded panel reaches the right edge. Ruling: the collapsed strip is
  FIXED to the viewport bottom and spans the full content column to the
  right edge (desktop: from the rail's right edge to the viewport edge;
  phone: full width, sitting above the mobile tab bar). The expanded panel
  anchors to the same bottom edge — never floating mid-flow.
- The expanded panel shows a large dead region between its content and the
  input row (h-[70dvh] with sparse content) — size to content or fill
  deliberately; no dead air.
- Applies to BOTH shells (client CopilotDock + StaffCopilotDock) and must
  be verified at phone width, md, and lg+.
- The agents page's own vertical gap (empty Client agents section + mt-10
  stacking) belongs to the CD-G1 rework, not the dock fixer.
- Albert: "implement with an agent that reviews at the end if it matches
  what I asked" — a dedicated Albert-match review lens runs over the whole
  CD-G wave after merge, checking his verbatim feedback against localhost.

### CD-G9 — Narrow-viewport shell contract + copilot dismissal + chrome relocation (Albert, fourth batch)
- **CD-G9a — bottom bar everywhere below md.** Any view showing the client
  4-tab nav (the client shell AND the staff shell in client context) renders
  the SAME bottom tab bar at narrow width: Dashboard · AI Agents · Calendar ·
  Workspace · Company (Company LAST; it opens the sheet with profile,
  documents, competitor track, brand colors, settings). NO top menu/hamburger
  pattern at narrow width — "We don't want a top menu-like thing." The client
  shell already has this (client-rail.tsx mobile bar + Company sheet); the
  staff shell must adopt it in client context. Staff full-admin nav at narrow
  width is out of scope for now (more tabs than fit a bar) — flagged, not ruled.
- **CD-G9b — copilot dismissal.** The expanded copilot closes on ANY click
  outside it; it stays open only while the user is clicking/typing within it.
  The explicit close control also remains. The collapsed strip sits directly
  ABOVE the bottom tab bar at narrow width (54px offset contract), and pops
  up from there.
- **CD-G9c — chrome relocation in full view.** The top-right icon cluster
  (support/contact, light-dark theme switch, notifications) moves into the
  Company/settings area (account-menu zone) instead of a floating top bar.
  NOTE: this consciously overrules F116's "badge visible without opening a
  menu" rationale for the bell — Albert's ruling wins; record in ledger. An
  unread-count dot may surface on the Company/account trigger so the signal
  survives without the floating bar.

### CD-G8/G9b orchestrator rulings after the dock-fixer report (2026-07-28)
- **Outside-click dismissal is scoped to the OVERLAY presentation (<lg).**
  Albert's words described the pop-up ("it should pop up… click out, it
  should hide"). At lg+ the copilot is a persistent side rail whose collapse
  reflows the content column — auto-collapsing it on any page click is not
  what he asked for. The rail keeps its explicit toggle only. (Flagged for
  the Albert-match lens to confirm against his eye.)
- **Right-edge gap ruling: the forced classic scrollbar goes.** globals.css
  forces `html { overflow-y: scroll }` + root-level `::-webkit-scrollbar`
  styling, which opts Chrome/macOS out of overlay scrollbars — every
  `fixed right-0` element stops 10px short. Fix globally: drop the forced
  root scrollbar, scope the custom scrollbar skin to inner scroll containers
  only. macOS gets overlay (true edge-to-edge); other platforms unchanged in
  substance.
- **Merge order:** the dock branch depends on CD-G9a's staff bottom bar at
  phone width (strip sits on the 54px bar). Shell3 merges FIRST, dock second.
  Both read MOBILE_TAB_BAR_H / MOBILE_TAB_BAR_OFFSET_CLASS (src/lib/constants.ts).
- **Staff `main` needs a bottom scroll reserve** (client has pb-28/md:pb-16;
  staff has none, so last rows sit behind the strip) — assigned to shell3,
  which owns staff chrome.
- **Dead code found:** the non-docked floating ChatbotWidget branch
  (floatingPosition, fixed 380px panel) is unreachable — end-loop sweep item,
  not fixed mid-wave.

### End-loop sweep additions (post-CD-G9 build)
- `src/components/theme-toggle.tsx` becomes unreferenced once shell3 merges
  (relocations use the labeled ThemeSwitch rows) — delete in the end loop.
- shell3 applied CD-G9c staff-wide (AppHeader was one mount serving both
  context modes) — accepted; staff no-context narrow keeps hamburger but
  gains the unread dot + drawer rows so nothing went 3 taps deep.

### P3 builder deferrals (carry into WP-4+ / end loop)
- WP-9 options picker still to build (D6 removed only the premature promise).
- Clients lost the cross-agent "recent runs" list (runs now live per-agent on
  detail pages). Acceptable under CD-G1; surface to Albert in the wave report.
- Client run gesture takes no attachments — generic dialog's picker now
  unreachable for clients. Needs a design call if client attachments matter.
- Staff keep the all-in-one cards + curation pane (intentional); staff
  roster/detail unification is future work.
- calendar-body.tsx ~178 falls back to agent.description for a blurb — same
  CD-G2 defect class on the calendar surface. End-loop fix via clientAgentBlurb.
- Pre-existing react-hooks/purity lint errors (Date.now()) in agents page +
  launch-card.tsx — pre-date this wave; end-loop sweep.

### CD-G10 — Workspace board toolbar must be one straight row (Albert, fifth batch)
Screenshots: with the "Run up to N pending tasks now" CTA present, the board
toolbar breaks into a crooked two-row layout (tabs bottom-left, search/status
top-right, CTA floating). Without the CTA it renders as the correct single
straight row (tabs · search · status aligned). Ruling: the toolbar is ALWAYS
one aligned row — tabs, search, status filter on a shared baseline exactly as
the correct screenshot; the run-pending CTA gets a clean, non-distorting
placement (right-aligned in the row if it fits, else its own full-width row
below the toolbar), verified at common widths. Owner: p3-builder (same surface
family as its settings-actions batch-runner work).

### CD-G11 — Brand color swatches copy their hex on click (Albert, fifth batch)
Clicking a swatch copies its color tag ("#E8703A"-style) to the clipboard,
with a brief visual confirmation ("Copied" flash / check) so the click reads
as successful. Coexists with the existing hover tooltip and CD-E2 rules
(clients see swatches + hex only; internal usage percentages stay staff-only).
Both mounts (staff sidebar + client rail) get it. Owner: shell3-fixer.

### P3 WP-4+ round deferrals (structural — carry to Tomer handover + future work)
- `matchAssetsToSlots` exists+tested but unwired: wiring it re-dates existing
  client assets and `reflowClientChain` has zero slot awareness — the two
  planners would fight. Must land TOGETHER, exercised against real data.
- Calendar slot rendering: no component renders AgentSlot outside the agents
  week strip; client calendar has no slot concept. Depends on the above.
- §4.4 grey-paused-slots: blocked on calendar slot rendering (paused schedules
  are filtered out entirely at calendar-body today).
- `assignOptionRefs` unwired: WP-9 picker reads slot.optionRefs which nothing
  populates yet; natural home ensureSlotHorizon + X batch parse.
- Slot-note consumption paths 1/2 (day-of context file, revision pass): need
  per-slot cron firing with karos_slot_id + webhook slot branch (Tomer seam).
- RULING NEEDED (Albert or orchestrator): WP-9 learning-log volume — 2 negative
  rows/day/slot burns the 30-row x-agent-context window in ~2 weeks and can
  evict genuine client feedback. Options: raise cap, separate auto-log stream,
  or decay. Blocked before WP-9 runs at volume.
- Blockers FIXED this round worth Tomer's attention: launchCreditCost now has
  its (staff) write path; scheduled fires stamp runType; ledger operation
  vocabulary introduced.

## Albert-match review results (CD-G wave, 2026-07-28)
MATCH: CD-G1/G2/G3 roster+detail (zero Run buttons, copy clean), CD-G8/G9b
dock (pinned, content-sized, overlay dismissal, lg+ rail stable), CD-G10
toolbar, CD-G11 swatch copy (all three mounts), churn spot-checks (no
Upcoming rows, no staff prompt on calendar, no batch language anywhere).
MISMATCH shortlist → mop-up round (CD-H series):
- CD-H1: counter tiles must be the FIRST section under Overview (currently
  y≈1062 behind AI Insights + Performance tab) — the exact CD-G6 complaint.
- CD-H2: sidebars scroll again (staff 701/635 @1280×800; client 759/733 even
  @1440×900) — CD-E3 breach. Lever: Brand Colors collapses to header-inline
  swatches (keeps everything visible; approved spacing untouched).
- CD-H3: competitor ↗ missing on rows with no stored url (Okara.ai, ploy.ai)
  — derive the same way the favicon fallback does; refresh teams also fill
  real urls data-side.
- CD-H4: client dashboard Overview cards clip at 375 (missing min-w-0 in the
  grid; badges + "Open archive" cut off).
- CD-H5: client shell narrow-width parity with CD-G9c — bell moves into the
  client Company sheet (+dot on Company tab); slim logo+credits strip stays
  (branding, not a menu — flagged for Albert).
- CD-H6: Company sheet left "open" across a md-resize parks invisible
  fixed-inset click catchers over desktop — close/gate on breakpoint.
- CD-H7 (cosmetic set): 66px search stub at 1280 w/ rail open; badge "9+" vs
  panel "32 active" count copy; "Mon–Fri 09:00 · next 11:00 AM" zone mismatch
  on the calendar run card; Landing Builder generic fallback blurb.
- CD-H8 (to p3-builder after its merge): live-schedule-no-umbrella detail page
  is a stub for the flagship Instagram case — enrich the legacy branch with
  Create-new-post, pace controls and deliverables (templates stay
  umbrella-gated); §9 backfill script remains the data-side fix.
- Environmental, report-only: 10px right gutter persists wherever classic
  scrollbars are on (scrollbar-gutter: stable) — needs Albert's eye on his
  machine.

### SYSTEMIC pipeline bug found by refresh teams (2 of 2 clients so far)
Every client-tier doc twin is missing its FIRST `##` section (target-audience@client
opens mid-doc on "### Secondary ICP" in both Hanky Panky and Pitch by Deel) —
an off-by-one truncation in the condensation pass, plus leaked template
instructions / LLM meta-commentary in stored docs. The refresh fixes the DATA;
the condensation code bug will re-corrupt on the next Regenerate. End-loop item:
find + fix the off-by-one in the pipeline's condense step (src/lib/intel) and
add a meta-commentary scrubber. Also: stored palettes matched no live-site hex
for 2/2 clients — the palette extractor is unreliable.

## CD-G7 refresh — state of record (orchestrator, 2026-07-28)
- Export: 7/7 clients dumped read-only (scratchpad refresh-export/, index.json
  2026-07-28T16:15Z). This export is the rollback backup per PLAN §5.
- Proposals: 7/7 written + validated through refresh-apply's dry-run gate.
- APPLIED: Karos Labs (iZLc0mtwSFXNKE2KkC2d) — 14 docs, 16 competitor rows,
  1 client doc, committed atomically 2026-07-28T16:50:35Z. Albert-authorized
  pilot; portal reads it live.
- QUEUED behind Albert: Hanky Panky, Pitch by Deel, XO Digital, Geektime,
  Sitti ("apply the rest"); Kindly Yours additionally gated on Albert
  confirming the client is kindlyyours.co (gifting) not the Walmart intimates
  brand the stored data described.
- Fill-only manual edits the applies will skip-and-report: font fields for
  Karos Labs (Spectral/Hanken Grotesk), Geektime (Open Sans — Inter has no
  Hebrew glyphs), Pitch (Bagoss), Sitti (Gaegu), Kindly Yours (Playfair/
  Poppins), XO (Plus Jakarta Sans); plus Karos "no bright accents" guideline.
- Pass-1 audit no-home items now homed: CD-H rows added to LEDGER; CD-D2's
  promised Phase-3 agent representation logged as an OPEN Tomer-adjacent item
  in the handover's residuals (not built, no row claimed it built).
