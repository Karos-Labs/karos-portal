# Handoff from E (Reporting, Seats, notifications, roster extraction)

Package E has landed. Nothing below blocks E; each item is a change in a file E does not own, or a
note for the verifier about a boundary E crossed deliberately.

## 1. For A — move `MeasurementStamp` under the tiles (`components/seo-geo-panel.tsx`)

think-reporting §3 move 1, and the only part of the Reporting ORDER that lives outside E's files.
In `SeoGeoScores`, `<MeasurementStamp view={measurement} />` currently renders ABOVE the tile grid:

```
<MeasurementStamp view={measurement} />
<div className="grid grid-cols-1 gap-4 @xl:grid-cols-2 @4xl:grid-cols-3">   ← the tiles
```

Move the stamp BELOW that grid. It reads as the caption of the numbers rather than a preface to
them, which is the parent's stated order for the tab. The legacy-snapshot banner stays ABOVE the
tiles: it qualifies the numbers before they are read.

E's `seo-geo-mounting.test.ts` pins the tab's section order (`<SeoGeoScores` < `{visibilityWork}` <
`{visibilityPanel}` < `<ClientSuggestions`) and says nothing about the inside of `SeoGeoScores`, so
this move needs no test change from E.

## 2. `flow-audit-undo-and-rows.test.ts` — settled, nothing owed

E rewrote the three R10 assertions in that file that were about the bell (see §3). Its fourth
failure was C's — R8's "an inert row must not wear the shell of a link", measured against
`home-task-row.tsx`, whose ladder rows are whole-row links now — and C has since landed the
matching pin. The file is green as of this handoff: `npx vitest run
src/lib/__tests__/flow-audit-undo-and-rows.test.ts` → 22 passed. Recorded because that file is in no
package's ownership list, so two packages edited it and neither owns it.

## 3. Test files E touched that no package owns

Both pin behaviour E removed, and both test only files E owns (`lib/notification-rows.ts`,
`components/notification-bell.tsx`), so leaving them red would have left the suite red with nobody to
fix it (ruling 8: delete the tests of removed behaviour). Every changed assertion carries a
"round 6:" comment.

- `lib/__tests__/client-review-feed-grain.test.ts` — the client review feed returns NO rows now, not
  one summary row; the badge moves by zero for a client; the `ReviewSummaryRow` render test is gone
  with the component. The file's central question is unchanged in shape: the assertions still hold at
  every batch size and on both sides of the payload bound `data.ts` keeps.
- `lib/__tests__/flow-audit-undo-and-rows.test.ts` — three R10 assertions (the client task feed, the
  badge count, the summary line's shape). The fourth failure is C's, see §2.

E also repaired one pin in its OWN `settings-nav.test.ts` that C's change had broken:
`BrandProfileModal`'s `useState` initialiser now reads `client.description ?? client.brief ?? ""`,
so the assertion asks for the three KEYS rather than one frozen initialiser string.

## 4. What E threaded for F (F.md items 1 to 4) — all four, both branches

- `now` on both `<ClientAgentRoster>` mounts (`now={now}` client, `now={staffNow}` staff).
- `lastMade`, `nextAt` and `attentionReason` per entry, resolved through the helpers F named:
  `agentProducedAssets` + `deliverableStamp` for the newest produced item, and B's
  `agentUpcomingCalendarDays` for the next planned day (which landed while E was working, so
  precedence 1 did NOT need a fourth attribution join — F's fallback to the schedule's `nextRunAt`
  is the second rung, gated on `status === "active"`).
- `attentionReason` resolves `"intake"` and `"launch"` only. `"credits"` is never returned: the
  roster deliberately does not read `getClientCredits` (#130), so a credits refusal leaves the row
  offering "Open", which F's own note says is the honest fallback.
- The client branch's copies live in `lib/client-roster.ts` (E's new module), the staff branch's in
  `agents/page.tsx`. Both read `viewerIsClient` correctly for their reader.

## 5. New exports other packages may want

- `lib/client-roster.ts` · `buildClientRosterEntries({ clientId, client, viewerIsClient, now, data })`
  → `ClientRosterEntry[]` (= `AgentRosterEntry` + `granted`, `agentKey`, `agentName`, `enabled`).
  `data` is required and holds the five reads the caller already has (`allAgents`, `jobs`,
  `plannedRuns`, `umbrellas`, `assets`), so no surface pays for them twice. Anything that needs the
  client's roster status must call this rather than assemble `rosterStatus`'s inputs again.
- `lib/visibility-levers.ts` · `visibilityLeverFor`, `citationDomainFor`, `visibilityWorkBand`,
  `sortVisibilityWorkRows`, `NO_LEVER`, `VISIBILITY_WORK_STANDFIRST`. Pure, client-safe.
  **Adding an agent to `product-mapping.ts` or a new `*_KEY` to `custom-agent-launch.ts` now fails
  `visibility-levers.test.ts`** until it has a sentence or a `NO_LEVER` entry. That is the point.

## 6. Two notes for the verifier

- **`Button variant="outline"` as a Link.** `ui.tsx`'s `Button` is a `<button>` and has no `asChild`,
  and a `<button>` inside an `<a>` is invalid markup. `visibility-work.tsx`'s "Open {agent}" control
  is therefore a real `<Link>` carrying `Button`'s own `outline` recipe (plus `focus-ring`), written
  out once with a comment naming its source. If A ever exports a `buttonClasses(variant, size)`
  helper from `ui.tsx`, this call site should use it.
- **"Not on your plan" reaches a row only through `granted: false`.** The section lists the roster's
  own agents, and the reachable un-granted case is an agent that has DELIVERED work for this client
  without the grant ever being written — which is exactly the row that cannot be opened
  (`agents/[agentId]/page.tsx` gives a client `notFound()`), so it gets Support instead of a link.
  E did not add a second source of catalogue rows for agents the client has never had: that would
  mean `buildClientRosterEntries` returning entries the Agents page must then filter out, and the
  brief's contract is that it returns "the same entries the agents page renders today". If Albert
  wants the full catalogue advertised there, it is one more read and a widened return, not a change
  to this section's rendering.
