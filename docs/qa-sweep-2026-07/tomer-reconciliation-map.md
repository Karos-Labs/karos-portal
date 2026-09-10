# Tomer reconciliation map — bdb5f23..origin/main vs claude/karos-portal-qa-feedback-7efbdf
(Produced by the read-only analyst 2026-07-28; committed verbatim by the orchestrator.
Execution rulings appended at bottom.)

Probe: 12/29 overlapping files merge clean, 16 conflict (44 hunks), 1 modify/delete.
Two "clean" files are semantically broken if taken as-is (scheduled-runs zone bypass,
calendar-body identity revert).

## Headline collisions
- SEMANTIC-CONFLICT (5): custom-agents.tsx (AgentSetupState unification — keep our
  keyed map, widen to {ready, href, label, kind, data}, add "reddit" kind, keep his
  setupNeeded schedule gate alongside our paceOnly; NEVER reintroduce description),
  agents/page.tsx (his agentKeyMatchesClientSlug conjunct unions into both branch
  filters; our roster shape wins), client-home.tsx (take his delete), submit-custom.ts
  (one refusal copy for both cores + his tests updated), modal.tsx (all four features
  survive: his scrollRef+focus outline on OUR split body; our 1100px cap +
  data-overlay-root).
- MERGE-WITH-CARE (11) incl.: scheduled-runs.ts — his projectRunOccurrences MUST
  thread timeZone or every occurrence after the first falls to runtime-local (repro:
  Sao Paulo 09:00 → 06:00; Tokyo 22:00 → weekend chip); calendar-body.tsx — his
  flatMap projection with OUR productName (F147), cadence, gated prompt, F30
  "cancelled"; take his clientOptions branch fix verbatim; planned-run-actions —
  BOTH gates (his unfireableScheduleReason + our clientAgentRunRefusal) in all six
  writers; custom-agent-launch — union predicates + add REDDIT_SETUP_REQUIRED_PREFIX
  to isClientReadableRefusal + keep our six placeholder removals.

## Policy rulings (orchestrator, binding for the merge)
1. Binding vs umbrella: COMPLEMENTARY layers. REQUIRED: binding rung in
   evaluateLaunchGate (before intake_required) + agentKeyMatchesClientSlug check in
   bindClientAgentAction (refuse the BIND, not the launch) — else merging creates an
   F131-class enabled-button/server-refuses state.
2. F38 UN-STRUCK (his commit creates the exact symbols our strike called phantom);
   its prescribed staff-hub fix is undone on BOTH sides and is now a live regression
   (refusal after the brief is typed) — apply it in the merge round (widen hub
   clients prop with agentsRepoSlug, filter, fixed chip/disabled Run). F35 binding-
   display half un-struck and built. F27 re-opened for Reddit: pin outputsPerRun=1,
   cap 5/week for Reddit identities server-side.
3. Reddit surfaces get the full rule application (map §3b table): stripInlineMarkdown
   at all 8 raw sites, laneLabel fallback, RedditDraftsBatch third sniff slot in
   asset-detail-modal (order: li → reddit → x; "## Account N ·" collides with X
   sniff), JobStatus/JobStatusBadge + formatDate in intake, refusal prefix
   allowlisted, F28 archive sentence rewritten, chainFamilyForAgent returns
   undefined for Reddit (identity-map owner hazard), buildAgentSetup + blurb entry.
4. Runway: merge as-is, RUNWAY_AUTOGEN_ENABLED stays unset. FIX at boundary: the
   "Runway autopilot" actor row must not reach a client's Activity tab (client-safe
   actor label or exclude system-actor rows in the client projection); neutralize
   the brief's "runway top-up / next two weeks" echo risk with a content-safe brief.
   PRODUCT QUESTIONS for Albert/Tomer before enabling: one-job-per-deficit gap
   (a deficit of 10 gets 1 asset), calendar badge computed with empty platform list,
   per-client token cost attribution with no credits moved, response dumping all
   clients behind one CRON_SECRET.
5. Refusal copy: OURS (click-path: 'Open this agent on your AI Agents page and
   follow "Set it up" under "What it knows about you"') applied byte-identically to
   both cores; his three toContain assertions updated.
6. hasLinkedInAgentIntake: KEEP OUR 2-arg per-agent-key form (4 HEAD call sites,
   preserves Path-B master semantics); adapt his test; document the seat-only
   company-page divergence in the merge commit.
7. href AND data both live on AgentSetupState: his inline intake pane serves the
   staff dialog; our href card serves the client detail route (CD-E1/CD-G1 model).

## Post-merge survival list (lens must verify all — map §5 verbatim)
His: binding refusal both cores + six writers + roster absence; recurring chips on
every fire day; scoped View-as-Client picker; lastError persistence + explicit null;
Reddit intake/feedback/refusal-with-link; runway flag-off = report-only; invalid X
handle refused.
Ours: F147 chip identity; F108 zone (Sao Paulo + Tokyo + no weekend chip); F30
cancelled terminal; CD-G9b data-overlay-root; F32 1100px; F131 no enabled-refused
control (new binding rungs); F27 clamps incl. Reddit; A3/A4 (no batch language, no
"Runway autopilot" to clients); F149 posted-only archive; F47/F126 all three
readers; CD-E1/CD-G1 setup.href alive from detail page.
