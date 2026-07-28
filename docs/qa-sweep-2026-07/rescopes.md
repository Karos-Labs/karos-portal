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
