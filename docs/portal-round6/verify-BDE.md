# Round 6 verification: packages B, D, E (read-only)

Worktree `claude/portal-round6`, uncommitted. `npx tsc --noEmit` clean. Every acceptance test
file named in §3.B / §3.D / §3.E green (20 files, 635 tests, run individually). No
`handoffs/INTEGRATION.md` exists.

## 1. Acceptance criteria

| § | Criterion | Verdict | Evidence |
|---|---|---|---|
| B | `agent-detail-archetypes.test.ts` + `client-agents.test.ts` green | PASS | vitest, 2 files green |
| B | status word identical for `viewerIsStaff` true/false | PASS | `client-agents.ts:893` `statusWord` takes the same input; `viewerIsStaff` reaches only `staffNote` (`:886-890`) |
| B | `grep text-neon` rail + star empty | PASS | both files clean; `agent-star-button.tsx:64-67` pinned ink |
| D | `custom-agent-launch` tests green | PASS | no file of that name; `agent-launch-ui.test.ts`, `run-dialog-setup-gate-copy.test.tsx`, `agent-library-launch-price.test.tsx` green |
| D | "No reference files" gone for the client branch | PASS | `agent-input-files.tsx:212-225` (`canUpload ? … : null`); mount is staff-only, `custom-agents.tsx:3024-3042` |
| D | no `variant="accent"` in the client dialog | PASS | 4 hits: `:2027` schedule modal, `:2832` staff data pane (`panes` is `undefined` for a client, `[agentId]/page.tsx:393-400`), `:3203`/`:3460` admin editors |
| E | five test files green | PASS | seo-geo, client-suggestions, mounting, settings-nav, notification-bell-shell |
| E | GEO-04/27/35/11 only in the plan catalogue | PASS | `seo-geo.ts:1325,1333-1335` REC_COPY, `:862` registry, `:1180/1196/1214` gap production; `CLIENT_SUGGESTION_COPY` holds three ids only (`:1594-1608`) |
| E | `grep "Seats"` in settings page empty | PARTIAL | 5 hits, all the LinkedIn OAuth `EmployeeSeat` (`:22,:328,:734`) that §4 keeps, plus the removal comment `:367-374`. Card, `seatSetupLinks`, `listClientSeats`, `ClientSeat` all gone; absence pinned `settings-nav.test.ts:320-336` |
| E | no `hover:text-neon` in E's files | PASS | only a prose mention, `settings/page.tsx:873` |

## 2. The predicate

PASS. `agent-detail-archetypes.ts:414-418`: launch and test excluded, `scheduledAt > now +
UPCOMING_WINDOW_MS` excluded, then `isUpcomingPost` (`calendar-kind.ts:131-135`) which requires
`scheduledAt > now` and a kind in {scheduled, placeholder, draft}. Nothing past-dated counts;
`failed`/`held` are excluded by kind. The dropped `isClientCalendarStatus` was already `return
true` (`calendar-kind.ts:206`), so removing it changed nothing. Test pin inverted with a "round
6:" comment at `agent-detail-archetypes.test.ts:728-736`, plus a ceiling pin `:738-748`.

One function, four readers: roster → `client-roster.ts:146` (`agents/page.tsx:170`), detail page
→ `[agentId]/page.tsx:510`, Reporting → `settings/page.tsx:602` calling
`buildClientRosterEntries`, ladder → `clients/[id]/page.tsx:518` + `rosterStatus(...)` at `:529`.
Staff branch calls the same viewer-independent `agentsWithUpcomingContent`
(`agents/page.tsx:432-439`).

## 3. Parity

PASS. `statusWord` is viewer-independent by construction; `viewerIsStaff` can only append
`staffNote`. Staff extras are `Internal`-badged: `roster-row.tsx:132`, `agents/page.tsx:693`,
status line `agent-sections.tsx:166-172`, dialog `custom-agents.tsx:2665`. No layout-changing
viewer branch in the dialog, status line, rail, Reporting (`viewerIsClient: true` for both
readers, `settings/page.tsx:605`) or the bell. Residual, pre-existing: `hasDelivered` still comes
from `agentsWithDeliveredWork` with a per-viewer `viewerIsClient`, so the client archive window
can still move that one rung.

## 4. Orange

Agent detail page: exactly one `variant="accent"` can render — `needsSetup ? AgentSetupHero
(:69) : (AgentDetailPanel :211 | LaunchCard :149 | LegacyAgentPanel :202 | EmptyState)`,
`[agentId]/page.tsx:1263-1330`. The `?task=` kickoff strip is now `primary`
(`task-kickoff-strip.tsx:129`). Client dialog, Reporting, bell body: no accent. Pin button and
rail: no `text-neon`. Exceptions below.

## 5-9

Rule 3: compliant on the touched surfaces (chevrons static and `text-muted-2`, `focus-ring`
added, `ArrowRight`/`→` after labels removed, `row-lift` on bordered rows, "Adjust pace" a quiet
text control). Exceptions below. Copy: no em dashes or spaced hyphens in any added string;
"about N credits" via `estimatedCreditsLabel` and "N credits" flag-off (`credits.ts:437-458`);
Reddit noun is "reply" (`agent-archetype.ts:129`); Support is the only help word; heading exact
(`visibility-work.tsx:72`); the three suggestion entries and every lever sentence match
think-reporting §1/§2B verbatim. Dead code: `StatusBadge`, `SchedulePaceCard`'s aside, the rail
star machinery, `ReviewSummaryRow`/`TaskSummaryRow`, Seats card + read + `seatSetupLinks`,
`reputationBubble`, four `CLIENT_SUGGESTION_COPY` entries, the `REC_COPY` fallback and
`firstSentence`, the dialog eyebrow/estimate badge/blurb — all gone, all with absence pins.
Efficiency: the two new reads are in the existing `Promise.all` (`settings/page.tsx:219-221`);
`buildClientRosterEntries` takes `data` and re-reads nothing; `nextAt` reuses
`agentUpcomingCalendarDays` (`client-roster.ts:270`), no fourth join; `unreadNotificationCount`
sums the same two builders the panel renders (`notification-rows.ts:200-206`). Price: quote =
`agentRunCost × quoteMultiplierFrom` = `batch_size ?? post_count ?? 1`
(`custom-agent-launch.ts:1765-1767`); the submit still sends `batchSizeFrom` only
(`custom-agents.tsx:2606-2608`).

## Findings

| Finding | Severity | file:line | Fix |
|---|---|---|---|
| Bell trigger has `focus-visible:outline-none` + an orange ring, no `.focus-ring` — rule 3 names this a bug | should-fix | `notification-bell.tsx:264` | replace the three utilities with `focus-ring` |
| Bell's `variant="row"` trigger has no focus treatment at all | should-fix | `notification-bell.tsx:243-247` | add `focus-ring` |
| Client-reachable pace modal (opened by B's new "Adjust pace") paints an orange band, an orange price and an `accent` Save over the page's own accent | should-fix | `custom-agents.tsx:2122,2125,2027` | band → `border-border bg-surface-2`, price → `text-foreground`, Save → `primary` |
| Two `text-neon` coin glyphs still render for a client beside the page's accent CTA (rule 2: icon chips ink or grey) | should-fix | `legacy-agent-panel.tsx:190`, `agent-detail-panel.tsx:196` | drop the `viewerIsClient` branch, use `text-muted-2` |
| AF-5 fires on any `idle` tone, so an agent with future drafts and no umbrella, schedule, delivered work or intake now reads "Live" above `AgentSetupHero`'s "it starts producing for you" | should-fix | `client-agents.ts:900-903` vs `[agentId]/page.tsx:918` | require `hasDelivered \|\| readyToRun` for the AF-5 promotion, or exclude it when `needsSetup` |
| `buildClientRosterEntries` is awaited serially after the `Promise.all` and internally fires `buildAgentSetup`'s per-agent intake reads, so Reporting adds a serial read wave beyond the two parallelised reads | should-fix | `settings/page.tsx:601-616`, `client-roster.ts:164` | start the call inside the same `Promise.all` (its five inputs come from the two earlier waves) or pass a prebuilt setup map |
| Predicate widening: every client with imported future drafts inside 14 days flips to "Live" at once, including `launchState: "not_launched"` umbrellas | should-fix (logic risk) | `agent-detail-archetypes.ts:414` | run think-agents §0's attribution query on production before merge |
| Reporting discards `lastMade`/`nextAt`, which `buildClientRosterEntries` computes per agent | nit | `settings/page.tsx:655-670` | optional `include` flag, or accept the cost |
| Archive link hovers `muted → foreground` with no underline (rule 3's quiet link) | nit | `[agentId]/page.tsx:1500` | add `hover:underline` |
| Staff bell empty state has no control ("Open your calendar" is client-only) | nit | `notification-bell.tsx:316-325` | staff already have footer links when rows exist; consider a `/jobs` link |
| Stale comments still describe rail stars after B removed them | nit | `client-rail.tsx:64`, `sidebar.tsx:118` | reword |
| `hover:-translate-y-0.5 hover:shadow-lg` on the agent-library card (staff surface, D's file) | nit | `custom-agents.tsx:974` | drop lift and bloom |
