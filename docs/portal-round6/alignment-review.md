# Round 6 alignment and risk review (2026-09-04)

Worktree `claude/portal-round6`, uncommitted diff of 83 files, read against `albert-brief-round6.md`, `risk-review.md`, `impl-brief.md`, `round6-approval.html` and the six handoffs. `npx tsc --noEmit` is clean. Items already on the integrator's list (two red tests, handoff requests, `ArchiveTile` hover, `MeasurementStamp`, `buttonClass`, the widened "Not on your plan") are not repeated here.

## A. Ask by ask

| Ask (brief / approval page) | Built (file:line) | Verdict |
|---|---|---|
| 07 Reporting: no general advice, allow-list of three structural items | `lib/seo-geo.ts:1591` `CLIENT_OWNED_IDS` = GEO-25/07/14; copy `:1618`; REC_COPY fallback deleted `:1699` | DONE |
| 07 "Things only you can do" at the very bottom, heading always renders | `settings/page.tsx` reporting order: scores, VisibilityWork, panel, ClientSuggestions; `seo-geo/client-suggestions.tsx:60` | DONE |
| 07 New section above it, every relevant agent, one sentence, button straight to the agent page | `components/seo-geo/visibility-work.tsx` rows, outline `<Link>` "Open {agentName}" `:129`; table `lib/visibility-levers.ts`; roster status via `lib/client-roster.ts` | DONE |
| 07 Agents not on plan read "Not on your plan" + Support | `visibility-work.tsx:106,137` | DONE (scope widening is the integrator's) |
| 07 "Quoted N times" line, claims-cap test | `visibility-work.tsx:116`; `visibility-levers.test.ts` | DONE |
| 01 One interaction logic; SEO cells light up like KPI cells | `ui.tsx:26,44,95` (Button colour-only, Card no hover, `.focus-ring` on Button/Input/Textarea/Select/TabButton); `globals.css:283`; `home-standing.tsx:48` cells are `Link row-lift focus-ring` to `#presence` / `#share` (`seo-geo-panel.tsx:416,434`) | DONE |
| 01 Home orange = ladder button, progress fill, row hovers, bell badge | KPI icons, sparkline, chips, takeaway, coins all ink/grey; only `home-get-set-up.tsx:145` fill, `home-task-row.tsx:22` link, bell badge remain | DONE |
| 02 Why one "Let's do this"; better CTA | `home-task-row.tsx:294` label required; `setup-ladder.ts` `action` strings per step | DONE |
| 02 Tailored steps: what is missing, land on the field, detect done | Profile: `profileStepLine`, `?edit=&for=`, `client-profile-panel.tsx:585` outline + focus + `HereFor`. Docs: `?doc=&for=#documents`, `client-documents.tsx:1065`, "Looks right" foot `:334`. Agent steps: `#setup` / `#run` hrefs `setup-ladder.ts:941,952` | PARTIAL: no element on the agent page carries `id="setup"` or `id="run"`, so steps 3 and 4 land at the top of the page, not on the control |
| 02 Honest signals per step (profile = 3 fields, voice = confirmed, agent = live or set up, run = reached review, result = opened) | `clients/[id]/page.tsx:107,120,188`; `action-list.ts:41` (05 event-tracked); `run-calendar.tsx:1912` | DONE (see D for the step 5 gap) |
| 02 Completion state once, then gone | `home-get-set-up.tsx:149`; `page.tsx:270` cooldown removed | DONE |
| 02 Waiting row: "Karos is setting up your {agent}. Usually ready within 2 business days." | `setup-ladder.ts:914` | DONE |
| 03 Predicate: drafts count, 14-day window, ladder reads the same function | `agent-detail-archetypes.ts:375,414` (`isUpcomingPost` + ceiling); ladder `page.tsx:164` `rosterStatus(...)` | DONE |
| 03 Status words unchanged; one badge component; reasons as sentences; failed run = Internal for staff | `client-agents.ts:690,880`; `roster-row.tsx:213` `RosterStatusBadge` (roster + Reporting) | DONE |
| 03 Chip beside logo gone; strip is one plain line with linked facts and Adjust pace | `[agentId]/page.tsx:1182,1224`; `agent-sections.tsx:120`; `legacy-agent-panel.tsx:263` | DONE |
| 03 "N posts planned" in the approval mock | `[agentId]/page.tsx:112` prints "N days planned" | DEVIATED (accepted, C below) |
| 04 Every notification row opens something; "2 unread" clickable or gone; empty state with calendar link | `notification-bell.tsx:513` chip gone; action rows are `<Link>` + Done `:687,713`; empty state `:540`; `notification-rows.ts:983,1045` client feeds empty | DONE ("Mark all as read" not built, permitted by impl brief) |
| 05 Dialog: one question, Try chips, defaults line + Change, one More options, staff run types in staff block, no files for clients | `custom-agents.tsx:2594,2599,2635,2649,2736` | DONE |
| 05 Title and confirm "Create post" (noun-aware), paper confirm, footer one line, default 1, price follows count | `custom-agents.tsx:96,2465,2521,2541`; `custom-agent-launch.ts:862,903` | DONE |
| 05 Dashed "No reference files" box gone | `agent-input-files.tsx:16`; mount inside `StaffOnlySection` only `custom-agents.tsx:2743` | DONE |
| 06 Rail: marks and names, no stars, 32px, pinned first, hairline, cap 6, one current row, empty state links | `client-rail-agents-nav.tsx:55,264,298` | DONE |
| 06 Pin only on the agent page, ink not orange | `agent-star-button.tsx:64` | DONE |
| 06 Agents tab: one row per agent, status, last made, next, verb, chevron; Coming Soon greyed no link | `roster-row.tsx`; `client-agent-rows.ts:1011` | DONE |
| 06 Not-set-up copy + real action; no video frame without a video | `[agentId]/page.tsx:308`; `agent-setup-hero.tsx:47` | DONE |
| 08 Remove Seats card and its read | `settings/page.tsx` (card, `seatSetupLinks`, `listClientSeats` all gone) | DONE |
| Small: RUNS ON REQUEST badge gone | `[agentId]/page.tsx:1182` | DONE |
| Small: daily-content agent reads Live | predicate above; both agent pages and ladder | DONE |
| Small: rows in "What we are doing" go straight to the agent page | `visibility-work.tsx:129` | DONE |
| Sidebar "research a better look" (whole rail) | rows gain `.focus-ring` only (`rail-nav-link.tsx:44`) | PARTIAL by design (risk review D: nothing on the rail as a whole; agents block done) |

## B. Derailment check

| Check | Result |
|---|---|
| Renamed status word | None. Seven words intact in `client-agents.ts`; the only new word is "Not on your plan" in Reporting. |
| Second orange per client screen | Home: none beyond the sanctioned four. Agents tab: none. Agent page: one of hero / launch / run panel / legacy keeps `accent` (mutually exclusive); a `text-neon` coin glyph beside the price for clients remains (`agent-detail-panel.tsx:196`, `legacy-agent-panel.tsx:190`), small but a second orange. Run dialog: no accent in the client pane; the staff data pane's "Continue to the run" is mutually exclusive. Reporting: none; `seo-geo-panel.tsx:664` paints a refreshing STATUS line in `text-neon` (orange signalling status). Profile: two pre-existing hand-rolled `bg-neon` saves (`client-profile-panel.tsx:519,955`) and orange headings/glyphs in the document panel (`client-documents.tsx:606,630,692,881,948`); the ladder now lands clients here. Bell: badge only. |
| Staff-only branch changing shared layout | One minor case: the "More options" toggle renders for staff and not for a client on intake-driven agents (`custom-agents.tsx:2634`), so the two readers see one row of difference; the content inside is a marked `StaffOnlySection`. Everything else is additive (`Internal` line, staff footer links). |
| Em dashes / spaced hyphens in client strings | None in added rendered strings (diff and the five new files scanned; hits are all comments). |
| Content ideas on Home | None. |
| Calendar "Schedule a run" for clients | Unchanged, staff only (`run-calendar.tsx:1572`). |
| Client uploads | None; `AgentInputFiles` mounts only inside `StaffOnlySection`. |
| impl-brief §1.7 list | Nothing built: no rename, no "Paused", no phase-2 feed, no "More ways", no site-access field, no dynamic agents in Reporting (`visibilityLeverFor` returns null for unknown keys), no brand-voice editor, no top-up. |
| Brand voice / top-up assumptions | None. "Something is off" opens Support. Note: `BrandProfileModal` now pre-fills About with `client.brief` when no description exists (`client-profile-panel.tsx:257`); the panel already displayed the brief as the About fallback, so no new exposure, and it is a description field, not the voice document. |
| Stray change | `.claude/launch.json` gained `autoPort: true` and lost its trailing newline; unrelated to round 6. |

## C. Executor-declared deviations

| Deviation | Verdict | Why |
|---|---|---|
| B did not import `RosterStatusBadge` on the agent page | ACCEPT | Decision 10 removed the chip; the word is still `rosterStatus`'s, said once in the status line; an unused import is the dead code ruling 8 forbids. |
| "N days planned" not "N posts planned" | ACCEPT | A3/A4 is a standing privacy rule (no batch shape); days are what the client's calendar already shows. The approval mock was illustrative. |
| C's `?doc=…&for=…#documents` instead of the brief's spelling | ACCEPT | The brief's spelling put the params in the fragment; C's is the only working grammar. |
| E's "Not on your plan" scope (roster-derived only) | ACCEPT the widened version the integrator is building, on two conditions: Support only, and status still from `buildClientRosterEntries` (no second derivation). | Decision 7 says "every relevant agent". |
| D's default `post_count` 1 and `quoteMultiplierFrom` | ACCEPT | Decision 5 as written; `batch_size` wins where both exist, so the quote is never below the hold. |
| C's `nextSetupStep` skips blocked rows, so a client may see no accent control | ACCEPT | True statement when the next move is ours; the ladder shows status words instead. Pairs with fix 2 below so step 5 cannot become "current" over an empty archive. |

## D. Logic risks

1. **Predicate widening.** `isUpcomingCalendarItem` now counts `draft` inside 14 days. Readers that flip together: both agent rosters, the detail page status and its "Next post" facts, Reporting rows, ladder step 3, `agentUpcomingCalendarDays`. Refusals and `enabled:false` still outrank. `held`/`failed`/`published` kinds are excluded by `UPCOMING_KINDS`. The ops pre-check on attribution (risk review §F) is still required before prep.
2. **Ladder step 5 can be a dead end.** `runDone` is true once a job reaches `review`, but the asset it produced is a `draft`, which `isInClientArchive` excludes, so `newestArchived` is undefined and the current row's accent button "Open your first post" opens `?view=archive` with nothing in it (`clients/[id]/page.tsx:209,242`; `setup-ladder.ts:968`). Blocker.
3. **Step 5 regresses for existing clients.** Action 05 moved from "an output exists" to "the client opened one"; no client has a stored 05 row, so every live client's ladder comes back at 5 of 6 with "Open your first post". Approved semantics (page 02), one click clears it (the link opens the newest archived post and writes 05), but expect it on every Home the day this ships. Step 1 also flips for clients without a website (decision 2).
4. **Steps that can wait forever.** Step 2 waits while either client-tier document is missing, with a promise "Usually ready within the hour" (`setup-ladder.ts:896`) that Albert did not approve (decision 4 covered agent setup only). Step 3 waits on a non-self-serve agent until it is live. Both are Karos's, both are links, neither takes the button: correct shape, unapproved copy in one.
5. **Documents "done" changed meaning.** Existing 21/22 rows stay done (upsert, no migration); new confirmations come from "Looks right". `confirmedDocTypes` is now threaded from the settings page, so the foot does not re-ask.
6. **Badge count readers.** `notification-bell.tsx:188`, `client-rail.tsx:118` (`viewerIsClient: true`), `sidebar.tsx:595` all call `unreadNotificationCount` with the same feeds, so the three stay one number by construction.
7. **`useSearchParams` in layout-mounted client components** (`client-profile-panel.tsx`, `client-documents.tsx`). Per `node_modules/next/dist/docs/01-app/03-api-reference/04-functions/use-search-params.md:179` the build fails only for a STATIC route without Suspense; every `(app)` route reads cookies via `requireUser`, `next.config` has no `cacheComponents`/PPR, and `run-calendar.tsx` already used it under the same layouts. Low risk; if cacheComponents is ever enabled, wrap both in `<Suspense>`. The `!compact && !hideDescription` gate keeps the three profile mounts from all opening the sheet.
8. **Writes on page load.** Exactly one, by design: `/calendar?view=archive&asset=…` writes action 05 for a client on open (`run-calendar.tsx:1912`, seeded via `archive-view.tsx:157`). It also fires on EVERY archive open, an upsert each time; gate it on a `resultDone` prop or a once-per-mount ref.

## E. Efficiency and dead ends

| Surface | Reads added | In the page's `Promise.all`? |
|---|---|---|
| Home | `listPlannedScheduledRuns`, `listClientContextDocs(id,"client")` | Yes (`page.tsx:89`) |
| Reporting | `listPlannedScheduledRuns`, `listAssets` | Yes (`settings/page.tsx:100`); but `buildClientRosterEntries` (which awaits `buildAgentSetup`'s intake reads) is a third serial await at `:638`, with its own `Date.now()` rather than the page's clock |
| Agent page | none (second pass over `assets`) | n/a |
| Agents tab | none; N passes over assets for N agents (F's note) | n/a |

Dead code: none of `AgentStatusStrip`, `SchedulePaceCard`, `ClientAgentRosterCard`, `ReviewSummaryRow`, `TaskSummaryRow`, `hasOutput`, `seatSetupLinks`, `firstSentence`, `reputationBubble`, `AgentBlurb` survives outside comments; tests that name them do so as `not.toContain` pins. `roster-card.tsx` is now a one-line shim with one importer (`visibility-work.tsx:5`); point it at `./roster-row` and delete the shim. Four comments still narrate "Let's do this" (C's handoff lists them).

Empty states and static rows: bell (link to calendar), rail (link to roster), VisibilityWork (Support), ClientSuggestions (heading + sentence, static by design), run-history rows and Home attention rows now sit on dividers without the link shell, Coming Soon row greyed and unlinked, not-set-up EmptyState carries Support. The one dead end is D2.

## F. Verdict: FIX FIRST

Blockers first.

1. **Step 5 dead end.** `src/lib/setup-ladder.ts:962` (result step): give `action` only when the archive holds an item, else `waiting: true` with why "Your Karos team is reviewing your first {noun}. It lands in your Workspace once approved." Thread a `resultReady: boolean` (`Boolean(newestArchived)`) from `clients/[id]/page.tsx:242` and make the label noun-aware ("Open your first reply" for Reddit) via `agent.runLabel`. Update `setup-ladder.test.ts:716` pin.
2. **`#setup` and `#run` anchors do not exist.** `src/app/(app)/clients/[id]/agents/[agentId]/page.tsx`: add `id="run"` + `scroll-mt-24` on the wrapper that mounts `AgentDetailPanel` / `LegacyAgentPanel` / `ClientAgentLaunchCard`, and `id="setup"` on the `AgentSetupHero` mount, so `setup-ladder.ts:941,952` land on the control the approval promised.
3. **Unapproved promise copy.** `src/lib/setup-ladder.ts:896` "Usually ready within the hour": either get Albert's number (decision 4 style) or soften to "Your Karos team is writing them now." Update `setup-ladder.test.ts:134`.
4. **Action 05 written on every archive open.** `src/components/run-calendar.tsx:1912`: skip the write when the ladder already has 05 done (pass `resultDone` from the page) or guard with a once-per-mount ref.
5. **Reporting roster build is serial.** `src/app/(app)/clients/[id]/settings/page.tsx:638`: start `buildClientRosterEntries` inside the second `Promise.all` at `:291` (it needs `spendJobs`/`spendUmbrellas`; move those two reads into the first block) and pass the page's existing clock instead of a fresh `Date.now()`.
6. **Orange signalling status on Reporting.** `src/components/seo-geo-panel.tsx:664`: `text-neon` on the "Refreshing this snapshot" line becomes `text-info` (judgment scale).
7. **Second orange on the agent page.** `src/components/client-agents/agent-detail-panel.tsx:196` and `legacy-agent-panel.tsx:190`: the client coin glyph goes `text-muted-2`.
8. **Stray file.** Revert `.claude/launch.json` or commit it separately.
9. **Shim.** `src/components/seo-geo/visibility-work.tsx:5` imports from `./roster-row`; delete `roster-card.tsx`; update `agent-detail-sections.test.ts` if it pins the path.

Follow-ups for round 7, not this PR: Profile tab's two `bg-neon` saves (`client-profile-panel.tsx:519,955`) and the document panel's orange headings and glyphs (`client-documents.tsx:606,630,692,881,948`), now that the ladder lands clients there; `hover:text-neon` on unowned client surfaces (`agent-not-on-plan.tsx:69`, `intake-no-runs.tsx:44`, `task-ticket-modal.tsx:1066`, `live-card.tsx:370,487,499,564`); the "More options" toggle appearing for staff only on intake-driven agents (`custom-agents.tsx:2634`); the ops attribution pre-check before the predicate ships to prep.
