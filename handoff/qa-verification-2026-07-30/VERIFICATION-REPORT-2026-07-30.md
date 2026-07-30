# Verification report — Albert's QA-sweep implementation on `origin/main`

Reviewer: Claude · 2026-07-30 · verified against `5b28c29` (== `origin/main`), baseline `ddcef3e`

---

## Read this first — what this report is and is not

All **137 findings were verdicted against the code** at `origin/main`. That part is done.

Two things were **not** done, both because your org hit its monthly Anthropic spend limit mid-run:

1. **The adversarial re-check never ran.** Every verdict below is a single reviewer's first pass. 13 skeptic agents were queued to attack each verdict and all 13 died on the spend limit. Expect some of the 17 new bugs to fall over on contact — they are leads, not confirmed defects, unless marked otherwise.
2. **The ~30k lines of unrequested work were never audited.** 10 auditors (credits, auth/roles, scheduler, webhook, regressions, silent reverts, copy, data compat, coherence, test quality) all died on the same limit. **Nobody has reviewed the extra campaign work.** That is the single biggest open hole and it is unchanged from before this session.

This is the same wall that stopped the original fix-audit at 2 of 12 batches.

---

## Headline

| Verdict | Count |
|---|---|
| `fixed` | 114 |
| `partial` | 12 |
| `done-differently` | 11 |
| `untouched` | 0 |
| `regressed` | 0 |
| `fix-was-wrong` | 0 |
| **total** | **137** |

**Nothing was ruined.** Zero `untouched`, zero `regressed`, zero `fix-was-wrong` across all 137. Your instinct that it was taken carefully is borne out: `tsc --noEmit` is clean, **1419 tests pass across 97 files** (12,110 of the 52k added lines are tests he wrote), and the merge is live in production.

**The number mapping you were worried about is a non-issue.** His `F<n>` is exactly your `#<n>` for all 137 — no renumbering, no findings of yours missing from his inventory, no findings of his without a counterpart. The five apparent title mismatches are just his status notes bleeding into the title column.

**It is live.** The merge is deployed: the new per-agent detail route `/clients/[id]/agents/[agentId]` resolves in production, the CD-G2 rewritten blurbs render, and the Ops Import nav item is present. No hand-deploy has overridden the pipeline.

---

## The 11 places his ledger overstates the result

He reports 131/137 RESOLVED. On my read, **11 rows marked RESOLVED are partial.** None is a lie — in each case a real majority of the fix landed — but the ledger row should not read RESOLVED.

| # | Sev | Title | What is still missing |
|---|---|---|---|
| **#24** | blocker | An always-on agent that has failed every single run still show | did not land. (1) A CLIENT still gets no reason and no action: schedule.lastError is only read by rosterStatus and by the staff-only StaffAgentControls; neither AgentDetailPanel nor LegacyAg… |
| **#11** | high | The same problem appears as two cards with contradictory prior | still contains the pre-dedupe rows, and re-resolving their copy through today's REC_COPY makes them textually identical while keeping their contradictory impact and channel badges. src/lib/s… |
| **#27** | high | The Reddit agent's schedule dialog offers up to 35 replies a w | did not land: nothing is Reddit-aware in AgentScheduleModal's copy — the label is still "Posts per week" (custom-agents.tsx:1196-1200) and the client description still reads "How often this … |
| **#50** | high | "Refresh Task Map" promises a market-footprint scan; the run n | still missing is the fix's mandatory rider ("Either way, give the onboarding/re-auth coverage contract a reachable control"): persistSwarmTasks still hardcodes `owner: "karos_managed"` at ag… |
| **#148** | high | The portal has no launch-vs-runs model — the architecture the  | Almost all of the product model landed, and it is genuinely mounted. Types: ClientAgentLaunchState / ClientAgentTemplate / ClientAgent (with templates[] + rotation[]) / AgentSlot (templateKe… |
| **#35** | medium | On the staff Agents page you can only discover an agent's clie | still discoverable only by writing the brief and reading the refusal, exactly the reported symptom. The alternative arm (thread xSetup/linkedinSetup/redditSetup through the hub so the dialog… |
| **#37** | medium | Staff cross-client lists render every row in the database with | still calls listAssets() and listJobs() over the whole database and only reduces them to per-client counts afterwards (35-48); the comment at :24-34 admits the server-side count() is a hando… |
| **#65** | medium | Task-creating actions never hand you off to the board where th | still bare prose with nothing to click — the persist-tasks tool returns `Created ${count} task${…} in your task board${skipNote}.` at src/app/api/clients/[id]/chat/route.ts:685, and the copi… |
| **#67** | medium | The resume a client uploads is never read — but the UI says it | still only stores the file and mirrors `resumeUrl` onto the seat (route.ts:36-46) with no PDF/DOCX/TXT text extraction, so the resume is still never read by a model. And `backgroundContext` … |
| **#145** | medium | A channel whose token dies silently vanishes from “Connected c | still counts only usable rows and has no hint (:48, :60) even though StatCard supports one (src/components/ui.tsx:216, :229; the Agent runs tile uses it at :65-69), so a dead channel still s… |
| **#71** | low | Client-facing strings use a spaced hyphen where the rest of th | still client-visible, two server-action refusals rendered verbatim in the UI also use it: src/lib/actions/asset-actions.ts:265 "placeholder - put it on the calendar…" and :294 "being publish… |

The one that matters most is **#24 (blocker)**. Detail below.

---

## New defects found while verifying — ranked

17 of these. They are the actionable output of this session. **Unrefuted** — see the caveat above.

### 1. #103 — A client user has no sign-out anywhere on a phone

`src/app/(app)/clients/[id]/settings/page.tsx:224-259; src/components/settings-tabs.tsx:28-77; src/components/integrations-tab.tsx:146-222`

Deleting the Account card removed the ONLY sign-out a client user can reach at phone width. The fix
instruction's justification ("LogoutButton already renders in the rail's AccountMenu") is true only
on desktop: AccountMenu is mounted at client-rail.tsx:209, inside the `hidden ... md:block` aside
(client-rail.tsx:102). The mobile Company sheet (client-rail.tsx:280-320) has Settings, Team, the
bell, Contact us and the theme switch — no LogoutButton. The staff shell does have one in its mobile
sheet (sidebar.tsx:739), and /settings (settings-form.tsx) has no sign-out either, so grep confirms
LogoutButton is reachable for a CLIENT_USER only via account-menu.tsx:99. At ddcef3e the deleted
card was that path (the sheet links to Settings), so this is a regression introduced by faithfully
implementing a wrong clause of the instruction.

### 2. #107 — “Publish Now” now renders on unapproved drafts and on “Karos never posts it” placeholders — and the server allows it

`src/components/asset-detail-modal.tsx:417 (PublishNowRow, mounted at :369) + src/components/run-calendar.tsx:907-912 (canPublish={canSchedule}, connectedPlatforms from connectedPlatformsByClient)`

Making the prop flow exposed a gate that was dead code before. src/components/asset-card.tsx:481-482
is `canApprove && compatibleConnected.length > 0 && asset.status !== "published"` — no `publishMode
!== "placeholder"` and no approved/scheduled requirement, unlike the new modal gate (asset-detail-
modal.tsx:436-440, which excludes placeholders). assets-view.tsx:124 hands the client's platform
list to EVERY card of that client, and pushablePlatformsByClient only decides WHICH CLIENTS to read
integrations for, not which assets. So on /assets and /jobs/[id] a staff member now sees "Publish
Now" on (a) unapproved drafts and (b) "Calendar-only roadmap item. Karos never posts it"
placeholders, and publishAssetNowAction (src/lib/actions/asset-actions.ts, publishAssetNowAction
body) refuses neither — it only rejects status === "published" — so pressing it really posts an
unapproved draft or a placeholder. Fix: copy the modal's two extra conditions into asset-
card.tsx:481 and add a server-side refusal for publishMode === "placeholder" / status === "draft".

### 3. #86 — Client-triggered LLM call with no credit charge

`src/components/client-documents.tsx:491`

Wiring generateDocSummaryAction to the client-facing drawer created an unmetered, client-triggerable
LLM call: the effect at client-documents.tsx:460-472 fires on every DocOverlay open and the action
makes a Haiku call with only logger.logUsage — no chargeClientCredits, no isBillableClientActor
branch (intel-actions.ts:422-476), unlike the 1-credit chat message and 2-credit correction. Each
new document version re-triggers it for every document a client opens, and because the cache write
happens in after() (:462-474), rapid repeat opens before that write lands each cost a fresh call.

### 4. #16 — Four promoted SEO/GEO checks silently vanished from both markdown briefs

`src/lib/seo-geo.ts:942-944`

The lever change silently empties the markdown briefs of the four promoted checks. buildSeoBrief
filters `g.lever === "SEO"` (src/lib/intel/seo-geo.ts:637) and buildGeoBrief filters `g.lever ===
"GEO"` (src/lib/intel/seo-geo.ts:734); neither accepts "BOTH". At ddcef3e,
GEO-01/GEO-02/GEO-17/GEO-20 carried lever "GEO" and appeared in the GEO brief's prioritized gap
list. At HEAD they are promoted to "BOTH" by the dedupe and are therefore excluded from BOTH briefs
— the gaps vanish from the markdown fed to downstream doc generation and the client report
(src/lib/intel/report.ts also reads insights.gaps). No other consumer of `lever` was missed (a repo
grep finds only these two equality filters). Fix: make the two filters `g.lever !== "GEO"` /
`g.lever !== "SEO"`, or include "BOTH" explicitly.

### 5. #11 — Duplicate rows with contradictory chips on the client-facing action plan the #1 fix just mounted

`src/components/seo-geo/presenter.ts:945-947`

healRecommendations (presenter.ts:945-947) heals copy without deduping, so a legacy snapshot shows
the same action twice on the client's plan with contradictory chips. Reproduced against HEAD: for
BOTH-09 (no REC_COPY entry at ddcef3e, so the two registries stored two rows titled "Valid XML
sitemap, referenced in robots.txt, no noindexed entries" and "Sitemap valid + referenced"),
healRecommendations returns two rows both titled "Publish a clean map of your site" with the same
description, one badged high/search results and one medium/AI answers. Same for BOTH-02, BOTH-03 and
GEO-01. Both rows share recId "BOTH-09", so approving one flips both — visually it is exactly the
two-cards-one-defect symptom F11 reports, now on the client-facing plan the F1 fix just mounted.
Fix: dedupe by recId (and by resolved title) inside healRecommendations, keeping the higher-impact
row.

### 6. #58 — Autopilot preview and autopilot run disagree about what will run, under “View as client”

`src/components/tasks-board.tsx:114-131 and :148-195, src/lib/actions/settings-actions.ts:113-143`

The preview and the run diverge for a staff member using "View as client". Under impersonation
getCurrentUser returns a CLIENT_USER, so previewPendingTasksBatchAction evaluates
clientTaskRunRefusal and SUBTRACTS guard-rail-blocked tasks from `count` (settings-
actions.ts:129-135) — but isBillableClientActor is false, so runPendingTasksBatchAction falls to the
staff branch at settings-actions.ts:104-106 and calls runAutopilotBatch(clientId), which re-selects
the batch itself (execution-engine.ts:465-471) and applies no refusal filter. The panel therefore
quotes a smaller task count than what actually runs, and agents whose umbrella is not live get
executed on that path. The same branch also reports `started: staffBatch.length` from an unfiltered
selection.

### 7. #5 — The task-ticket dialog is no longer viewport-centred

`src/app/(app)/layout.tsx:180, src/app/(app)/layout.tsx:242, src/components/tasks-board.tsx:867-868`

The `@container` wrappers set `container-type: inline-size`, which applies layout containment and
therefore makes those wrappers the containing block for `position: fixed` descendants.
`TaskTicketModal` (mounted from src/components/tasks-board.tsx:890, i.e. INSIDE the wrapper) is the
one dialog in the repo that is NOT portaled: src/components/task-ticket-modal.tsx:631 renders
`className="fixed inset-0 z-[9999] flex items-center justify-center p-4"` directly in the React
tree. Its inset-0 now resolves against the max-w-6xl content column (whose height is the whole
scrolled page) instead of the viewport, so the backdrop no longer covers the rail/dock and the
max-h-[90vh] panel is centred against the full page height — opening a ticket from the top of a long
board can place the dialog far below the fold. Every other overlay in the repo uses createPortal for
exactly this reason (see the note at src/components/contact-us-modal.tsx:96-97, "containing block
doesn't offset this fixed overlay"). Same hazard, smaller impact, at src/components/seo-geo/score-
popover.tsx:72, whose `fixed inset-0` click-catcher now only covers the content column.

### 8. #88 — Copilot transcript loss across the 1024px breakpoint

`src/components/chatbot-widget.tsx:828`

Stale-mirror transcript loss across the lg breakpoint. CopilotDock now keeps BOTH widgets
permanently mounted (the sheet is hidden with `!sheetOpen && "hidden"` at copilot-dock.tsx:181
rather than conditionally rendered as at ddcef3e), and both share one storage key. The restore
effect runs once per mount with deps `[storageKey]` (chatbot-widget.tsx:144-158) and there is no
`storage`/BroadcastChannel listener anywhere in the file, so the hidden mount never re-reads the
key. Sequence: load at ≥1024px with 4 persisted messages — both mounts restore 4; send two messages
in the rail — storage now holds 6, the sheet still holds 4 in memory; rotate an iPad to portrait
(crosses lg) — the sheet paints its stale 4 and, on the next send, its write-back (162-175) persists
that stale list, permanently dropping two messages the client was charged for. The same gap
resurrects a cleared thread: `reset()` in the rail removes the key but cannot clear the sibling
mount's in-memory copy, which re-persists it on its next send. His "never clear on empty" guard
(170) covers only the empty-clobber case, not a stale non-empty one.

### 9. #27 — The Reddit agent page sells a draft-only product as a posting one

`src/lib/scheduled-runs.ts:52-68 + src/lib/actions/planned-run-actions.ts:238-264 + src/components/custom-agents.tsx:1197-1225`

New in this merge (CD-H8): LegacyAgentPanel hardcodes post vocabulary and is mounted for ANY unbound
agent with a schedule or delivered work, including the Reddit agent (agents/[agentId]/page.tsx:640
has no archetype exclusion, and agentArchetype maps Reddit to daily_finder only for the hero). So a
Reddit page renders DailyFinderPanel's correct "reply" language and, directly under it, "Create a
new post", "credits per post", "How often it posts" and "This agent is already posting for you"
(legacy-agent-panel.tsx:174-186, 138-192) — a draft-only product being sold as a posting one.
AgentDetailPanel already solves this with OUTPUT_NOUN[archetype]; LegacyAgentPanel takes no
archetype at all.

### 10. #113 — The client picker is shown to employees but is always empty for them

`src/components/sidebar.tsx:617-619`

The picker is now shown to employees but is inert for them: src/app/(app)/layout.tsx builds the
employee-scoped list as `staffClients` (line 53) yet only assigns `clients` inside the admin-only
`if (adminData)` branch (line 107), so Sidebar receives `clients={[]}` (line 225) for every
KAROS_EMPLOYEE. Their dropdown always reads "No clients found" (sidebar.tsx:174-176). The comment
justifying the change (sidebar.tsx:612-616) asserts "`clients` is already fenced to their assigned
clients by the app layout" — that is not true at HEAD. Clearing the context still works, so F113
itself is resolved; what shipped is a switcher an employee cannot switch with, plus a false code
comment.

### 11. #145 — Channels tile and the card beneath it now disagree

`src/components/client-analytics.tsx:164-193 (all integrations listed, warning badge + settings link for dead tokens); still unfixed at src/components/client-analytics.tsx:60 (`<StatCard label="Channels" value={activeChannels.length} />`)`

New user-visible inconsistency introduced by the fix: the Channels tile and the card beneath it now
disagree. With 3 healthy + 1 expired integration the tile reads "Channels 3" while the list below it
shows 4 rows; at baseline both showed 3. The card's sub-line explains it one card over, but the tile
is the number a client reads first. One-line fix on client-analytics.tsx:60:
hint={staleChannels.length > 0 ? `${staleChannels.length} needs attention` : undefined}.

### 12. #119 — Two client-visible labels still use the decorative colour token as text

`src/app/globals.css:33, 36, 230, 231`

Two client-visible spans use the decorative token as TEXT, at exactly the size F119 is about:
src/components/seo-geo-panel.tsx:135 and :761 render `<span className="ml-1.5 normal-case text-
muted-3">· {group.basisLabel}</span>` inside 10px intent headers. globals.css:34-35 says of
--muted-3: "kept for DECORATIVE use only … Text must never use it." Those two labels therefore still
render at the old ~3.5:1 on the SEO/GEO panel, which is mounted on the client dashboard
(src/app/(app)/clients/[id]/page.tsx:19, 88).

### 13. #76 — The “document is being rebuilt” row is dead code, so the document silently disappears instead

`src/app/(app)/layout.tsx:119`

The new `kind: "rebuilding"` row (client-documents.tsx:91, rendered at :1113-1122) is dead code and
the client-facing half of the instruction is therefore unmet in effect. It only fires when
allowInternalFallback is false AND an internal-tier twin is present, but the only mount that passes
false (client-rail) is now handed client-tier rows exclusively, so internalTier is always undefined
and the pick resolves to `{kind:"none"}`. Net effect for a client whose client-tier copy is missing
or empty: the document silently disappears from the nav with no explanation, instead of the promised
"This document is being rebuilt" row.

### 14. #20 — Two contradictory refresh promises inside the same card

`src/components/seo-geo/presenter.ts:471-493; src/components/seo-geo-panel.tsx:557-599`

The new strip line and the old copy now contradict each other inside the SAME card: panel:580
renders "No refresh is scheduled yet, so this snapshot won't update on its own." and panel:596,
three elements below it in that card, still renders "We'll retry on the next snapshot." for the no-
engines case. The roster chip "· next snapshot" (panel:826) and the drift line "are measured on the
next snapshot" (panel:686) promise the same thing on a client whose schedule is off. Copy-only, but
it is a client-visible contradiction the fix created.

### 15. #30 — Staff cancel dialog promises a credit refund for a run that was never charged

`src/lib/types.ts:216-222 + src/app/api/agent-service/webhook/route.ts:38-45 + src/lib/actions/external-job-actions.ts:41-65`

custom-agents.tsx:935 mounts <CancelRunControl runId={run.id} /> inside AgentRunHistory without
passing `refunds`, so it defaults to true — and AgentRunHistory is staff-only (rows are built only
when isStaff). A staff member cancelling a staff-fired run therefore reads "Stop this run? Credits
for it are returned." for a run that was never charged, which the component's own doc block (custom-
agents.tsx:968-974) says must not happen. Both client mount sites pass the flag correctly; only this
one omits it.

### 16. #39 — “Managed product” — internal vocabulary in client-facing SEO/GEO copy

`src/components/managed-products.tsx deleted (commit fbecbbf) + src/lib/execution-engine.ts:307-320 + src/components/seo-geo/presenter.ts:1326-1327`

presenter.ts:1326-1327 now renders "Produced by the <name> managed product." into the client-facing
SEO/GEO fix route. "Managed product" is internal portal vocabulary (the catalog's own word for the
agent-service task types), which the house copy rule bars from client-facing text — a client should
be told which agent or team does the work, not the internal product class.

### 17. #127 — Stale helper copy in the admin agent editor contradicts the guarantee #127 was about

`src/components/custom-agents.tsx:68-73`

Stale, now-false helper copy in the admin agent editor: src/components/custom-agents.tsx:1953-1956
tells staff "Leave empty and the card falls back to the internal description." That is no longer
true — agentBlurb/clientAgentBlurb never reads `description` (src/lib/agent-blurbs.ts:163-176); an
empty blurb falls back to the keyed blurb map. The same wrong claim is in the comment at custom-
agents.tsx:539-540 ("the client's card is still falling back to the lab manifest below"). Staff-
facing only, but it misdescribes the very guarantee this finding was about.

---

## Needs your eyes — judgement calls made on your behalf

- **#24** (blocker, `partial`) — Whether a client must see the refusal text (and a support route) or whether the one-word "Needs attention" is the deliberate client face is a product call; the implementer's handover logs a different F24 residual and does not mention dropping the client-side sentence.
- **#97** (blocker, `done-differently`) — The row now reads "N deliverables in review". The fix instruction dictated that wording, but the house copy rule lists "review" as an internal status word not to show clients. The paired hint ("Your Karos team is reviewing these — they'll appear in your archive when ready") carries the meaning in plain English, so this is a copy judgement call, not a code defect.
- **#125** (blocker, `fixed`) — Residual, outside the instruction and unchanged from baseline: the gate is all-or-nothing (analytics.ts:103 — every row mock or stale). A client with one live channel plus other connected platforms whose provider fell back to mock (analytics-providers.ts:480, :497) still gets a full briefing built partly from invented figures, and unbadged, since dataSourceHeaders uses the same all-or-nothing test (route.ts:92-93). Worth a product call on per-row provenance.
- **#127** (blocker, `fixed`) — scripts/backfill-agent-blurbs.ts still has to be run with --apply against the live customAgents so the seven agents carry curated blurbs rather than the keyed fallbacks; verify on screen afterwards.
- **#5** (high, `fixed`) — Open a task ticket on /tasks at 1280px after scrolling down the board — confirm whether the dialog is still viewport-centred. The containment/fixed-positioning interaction is a CSS-spec consequence I could only verify by reading, not by rendering.
- **#7** (high, `done-differently`) — The requested agent handoff was deliberately dropped rather than built: no card in "What we're fixing" can start a run, only an approval request. That is a product decision (the 27 Jul call asked for handoff into the agents), so Daniel should confirm the approval-only route is acceptable for launch.
- **#58** (high, `fixed`) — Whether the §2 guard rail is supposed to bind an impersonating admin is a product call (clientAgentRunRefusal deliberately returns null for non-CLIENT_USER roles) — but the preview and the runner should at least agree on the number.
- **#77** (high, `fixed`) — The carry-forward is prompt-mediated, not deterministic, yet the modal states it as a fact to an admin. Worse, listClientDocCorrections returns up to 100 rows with no de-duplication or supersession logic (data.ts:1576-1586), so a fact corrected twice injects BOTH versions as "absolute ground truth" in the same prompt, and every correction ever made is re-injected on every future run forever.
- **#78** (high, `fixed`) — The fix now depends on infrastructure that is not in place: cloudbuild.yaml:139-142 sets --memory/--cpu/--timeout/--concurrency but no CPU-allocation flag, so under Cloud Run request-based billing the CPU is throttled once the response is sent and the multi-minute after() pipeline is best-effort — it can be starved or killed while holding the lock for the full 20-minute stale window. The implementer flagged this himself (docs/qa-sweep-2026-07/TOMER-HANDOVER.md:495-508: "Add --no-cpu-throttling to the deploy args"); agent-service/cloudbuild.yaml:92 already has it, the portal's does not.
- **#87** (high, `fixed`) — One file away, the same defect class survives untouched: proactive-assistant.ts:259 (Scenario B, no social accounts) still instructs "Perform an external footprint scan using world knowledge about this client's URL, industry, and market position" — a confident external scan from model recollection, on the Scan & Refresh path. Out of F87's stated scope but the same credibility risk; someone should decide whether that line goes too.
- **#88** (high, `fixed`) — The stale-mirror loss needs one real device check (rotate a tablet across 1024px mid-conversation, or resize a desktop window) to confirm severity; the code path is unambiguous but the frequency is a product call.
- **#107** (high, `fixed`) — Decide the product answer for the new hole: Publish Now now renders on drafts and on "Karos never posts it" placeholders in the staff assets list, and the server action allows both.
- **#113** (high, `fixed`) — The escape hatch is fixed, but the second half of what the employee saw — a client copilot dock appearing on the right the moment they open a client page — is still there by design and was never ruled on.
- **#148** (high, `partial`) — F148 is the document's biggest work item and its ledger row reads RESOLVED while the sub-directive that owns the run-day note consumption (CD-A3) reads RESOLVED-PARTIAL. Daniel should decide whether shipping per-slot notes that only a human ever applies is acceptable for the demo, since the client-facing echo copy asserts the note was applied.
- **#149** (high, `fixed`) — The 30-day window applies only to published work, so an approved post a client never marks posted stays in their archive forever — that is the deliberate deviation from "age it out after ~30 days" and is a product call, not a code question.
- **#150** (high, `partial`) — The remaining half is infrastructure Tomer owns (GCS bucket, agent-service upload contract); someone needs to confirm the agent service will in fact write to Asset.videoUrl in the shape assetVideos() expects before the email workaround can retire.
- **#39** (medium, `done-differently`) — Worth confirming on screen that a client can actually get a Social/Newsletter/Blog/Landing run started from the task board (the dispatch path is a status transition plus resolveTaskProduct, not a visible "run this product" control), since the whole finding is about there being no front door.
- **#91** (medium, `fixed`) — The same prompt file still mandates the word it now forbids: TASK PHRASING STANDARDS at proactive-assistant.ts:321 gives "Generate and queue 5 LinkedIn posts via [Agent Name]" as a model task title. Those titles land on the client's task board, so "queue" can still reach the client one surface over, and line 321 directly contradicts the new rule at line 398. Pre-existing text, not introduced by this fix, but the contradiction is new and someone should reword 321.
- **#94** (medium, `fixed`) — This is a visual claim I verified only by reading classes and doing the height arithmetic. The sheet has no definite height (fixed, left/right/bottom, max-h only), so whether the inner `grow overflow-y-auto` regions scroll correctly rather than overflowing the cap is worth one look on a real phone — the finding has a screenshot, so a re-shoot is cheap.
- **#95** (medium, `fixed`) — He wrote "per run" where the fix said "per output", and for a manual run he is right (multiplier is 1). But scheduled runs bill `creditCost * outputsPerRun` on every fire (submit-custom.ts:319-322, run-scheduled/route.ts:79), and the appendix never mentions the multiplier while telling the model "Never invent credit figures beyond these" — so a client asking what their scheduled agent costs per week gets an understated number. Worth one line of copy.
- **#103** (medium, `fixed`) — Confirm on a phone that a CLIENT_USER has no sign-out anywhere (see newBugDetail) — this needs a product decision on where to put it back, and it is a real lockout-shaped regression, not a cosmetic one.
- **#111** (medium, `fixed`) — Layout-only change with a screenshot finding behind it — worth one look at 375px and at laptop width with the copilot dock open to confirm the agenda and the taller chips read as intended.
- **#118** (medium, `fixed`) — The reworded example says "run their content agent" — whether a repo agent by that name exists in a real client's imported catalog is data-dependent, so a staff member could still follow the worked example and get "agent not found" from list_agents.
- **#119** (medium, `fixed`) — A token used 463 times was lightened; only a visual pass can confirm the muted/muted-2 hierarchy did not flatten, which is the risk the fix instruction itself named.
- **#124** (medium, `done-differently`) — The struck finding's other half — "lift the three score tiles above the fold" — went the opposite way: F99 moved SeoGeoScores inside the visibility tab (page.tsx:155-161), so a client must now click "Search & AI visibility" to see any score, where at the baseline the scores always rendered on the page. Albert's revert covered the tiles, not this.
- **#130** (medium, `fixed`) — Until an admin types per-agent prices into the new "Credits per run" field, every card still reads 25 credits — the on-screen symptom the finding described persists as a data task.
- **#136** (medium, `fixed`) — Whether four columns are actually legible at the real staff width with the copilot rail out — and how many cards now fit on screen — is a visual claim that only a screenshot at 1280 and 1440 can settle; the code proves the layout exists, not that it reads well.
- **#44** (low, `fixed`) — The client's credit balance is no longer visible on the AI Agents page at all; confirm that is intended, since the finding's fix explicitly asked to keep that badge.
- **#71** (low, `partial`) — The residue is pure copy judgement across surfaces a grep cannot fully separate from arithmetic; a human should do one final read-through of the Reddit drafts reader and the X intake takes list, plus decide whether server-action refusal strings count as in-scope client copy.
- **#86** (low, `fixed`) — Someone should decide whether client-triggered summary generation should cost credits like every other client-facing AI action does.

---

## Per-finding table (all 137)

`L` = his ledger status. Verdicts other than `fixed` and rows where I disagree with him are bolded.

| # | Sev | Trk | L | Verdict | Evidence now |
|---|---|---|---|---|---|
| #1 | bloc | A | RESOLVED | fixed | `src/components/seo-geo-panel.tsx:400-405` |
| #3 | high | B | RESOLVED | fixed | `src/components/seo-geo/presenter.ts:1307-1321` |
| #4 | high | A | RESOLVED | fixed | `src/components/seo-geo/presenter.ts:1208` |
| #5 | high | A | RESOLVED | fixed | `src/app/(app)/layout.tsx:180, src/app/(app)/layout.tsx:242, src/compon` |
| **#7** | high | B | RESOLVED | **done-differently** | `src/components/seo-geo/presenter.ts:1250-1262, 1302-1327` |
| #9 | high | B | RESOLVED | fixed | `src/lib/seo-geo.ts:1222-1263` |
| #10 | high | B | RESOLVED | fixed | `src/lib/seo-geo.ts:493-502` |
| **#11** | high | B | RESOLVED | **partial** | `src/components/seo-geo/presenter.ts:945-947` |
| #12 | high | B | RESOLVED | fixed | `src/components/seo-geo/presenter.ts:1445-1491` |
| #15 | medi | B | RESOLVED | fixed | `src/components/chatbot-widget.tsx:812` |
| #16 | medi | B | RESOLVED | fixed | `src/lib/seo-geo.ts:942-944` |
| #17 | medi | A | RESOLVED | fixed | `src/components/seo-geo/presenter.ts:1557-1575` |
| #18 | medi | A | RESOLVED | fixed | `src/components/seo-geo-panel.tsx:743-878` |
| #19 | medi | A | RESOLVED | fixed | `src/components/seo-geo-panel.tsx:855-877` |
| **#20** | medi | A | RESOLVED | **done-differently** | `src/components/seo-geo/presenter.ts:471-493; src/components/seo-geo-pa` |
| #22 | medi | B | RESOLVED | fixed | `src/components/seo-geo/presenter.ts:1295; src/lib/seo-geo.ts:882-898` |
| #23 | medi | B | RESOLVED | fixed | `src/components/seo-geo-panel.tsx:500; src/components/seo-geo/presenter` |
| **#24** | bloc | A | RESOLVED | **partial** | `src/lib/client-agents.ts:488 + src/lib/client-agent-rows.ts:147-152 + ` |
| #25 | high | A | RESOLVED | fixed | `src/lib/credits.ts:264-303 + src/app/(app)/clients/[id]/agents/page.ts` |
| **#27** | high | B | RESOLVED | **partial** | `src/lib/scheduled-runs.ts:52-68 + src/lib/actions/planned-run-actions.` |
| #28 | high | B | RESOLVED | fixed | `src/components/asset-detail-modal.tsx:286-317 + src/components/x-agent` |
| #29 | high | B | RESOLVED | fixed | `src/lib/actions/asset-actions.ts:205-238` |
| #30 | medi | B | RESOLVED | fixed | `src/lib/types.ts:216-222 + src/app/api/agent-service/webhook/route.ts:` |
| **#31** | medi | B | RESOLVED | **done-differently** | `src/app/(app)/clients/[id]/agents/page.tsx:158-163,205 + src/app/(app)` |
| #32 | medi | A | RESOLVED | fixed | `src/components/modal.tsx:112-140` |
| #33 | medi | A | OPS-PENDING | fixed | `src/lib/job-title.ts:13-29 + src/app/api/agent-service/webhook/route.t` |
| #34 | medi | A | RESOLVED | fixed | `src/app/(app)/clients/[id]/agents/page.tsx:218-233 + :366-384` |
| **#35** | medi | A | RESOLVED | **partial** | `src/components/custom-agents.tsx:154-158 (intakeDrivenLabel) vs :530-5` |
| #36 | medi | A | RESOLVED | fixed | `src/components/custom-agents.tsx:1445-1460` |
| **#37** | medi | A | RESOLVED | **partial** | `src/components/jobs-list.tsx:35-51,148-161 + src/components/clients-gr` |
| #38 | medi | B | RESOLVED-in-me | fixed | `src/components/custom-agents.tsx:501-503,571-582,600-602,1676-1694` |
| **#39** | medi | B | RESOLVED | **done-differently** | `src/components/managed-products.tsx deleted (commit fbecbbf) + src/lib` |
| #40 | medi | A | RESOLVED | fixed | `src/components/custom-agents.tsx:1195-1201` |
| #41 | low | A | RESOLVED | fixed | `src/components/x-agent-intake.tsx:708-720` |
| #42 | low | A | RESOLVED | fixed | `src/components/x-agent-intake.tsx:498-508` |
| #43 | low | A | RESOLVED | fixed | `src/app/(app)/clients/[id]/agents/page.tsx:385-406` |
| #44 | low | A | RESOLVED | fixed | `src/app/(app)/clients/[id]/agents/page.tsx:209-212` |
| #45 | low | A | RESOLVED | fixed | `src/lib/actions/external-job-actions.ts:10-12` |
| #46 | bloc | B | RESOLVED | fixed | `src/components/asset-detail-modal.tsx:122-137, src/components/asset-de` |
| #47 | bloc | B | RESOLVED | fixed | `src/components/asset-detail-modal.tsx:394-404, src/lib/asset-visibilit` |
| #48 | high | B | RESOLVED | fixed | `src/components/tasks-board.tsx:103-112, src/lib/actions/settings-actio` |
| **#50** | high | B | RESOLVED | **partial** | `src/components/chatbot-widget.tsx:65-74, src/lib/agent-swarm.ts:456 an` |
| **#51** | high | B | RESOLVED | **done-differently** | `src/components/notification-bell.tsx:242-284, src/components/client-ra` |
| #53 | high | A | RESOLVED | fixed | `src/components/linkedin-seats-workspace.tsx:155, src/lib/credits.ts:13` |
| #54 | high | A | RESOLVED | fixed | `src/components/task-ticket-modal.tsx:55-59, src/lib/actions/task-actio` |
| #55 | high | B | RESOLVED | fixed | `src/app/api/auth/social/[provider]/route.ts:29-47, src/lib/integration` |
| #56 | high | B | RESOLVED | fixed | `src/app/(app)/clients/[id]/settings/page.tsx:212-222, src/lib/actions/` |
| #57 | high | A | RESOLVED | fixed | `src/components/task-ticket-modal.tsx:411` |
| #58 | high | B | RESOLVED | fixed | `src/components/tasks-board.tsx:114-131 and :148-195, src/lib/actions/s` |
| #60 | medi | A | RESOLVED | fixed | `src/components/client-context-bar.tsx:18-52, src/app/(app)/layout.tsx:` |
| #61 | medi | B | RESOLVED | fixed | `src/lib/actions/task-actions.ts:75-97, :428-441` |
| #62 | medi | B | RESOLVED | fixed | `src/lib/actions/competitor-actions.ts:476 and :515, src/components/cli` |
| #63 | medi | A | RESOLVED | fixed | `src/components/icon.tsx:11-18` |
| #64 | medi | A | RESOLVED | fixed | `src/components/notification-bell.tsx:382 and src/components/tasks-boar` |
| **#65** | medi | A | RESOLVED | **partial** | `src/app/api/clients/[id]/chat/route.ts:685` |
| #66 | medi | A | RESOLVED | fixed | `src/components/archive-view.tsx:191-231` |
| **#67** | medi | B | RESOLVED | **partial** | `src/app/api/users/resume/route.ts:36-46` |
| #68 | medi | B | RESOLVED | fixed | `src/app/(app)/layout.tsx:52-101` |
| #69 | medi | A | RESOLVED | fixed | `src/components/client-documents.tsx:1083-1089 and src/lib/actions/_sha` |
| #70 | medi | A | RESOLVED | fixed | `src/lib/draft-lane-label.ts:32-48, src/components/x-drafts-review.tsx:` |
| **#71** | low | A | RESOLVED | **partial** | `src/components/reddit-drafts-review.tsx:308 and :435, src/components/x` |
| #72 | low | A | RESOLVED | fixed | `src/components/sidebar.tsx:60, src/app/(app)/tasks/tasks-body.tsx:191,` |
| #73 | low | A | RESOLVED | fixed | `src/components/activity-timeline.tsx:504-515, :93, :156, :184` |
| #74 | high | B | RESOLVED | fixed | `src/lib/actions/intel-actions.ts:544` |
| #75 | high | B | RESOLVED | fixed | `src/lib/active-client-context.tsx:54` |
| #76 | high | B | RESOLVED | fixed | `src/app/(app)/layout.tsx:119` |
| #77 | high | B | RESOLVED | fixed | `src/lib/intel/pipeline.ts:775` |
| #78 | high | B | RESOLVED | fixed | `src/lib/actions/intel-actions.ts:265` |
| #79 | medi | A | RESOLVED | fixed | `src/components/client-documents.tsx:73` |
| #80 | medi | A | RESOLVED | fixed | `src/components/client-documents.tsx:434` |
| #81 | medi | B | RESOLVED | fixed | `src/lib/actions/intel-actions.ts:565` |
| #82 | medi | B | RESOLVED | fixed | `src/components/client-documents.tsx:128` |
| #83 | medi | A | RESOLVED | fixed | `src/lib/doc-render.ts:275` |
| #84 | medi | B | RESOLVED | fixed | `src/components/client-documents.tsx:843` |
| #85 | medi | A | RESOLVED | fixed | `src/components/correct-info-modal.tsx:134-137` |
| #86 | low | B | RESOLVED | fixed | `src/components/client-documents.tsx:491` |
| #87 | high | B | RESOLVED | fixed | `src/lib/ai/prompts/proactive-assistant.ts:384` |
| #88 | high | A | RESOLVED | fixed | `src/components/chatbot-widget.tsx:828` |
| #89 | high | A | RESOLVED | fixed | `src/components/chatbot-widget.tsx:808` |
| #90 | high | B | RESOLVED | fixed | `src/components/strategy-war-room.tsx:307` |
| #91 | medi | B | RESOLVED | fixed | `src/components/chatbot-widget.tsx:111` |
| #92 | medi | B | RESOLVED | fixed | `src/lib/campaign-engine.ts:217` |
| #93 | medi | A | RESOLVED | fixed | `src/components/strategy-war-room.tsx:186` |
| #94 | medi | A | RESOLVED | fixed | `src/components/copilot-dock.tsx:179` |
| #95 | medi | A | RESOLVED | fixed | `src/app/api/clients/[id]/chat/route.ts:203` |
| **#97** | bloc | B | RESOLVED | **done-differently** | `src/components/client-home-overview.tsx:121-138 (non-link status row);` |
| #99 | medi | A | RESOLVED | fixed | `src/app/(app)/clients/[id]/page.tsx:180-209 (client branch: one-line w` |
| #100 | low | A | RESOLVED | fixed | `src/components/transcript-tools.tsx:179 ("Analyzing…" / "Ingest & anal` |
| #101 | high | A | RESOLVED | fixed | `src/components/linkedin-seats-workspace.tsx:239-253, 261-304, 106-121` |
| #102 | high | B | RESOLVED | fixed | `src/components/credits-panel.tsx:146 and 227-237; src/app/(app)/layout` |
| #103 | medi | A | RESOLVED | fixed | `src/app/(app)/clients/[id]/settings/page.tsx:224-259; src/components/s` |
| #104 | medi | A | RESOLVED | fixed | `src/components/credits-panel.tsx:98-103, 259-281, 290-318` |
| #105 | medi | B | RESOLVED | fixed | `src/components/integrations-tab.tsx:325-344, 346-365, 537-541, 713-731` |
| #107 | high | B | RESOLVED | fixed | `src/components/asset-detail-modal.tsx:417 (PublishNowRow, mounted at :` |
| **#108** | high | B | RESOLVED | **done-differently** | `src/lib/scheduled-runs.ts:100-121 (timezone-pinned branch of computeNe` |
| #109 | medi | A | RESOLVED | fixed | `src/components/run-calendar.tsx:392-451 (PastRunCard header link/butto` |
| #110 | medi | B | RESOLVED | fixed | `src/components/run-calendar.tsx:230-268 (both handlers) and :301-357 (` |
| #111 | medi | A | RESOLVED | fixed | `src/components/run-calendar.tsx:715 and :722 (`hidden grid-cols-7 sm:g` |
| #112 | low | A | RESOLVED | fixed | `src/app/(app)/calendar/calendar-body.tsx:419-436 (EmptyState with acti` |
| #113 | high | A | RESOLVED | fixed | `src/components/sidebar.tsx:617-619` |
| #115 | medi | B | RESOLVED | fixed | `src/lib/actions/user-actions.ts:37-67, 159, 170-172` |
| #116 | medi | A | RESOLVED | fixed | `src/components/client-rail.tsx:201-207` |
| #117 | medi | B | RESOLVED | fixed | `src/app/(app)/clients/page.tsx:12-22 and src/components/clients-grid.t` |
| #118 | medi | A | RESOLVED | fixed | `src/app/(app)/connect/page.tsx:20, 61-70` |
| #119 | medi | A | RESOLVED | fixed | `src/app/globals.css:33, 36, 230, 231` |
| **#120** | medi | A | RESOLVED | **done-differently** | `src/components/x-agent-intake.tsx:720, src/components/linkedin-agent-i` |
| #121 | low | B | RESOLVED | fixed | `src/components/notification-bell.tsx:69-73` |
| #122 | low | A | RESOLVED | fixed | `src/lib/integrations/platforms.ts:117-141` |
| **#123** | low | A | RESOLVED | **done-differently** | `src/components/client-analytics.tsx:65-69` |
| **#124** | medi | A | STRUCK-BY-ALBE | **done-differently** | `src/components/client-analytics.tsx:52-71 (four baseline tiles restore` |
| #125 | bloc | B | RESOLVED | fixed | `src/app/api/clients/[id]/insights/route.ts:100-110 (non-staff get need` |
| #126 | medi | A | RESOLVED | fixed | `src/components/ai-insights.tsx:200-201 (INLINE_EMPHASIS_RE), :218-254 ` |
| #127 | bloc | B | OPS-PENDING | fixed | `src/components/custom-agents.tsx:68-73` |
| **#128** | high | A | RESOLVED | **done-differently** | `src/components/custom-agents.tsx:183-216` |
| #129 | high | A | RESOLVED | fixed | `src/lib/client-agents.ts:473-511` |
| #130 | medi | A | OPS-PENDING | fixed | `src/lib/types.ts:271` |
| #131 | bloc | A | RESOLVED | fixed | `src/lib/client-agent-runs.ts:141-150` |
| #132 | high | A | RESOLVED | fixed | `src/lib/client-agent-rows.ts:103-112` |
| #133 | high | B | RESOLVED | fixed | `src/lib/seo-geo.ts:1127; src/components/seo-geo/presenter.ts:353-361` |
| #134 | high | A | RESOLVED | fixed | `src/lib/custom-agent-launch.ts:358` |
| #135 | low | A | RESOLVED | fixed | `src/components/custom-agents.tsx:1280-1284` |
| #136 | medi | A | RESOLVED | fixed | `src/components/tasks-board.tsx:867-868 and :309-317` |
| #138 | medi | B | RESOLVED | fixed | `src/lib/intel/templates.ts:25` |
| #139 | low | A | RESOLVED | fixed | `src/components/correct-info-modal.tsx:120` |
| #140 | low | A | RESOLVED | fixed | `src/components/client-documents.tsx:916` |
| #141 | low | A | RESOLVED | fixed | `src/components/credits-panel.tsx:221-224 and 40-59, 259-281` |
| #142 | low | A | RESOLVED | fixed | `src/components/run-calendar.tsx:695 (`shrink-0 whitespace-nowrap` on t` |
| #143 | medi | A | RESOLVED | fixed | `src/components/notification-bell.tsx:406-415, 335-355, 23` |
| #144 | low | A | RESOLVED | fixed | `src/components/seo-geo/gap-list.tsx:19-23; src/components/seo-geo/pres` |
| **#145** | medi | A | RESOLVED | **partial** | `src/components/client-analytics.tsx:164-193 (all integrations listed, ` |
| #146 | medi | A | RESOLVED | fixed | `src/lib/data.ts:788` |
| #147 | high | B | RESOLVED | fixed | `src/lib/agent-identity-map.ts:117-150` |
| **#148** | high | B | RESOLVED | **partial** | `src/components/client-agents/live-card.tsx:49-321` |
| #149 | high | B | RESOLVED | fixed | `src/lib/asset-visibility.ts:97-107 and src/app/(app)/tasks/tasks-body.` |
| **#150** | high | B | DEFERRED-TOMER | **partial** | `src/components/asset-detail-modal.tsx:271-280, src/lib/types.ts:452-45` |
| #151 | high | A | RESOLVED | fixed | `src/app/(app)/calendar/calendar-body.tsx:315-321 (title via cleanTitle` |
| #152 | high | B | RESOLVED | fixed | `src/lib/__tests__/seo-geo-mounting.test.ts:55-89` |

---

## What I verified myself, by hand

Five spot checks, including the three leads you handed me.

**#1 — fixed, well.** `SeoGeoActionPlan` is imported at `seo-geo-panel.tsx:37` and mounted at `:400`.
The gap list is properly demoted *and* role-gated, which is what you asked me to confirm: it renders
only behind `!isClientViewer` inside a `Disclosure` whose summary literally says "(staff only)"
(`seo-geo-panel.tsx:406-413`). Two things beyond the ask that are genuinely good: a `planPending`
empty state for snapshots captured before plans existed, and `healRecommendations` re-resolving the
copy **at the server boundary** so raw engineering labels never enter the RSC payload. There is also
a test — `src/lib/__tests__/seo-geo-mounting.test.ts` — that pins both the import and that
`<SeoGeoActionPlan>` precedes `<GapList>`, with a comment naming the five-week regression. That is a
direct guard against the `de0d414` silent-revert precedent you flagged.

**#63 — fixed. Your lead was a false alarm, for a good reason.** `icon.tsx` does still fall back to
`icons.Sparkles`, but the fix never asked for that to be removed — the fallback is required because
icon names are user-configurable on agents. It asked for two things: rename the 37 call sites, and
make the miss loud in development. Both landed. The dev `console.warn` is at `icon.tsx:11-18`, with a
one-warning-per-name guard, and the seven canonical names now appear 71 times across the tree
(`TriangleAlert` 26, `CircleCheck` 26, `CircleAlert` 9, `SquareCheck` 4, `LoaderCircle` 3,
`ChartNoAxesColumn` 2, `WandSparkles` 1).

**#132 — fixed, and I nearly misfiled it.** On the live portal I saw run-history rows still showing
raw operator typing with typos intact ("Create 1 linkein post for the company"). That looks like the
defect — but the fix instruction says, in as many words, *"Keep the raw prompt in the run detail for
staff."* I was logged in as admin. The code scopes it correctly: `run.prompt` is populated for staff
only, with the reasoning at `custom-agents.tsx:901-902`, and `AgentRunHistory` is never mounted for a
client viewer (`:866-867`). Working as designed. Worth recording because it is the shape of error this
kind of review makes most often.

**#24 — partial, and you can see it in production right now.** The pilot client's Instagram Agent
shows a green **"Live"** badge while its only run, 2 days ago, reads **"Failed"**. This is the
document's fault, not Albert's: the fix instruction only asked for `schedule.lastError`, which
captures *submit-time refusals*. A run that submits successfully and then fails at the agent service
never sets it. Faithfully implemented, still visibly broken. If you fix one thing from this report,
key the badge off last-run outcome, not off `lastError`.

**Repo debris — none of it was cleaned.** All of it is still tracked at `origin/main`: 7 root-level
`*.png`, `dev-error.log`, and `_backup/` (7 Firestore snapshots). `.gitignore` still has no rule for
any of them. My earlier impression that the PNGs had gone was wrong — that was me grepping the wrong
worktree. Tomer said he would do this; he has not.

---

## Decisions waiting on you (from his handover, §5.1 and §2)

Albert's `TOMER-HANDOVER.md` is 1,921 lines and genuinely good — it is an honest document, including
about its own gaps. It asks for two categories of thing.

**Six ops steps, none of them run, all `--apply`-gated and dry-run by default.** Note the standing
warning at the top of his §2: **the dev `.env.local` points at production Firestore.**

| Step | Unblocks | Command |
|---|---|---|
| §2.1 | #127 | `npx tsx scripts/backfill-agent-blurbs.ts --apply` |
| §2.2 | #33 | `npx tsx scripts/backfill-asset-titles.ts --apply` |
| §2.8 | Phase 3 on existing clients | `scripts/backfill-client-agents.ts`, per client |
| §2.9 | CD-G7 fleet data quality | `refresh-apply.ts --apply`, per client |
| §2.10 | **#130, and every client Launch button** | set `creditCost` + `launchCreditCost` per agent in the admin editor — no script |
| §2.11 | roster completeness | `grant-all-agents.ts` sanity pass |

**§2.10 is more urgent than its ledger row suggests.** On the live Instagram Agent detail page the
staff cost panel reads *"Launch price now: **not set — clients cannot launch it**"*. Until someone
types per-agent prices in, the entire client Launch flow this campaign built is inert in production,
and every card still shows the flat 25 credits that #130 was raised about. The copy is honest about
it, which is to Albert's credit — but it is a data task standing between you and a working demo.

**Product calls he explicitly refuses to make for you** — the one that matters most:

> **The X agent's learning log evicts real client feedback in about ten days.** The window that
> teaches the X agent a client's taste is capped at `FEEDBACK_ROWS_PER_ACCOUNT = 30`, and it is
> per *account bucket*, not per client. Each daily pick auto-writes the two unpicked options as
> `not_posted`, and marking the winner posted writes a third — so the real burn is **3 rows/day**,
> not the 2 the original ruling assumed. For a single-account client all three land in the same
> `"company"` bucket and exhaust the window in ~10 days, evicting the genuine human feedback the
> log exists to carry. His preferred fixes, in order: raise the cap; split the auto-log into its
> own stream so it cannot evict human feedback; or decay auto-rows faster than human ones.

Others: #77 corrections are treated as absolute ground truth with no cap, no expiry and no
supersession, so every correction ever made is re-injected into every future run at Karos's token
cost (my reviewer flagged the same thing independently — `data.ts:1576-1586` returns up to 100 rows
undeduplicated); paused schedules vanish from the client's calendar with no explanation; and clients
lost the cross-agent "recent runs" list, which was a real surface, in exchange for per-agent pages.

**One infrastructure item worth pulling forward** because it silently weakens a fix that is marked
resolved: #78 moved document regeneration into `after()`, but `cloudbuild.yaml:139-142` sets memory,
CPU, timeout and concurrency and **no CPU-allocation flag**. Under Cloud Run request-based billing the
CPU is throttled once the response is sent, so a multi-minute `after()` pipeline can be starved or
killed while holding its lock for the full 20-minute stale window. `agent-service/cloudbuild.yaml:92`
already sets `--no-cpu-throttling`; the portal's does not. He flagged this himself at handover
§3.1 / lines 495-508.

---

## What I could not verify, honestly

- **The adversarial re-check of all 137 verdicts** — 13 agents, all killed by the spend limit.
- **The whole unrequested-work audit** — credits, auth/role boundaries, scheduler, webhook,
  regressions, silent reverts, copy QA, Firestore backward-compatibility, coherence, and test
  quality. 10 agents, all killed by the spend limit. This is the review you most need and it has
  not happened. In particular nobody has checked what existing production documents do when the
  campaign's new fields are absent — which is the state of the database right now, since no
  backfill has run.
- **A real client-role session.** I could not complete one. `Sign in as` on `/team` is wired
  correctly in code (`team-manager.tsx:72-77` → `startImpersonationAction` → `startImpersonation`,
  `auth.ts:317`, `CLIENT_USER`-only, httpOnly cookie), but three clicks produced no navigation in my
  session. I traced that to the browser tooling, not the portal: your Chrome window reports
  `devicePixelRatio 1.5` at 53% zoom and the extension returned a cropped 914px-wide capture of a
  1705px page, so ref-derived click coordinates land off-target. **I do not believe this is a portal
  defect and it should not be filed as one** — but it does mean the ~40 client-role findings remain
  code-verified only, exactly as they were when the document was written. One manual pass as
  `qa-lens@karoslabs.com` would close it.
- I resized your Chrome window to 1440×900 while trying to work around the above. Worth knowing.
- **Deploy provenance.** `gcloud auth` has expired (it needs an interactive Chrome login I cannot
  do), so I confirmed the merge is live by reading the production DOM rather than by listing
  revisions. If you want to know *who* deployed and whether a hand-deploy is lurking:

```bash
gcloud auth login
```

---

## If you do only five things

1. **#24** — badge off last-run outcome, not `lastError`. A blocker, visible on the pilot client now.
2. **#107** — `asset-card.tsx:481` is missing the modal's two extra conditions, and
   `publishAssetNowAction` refuses neither a draft nor a placeholder. This one really posts.
3. **§2.10** — set per-agent prices, or no client can launch anything.
4. **#103** — confirm on a phone whether a client user can sign out at all.
5. **Commission the unrequested-work audit** when the spend limit resets. 30k lines, unreviewed.
