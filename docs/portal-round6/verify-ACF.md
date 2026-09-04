# Verification: packages A, C, F (read-only, 2026-09-04)

Working tree at time of check; an integrator is editing concurrently, so a few items moved
under the review (`buttonClass`, `ArchiveTile`) and are recorded at their CURRENT state.
No `handoffs/INTEGRATION.md` exists.

## 1. Acceptance criteria

### §3.A — primitives and the interaction sweep

| Criterion | Result | Evidence |
|---|---|---|
| `Card` has no hover styles | PASS | `src/components/ui.tsx:109` — only `transition-colors duration-200`; `hover:border-border-strong` / `hover:shadow-[var(--shadow-2)]` gone |
| `Button` has no translate or shadow bloom | PASS | `src/components/ui.tsx:31-40` (`BUTTON_VARIANTS`) — `primary: hover:bg-primary/90`, `accent: hover:bg-neon-bright`, no `-translate-y`, no `shadow-` |
| `.focus-ring` exists | PASS | `src/app/globals.css:288-291`; token `--focus: var(--foreground)` at `:82` |
| applied by Button / Input / Textarea / Select / TabButton | PASS | `ui.tsx:29` (BUTTON_BASE), `:143`, `:157`, `:171`, `:316` |
| `grep -rn "outline-none" src/components/ui.tsx` → only lines that also apply `.focus-ring` | PASS | one hit, `ui.tsx:123`, inside a comment |
| Home's orange = ladder button, progress fill, row-lift, bell badge, nothing else | PASS | only `bg-neon` on a Home surface is `home-get-set-up.tsx:145` (progress fill); the ladder control reads `buttonClass({variant:"accent"})` (`home-task-row.tsx:31`); sparkline `home-kpis.tsx:40` → `var(--foreground)`; meters `home-standing.tsx:65-67` → `bg-foreground` on `bg-muted-3/20`; three icon chips demoted (`home-kpis.tsx:369`, `home-standing.tsx:166`, `client-home-overview.tsx:457`) |
| reduced-motion covers transition-duration | PASS | `globals.css:457-471` |
| `#presence` / `#share` anchors | PASS | `seo-geo-panel.tsx:701`, `:739`, both `scroll-mt-24`; `reportHref` carries no fragment (`clients/[id]/page.tsx:349`) |
| presenter takeaways rewritten | PASS | `seo-geo/presenter.ts` |

### §3.C — setup ladder and landings

| Criterion | Result | Evidence |
|---|---|---|
| `home-recommended-tasks.test.ts`, `action-list.test.ts`, `setup-ladder.test.ts` green | PASS | `npx vitest run` — 208 passed, 0 failed across the three |
| no string "Let's do this" remains in `src/` | PASS (rendered) | 5 hits, all comments/test narration: `agents/page.tsx:87`, `agents/[agentId]/page.tsx:214`, `task-kickoff-strip.tsx:37`, `lib/task-kickoff.ts:5`, `home-recommended-tasks.test.ts:11,46` |
| the ladder never renders two `accent` buttons | PASS | `home-get-set-up.tsx:197-205` passes `start` only for `step === next`; `nextSetupStep` (`setup-ladder.ts:1006`) returns one step |
| step 0 has no href | PASS | `setup-ladder.ts:881-889` |
| decision 4 waiting copy | PASS | `setup-ladder.ts:917-919` |
| decision 9 (done once, cooldown gone) | PASS | `clients/[id]/page.tsx:648-652` — `ACTION_DISMISS_COOLDOWN_MS` no longer read for the ladder |
| landings `?edit=`/`?doc=`/`?for=`/`?asset=` read and cleaned | PASS | `client-profile-panel.tsx:599-600`/`:47-54`, `client-documents.tsx:1067-1079`, `run-calendar.tsx:1922-1929`, `calendar-view-modes.ts:76-89` |

### §3.F — Agents tab rows and setup hero

| Criterion | Result | Evidence |
|---|---|---|
| `client-agent-rows.test.ts` green | PASS | 61 passed |
| no `hover:-translate`, `shadow`, `text-neon` in F's components | PASS | one `shadow` hit, `roster-row.tsx:183`, inside a comment |
| `RosterStatusBadge` still exported from `roster-card.tsx` | PASS | `roster-card.tsx:12` re-export; consumed by `agents/[agentId]/page.tsx` and `seo-geo/visibility-work.tsx` |
| full-width row, `min-h-[64px]`, whole row one `<Link>`, one static chevron, `row-lift` + `focus-ring` | PASS | `roster-row.tsx:179`, `:185`, `:196-199`, `:172-174` |
| verb table matches the handoff | PASS | `client-agent-rows.ts:169-195` |
| Coming Soon = no link, no chevron, greyed | PASS | `roster-row.tsx:188-194` |
| setup hero: no placeholder frame unless `previewVideoUrl`; accent kept | PASS | `agent-setup-hero.tsx:55-61`, `:69`; hero is mutually exclusive with the rest (`agents/[agentId]/page.tsx:1263`) |
| Agents tab renders no orange for a client | PASS | no `bg-neon`/`text-neon`/`variant="accent"` in `agents/page.tsx`, `roster*.tsx`, `task-kickoff-strip.tsx`, `visibility-work.tsx` |

## 2. Findings

### Blockers

| Finding | file:line | Fix |
|---|---|---|
| `interaction-primitives.test.ts` FAILS. The `buttonClass` extraction hoisted the recipe to module scope as `BUTTON_VARIANTS`/`BUTTON_SIZES`, so the test's `UI.indexOf("const variants")` returns -1 and it slices an empty string — the two `not.toContain` assertions pass VACUOUSLY and the two positives fail. | `src/lib/__tests__/interaction-primitives.test.ts:110-111` | Slice from `const BUTTON_VARIANTS` to `const BUTTON_SIZES` and assert the index is `> -1` |

### Should-fix

| Finding | file:line | Fix |
|---|---|---|
| Rule 3 on a touched client-facing surface: the calendar's empty-state CTA is a hand-rolled accent Link with `transition-all duration-200 hover:-translate-y-0.5`. It is the exact "Link styled as a Button" site `buttonClass` now exists for, and no package owns the line. | `src/app/(app)/calendar/calendar-body.tsx:907` | `className={buttonClass({ variant: "accent" })}` |
| Rule 3: `ArrowRight` after a button/link label on a client-facing calendar row ("Review deliverable"), both branches. | `src/components/run-calendar.tsx:1172`, `:1177` | Drop the glyph (rule 3); `REVIEW_BUTTON_CLASS` keeps the voice |
| Rule 3 + ruling 2: an orange text link with a trailing `ArrowRight` on the client's agent page ("See all in your Workspace"). Unowned by any package. | `src/components/client-agents/live-card.tsx:369-374` | Quiet link (`text-muted` → `text-foreground` + underline), `focus-ring`, no glyph |
| Ruling 2: orange signals STATUS. The "Refreshing this snapshot now" line on the Reporting tab is `text-neon`; the judgment scale (`info`) is the rule and the band two lines below already uses it. | `src/components/seo-geo-panel.tsx:660` | `text-info` (or `text-muted`) |
| C's handoff to E is unapplied: `confirmedDocTypes` is not passed to `<ClientDocuments>`, so `DocConfirmFoot` renders `confirmed={false}` on every load. A client who pressed "Looks right" is asked "Does your Brand Voice describe you?" again while the ladder row beside it is ticked, and a second press rewrites the same row. | `src/app/(app)/clients/[id]/settings/page.tsx:397` (mount), consumed at `src/components/client-documents.tsx:1121` | Pass `confirmedDocTypes={contextDocConfirmations}` built from `listClientActionStates(id)` ids 21/22/23 |
| Rule 3: a bordered chip-shaped `<Link>` (credits) with no hover treatment, no fill step and no chevron — a link wearing a static box's shell. | `src/components/client-rail.tsx:252-255` (and the twin at `:279`) | Add `hover:bg-surface-2` (fill-only, the border is drawn) or drop the border |
| Rule 3, unowned: the run dialog's archetype/agent picker card still lifts and blooms (`hover:-translate-y-0.5 hover:border-border-strong hover:shadow-lg`) — a client-facing surface, package D's file. | `src/components/custom-agents.tsx:974` | `row-lift` + `focus-ring`, no lift, no shadow |

### Nits

| Finding | file:line |
|---|---|
| Efficiency: `buildClientRosterEntries` calls `agentProducedAssets` once per agent, and each call re-runs `getClientArchiveAssets` over the client's whole asset history — O(agents × assets). F's handoff §2 predicted this and named the fix (build the attribution once, fold in one loop). No new Firestore read, so it is latency only. | `src/lib/client-roster.ts:246` |
| `useUndoableDismiss` / `HomeTaskUndoRow` / `UNDO_WINDOW_MS` have no mount (the ladder deliberately has no skip). Pre-existing, documented, and pinned by `flow-audit-undo-and-rows.test.ts:66-68`, so not a round-6 regression — but it is ~140 lines of unreachable client code plus its test. | `src/components/home-task-row.tsx:41-239` |
| `HomeTaskRow`'s `dismiss`, `meta`, `error` and `busy` props have no caller now that the ladder is the only reader. | `src/components/home-task-row.tsx:274-295` |
| Decision 3 says "opens Support with the document named"; the document's name is in the sentence beside the trigger, not carried into the dialog. Defensible (R7: Support is the one word), worth a ruling. | `src/components/client-documents.tsx:801-808` |
| `markActionDoneAction(clientId, "05")` fires on every archive modal open, not only the first. Harmless (upsert), one extra write per open. | `src/components/run-calendar.tsx:1928` |

## 3. Rule 3 sweep, per touched client-facing surface

Clean: `home-kpis.tsx` (static chevron, `focus-ring`, grey eyebrow), `home-standing.tsx`
(both cells whole-cell links + chevron + `focus-ring`; empty tile gained both; quiet link
lost its chevron), `home-calendar-preview.tsx` (`focus-ring` on rows, `OUTLINE_LINK_CLASS`
on the empty CTA, trailing chevron dropped), `client-home-overview.tsx` (inert twins at
`:519` and the attention rows now drop the border and sit on a divider; hints render as
text, `title=` gone), `home-task-row.tsx` (link branch vs static branch, mutually
exclusive by construction, `:337`), `roster-row.tsx`, `archive-view.tsx:524` (tile now
`focus-ring row-lift`, lift and shadow gone), `rail-nav-link.tsx`, `modal.tsx`,
`seo-geo/{disclosure,flag-button,gap-list,score-popover}.tsx`, `client-profile-panel.tsx`,
`client-documents.tsx`, `here-for.tsx`. No `outline-none` without `.focus-ring` in any
file the three packages own. Exceptions are the six should-fixes above, none of which any
package owns.

## 4. Parity

PASS. The only viewer-conditional lines added across A/C/F are
`clients/[id]/page.tsx:527` (`viewerIsStaff: false` — deliberately identical on both
branches, per ruling 1) and `:600` (`calendarBase`, a route rewrite, not a layout branch).
No new `StaffOnlySection`, no new status word per viewer. `roster-row.tsx`'s `note` /
`notGranted` are the pre-existing additive `Internal` idiom.

## 5. Dead code / dead ends

- `ClientAgentRosterCard`: deleted, zero references. `roster-card.tsx` is a one-line
  re-export, which §3.F sanctions.
- `hasOutput`: gone from `ActionSignals` and `computeActionDone`; only comments and two
  negative test pins mention it.
- `ACTION_DISMISS_COOLDOWN_MS`: still live for the checklist rows (`action-list.ts:414`),
  correctly no longer read by the ladder.
- Star machinery: intact by design (Pin on the agent page, order in the rail).
- Dead ends: every ladder row either links or is visibly static (`home-get-set-up.tsx:197-227`);
  step 0 and the docs-being-written wait carry no href and no hover; the roster's empty
  state carries a Support action (`agents/page.tsx:273`); `ClientAgentRoster` returns null
  rather than rendering an empty shell.

## 6. Logic spot-checks (item 9)

All four decisions and §2.11 hold. Profile = category + description + website, each named
(`clients/[id]/page.tsx:392-400`, `setup-ladder.ts:790`). Voice = per-document "Looks
right", `waiting` while `present` is false (`setup-ladder.ts:864-910`). Agent = `hasIntake`
and `standUpDone` separately, `live` from `rosterStatus(...).tone === "live"`
(`page.tsx:519-548`, `setup-ladder.ts:625`). Run = `review|approved|delivered`
(`page.tsx:387-389`). Result = event-tracked action 05 (`action-list.ts:317-327`).
The ladder cannot render two accent controls; the completion state does not return
(`page.tsx:648`).

## 7. Efficiency

PASS. Both new reads joined the existing `Promise.all` (`clients/[id]/page.tsx:101-175`:
`listPlannedScheduledRuns`, `listClientContextDocs`); E's two Reporting reads joined
`settings/page.tsx:209`. `agentsWithUpcomingContent` runs once per page on the client
branch. `rosterStatus` is the single "live" source for the ladder, the roster, the agent
page and Reporting. The one remaining duplication is the per-agent
`agentProducedAssets`/`getClientArchiveAssets` pass in `client-roster.ts` (nit above).

## 8. Staff-app regression risk from `ui.tsx` (item 10, not fixed)

1. **`Card` lost its hover in 61 files.** Only ONE site has a `Card` as a link target
   (`clients-grid.tsx:540`) and it restores the hover on its own className, so nothing
   loses an affordance. Everything else was decorative. Risk: cosmetic only, on
   `/admin/*`, `/jobs`, `/team`, `/dashboard`, `/agents`, `/transcripts/[id]`.
2. **`primary` lost its RESTING shadow** (`shadow-[0_8px_22px_-8px_...]`), not just a
   hover one. Every primary button in the staff app is now flat. Deliberate per rule 2,
   but it is a global visual change beyond "the hover no longer moves" and deserves a
   screenshot pass.
3. **`transition-all duration-200` → `transition-colors duration-150`.** Any call site
   that added a non-colour hover through `className` would now snap. Grep found none, so
   no live consumer is affected.
4. **`focus-visible:ring-foreground/25` → `.focus-ring` outline.** Focus is now a 2px ink
   outline with a 2px offset instead of an inset ring, so it can overlap tight
   staff-toolbar layouts (`more-actions-menu.tsx`, `agents/run-attachments.tsx` still
   carry the old recipe alongside and will show both).
5. **Trailing glyphs after button labels persist** on staff surfaces A does not own —
   `admin/ops/page.tsx:113`, `agents/page.tsx:111`, `signup/page.tsx:241,374`,
   `onboarding-wizard.tsx:242,289`, `client-analytics.tsx:242`, `chatbot-widget.tsx:890`.
   Out of scope for round 6 (client-facing only), listed for the sweep.
