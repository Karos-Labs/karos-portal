# Handoff from package D (Create a post dialog)

Nothing here BLOCKS another package: D landed entirely inside the files it owns
(`components/custom-agents.tsx`, `lib/custom-agent-launch.ts`,
`components/agent-input-files.tsx`, plus the two test files that pin them).
`lib/credits.ts` was not touched: the per-post quote needed no new pricing
helper, only a multiplier read, and that lives in `custom-agent-launch.ts`.

## 1. Offered, not required: one label helper for the run control (B and F)

`runActionLabel(agent)` is now exported from `src/components/custom-agents.tsx`:

```ts
export function runActionLabel(agent: Pick<RunnableAgentSummary, "key" | "name">): string
// "Create post" | "Create clip" | "Draft reply"
```

It is `OUTPUT_NOUN[agentArchetype({ key, name })]` with the reply case reading
"Draft reply". The dialog title and its confirm both use it, so if F's roster
verb ("Create post", noun-aware) and B's trigger derive the noun the same way
(either by importing this or by asking `agent-archetype.ts` directly, which is
where the noun actually lives), the three surfaces cannot drift. Do NOT add a
fourth regex over the agent key.

## 2. What D changed that touches copy other packages quote

- The dialog's confirm and title now say `runActionLabel(agent)`, never "Start
  run". `src/lib/__tests__/run-dialog-setup-gate-copy.test.tsx` had a pin on
  "Start run"; it is inverted with a "round 6:" comment.
- `post_count` ("Number of posts", the Instagram/TikTok content system) defaults
  to **1**, not 3. Any surface that describes a fresh run as producing three
  posts is now wrong. `defaultRunBatchSize` is unaffected (it reads `batch_size`
  only), so the agent page's band price and the fresh dialog's footer still
  quote the same number.
- The Instagram/TikTok profile's `request` label is now "What should this post be
  about?" (was "Content goal or campaign").

## 3. One accent left inside this dialog, deliberately

`grep 'variant="accent"' src/components/custom-agents.tsx` returns three hits,
none in the client run pane: two are the admin editor's save buttons, one is the
schedule dialog. The run dialog's DATA pane still has
`variant={continueToRun ? "accent" : "subtle"}` on "Continue to the run" - that
pane is staff-only by construction (the intake panes are prefetched only on the
staff branch of the agent detail route, so `intake` is null for a client), it is
mutually exclusive with the run pane's footer, and it is the one control that
moves the reader forward. If the round-6 verifier rules zero accents in this
file, that is the line to change.

## 4. For package A (`components/modal.tsx`, read-only for D)

D uses the existing `footer` slot as: one `text-xs text-muted` middot line on the
left, ghost Cancel + primary confirm on the right. The slot's top hairline is
enough; if A gives the footer a background band, this dialog will grow a band it
does not want.
