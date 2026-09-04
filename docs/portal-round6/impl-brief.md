# Round 6 implementation brief (2026-09-04)

Albert approved `round6-approval.pdf` with every recommendation on page 6 taken as "yes". This file is
the contract for the executor, verifier and review agents. Read, in order: this file,
`albert-brief-round6.md`, `risk-review.md` (its rulings override the think docs), then the think doc
sections named in your work package.

## 0. How we work in this worktree

- Branch `claude/portal-round6` in `/Users/albertkattan/Karos Labs CMO/.claude/worktrees/quirky-swartz-183eb4`.
  Several agents edit the SAME working tree at once. You may only edit the files your package owns
  (§3). If you need a change in a file you do not own, write the exact request into
  `docs/portal-round6/handoffs/<your-package>.md` (create it) and continue; do not edit the file.
- Do not commit, do not push, do not start a dev server, do not run `npm run build`. Do not run
  `git stash`. `.env.local` points at the PRODUCTION Firestore: never run scripts or actions that write.
- Typecheck with `npx tsc --noEmit 2>&1 | grep -E "<paths you own>"`; other packages are mid-flight, so
  errors in files you do not own are expected and not yours. Run only the test files you own or touch:
  `npx vitest run <file> ...`. Do not run the whole suite.
- Every test pin you change on purpose gets a one-line comment saying "round 6:" and why.
- Read `node_modules/next/dist/docs/` before using a Next API you are unsure of (this is Next 16).

## 1. Rulings that bind every package

1. **Parity.** Staff "client context" renders exactly what the client sees. Staff-only extras only as
   additive `StaffOnlySection` / `Internal` badge blocks. Never a staff-only branch that changes shared
   layout, and never a different status WORD per viewer.
2. **Ember.** Two inks and ONE rationed orange (`--neon`). `Button variant="accent"` at most once per
   screen and only on the control that moves the client forward: Home = the ladder's current-step button;
   agent page = the run / setup / launch control (mutually exclusive states, one renders). Everything else
   is `primary` (paper) or `outline`. Status tones use the judgment scale only (`success`, `warning`,
   `info`, `muted`); orange never signals status. Meter fills, sparklines, icon chips: ink or grey.
3. **Interaction logic** (think-home §1.1), portal-wide:
   - Link: whole surface is the target; hover = one fill step (`surface-2` to `surface-3`) plus the
     accent hairline on bordered rows (`row-lift`); ends in ONE trailing `ChevronRight` in `muted-2`,
     static (no slide, no colour change). No translate, no shadow change.
   - Button: colour change only (150 to 180 ms). No `-translate-y`, no shadow bloom, no glyph after the
     label. `accent` hovers to `--neon-bright`, `primary` to 90% opacity.
   - Static: no border tint, no fill change, no chevron, default cursor. A static box may not wear the
     shell of a link.
   - Focus: one utility `.focus-ring` (`outline: 2px solid var(--focus); outline-offset: 2px`,
     `--focus: var(--foreground)`) on every interactive element, inputs included. `outline-none`
     without `.focus-ring` is a bug.
   - Card is a container and never hovers.
   - Quiet text links hover `muted` to `foreground` with underline; `hover:text-neon` is not a rule.
4. **Status words stay as they are** (Live, Setting up, Setup needs attention, Needs attention, Runs on
   request, Not set up yet, Coming Soon). One exported `RosterStatusBadge` renders them everywhere.
   Reasons become a sentence under the badge, never a new badge word. "Not on your plan" exists only in
   Reporting's new section.
5. **Live** = `rosterStatus(...)` says so, where `hasUpcomingContent` counts any non-launch, non-test
   asset attributed to the agent with `scheduledAt` in (now, now + 14 days] and a `postKind` in
   {scheduled, placeholder, draft} (reuse `isUpcomingPost` from `calendar-kind.ts`), plus the existing
   umbrella `live` / schedule `active` rungs. One function, all readers (roster, detail page, Reporting,
   the setup ladder).
6. **Copy.** No em dashes and no spaced hyphens in any client-facing string (a test enforces it).
   Prices read "about N credits". Sentence case. Reddit drafts a "reply", never a "post". Support is the
   one word for every help trigger (never "Ask about it", "Contact us").
7. **Not in scope, do not build:** client file uploads in the run dialog, the six-state status rename,
   "Coming Soon" as "Paused", the phase-2 notification feed, "More ways to get value" after the ladder,
   a site-access data field, dynamic agents in the Reporting section, brand-voice editing, credit top-up,
   calendar "Schedule a run" for clients, the canned SEO "What we're fixing" plan (gone for good).
8. **Efficiency.** No new Firestore reads where an existing read in the same page already has the data;
   new reads join the page's existing `Promise.all`. No dead code: delete what you replace (components,
   copy tables, imports, tests of removed behaviour). No dead ends: every client-facing empty state,
   row and card either opens something or is visibly static (rule 3).

## 2. Decisions Albert approved (taken as written)

1. Client-visible future drafts count as producing, 14-day window.
2. Profile complete = category + description + website, each named.
3. Documents: "Looks right" marks the step done; "Something is off" opens Support with the document named.
4. Waiting row: "Karos is setting up your {agent}. Usually ready within 2 business days."
5. Run dialog: default 1 post; footer price = post_count × per-post estimate, "About N credits".
6. Agents tab: full-width rows.
7. Reporting section shows agents not on the plan as "Not on your plan" + Support.
8. `?asset=` calendar URL key opens one item on load.
9. After the ladder completes: the card shows the done state once, then disappears; slot stays empty.
10. Agent page: the status chip beside the logo goes; the tinted strip becomes one plain status line.

## 3. Work packages and file ownership

Paths under `src/` unless noted. A file appears in exactly one package.

### A. Primitives and the interaction sweep (Home, Reporting chrome, shared)
Owns: `components/ui.tsx`, `app/globals.css`, `components/home-kpis.tsx`, `components/home-standing.tsx`,
`components/home-calendar-preview.tsx`, `components/client-home-overview.tsx`, `components/rail-nav-link.tsx`,
`components/client-rail.tsx`, `components/seo-geo-panel.tsx`, `components/seo-geo/disclosure.tsx`,
`components/seo-geo/flag-button.tsx`, `components/seo-geo/gap-list.tsx`, `components/seo-geo/score-popover.tsx`,
`components/seo-geo/presenter.ts` (only the two takeaway strings at ~:1113 and ~:1117),
`components/client-agents/client-agent-run-history.tsx`, `components/client-agents/agent-archive-rows.tsx`,
`components/client-agents/archetype-cards.tsx`, `components/modal.tsx`, and any test that pins these.
Scope: think-home §1.2, §1.3 (every row of the table EXCEPT the ladder rows, the bell, and the
agents-surface rows owned by B/F), §1.4, §1.5. In `home-standing.tsx` the two SEO cells become whole-cell
links to `?tab=reporting#presence` and `#share` (add those two anchors in `seo-geo-panel.tsx` next to
`#visibility-scores`); "See the breakdown" becomes a quiet link "Open the full report" without a glyph;
takeaway band and icon chips lose orange; meters and sparkline fill `foreground`. `presenter.ts`
takeaways: "That's the gap our agents are working on." / "Our agents' job now is to protect that position."
Add `@media (prefers-reduced-motion: reduce)` covering `transition-duration`.
Acceptance: `Card` has no hover styles; `Button` has no translate or shadow bloom; `.focus-ring` exists and
is applied by `Button`, `Input`, `Textarea`, `Select`, `TabButton`; `grep -rn "outline-none" src/components/ui.tsx`
returns only lines that also apply `.focus-ring`; Home's orange = ladder button, progress fill, row-lift hovers,
bell badge, nothing else.

### B. Status truth, agent page header and status line, rail, pin
Owns: `lib/agent-detail-archetypes.ts` (+ `lib/__tests__/agent-detail-archetypes.test.ts`),
`lib/client-agents.ts` (+ `lib/__tests__/client-agents.test.ts`), `lib/calendar-kind.ts` (read-only unless
a helper needs exporting), `app/(app)/clients/[id]/agents/[agentId]/page.tsx`,
`components/client-agents/agent-sections.tsx`, `components/client-agents/legacy-agent-panel.tsx`,
`components/client-agents/agent-detail-panel.tsx`, `components/client-agents/task-kickoff-strip.tsx`,
`components/client-agents/launch-card.tsx`, `components/client-rail-agents-nav.tsx`,
`components/client-agents/agent-star-button.tsx`.
Scope: think-agents §0 (the predicate: `isUpcomingCalendarItem` counts drafts via `isUpcomingPost`, 14-day
ceiling, delete the stale comment, invert the test pin at ~:726 with a "round 6:" comment); think-agents §1
as amended by risk-review B1/B2 and decision 10: keep the words, `lastRunFailed` no longer changes the word
for anyone (staff get an `Internal` badge + line), the header chip beside the logo goes, the identity tile
sits left of the h1, Pin stays right, the strip becomes ONE plain 13px status line under the header with the
tone dot (judgment scale), middot-separated facts, each fact with a destination a link ("Next post Thu 5" →
calendar day, "12 in your Workspace" → archive), "Adjust pace" at the end when a schedule exists,
`SchedulePaceCard`'s "No schedule yet" aside removed, delete the duplicated `StatusBadge` in `[agentId]/page.tsx`
and import `RosterStatusBadge` from `components/client-agents/roster-card.tsx` (F exports it; until F lands you
may see a missing-export error, that is expected). The not-set-up EmptyState copy in `[agentId]/page.tsx`
(~:1287) becomes "Not set up yet. Your Karos team sets this up. Tell us when you want it." + the Support
trigger. Orange per B2: `agent-detail-panel.tsx` run button, `launch-card.tsx`, `legacy-agent-panel.tsx`
CTA keep `accent`; `task-kickoff-strip.tsx` button becomes `primary`; Pin button ink (`text-foreground` on
`bg-surface-2` when pinned, outline star when not); arrows-as-characters and `ArrowRight` after labels in
your files go (rule 3). Rail (think-agents §3): rows = mark + name, no stars, 32px, `h-4 w-4` mark, `gap-3`,
hover/active `bg-surface-2 text-foreground`, `aria-current="page"`, one current row (parent "AI agents"
loses its fill when a child is active), pinned first then hairline then the rest capped at 6, "No agents set
up yet" becomes a link "See your agents". Sidebar rows get `.focus-ring` (A defines it; use the class name).
Acceptance: `npx vitest run src/lib/__tests__/agent-detail-archetypes.test.ts src/lib/__tests__/client-agents.test.ts`
green; the status word for a given agent is identical for `viewerIsStaff` true and false; `grep -n "text-neon" src/components/client-rail-agents-nav.tsx src/components/client-agents/agent-star-button.tsx` is empty.

### C. Get set up ladder and its landings
Owns: `lib/setup-ladder.ts` (+ its tests), `components/home-get-set-up.tsx`, `components/home-task-row.tsx`,
`app/(app)/clients/[id]/page.tsx`, `components/client-profile-panel.tsx`, `components/client-documents.tsx`,
`components/client-context-sections.tsx`, `lib/calendar-view-modes.ts`, `lib/action-list.ts` (+ test),
`lib/__tests__/home-recommended-tasks.test.ts`, the calendar archive component that opens the asset detail
modal (find it under `components/` / `app/(app)/clients/[id]/calendar`; you own the open-on-load change only),
new `components/here-for.tsx`, and the write action(s) you need in `lib/actions/` for "Looks right" and the
ladder "Done" (new files or additive edits only; name them `round6-*` or add to the obvious existing action file
and list it in your handoff).
Scope: think-home §2.1 to §2.11 with decisions 2, 3, 4, 8, 9, and risk-review B3 (step 3 "live" reads
`rosterStatus(...)` from `lib/client-agents.ts`, replacing the `launchState === "live"` check at ~:460; B owns
that function, you only call it) and B6c (ladder verbs). Every incomplete row is a whole-row link with a status
word ("Not started" / "After step 3"); only the current row carries `Button variant="accent"` whose label names
the action and the missing thing (§2.2 strings); done rows plain, no link. Step 0 gets no href. Landings:
`?tab=profile&edit=description|category|website&for=<stepId>`, `?tab=profile#documents&doc=<type>&for=...`,
agent page `#setup` / `#run`, `/calendar?view=archive&asset=<id>`. `<HereFor>` band (info tone,
`role="status"`) at the landed section, target field outlined with `--focus` and focused, clears on first save
or "Got it". Document foot: quiet "Looks right" (writes action 21/22 done) and "Something is off" (opens the
existing Support trigger with the document named). Waiting row copy per decision 4, links to the agent page,
never takes the button, clears on live evidence. Completion state per decision 9 (remove the 7-day cooldown
return). Step 4 done = a non-launch, non-test job reached review/approved/delivered. Step 5 done = the client
opened an asset (action 05 becomes event-tracked when the detail modal opens for a client).
Acceptance: `npx vitest run src/lib/__tests__/home-recommended-tasks.test.ts src/lib/__tests__/action-list.test.ts`
plus setup-ladder tests green; no string "Let's do this" remains in `src/`; the ladder never renders two
`accent` buttons.

### D. Create a post dialog
Owns: `components/custom-agents.tsx` (the client run dialog only; the staff intake pane inside
`StaffOnlySection` stays), `lib/custom-agent-launch.ts` (+ tests), `components/agent-input-files.tsx`, and
`lib/credits.ts` only if the per-post estimate needs a pure helper (additive).
Scope: think-agents §2 as amended by risk-review (no client uploads: render nothing for clients, staff keep the
library picker; run type "Set up the content system / Refresh strategy" is staff-only inside the existing
`StaffOnlySection` idiom; the dialog confirm is `Button variant="primary"` labelled "Create post" (noun-aware:
"Create clip", "Draft reply"); default `post_count` 1; footer price = post_count × per-post estimate as
"About N credits", or "N credits" when `CREDITS_PLAN_V2_ENABLED` is off, matching whatever the current footer
does for the flag). One required field ("What should this post be about?", no asterisk; optional fields say
"(optional)"), three "Try:" chips that fill it with a selected state in `bg-surface-2 border-border-strong
text-foreground`, defaults as one muted summary line with a "Change" text control that opens More options and
focuses the first field, ONE `More options` disclosure (`aria-expanded`) with a two-column grid, footer = one
`text-xs text-muted` line "About N credits · ready in about 30 minutes · you can leave this page" + ghost
Cancel + primary confirm. Delete the eyebrow/intro/deliverables box, the estimate badge and the blurb; the
subtitle carries the deliverables in one sentence. Started state copy: "Your post is on its way. About 30
minutes. Your Karos team reviews it, then it lands in your Workspace." Dialog fits 1280×800 collapsed
(~480px) and with More options open (~700px).
Acceptance: `custom-agent-launch` tests green; `grep -n "No reference files" src/components/agent-input-files.tsx`
shows the dashed box gone for the client branch; `grep -n 'variant="accent"' src/components/custom-agents.tsx`
returns nothing in the client dialog.

### E. Reporting, Seats, notifications clean-up, roster extraction
Owns: `lib/seo-geo.ts` (+ `lib/__tests__/seo-geo.test.ts`, `seo-geo-client-suggestions.test.ts`,
`seo-geo-mounting.test.ts`), `components/seo-geo/client-suggestions.tsx`,
`app/(app)/clients/[id]/settings/page.tsx` (+ `lib/__tests__/settings-nav.test.ts`),
`app/(app)/clients/[id]/agents/page.tsx`, new `lib/client-roster.ts` (+ test), new `lib/visibility-levers.ts`
(+ test), new `components/seo-geo/visibility-work.tsx`, `lib/notification-rows.ts`,
`components/notification-bell.tsx` (+ `lib/__tests__/notification-bell-shell.test.ts`), `lib/__tests__/client-copy-boundary.test.ts`
(only the lines that pin files you change).
Scope: think-reporting §1 (allow-list `GEO-25`, `GEO-07`, `GEO-14`; three copy entries as written; delete the
`REC_COPY` fallback; empty states "Nothing on your side is holding you back right now." / the lowConfidence
sentence; the heading always renders; section intro as written), §2 as amended (heading "What we are doing to
improve your SEO and GEO"; extract the client roster build from `agents/page.tsx` into
`buildClientRosterEntries({ clientId, client, viewerIsClient, now })` in `lib/client-roster.ts` returning the
same entries plus `granted`; the agents page keeps rendering exactly what it renders; the lever table as written
in §2B; row = mark · name · sentence · optional "Quoted N times in the answers we measured" · `RosterStatusBadge`
imported from `components/client-agents/roster-card.tsx` · ONE control: `Button variant="outline"` as a Link
labelled "Open {stored agent name}", no chevron, to `/clients/{id}/agents/{customAgentId}`; not granted → badge
"Not on your plan" (neutral) + the standard Support trigger, no Open; claims-cap test over the lever table),
§3 order (scores → measurement stamp under the tiles → VisibilityWork → panel → ClientSuggestions last;
delete `reputationBubble` and both mounts; pin the order in `seo-geo-mounting.test.ts`), §4 Seats card deletion
(card, `seatSetupLinks`, `listClientSeats` read, imports; add the absence pin to `settings-nav.test.ts`).
Notifications (think-home §3.2 only, B5): remove the client summary rows (`ReviewSummaryRow`, `TaskSummaryRow`
for clients; staff rows untouched), the meeting action-item row becomes a whole-row link to `/transcripts/{id}`
with chevron and `.focus-ring` and "Done" as a separate control in the right slot, the "N unread" chip becomes a
quiet "Mark all as read" shown only when unread event rows exist (if no persisted seen-marker exists today, hide
the control rather than adding a field), empty state "Nothing needs you right now." + quiet link "Open your
calendar". Badge count must equal the rows rendered for that viewer.
Acceptance: the five test files listed green; `grep -n "GEO-04\|GEO-27\|GEO-35\|GEO-11" src/lib/seo-geo.ts`
shows them only in `REC_COPY` (plan catalogue), not in client suggestions; `grep -n "Seats" src/app/\(app\)/clients/\[id\]/settings/page.tsx`
is empty; no `hover:text-neon` in files you own.

### F. Agents tab roster rows and not-set-up states
Owns: `components/client-agents/roster.tsx`, `components/client-agents/roster-card.tsx` (rename or replace with a
row component; KEEP a named export `RosterStatusBadge` with the current props from `roster-card.tsx` so B and E can
import it; if you move it, re-export from `roster-card.tsx`), `components/client-agents/agent-setup-hero.tsx`,
`components/client-agents/types.ts` if a field is needed, `lib/client-agent-rows.ts` (+ test) only if the row
needs a derived field, `lib/agent-blurbs.ts` read-only.
Scope: think-agents §4 with decision 6: one full-width row per agent, `min-h-[64px]`, whole row one `<Link>`;
columns: identity (mark + name + one-line blurb) · `RosterStatusBadge` · last made (newest produced title,
relative stamp) · next (next planned day inside 14 days or the schedule's next fire) · verb + ONE trailing
`ChevronRight` (Live / Runs on request → "Create post" noun-aware; Setup needs attention / Needs attention →
"Set up" / "Launch" / "Add credits" per the reason; Setting up → "Open"; Not set up yet → "Request setup";
Coming Soon → no link, no chevron, greyed). Below `@2xl` the meta collapses to one 11px line. Rule 3 hover
(fill + hairline, static chevron, `.focus-ring`); no lift, no orange. Setup hero: no placeholder video frame
unless `previewVideoUrl` exists; the block is the sentence "Save what {agent} needs to know, and it starts
producing for you" and the setup button (keeps `accent`, it is the page's one orange). The data you need
(produced assets, planned runs) is already loaded by `agents/page.tsx` (E owns that file; if you need a new
prop threaded through, write the exact prop name and type into your handoff and E adds it).
Acceptance: `npx vitest run src/lib/__tests__/client-agent-rows.test.ts` green; no `hover:-translate`,
`shadow`, or `text-neon` in your components; `RosterStatusBadge` still exported from `roster-card.tsx`.

## 4. Verification and review (after all six land)

1. Handoffs in `docs/portal-round6/handoffs/*.md` applied by the owning package.
2. `npx tsc --noEmit` clean. `npx vitest run` green. `npm run build` passes.
3. Verifier agents (one per package) check acceptance criteria, rule 3 on every touched surface, parity, the
   orange count per screen, dead code (removed components with no remaining imports, unused copy tables),
   and no dead ends.
4. Fable alignment review of the whole diff against `albert-brief-round6.md`, `risk-review.md` and this file.
5. Full code review (`/code-review` at high effort) and a simplification pass; fixes applied.
6. Dev server on localhost; walk Home, Agents, an agent page, Create a post (do NOT press the confirm), Reporting,
   Profile, the bell; screenshots.
