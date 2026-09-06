# Handoff from F (Agents tab roster rows) to E

Package F replaced the roster's two-column card grid with one full-width row per agent
(`src/components/client-agents/roster-row.tsx`). The row renders four new facts. F does not own
`src/app/(app)/clients/[id]/agents/page.tsx`, so **E threads them**.

Nothing here is blocking: every new field is optional and the row degrades to today's content
(mark, name, blurb, badge, verb, chevron) when it is absent. The verb, the chevron and the whole-row
link already work with no change to the page at all.

The entry type is `AgentRosterEntry` in `src/components/client-agents/roster.tsx` (not
`components/client-agents/types.ts`: that file holds `ClientAgentCardRow`, the umbrella projection,
which the roster deliberately does not use). F added the fields there and did not touch `types.ts`.

## 1. `now` on `<ClientAgentRoster>` (recommended, 2 call sites)

```
now?: number
```

The clock the row's stamps are resolved against. Optional with a `Date.now()` fallback, so the page
compiles unchanged, but pass it: every other answer on the page (the delivered-work join, the
refusal freshness window, the upcoming-content predicate) is already resolved against one `now`, and
a row printing "2d ago" against a second clock can disagree with the badge beside it.

- client branch, `page.tsx:~406`: `<ClientAgentRoster clientId={id} entries={allRosterEntries} now={now} />`
  (`now` is already in scope at `:141`).
- staff branch, `page.tsx:~823`: `now={staffNow}`.

## 2. `lastMade` per entry

```
lastMade?: { title: string; at: number } | null
```

The newest thing this agent produced that THIS viewer may see. `title` is `Asset.title`; `at` is the
viewer's own deliverable stamp. Rendered as `Founder mode · 2d ago`.

Data already on the page: `assets`, `jobs`, `umbrellas`, and the agent itself. The helper that
answers it is the one both agent pages already read, so no new Firestore read and no second
attribution join:

```ts
import { agentProducedAssets, deliverableStamp, umbrellaForAgent } from "@/lib/agent-detail-archetypes";

const produced = agentProducedAssets({
  assets, jobs,
  agent: { id: agent.id, name: agent.name, key: agent.key },
  umbrella: umbrellaByAgentId.get(agent.id) ?? null,   // umbrellaForAgent(umbrellas, agent.id) on the staff branch
  umbrellas,
  viewerIsClient: true,                                 // false on the staff branch
  now,
});
const newest = produced.reduce<Asset | null>(
  (best, a) =>
    best === null || deliverableStamp(a, viewerIsClient) > deliverableStamp(best, viewerIsClient) ? a : best,
  null,
);
const lastMade = newest ? { title: newest.title, at: deliverableStamp(newest, viewerIsClient) } : null;
```

`agentProducedAssets` runs a client viewer through `getClientArchiveAssets`, so this is the same set
the client's Workspace shows them: naming the title on the roster publishes nothing new. Do not pass
a status, a draft marker or a count (A3/A4).

That is N passes over the client's assets for N agents. If it measures badly, build the
`assetBelongsToAgent` attribution once per agent and fold in one loop rather than adding a read.

## 3. `nextAt` per entry

```
nextAt?: number | null
```

Epoch millis of the next planned DAY. Rendered as `Next Today` / `Next Tomorrow` / `Next Thu 5`.
A day and nothing else: never a title, never a count.

Precedence, both from data already in hand:

1. the earliest client-visible calendar item attributed to this agent with
   `scheduledAt` in `(now, now + 14 days]` — the same window and the same predicate
   `agentsWithUpcomingContent` uses for `hasUpcomingContent` (B owns `agent-detail-archetypes.ts`
   and is rewriting `isUpcomingCalendarItem` per think-agents §0; ask B to export a
   `nextUpcomingByAgent(...)`-shaped answer, or the earliest `scheduledAt` alongside the id set,
   rather than writing a fourth attribution join here);
2. otherwise the schedule's next fire: `scheduleByAgentId.get(agent.id)?.nextRunAt`
   (`ClientAgentScheduleRow.nextRunAt`, already built by `toScheduleRows`), only while
   `status === "active"`.

Leave it null when neither exists. A "Not set up yet" row with no next day renders an empty column,
by design: no filler text, and the columns stay aligned across rows.

## 4. `attentionReason` per entry

```
attentionReason?: "intake" | "launch" | "credits" | null
```

Which of the three fixes an attention row points at. It does NOT change the status WORD (ruling 4
keeps the seven words and `RosterStatusBadge` renders them); it decides the row's verb:

| reason | verb |
|---|---|
| `"intake"` | Set up |
| `"launch"` | Launch |
| `"credits"` | Add credits |
| absent / null | Open |

It is only read when `status.tone === "attention"` ("Needs attention" / "Setup needs attention"), so
setting it on other rows is harmless and pointless. Suggested resolution from what the page already
has:

- `"intake"` when `clientAgentSetup[agent.id]` exists and `!setup.ready` (the intake page is the fix,
  and `buildAgentSetup` is already awaited on both branches);
- `"launch"` when `umbrella?.launchState === "launch_failed"` (the press that failed is the press
  that fixes it);
- `"credits"` only if the current schedule refusal is a credits refusal. The roster deliberately does
  not read `getClientCredits` (#130), so if that cannot be answered without a new read, leave it
  unset and the row offers "Open", which is honest: the agent's own page carries the reason and the
  lever.

## 5. What F changed that E's file already compiles against

- `ClientAgentRosterCard` is deleted. Nothing imported it but `roster.tsx`.
- `RosterStatusBadge` is still a named export of `components/client-agents/roster-card.tsx`
  (that module is now a one-line re-export of the definition in `roster-row.tsx`), so B's import in
  `agents/[agentId]/page.tsx` and E's import in the Reporting section both work as the impl brief
  says. If a later pass wants the shim gone, move both imports to `./roster-row`.
- New pure helpers in `src/lib/client-agent-rows.ts`, tested in
  `src/lib/__tests__/client-agent-rows.test.ts`: `rosterRowVerb`, `rosterRunVerb`,
  `rosterRelativeStamp`, `rosterNextLabel`, and the `RosterAttentionReason` type.
