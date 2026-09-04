# Integration pass (round 6, 2026-09-04)

The single-writer pass after packages A to F landed. Every handoff item, both red tests, the
approved decision-7 gap, and the portal-wide rule-3 sweep. Final state:
`npx tsc --noEmit` clean · `npx vitest run` **345 files passed, 1 skipped · 5714 tests passed,
7 skipped, 0 failed** · `npx eslint` clean on every file touched here.

---

## 1. The two red tests

### `callback-prop-wiring` — `onConfirm` reported dead

Not actually dead: `client-documents.tsx` DID pass it, but through the conditional-spread idiom
`{...(clientId && actionId ? { onConfirm: … } : {})}`, and the scan only sees a real JSX
attribute (`name={…}`). A channel that is wired in a shape the guard cannot read is one edit away
from being a channel that is not wired, so the call site was straightened rather than the guard
loosened. `exactOptionalPropertyTypes` is off in this repo's tsconfig, so `onConfirm={undefined}`
is legal and the spread bought nothing:

- `client-documents.tsx:~1104` — `onConfirm={clientId && actionId ? () => {…} : undefined}`.
- `client-documents.tsx:~708` — `<DocConfirmFoot … onConfirm={onConfirm} />` (the inner forward,
  which the scan correctly does not count as a caller).

No test change.

### `health-banner-wired` — one gated render instead of two

**Not a regression for clients.** Both mounts are present in `agents/page.tsx`; E's rewrite of the
gate's arguments (`liveEntries.map((e) => e.agentKey)`) made the call multi-line, which collapsed
the client branch's JSX to `) && <EngineHealthBanner viewerIsClient />` — no parens, so the test's
`&& (\n<EngineHealthBanner` shape stopped matching. The client still saw the banner.

Restored the parenthesised shape at the client branch (`agents/page.tsx:~255`) so it reads
identically to the staff branch at `:~649` and the pin's "one banner, two registers" split stays
exact. No test change (the pin was right; the source had drifted from it). There is no Prettier in
this repo, so nothing will re-collapse it.

## 2. Handoff B.1 — `clientId` off `ClientRailAgentsNav`

Dropped `clientId={…}` from all four mounts (`client-rail.tsx` ×2, `sidebar.tsx` ×2) and deleted
the `clientId?: string` member (and its comment) from the component's props.

## 3. Handoff B.3 — `hover:text-neon` in `live-card.tsx`

The template title's disclosure button: `text-foreground hover:text-neon` →
`text-muted underline-offset-2 transition-colors hover:text-foreground hover:underline`, the same
quiet-link idiom A used in `home-standing.tsx:176`, plus `focus-ring` on the button itself. The
static sibling (`<p>` for a template with no detail) keeps `text-foreground`, which is rule 3's
point: a static box may not wear the shell of a link.

## 4. Handoff B.4 — stale `lastRunFailed` comments

Three sentences, not two — B.4 asks for the third explicitly:

- `agents/page.tsx:~502` — the "rung the client's branch skips" note now says what round 6 made
  true: the flag moves no WORD for anyone, and with `viewerIsStaff` it appends the `Internal`
  sentence.
- `agents/page.tsx:~515` — "`status.staffNote` is set only on the rung that creates the
  discrepancy" → set wherever there is a staff-only fact to state, a failed last run included.
- `client-roster.ts:~226` — "the rung is skipped" → what is skipped is the `Internal` sentence.

## 5. Handoff C→A — `buttonClass` exported from `ui.tsx`

`BUTTON_BASE` / `BUTTON_VARIANTS` / `BUTTON_SIZES` lifted to module scope; `buttonClass({ variant,
size, className })` exported; `Button` now calls it. Zero behaviour change for `Button` (same
strings, same order). Also exported `ButtonVariant` / `ButtonSize`.

Call sites that stopped restating the recipe:

| file | was |
|---|---|
| `home-task-row.tsx` | `ACCENT_LINK` const, accent + sm verbatim → `buttonClass({ variant: "accent", size: "sm", className: "shrink-0" })` |
| `seo-geo/visibility-work.tsx` | the "Open {agent}" Link's outline recipe → `buttonClass({ variant: "outline", size: "sm" })` |
| `home-calendar-preview.tsx` | `OUTLINE_LINK_CLASS` (round-6 addition) → `buttonClass({ variant: "outline", size: "sm" })` |
| `client-home-overview.tsx` | `OUTLINE_LINK_CLASS` (round-6 addition) → same |
| `client-downloads.tsx` | an accent Button restated on an anchor, with a lift and a shadow bloom → `buttonClass({ variant: "accent" })` (see §12) |

Those four outline sites carried `font-medium`, which `Button`'s own `outline` + `sm` recipe does
not; they now read the real voice. That drift is exactly what the duplication was hiding.

One test pin updated with a "round 6:" comment: `interaction-primitives.test.ts`'s rule-2
assertion sliced between the literals `const variants` and `const sizes`, which the lift renamed.
Same strings, same fact, new names — and it now asserts the anchor was found rather than silently
slicing an empty string, which is how it went red.

**Left deliberately:** `run-calendar.tsx`'s `REVIEW_BUTTON_CLASS` also restates the outline recipe,
but it is PRE-existing (it is in `HEAD`), not something the round-6 diff introduced. One-line
follow-up if wanted.

## 6. Handoff C→E — `confirmedDocTypes` on `<ClientDocuments>`

- `listClientActionStates(id)` joined the settings page's existing `Promise.all` (12th read →
  13th), with the tuple type extended. No serial await, no second read (ruling 8).
- `CONFIRMABLE_DOC_TYPE_BY_ACTION_ID` at module scope: `21`→brand-voice, `22`→target-audience,
  `23`→competitor-analysis. Rows with `status` `"done"` or `"not_relevant"` count as answered.
- `confirmedDocTypes={confirmedDocTypes}` on the mount.
- `viewerIsClient` **dropped** from the mount AND the prop deleted from `ClientDocuments` (with its
  `_viewerIsClient` destructure): that mount is the component's only one in the tree, so the prop
  had no supplier left. `intelSchedule` stays — it is still passed.

## 7. Handoff C→B / unowned — "Let's do this"

Reworded all four comment mentions to "Home's recommended-task press":
`task-kickoff-strip.tsx:37`, `agents/page.tsx:87`, `agents/[agentId]/page.tsx:214`,
`task-kickoff.ts:5`. (C.md also listed `[agentId]/page.tsx:~1106`; that mention was already gone.)

**`grep -rn "Let's do this" src/` is NOT empty, deliberately.** Three hits remain, all in
`src/lib/__tests__/home-recommended-tasks.test.ts` — one of them is
`expect(row).not.toContain("Let's do this")`, the pin that ENFORCES the string's absence from the
rendered row, plus the two comments explaining it. A pin that forbids a literal has to name it;
removing it to satisfy a grep would delete the guarantee the grep is a proxy for. The acceptance
criterion holds for every rendered surface and every non-test file.

## 8. Handoff C note — `archive-view.tsx`'s `ArchiveTile`

`hover:-translate-y-0.5 hover:border-border-strong hover:shadow-lg transition-all` →
`focus-ring row-lift` (one fill step to `surface-3` plus the accent hairline, no motion, no
shadow). Also dropped the thumbnail's `group-hover:scale-[1.02]` — the same hover event, and with
it gone the `group` class had nothing left to drive.

## 9. Handoff E.1 — `MeasurementStamp` under the tiles

Moved below the tile grid in `SeoGeoScores` (`seo-geo-panel.tsx`). The legacy-snapshot warning
stays above the tiles: it qualifies the numbers before they are read, where the stamp captions them
after. No test change (E's mounting pin says nothing about the inside of `SeoGeoScores`).

## 10. Handoff D.4 — `modal.tsx` footer slot

**Confirmed clean, nothing to do.** `modal.tsx:181` is
`<div className="shrink-0 border-t border-border px-6 py-4">` — a top hairline and no background
band. A did not add one.

## 11. Decision 7 — "Not on your plan" for agents the client has never had

Built as approved, and widened at the SECTION rather than in `buildClientRosterEntries` (whose
contract stays "the entries the Agents page renders"). No new Firestore read: the lever table is
static.

`lib/visibility-levers.ts`:

- New `VisibilityFamily` type (`blog | landing | linkedin | reddit | x | social | reputation |
  newsletter`) and a `family` field on every rule and on `VisibilityLever`.
- `social` covers THREE matcher rules (the combined content engine, the TikTok/shorts pattern, the
  bare Instagram pattern) because they are one product — so an account without it gets ONE row, not
  three rows for one thing.
- `FAMILY_NAMES` gives each family the `name` a row prints ("Blog agent", "Instagram and TikTok
  agent", …) and a `markIdentity` for `AgentIdentity`'s platform mark, since a catalogue row has no
  stored agent to take one from. Each `markIdentity` starts with a REAL agent key, so the matcher
  resolves it back to its own family (pinned).
- `visibilityLeverFamilies()` returns one entry per family in lever order.
- The measurement agent (`seo-geo-agent-v2`) and every `NO_LEVER` key are excluded for free: they
  match no rule, so they have no family and never reach the list. Pinned.

`components/seo-geo/visibility-work.tsx`:

- `VisibilityWorkRow` gains `key: string` (the agent id, or `family:<id>`) and `customAgentId`
  widens to `string | null`. The list keys on `row.key`; the Open control is gated on
  `row.granted && row.customAgentId`, so a catalogue row cannot produce a `/agents/null` link.
- Ungranted rows already rendered `Badge tone="neutral"` "Not on your plan" and the standard
  Support `FlagButton` with subject `Ask about the {name}` and no Open — unchanged, and both row
  kinds share it.

`settings/page.tsx`: the row build splits into `rosterVisibilityRows` and
`catalogueVisibilityRows` (families with no roster entry, `granted: false`,
`status: NOT_ON_PLAN_STATUS`), fed together to `sortVisibilityWorkRows`. `visibilityWorkBand`
already reads `granted` before the tone, so every catalogue row lands in band 5, at the bottom, in
lever order.

**Tests:** `visibility-levers.test.ts` gains two describes (13 → 21 tests): the social collapse,
one-entry-per-family in lever order, name/mark/round-trip per family, the NO_LEVER exclusion, the
band placement, plus a source pin on the section that the Open control asks for an agent id and the
list keys on `row.key`. The dash-punctuation cap now covers the family names too, since they are
client-facing copy.

**Left deliberately:** `VisibilityWork`'s `rows.length === 0` empty state ("No agents are set up on
this account yet." + Support) is now unreachable from its one caller, because every lever family
renders a row. It is kept because think-reporting §2E specifies it as the section's no-agent state
and it is the component's contract for an empty `rows`. Flagging it rather than deleting spec'd
copy — say the word and it goes.

## 12. Rule-3 sweep (`hover:text-neon` / `hover:-translate` / `ArrowRight`)

### Fixed (client-reachable)

| file | what |
|---|---|
| `client-agents/live-card.tsx:~371` | "See all in your Workspace": `text-neon` + trailing `ArrowRight` → quiet link, no glyph |
| `client-agents/clip-gallery.tsx:102` | lift + `shadow-lg` + `hover:border-neon/50` + a second focus-ring recipe → `focus-ring row-lift` |
| `client-downloads.tsx:67` | accent Button restated with lift + shadow bloom → `buttonClass({ variant: "accent" })` |
| `pending-task-suggestions.tsx:163` | accent button, lift + bloom → `transition-colors hover:bg-neon-bright` + `focus-ring` |
| `agent-not-on-plan.tsx:69` | outline control hovering orange → the outline voice's own hover + `focus-ring` |
| `run-calendar.tsx:1172,1177` | trailing `ArrowRight` after "Review deliverable", both branches → gone |
| `integrations-tab.tsx:100,929` | the two branded connect buttons: `hover:-translate-y-px` + `hover:shadow-md` → colour-only hover; `focus-visible:ring-*` → `focus-ring`. They keep the platform's own brand fill, which is deliberate |
| `intake-page-action-link.tsx:35` | `ArrowRight` → `ChevronRight` in `muted-2`, + `focus-ring` (its `clients/[id]/*-agent` routes are client-reachable) |
| `intake-no-runs.tsx:44` | `hover:text-neon` → quiet link + `focus-ring` |

### Left, admin/staff-only (grep hits, reported not fixed)

`resume-uploader.tsx:84,95` · `avatar-uploader.tsx:119` (both only mounted from `settings-form.tsx`
and `onboarding-wizard.tsx`) · `team-manager.tsx:21,145` (`/team`) ·
`analytics-dashboard.tsx:131,252` (`/admin/analytics`) · `clients-grid.tsx:182` (`/clients`) ·
`client-editor.tsx:194` · `create-client.tsx:111` · `task-ticket-modal.tsx:1066` ·
`my-action-items.tsx:271,280` (`/dashboard`, staff) · `client-analytics.tsx:242` (mounted only on
the STAFF branch of `clients/[id]/page.tsx:1019`) · `chatbot-widget.tsx:890` (staff copilot) ·
`admin/agent-studio/step-pipeline-builder.tsx:141` · `custom-agents.tsx:974,1037` (the admin agent
library card and its "Edit in Studio" link) · `custom-agents.tsx:1341` (inside
`StaffAgentControls`) · `custom-agents.tsx:2843` ("Continue to the run", the staff-only DATA pane
D.md §3 documents) · `onboarding-wizard.tsx:242,289` (the `(onboarding)` route group, outside the
portal proper — worth a look in a later pass).

### Left, not the pattern the rule forbids

- `run-calendar.tsx:713` — `text-neon-dim hover:text-neon` on "View job". Staff-only branch
  (`!viewerIsClient`), and it is an already-orange element going from dim to full, not a quiet link
  turning orange.
- `branding-modal.tsx:680` — the tone-keyword chip's `×`: `text-neon/60 hover:text-neon`, i.e. 60%
  → 100% of the chip's own ink. The chip itself being orange is an Ember-rationing question (it is
  client-reachable, via the pencil in `BrandColorsSection`) and is bigger than a hover fix; noted
  for whoever owns the branding modal, not patched here.
- Every other remaining grep hit is inside a comment, or is a keyboard handler
  (`e.key === "ArrowRight"` in `image-lightbox.tsx`, `asset-card.tsx`, `settings-tabs.tsx`).

---

## Files touched in this pass

`app/(app)/clients/[id]/agents/page.tsx` · `app/(app)/clients/[id]/agents/[agentId]/page.tsx` ·
`app/(app)/clients/[id]/settings/page.tsx` · `components/client-documents.tsx` ·
`components/client-rail.tsx` · `components/sidebar.tsx` · `components/client-rail-agents-nav.tsx` ·
`components/client-agents/live-card.tsx` · `components/client-agents/clip-gallery.tsx` ·
`components/client-agents/task-kickoff-strip.tsx` · `components/ui.tsx` ·
`components/home-task-row.tsx` · `components/home-calendar-preview.tsx` ·
`components/client-home-overview.tsx` · `components/seo-geo/visibility-work.tsx` ·
`components/seo-geo-panel.tsx` · `components/archive-view.tsx` · `components/client-downloads.tsx` ·
`components/pending-task-suggestions.tsx` · `components/integrations-tab.tsx` ·
`components/agent-not-on-plan.tsx` · `components/run-calendar.tsx` ·
`components/intake-page-action-link.tsx` · `components/intake-no-runs.tsx` ·
`lib/client-roster.ts` · `lib/task-kickoff.ts` · `lib/visibility-levers.ts` ·
`lib/__tests__/visibility-levers.test.ts` · `lib/__tests__/interaction-primitives.test.ts`

Two test pins changed, both with a "round 6:" comment and both because the SOURCE moved rather than
the behaviour: `interaction-primitives.test.ts` (the variant-map rename) and the additions to
`visibility-levers.test.ts` (new coverage, no inversion).

Not done, per the brief: no commit, no push, no dev server, no `npm run build`.

---

# Fix pass (round 6, 2026-09-04)

Single-writer pass over the three review reports (`verify-ACF.md`, `verify-BDE.md`,
`alignment-review.md`) plus Albert's twelve rulings. Final state: `npx tsc --noEmit` clean ·
`npx vitest run` **345 files passed, 1 skipped · 5717 tests passed, 7 skipped, 0 failed** ·
`npx eslint` clean on every file touched here.

## Albert's rulings

| # | Item | State |
|---|---|---|
| 1 | Step 5 dead end (alignment fix 1) | **done** |
| 2 | `#setup` / `#run` anchors (alignment fix 2) | **done** |
| 3 | Documents waiting copy (alignment fix 3) | **done** |
| 4 | Action 05 written at most once (alignment fix 4) | **done** |
| 5 | `buildClientRosterEntries` into the page's wave + page clock (alignment fix 5 / verify-BDE) | **done** |
| 6 | AF-5 must not read Live over a setup hero (verify-BDE) | **done**, with one narrowing — see below |
| 7 | A finished ladder does not reopen (alignment §D3) | **done** |
| 8 | `roster-card.tsx` shim deleted (alignment fix 9) | **done** |
| 9 | `VisibilityWork`'s unreachable empty state (INTEGRATION item 2) | **done** |
| 10 | `interaction-primitives.test.ts` re-anchored (verify-ACF blocker) | **already done**, tightened |
| 11 | Orange / status / rule-3 should-fixes | **done** (one extra, one deviation) |
| 12 | Do not touch `.claude/launch.json`; keep the `"Let's do this"` pins | **honoured** |

### 1. Step 5 is not a dead end

`setup-ladder.ts` gained `SetupLadderContext.resultReady`, threaded from
`clients/[id]/page.tsx` as `Boolean(newestArchived)` — the same list `resultHref` points into,
so the button and its destination cannot disagree. The result step now resolves in three
states rather than two:

- `resultDone` → plain ticked row (no action, no wait; the grandfather clause below can tick it
  over an empty archive, so the wait had to be excluded explicitly).
- `runDone && resultReady` → `action: "Open your first {noun}"`, noun from `agent.runLabel`
  through a new local `resultNoun`, which step 4's "Create your first {noun}" now reads too —
  one constant, so Reddit cannot be offered a "reply" and then a "post".
- `runDone && !resultReady` → `waiting: true` with
  *"Your Karos team is reviewing your first {noun}. It lands in your Workspace once approved."*
  It keeps its href (the Workspace, where the item will appear), exactly like step 3's
  stand-up wait, and `nextSetupStep` skips waiting rows so no accent control can point at an
  empty archive.

Tests: `setup-ladder.test.ts` gains `resultReady: false` on the base ctx (the harder default)
and one new case covering all four shapes plus the noun swap.

### 2. `#setup` and `#run`

`clients/[id]/agents/[agentId]/page.tsx`: `id="setup" scroll-mt-24` wraps the
`AgentSetupHero` mount; `id="run" scroll-mt-24` wraps the four mutually exclusive run shapes
(`AgentDetailPanel` / `ClientAgentLaunchCard` / `LegacyAgentPanel` / the not-set-up
`EmptyState`) as ONE wrapper, because exactly one renders and each of them IS this agent's run
control. Parent is `space-y-6`, so a single wrapping div is layout-neutral.

### 3. Documents waiting copy

`setup-ladder.ts`: *"Your Karos team is writing your Brand Voice and Target Audience now."*
The old line promised "Usually ready within the hour", which decision 4 never covered (that
number is for agent setup). The test pin at `setup-ladder.test.ts` is now an exact-string
assertion plus `not.toContain("within the hour")`, both with a "round 6:" comment.

### 4. Action 05 fires once

`run-calendar.tsx`: a `resultActionWritten` ref gates `markActionDoneAction(…, "05")` to once
per mount. Not the `resultDone`-prop route: neither calendar page reads
`listClientActionStates`, so that route would have added a Firestore read to answer a question
a boolean answers (ruling 8).

### 5. Reporting reads in two waves, one clock

`clients/[id]/settings/page.tsx`:

- `listJobs` and `listClientAgents` (the credits breakdown's two reads) moved INTO the first
  `Promise.all` — nothing in wave one depended on them.
- `buildClientRosterEntries` moved into the second `Promise.all`, beside the Firebase Auth
  record, and its result (`rosterEntries`) is shaped into rows at the point of use. It was a
  third serial await that itself fires `buildAgentSetup`'s per-agent intake reads.
- One `const now = Date.now()` at the top of the render is the page's clock and is what the
  roster build reads; the credits card still takes its month from `credits.monthKey`, per its
  own note. Three round trips became two.

### 6. AF-5 does not paint Live over a setup hero

`client-agents.ts`'s AF-5 rung now skips `input.readyToRun === false && !input.hasDelivered`.

**Narrowed from Albert's wording, deliberately, and this is the one judgment call in the
pass.** `hasDelivered || readyToRun` as a flat requirement also blocked `readyToRun:
undefined`, and undefined is not "not set up" — `buildAgentSetup` returns nothing at all for
an agent outside the seven intake families, which is precisely the imported-stream shape
(Instagram/TikTok content engine) AF-5 was written for. That flat form turned Albert's own
AF-5 bug report back on (`client-roster.test.ts`'s "says Live for an agent whose posts are
already on the calendar" went red). `readyToRun === false && !hasDelivered` is character for
character the detail page's own `needsSetup`
(`intakeDriven && !hasDelivered && !(setup.ready && setup.standUpDone)`), which is the state
whose page contradicts the word — so this is Albert's parenthetical ("or skip when the agent
needs setup") rather than his first clause. Same outcome for the case verify-BDE found.

Tests: `client-agents.test.ts` gains "does not paint Live over an agent's own setup hero"
(blocked at `readyToRun: false`; promoted again by `hasDelivered`, by `readyToRun: true`, and
when `readyToRun` is absent), all with "round 6:" comments.

### 7. The reopen rule

**Implemented rule: the stored `ladder-done` row is the whole test, and step 5 grandfathers
pre-release work.** Two halves, because they cover two different populations:

1. `clients/[id]/page.tsx`'s `ladderHidden` dropped its `setupLadderComplete(setupSteps) &&`
   conjunct. A client who pressed "Done" has said the card is over; a signal change does not
   revisit that answer. (Cost, stated plainly: the card can no longer come back for a client
   who pressed Done and later has a step un-tick — e.g. a new grant. That is the ruling as
   given.)
2. For the clients who never pressed Done, `resultDone` is
   `actionDone("05") || resultStepGrandfathered`, where `resultStepGrandfathered` is
   `clientVisibleAssets.some((a) => a.createdAt < RESULT_STEP_LEGACY_BEFORE)` —
   `RESULT_STEP_LEGACY_BEFORE = Date.UTC(2026, 8, 5)`, a new exported constant in
   `setup-ladder.ts`. Action 05's OLD signal was "a client-visible asset exists", so the work
   that already existed when the meaning changed still counts; anything produced after the
   release is judged by the new rule (the client opens it, the archive modal writes the row).

**Derived, not written.** No page-load Firestore write was added: the predicate reads
`clientVisibleAssets`, the projection the page already computes for the overview, on the
page's existing clock. The date is fixed rather than rolling because this is a one-time
migration expressed on read, so it has to name the moment the meaning changed — **if the
branch ships after 2026-09-05, bump that constant to the release date**, otherwise assets
created between now and ship day are judged by the new rule (honest, but it will show the row
to a few more clients than intended).

Tests: the `ladderHidden` pin is rewritten (now asserts the block does NOT contain
`setupLadderComplete`) and a new pin covers the grandfather derivation, both with "round 6:"
comments. `home-get-set-up.tsx`'s `hidden` prop doc was corrected to match.

### 8. The shim

`components/client-agents/roster-card.tsx` deleted; its one importer
(`seo-geo/visibility-work.tsx`) imports `RosterStatusBadge` from
`@/components/client-agents/roster-row`. No test pinned the path.

### 9. `VisibilityWork`'s empty state

Deleted, with its copy and its Support trigger, and the `rows.length === 0` branch with it —
every lever family renders a row for every client since decision 7's catalogue half, so it was
unreachable. The component's docstring now says so instead. Nothing pinned the copy.

### 10. `interaction-primitives.test.ts`

Already re-anchored on `const BUTTON_VARIANTS` / `const BUTTON_SIZES` by the integration pass.
Tightened per the ruling: BOTH slice indices are now asserted (`end > at`, plus a non-empty
slice), since a missing end anchor makes `indexOf` return -1 and `slice(at, -1)` keeps slicing
happily.

### 11. Orange, status and rule 3

| Surface | Change |
|---|---|
| `seo-geo-panel.tsx` refreshing line | `text-neon` → `text-info` (orange never signals status) |
| `client-agents/agent-detail-panel.tsx` coin | client branch dropped, `text-muted-2` for both readers |
| `client-agents/legacy-agent-panel.tsx` coin | same |
| `client-agents/live-card.tsx` coin | same — **extra, not on any list**: the third instance of the same glyph, on the same client screen as the two Albert named |
| `notification-bell.tsx` icon trigger | `focus-visible:outline-none` + orange ring → `focus-ring`; `transition-all` → `transition-colors` |
| `notification-bell.tsx` row trigger | gained `focus-ring` (it had no focus treatment at all) |
| `custom-agents.tsx` pace modal | band → `border-border bg-surface-2`, price → `text-foreground`, Save → `variant="primary"` |
| `calendar/calendar-body.tsx` empty-state CTA | hand-rolled accent + lift → `buttonClass({ variant: "accent" })`, kept `accent` because on an empty calendar it is the screen's single forward move |
| `client-rail.tsx` credits chip (both registers) | one fill step (`hover:bg-surface-2`); the desktop one lost its border tint, the mobile twin had no hover at all |
| `custom-agents.tsx:~974` card | lift + bloom + border tint → `row-lift` |
| `client-rail.tsx` / `sidebar.tsx` comments | stale "roster and its star toggles" / "stars and all" reworded (round 6 moved Pin to the agent page) |

**One deviation, flagged rather than done quietly:** `custom-agents.tsx:~974` did NOT get
`focus-ring`. It is a static `<div>` — the admin agent-library card, not a link and not
focusable — so a focus style there can never paint, and ruling 8 forbids dead style. Also
worth recording: that card is client-facing in neither sense. `CustomAgentsHub` has no mount
left in `src/app` at all (only `agent-library-launch-price.test.tsx` renders it), so the line
is currently unreachable staff code; the hover fix stands either way.

Already correct at the time of this pass, so left alone: `run-calendar.tsx`'s "Review
deliverable" glyph (removed in the integration pass) and `live-card.tsx`'s "See all in your
Workspace" (already a quiet link with no glyph).

## Left, with reasons

| Item | Source | Why |
|---|---|---|
| Ops attribution pre-check before the predicate ships | verify-BDE should-fix (logic risk), risk review §F | A production query, not a code change. Still required before prep: every client with imported future drafts inside 14 days flips to Live at once. |
| `.claude/launch.json` | alignment fix 8 | Albert's, by instruction. Untouched by this pass (still shows the pre-existing `autoPort` edit). |
| Four `"Let's do this"` mentions in `home-recommended-tasks.test.ts` | verify-ACF, integration §7 | By instruction: a pin that forbids a literal has to name it. |
| `client-roster.ts`'s per-agent `agentProducedAssets` pass (O(agents × assets)) | verify-ACF nit | Latency only, no extra Firestore read; the fix is a bigger refactor of the attribution join than this pass should carry. |
| Reporting discards `lastMade` / `nextAt` | verify-BDE nit | Accepted cost, as the verifier offered. |
| `[agentId]/page.tsx` archive link has no `hover:underline` | verify-BDE nit | It carries a trailing `ChevronRight`, so it is the row/chevron idiom (identical to Home's control), not the quiet-text-link idiom the nit measured it against. |
| Staff bell empty state has no control | verify-BDE nit | Staff-only, and the verifier only raised it as a "consider". |
| `home-task-row.tsx`'s undo machinery and unused `HomeTaskRow` props | verify-ACF nits | Pre-existing, pinned by `flow-audit-undo-and-rows.test.ts`, not a round-6 regression. |
| Profile tab's two `bg-neon` saves; document panel's orange headings; `live-card.tsx`'s note marker and day-chip `hover:border-neon/50`; the "More options" staff-only toggle | alignment review follow-ups | Explicitly assigned to round 7 by the alignment review. |

## Files touched in this pass

`app/(app)/calendar/calendar-body.tsx` · `app/(app)/clients/[id]/page.tsx` ·
`app/(app)/clients/[id]/agents/[agentId]/page.tsx` · `app/(app)/clients/[id]/settings/page.tsx` ·
`components/client-agents/agent-detail-panel.tsx` ·
`components/client-agents/legacy-agent-panel.tsx` · `components/client-agents/live-card.tsx` ·
`components/client-agents/roster-card.tsx` (deleted) · `components/client-rail.tsx` ·
`components/custom-agents.tsx` · `components/home-get-set-up.tsx` ·
`components/notification-bell.tsx` · `components/run-calendar.tsx` ·
`components/seo-geo-panel.tsx` · `components/seo-geo/visibility-work.tsx` ·
`components/sidebar.tsx` · `lib/client-agents.ts` · `lib/setup-ladder.ts` ·
`lib/__tests__/client-agents.test.ts` · `lib/__tests__/interaction-primitives.test.ts` ·
`lib/__tests__/setup-ladder.test.ts`

Five test pins changed or added, each with a "round 6:" comment: the ladder's document-wait
copy, the ladder's `ladderHidden` rule, the new step-5 and grandfather pins, and AF-5's
setup-hero pin. Net +3 tests (5714 → 5717).

Not done, per the brief: no commit, no push, no dev server, no `npm run build`.

---

# Review fix pass 2 (round 6, 2026-09-04) — FIXER 2

The second half of the code-review fixes: documents, archive/calendar, the run dialog's price, two
restated button recipes, two mono figures and the landing-param duplication. Rulings taken as
written. Files owned by FIXER 1 (status/ladder/roster/reporting and every
`clients/[id]/**/page.tsx`) were not touched — the one change needed there is a request, below.

| # | Item | State |
|---|---|---|
| 1 | D1 · staff must not confirm a client's document | **done** + handoff to FIXER 1 |
| 2 | D2 · action 05 fires only for a real open | **done** |
| 3 | D6 · price-label honesty (+ the stale `product-mapping.ts` comment) | **done** |
| 4 | E3 · button recipe reuse (two sites) | **done** |
| 5 | E13 · numbers are sans (two figures) | **done** |
| 6 | E14 · one landing-param helper | **done** |

## 1. D1 — the confirmation is the client's to give

`ClientDocuments` gained `canConfirm?: boolean`, **default `false`**. Threaded to `DocPanel` and
`DocConfirmFoot`; three things now hang off it:

- the `onConfirm` handler is built only when `canConfirm && clientId && actionId`, so
  `markActionDoneAction` has no channel at all for a staff reader (the write is gated at the
  CHANNEL, not inside the handler);
- the "Looks right" button and the "Something is off" Support half are not rendered;
- `DocConfirmFoot` returns `null` when `!canConfirm && !done` — a read-only viewer with nothing to
  read gets no hairline and no question addressed to somebody who cannot answer it.

Parity holds the way `home-get-set-up.tsx`'s `canHide` holds it: same document, same layout, same
read-only "Confirmed" line once the client HAS answered, one control withheld. "View as Client" is
staff and stays read-only.

**Request to FIXER 1 (blocking for clients, `handoffs/FIXER2.md`):** add
`canConfirm={isClientViewer}` to the `<ClientDocuments>` mount at
`app/(app)/clients/[id]/settings/page.tsx:~485`. The flag exists at `:192`. Until it lands the
default withholds the controls from EVERYONE, so ladder step 2 has no gesture that ticks it.

New test: `lib/__tests__/doc-confirm-gate.test.tsx` (5 tests). Asked of the RENDER
(`renderToStaticMarkup`, the panel opened through `?doc=&for=` since effects do not run), in both
directions, plus the default-withholds case, plus a source pin that the write's one call site is
guarded and that there is exactly one of them.

## 2. D2 — "opened" means the modal has an asset

`archive-view.tsx` had two channels reporting the same event, and the second one lied: a seeded
`useEffect` fired `onAssetOpened(initialAssetId)` on mount, BEFORE the lookup, so a stale or expired
`?asset=` id (the archive's projection drops drafts, future posts and anything past 30 days) opened
nothing and still told the host a deliverable had been read — `?asset=` came off the URL and, for a
client, action 05 was written against an empty screen.

- the seeded effect is gone; `handleOpenAsset` now only moves state;
- ONE effect, keyed on `openedAssetId = openAsset?.id ?? null` (the resolved lookup), covers the
  click and the deep link and fires only when the modal actually has an asset;
- `useRef` import dropped with the `seeded` ref. Both prop docs updated.

`run-calendar.tsx`: `onArchiveAssetOpened` lost its unread `_assetId` parameter (neither half needs
to know which deliverable it was — the param comes off the URL wholesale and action 05 is a flag).
The once-per-mount `resultActionWritten` ref stays exactly as the previous pass left it.

Test: `calendar-url-state.test.ts` gains a describe of 3 (the resolved-id key and its guard, "exactly
one channel" including an explicit `not.toContain("onAssetOpened?.(initialAssetId)")`, and the host's
parameterless handler). No DOM in this repo, so this is source-pinned like the rest of that file's
component-side wiring — the pins name the exact shapes, so restoring the seeded effect fails.

## 3. D6 — a count-based quote says "about"

New `quoteIsEstimate(values)` in `custom-agent-launch.ts`, beside `quoteMultiplierFrom` and reading
the same two keys in the same precedence, so the number and its wording cannot disagree about which
key won. True only when the multiplier came from `post_count`.

`custom-agents.tsx` gained `briefQuoteLabel(agent, values)`, which the run dialog's footer now calls
instead of `runPriceLabel(agent, cost × quoteMultiplierFrom(...))`. Two independent reasons to hedge,
and only the absence of BOTH earns the exact form: settlement on for this deploy
(`priceIsEstimate`), or the count as the multiplier. `post_count` never reaches the submit's
`chargeMultiplier`, so with settlement off "3 posts" used to print an exact "75 credits" against a
flat one-run hold. Same number, honest wording. `runPriceLabel` is unchanged for its other call
sites (the pace modal's per-post and weekly lines, where the multiplier IS the stored one).

`agent-engine/product-mapping.ts:~515`: "default 3" → "default 1", with a note that decision 5 moved
it and that this comment was stale.

Tests in `agent-launch-ui.test.ts` (3 new): `quoteIsEstimate` across both keys, both together, empty
and every rejected count; the two label forms as strings ("about 75 credits" / "75 credits" /
"25 credits"); and a pin that the footer calls `briefQuoteLabel` and that `briefQuoteLabel` ORs the
two reasons.

## 4. E3 — two restated recipes

| site | was | now |
|---|---|---|
| `custom-agents.tsx:~2767` (setup-first modal's anchor) | `focus-ring inline-flex h-9 … bg-primary … hover:bg-primary/90` restated | `buttonClass({ variant: "primary" })` |
| `run-calendar.tsx:~1043` `REVIEW_BUTTON_CLASS` | outline recipe with `transition-all` and its own `focus-visible:ring-*` | `buttonClass({ variant: "outline", size: "sm" })`, const deleted |

**No new size was added.** The anchor's hand-rolled `h-9` had no matching `BUTTON_SIZES` entry;
`md` (h-10) is what the "Not now" `Button` beside it already is, so the pair now matches instead of
missing by a pixel. `REVIEW_BUTTON_CLASS`'s `h-8`/`px-3`/`text-xs` is `sm` exactly, and it picks up
the colour-only transition and `.focus-ring` on the way. Nothing else referenced the constant. (This
closes the "left deliberately, pre-existing" note in §5 of the integration pass.)

## 5. E13 — numbers are sans

globals.css's own header states the rule; two client-facing figures had stayed mono, so the same
kind of number at the same size disagreed with Home about what a number looks like.

- `seo-geo/score-popover.tsx:~68` — the percentage headline: `font-mono` → `stat-number`,
  `text-2xl font-medium` untouched, `focus-ring` and the dotted-underline affordance untouched.
- `custom-agents.tsx:~2164` — the pace modal's "Estimated weekly cost" figure: same swap.

No test pinned either class string (`grep -rn "font-mono\|stat-number" src/lib/__tests__` was
empty), so nothing to update — one was ADDED instead: `interaction-primitives.test.ts` gains a
describe of 3 (the `.stat-number` definition, plus each figure). Scoped to the two figures rather
than banning `font-mono` from the files: both still use it legitimately, for uppercase eyebrows and
for the staff library's skill-directory paths.

## 6. E14 — one landing-param helper

New `lib/setup-landing-params.ts` (client-safe, imports the keys from `setup-ladder.ts` rather than
restating them): `landedFromLadder(params)` and `dropLandingParams(keys)`. A separate module on
purpose — both touch `window`, and `setup-ladder.ts` is imported by the server components that
resolve the ladder; FIXER 1 owns that file besides.

Both copies deleted: `client-profile-panel.tsx`'s `clearLandingParams` body and its
`SETUP_STEP_IDS.some(...)` (the local `landedFromLadder` const is now `landed`, since the imported
function owns the name), and `client-documents.tsx`'s `landingDone` body and its own copy of the
predicate. `SETUP_STEP_IDS` is no longer imported by either component.
`grep -rn "SETUP_LANDING_KEYS" src` now shows only key NAMES at the call sites, no URL surgery.

`dropLandingParams` deletes only the keys it is given and preserves the hash — the documents landing
arrives at `#documents`, and one of the two copies dropping it would scroll-jump the client away
from the section the ladder just sent them to.

New test: `lib/__tests__/setup-landing-params.test.ts` (4 tests), exercised for real against a
stubbed `window` object (no jsdom needed): every real step id accepted and four near-misses
rejected, the hash preserved with the other query params kept, and the server case not throwing.

## Verification

- `npx tsc --noEmit` — no errors in any file this pass touched. (The five errors present are
  `readyToRun` on `client-agents.ts`'s input type, in FIXER 1's `client-agents.test.ts` /
  `client-agent-runs.test.ts` — mid-flight, not this pass's.)
- `npx eslint` — clean on all 13 files touched.
- Tests, run as the pinning sets rather than the whole suite: 16 files / 317 tests (documents,
  archive, calendar, asset-status and copy sweeps) · 24 files / 465 tests (launch profiles, run
  dialog, custom agents, profile panel, interaction primitives) · 3 files / 29 tests
  (`callback-prop-wiring`, `client-model-charge-boundary`, `refusal-copy`) · 8 files / 86 tests (the
  other directory-walking sweeps) · the 4 new-file runs. **All green, 0 failed.** Net new tests: 15
  (5 + 3 + 3 + 3 + 4, minus none removed).

## Files touched in this pass

`components/client-documents.tsx` · `components/client-profile-panel.tsx` ·
`components/archive-view.tsx` · `components/run-calendar.tsx` · `components/custom-agents.tsx` ·
`components/seo-geo/score-popover.tsx` · `lib/custom-agent-launch.ts` ·
`lib/setup-landing-params.ts` (new) · `lib/agent-engine/product-mapping.ts` (comment only) ·
`lib/__tests__/doc-confirm-gate.test.tsx` (new) ·
`lib/__tests__/setup-landing-params.test.ts` (new) · `lib/__tests__/calendar-url-state.test.ts` ·
`lib/__tests__/agent-launch-ui.test.ts` · `lib/__tests__/interaction-primitives.test.ts` ·
`docs/portal-round6/handoffs/FIXER2.md` (new)

`components/ui.tsx` was NOT touched: `buttonClass` already exported what both E3 sites needed and no
size was missing.

Every changed or added pin carries a "round 6 review" comment naming its item. Not done, per the
brief: no commit, no push, no dev server, no `npm run build`, nothing that writes to Firestore.

---

# Review fix pass 1

Fixer 1's half of the code-review findings (C1, C2, C3, C4, C5, C6, C7, C8, D3, D4, D5, D7, E1,
E2, E4, E6, E7, E9, E10, E11). Rulings taken as final; nothing re-opened. Fixer 2 worked
concurrently on a disjoint file set and left no failing test.

Final state: `npx tsc --noEmit` clean · `npx vitest run` **347 files passed, 1 skipped · 5753
tests passed, 7 skipped, 0 failed** (from 5717 before this pass; +36 net, all additions) ·
`npx eslint` clean on all 23 files touched.

## 1. One status source for all readers (C1, C2, C3, C8)

**The rule implemented, exactly:**

> The status WORD for a shared agent is computed from identical inputs for every viewer and every
> surface. `buildClientRosterEntries` is the ONLY assembler of `rosterStatus`'s inputs in the
> repo. It always computes those inputs as the CLIENT would see them — `hasDelivered` through the
> client-visible derivation (`viewerIsClient: true`, unconditionally), `hasUpcomingContent`, the
> readiness pair, and the owning umbrella through `umbrellaOwnsClientCard`. `scope: "staff"`
> widens only the CANDIDATE SET (every enabled bound agent, granted or not, plus every paused
> one) and adds `note` / `notGranted` as additive fields. It cannot reach the word.
>
> And: "does this agent still need setting up" is ONE exported predicate,
> `agentNeedsSetup({ setup, hasDelivered })` — `hasDelivered ? false : agentReadyToRun(setup) ===
> false`, where `agentReadyToRun(setup) = setup ? setup.ready && setup.standUpDone : undefined`.
> The agent detail page's `needsSetup` and `rosterStatus`'s AF-5 gate are both that call. No
> caller spells `setup.ready && setup.standUpDone` any more: `rosterStatus` takes the setup
> OBJECT (`setup?: AgentReadiness | null`) in place of the old pre-computed `readyToRun` boolean.

- (a) `lib/client-agents.ts`: new exports `AgentReadiness`, `agentReadyToRun`, `agentNeedsSetup`,
  and `isCurrentScheduleRefusal` (the old module-private `refusalIsCurrent`, exported for item 10).
  `rosterStatus`'s `readyToRun` input became `setup`; the AF-5 gate is now `agentNeedsSetup(...)`
  rather than the re-spelled `readyToRun === false && !hasDelivered`.
- (b) `lib/client-roster.ts`: `viewerIsClient` replaced by `scope?: "client" | "staff"` (default
  client) plus `viewer`, `withRowFacts` and a `data.agentSetup` cache.
- (c) `agents/page.tsx`: the ~180-line staff hand assembly (lines 412-593) is gone, replaced by
  one `buildClientRosterEntries({ scope: "staff", … })` call. Four differences had already crept
  into that copy, each able to move the word: the raw umbrella instead of the card-owning one,
  `viewerIsClient: false` on the delivered-work join, its own `toScheduleRows(…, false)`, and a
  re-spelled readiness conjunction. Twelve imports and a second `buildAgentSetup` pass went with
  it.
- (d) `clients/[id]/page.tsx`: Home's ladder maps roster entries to `SetupLadderAgentCandidate`
  (`live: rosterByAgentId.get(agent.id)?.status.tone === "live"`) instead of assembling
  `rosterStatus` inputs itself — that fourth assembly was missing `hasDelivered`, which is the C1
  bug. No new reads: all five inputs were already in the page's `Promise.all`, and Home's existing
  `buildAgentSetup` result is handed over as a cache so the intake reads are not made twice.
  `withRowFacts: false`.
- (e) New tests in `client-roster.test.ts`: the word is identical for both scopes (live and idle),
  the staff superset is listed and marked without moving a word, and the C1 case — unsaved intake
  (`karos-x-agent-v2`, mocked `hasXAgentIntake: false`) + a delivered lab import + a client-visible
  future DRAFT — reads "Live" for the client, for staff, and for what Home reads off it.

Behaviour note for review: because the staff scope now asks the client's question, staff `lastMade`
carries the client delivery stamp and stops at the archive window, where the old staff branch used
`createdAt` and the full history. That is ruling 1 (staff read what the client reads; extras are
additive) and the operator facts they need are in `note`.

## 2. Seat privacy (D3)

`buildClientRosterEntries` takes `viewer: AssetViewer` and threads it into
`buildAgentAssetIndex` / `agentsWithDeliveredWork`, so the client-visible projection behind
`lastMade` (the one field on the row that prints an asset TITLE) is `getClientArchiveAssets`
with the seat gate applied. All four callers pass
`{ role: user.role, seatId: user.seatId, isGroupAdmin: user.isGroupAdmin }`.

## 3. Efficiency (E9, E10, E11)

- `lib/agent-detail-archetypes.ts`: new `AgentAssetIndex` + `buildAgentAssetIndex` (`jobById`, the
  viewer projection, the upcoming set — built once) and `groupAssetsByAgent` (one pass over the
  assets for N agents, attributions resolved up front). `agentsWithDeliveredWork`,
  `agentsWithUpcomingContent`, `agentProducedAssets` and `agentUpcomingCalendarDays` all take an
  optional `index`; every existing signature still works and builds its own when absent.
- `lib/client-roster.ts` builds the index once and passes it to all four joins (they were rebuilt
  six times per roster render: four helpers, two of them called twice for the enabled and paused
  sets). `lastMade` / `nextAt` come from two `groupAssetsByAgent` passes rather than per-agent
  `agentProducedAssets` + `agentUpcomingCalendarDays` calls.
- `withRowFacts?: boolean` (default true); `settings/page.tsx` passes `false`, so Reporting
  computes no `lastMade` / `nextAt` / `attentionReason`. Home passes `false` too.
- `listAssets` was checked: `data.ts` offers **no** bounded window and **no** projection (it is
  `col.assets().where("clientId","==",id).get()` with an in-process sort), so the read stays and
  the stale "NO ASSET READ ON THIS PAGE ANY MORE" comment at settings/page.tsx:420 was corrected
  to say what the read is now for (the round-6 roster status join), why it cannot be narrowed from
  that file, and which two data-layer shapes would narrow it.

## 4. Reporting badge (D4) and E4

Roster-derived rows always render `RosterStatusBadge` with the roster's word, granted or not;
"Not on your plan" is now `status: null`, which only a catalogue row (no roster entry) carries.
Ungranted roster rows keep Support instead of Open (`customAgentId: entry.granted ?
entry.customAgentId : null`), because a client opening one gets `notFound()`. One field per
decision: `status` the badge, `customAgentId` the control; `row.granted` is gone from the
component. `visibilityWorkBand` reads `status === null` for its last band, so an ungranted agent
with real delivered work is banded by its own state instead of being filed under "what this
account does not have". The strip-`lever` `.map` is deleted — `sortVisibilityWorkRows` is generic
and returns the caller's rows — and the duplicated `sentence` beside `lever` went with it
(`row.lever.sentence` is the one source).

## 5. Lever table (E2)

`lib/visibility-levers.ts` restructured: a `FAMILIES` record owns each product's `name`,
`markIdentity`, `order`, `lever` and `sentence` (all sentences verbatim); `RULES` entries carry
only `family` + `matches`. The two byte-identical social rules are merged. The clip rules now ask
`agentArchetype(subject) === "clip_maker"` and the Instagram rule asks
`AGENT_ARCHETYPE_PATTERNS.COMBINED_CONTENT_ENGINE` / `FEED_PLUS_CLIP_ENGINE`, instead of regexes
copied out of `agent-archetype.ts` — the copy was `CLIP_MAKER` minus `\bclips?\b` and
`\binterview\b`, so a `karos-clip-maker` or interview clipper matched nothing and vanished from
the report. The landing regex is hoisted to one `LANDING_PATTERN` used by the rule and by
`citationDomainFor`. `visibilityLeverFamilies()` reads `FAMILIES` directly (the row set is a
property of the table, not of rule order).

**One decision that needs Albert's eye.** A family owns exactly ONE sentence, so the TikTok/clips
sentence could not stay inside the `social` family: printing "A daily post on your Instagram" over
an interview clipper is a false statement about what the client bought. `clips` is therefore its
own family (name "Clips agent", order 6.5) with its verbatim sentence, beside `social` (name and
mark unchanged). They are separate lab agents with separate `agent-blurbs.ts` lines, so the
catalogue was under-counting products rather than over-counting them — but it does mean an account
with neither reads two "Not on your plan" rows where it read one. Easy to collapse back if that is
wrong: merge the two `FAMILIES` entries and drop the `clips` rule.

Tests updated (completeness, claims cap, the not-on-plan rows, the ordering) plus a new one
asserting `karos-clip-maker`, `karos-interview-clipper` and `karos-branded-shorts` all get the
clips lever while the combined engine stays `social`.

## 6. Ladder step 5 (C4, C5) and reopen (C6)

**The rules implemented, exactly:**

> `resultDone = ctx.resultOpened || ctx.agedOutDeliverable`, resolved inside
> `resolveSetupLadder` so there is one definition. `agedOutDeliverable` is true when the client
> has at least one client-visible non-draft POSTED asset whose delivery stamp is older than
> `CLIENT_ARCHIVE_WINDOW_MS` — computed on Home as
> `clientVisibleAssets.some(a => a.status === "published" && clientDeliveryStamp(a) < now -
> CLIENT_ARCHIVE_WINDOW_MS)`, off the projection the page already had. (`published` is the only
> status `isInClientArchive` ages out; approved/scheduled/delivered work stays until the client
> marks it posted.) The portal can no longer show it, so the step cannot be asked.
>
> The waiting row ("Your Karos team is reviewing your first {noun}…") renders only when
> `runDone && !resultReady && !agedOutDeliverable` — the genuine in-review case. It is reached by
> construction: the aged-out half ticks `resultDone`, which short-circuits the row.
>
> `ladderHidden = ladderDismissed && setupLadderComplete(setupSteps)`, where `ladderDismissed` is
> the stored `dismissed` or legacy `not_relevant` row read WITHOUT
> `ACTION_DISMISS_COOLDOWN_MS`. Decision 9 says the slot stays empty after completion, not that an
> incomplete ladder stays hidden — so a later grant that makes the ladder incomplete brings the
> card back.

`RESULT_STEP_LEGACY_BEFORE` and the date grandfather are deleted. The two contradicting paragraphs
on `SETUP_LADDER_HIDDEN_ACTION_ID` (~106-127) are rewritten into one statement of the two-condition
rule and why both halves have the same subject: the FINISHED card. Tests updated; new
`describe("step 5: opened, or aged out of the archive")` covers all four branches.

## 7. "After step N" (C7)

`afterStep` is `SETUP_STEP_IDS.indexOf(id) + 1`, so the agent step is 4 and the run step is 5 —
matching the six visible, unnumbered rows a client counts from the top. Pins and the doc examples
updated ("After step 4" / "After step 5").

## 8. Next-day label (D5)

`agents/[agentId]/page.tsx`'s local `dayLabel` is deleted; the status line reads
`rosterNextLabel(upcomingDays[0].at, now)`, so the row and the page it opens cannot say "Thu 5"
and "Tomorrow" about the same date.

## 9. Relative time (E1)

`relativeTime(value, now?)` in `lib/utils.ts` takes an optional clock; `rosterRelativeStamp` (a
duplicate of the same unit ladder that existed only to take one) is deleted and `roster-row.tsx`
calls `relativeTime(lastMade.at, now)`. Its three tests moved from
`client-agent-rows.test.ts` into `utils.test.ts` as `describe("with an injected clock")`.

## 10. Attention reason (D7, E6)

**A credits marker DOES exist in the data, so `"credits"` was KEPT** (not removed).

> The rule implemented: `attentionReason` is `"credits"` when the schedule's stored refusal is
> BOTH current — `isCurrentScheduleRefusal({ scheduleRefusal, scheduleRefusalAt, scheduleActive,
> now })`, the same freshness window the WORD was resolved through — and recognised by
> `isCreditDenialMessage(schedule.lastError)`; else `"intake"` when
> `agentNeedsSetup({ setup, hasDelivered })`; else `"launch"` when the umbrella's `launchState`
> is `launch_failed`; else `null` (verb "Open").

The refusal is asked FIRST because it is the rung that outranks everything else in `rosterStatus`:
an agent badged "Needs attention" over a credit denial was being offered "Set up" whenever its
intake happened to be incomplete as well. The roster still does not read the credit BALANCE
(#130) — it reads the denial the scheduler stored when it refused a fire, which `clientSafeRefusal`
passes through verbatim, and which `isCreditDenialMessage` recognises under all three house styles
that line has been minted in. Three new tests: the positive case, a denial that has aged out of
the window (must NOT say credits), and no lever where none is resolvable.

## 11. Optional (E7) — DONE, and it is over the line budget

`SetupStepView.kind` (`done | current | link | waiting | blocked`) is stamped by the resolver, and
`home-get-set-up.tsx` switches on it in a `taskRowProps` helper instead of a four-deep inline
ternary over six fields. The widget no longer calls `nextSetupStep` (comparing by object identity
was half of the derivation the resolver now owns); `nextSetupStep`, `setupLadderProgress` and
`setupLadderComplete` were generalised to accept the pre-`kind` shape.

**It is +50 net in `home-get-set-up.tsx` and ~+25 in `setup-ladder.ts`, i.e. over the 40-line
budget the brief set** — the switch itself is smaller than the ternary it replaced, the excess is
the two docstrings and three new tests. Flagged rather than trimmed, and it is independently
revertible (the `kind` field is additive; the flags it mirrors are untouched and still pinned).

## Files touched in this pass

`lib/client-roster.ts` · `lib/client-agents.ts` · `lib/client-agent-rows.ts` · `lib/utils.ts` ·
`lib/setup-ladder.ts` · `lib/visibility-levers.ts` · `lib/agent-detail-archetypes.ts` ·
`app/(app)/clients/[id]/page.tsx` · `app/(app)/clients/[id]/agents/page.tsx` ·
`app/(app)/clients/[id]/agents/[agentId]/page.tsx` · `app/(app)/clients/[id]/settings/page.tsx` ·
`components/seo-geo/visibility-work.tsx` · `components/client-agents/roster-row.tsx` ·
`components/home-get-set-up.tsx` · and the pins:
`lib/__tests__/client-roster.test.ts` · `client-agents.test.ts` · `client-agent-runs.test.ts` ·
`client-agent-rows.test.ts` · `setup-ladder.test.ts` · `visibility-levers.test.ts` ·
`agent-detail-archetypes.test.ts` · `utils.test.ts`

`lib/asset-visibility.ts` was NOT touched: `CLIENT_ARCHIVE_WINDOW_MS` and `clientDeliveryStamp`
were already exported. `components/home-task-row.tsx` was not touched either — its `trailing` /
`start` / `href` props already expressed every one of the five row kinds.

Every changed or added pin carries a "round 6 review" comment naming its finding. Not done, per the
brief: no commit, no push, no dev server, no `npm run build`, nothing that writes to Firestore.
