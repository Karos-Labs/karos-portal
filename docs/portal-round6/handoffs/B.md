# Handoff from package B (status truth, agent page header and status line, rail, pin)

Requests for files B does not own. Each is exact and self-contained.

## 1. `components/client-rail.tsx` (A) and `components/sidebar.tsx` (unowned): drop `clientId` from `<ClientRailAgentsNav>`

The rail's agents block no longer pins anything (the stars are gone; pinning is the agent
page's `AgentStarButton`), so `clientId` is no longer read. It is still ACCEPTED as an
optional prop in `client-rail-agents-nav.tsx` purely so these four mounts keep compiling:

- `src/components/client-rail.tsx:184` and `:297`
- `src/components/sidebar.tsx:827` and `:1010`

Delete the `clientId={...}` line at each of the four, then delete the
`clientId?: string` member from `ClientRailAgentsNav`'s props (the last block in that
type, with the comment pointing at this file). Nothing else changes.

## 2. `components/client-agents/roster-card.tsx` (F): `RosterStatusBadge` export

B needs no import of it after all — see the note below — but E does (think-reporting §2B),
so please keep the named export as the impl brief says.

**B did NOT import it, deliberately.** The brief asked B to delete the page's duplicated
`StatusBadge` and import `RosterStatusBadge` in its place. The chip it rendered is gone
under decision 10 (the header no longer states the status; the new 13px status line does,
with a tone dot and sentence case), and `Badge` is a mono uppercase 10px pill — so an
imported `RosterStatusBadge` would have had no call site on that page. Importing it unused
would be the dead code §1.8 forbids. `StatusBadge` is deleted; the agent detail page now
renders no status chip at all, and `agent-detail-sections.test.ts` pins that
(`expect(src).not.toContain("StatusBadge")`).

## 3. `components/client-agents/live-card.tsx` (unowned): one `hover:text-neon` left

`src/components/client-agents/live-card.tsx:185` still has
`text-foreground hover:text-neon` on a template title. Rule 3 says quiet text links hover
muted to foreground with an underline and `hover:text-neon` is not a rule. The file is in
no package, so B left it; it wants the same treatment as the links B changed.

## 4. Two comments in E's files now describe the old `lastRunFailed` rung

Both are accurate about the fact and stale about the mechanism, and both are one sentence:

- `src/app/(app)/clients/[id]/agents/page.tsx` ~:502 — "The rung the client's branch skips.
  This is the surface it was written for: a green badge above a run history whose last row
  reads Failed." There is no rung: `viewerIsStaff: true` now only adds the `Internal`
  sentence. Also, just below, "`status.staffNote` is set only on the rung that creates the
  discrepancy, so on every other agent this line adds nothing" — it is now also set for a
  failed last run, which is exactly what that note wants to show a staff reader, so the join
  is right and only the sentence needs updating.
- `src/lib/client-roster.ts` ~:226 — "`viewerIsStaff` is false, so the rung is skipped
  (AF-14)". Same correction: what it skips is the `Internal` sentence, not a word.

## 5. Note for C: `rosterStatus`'s inputs did not change shape

Ladder step 3 can call `rosterStatus(...)` exactly as the agent pages do. What changed
inside it (round 6): `lastRunFailed` no longer moves the WORD for any viewer — with
`viewerIsStaff` it appends `LAST_RUN_FAILED_STAFF_NOTE` to `staffNote` and nothing else —
and `hasUpcomingContent` now counts client-visible drafts inside a 14-day ceiling
(`agentsWithUpcomingContent`, unchanged signature). Live is still
`rosterStatus(...).tone === "live"`.
