# Client portal, round 6 — planning handoff (2026-09-04)

State of play: **planning complete, awaiting Albert's approval of the PDF. No code written for round 6.** Everything from rounds 1–5 is
merged and live on **prep** (PRs #73, #76, #79, #81 on top of `532bf1b`). Production has not
been touched since the manual promote of `0fef40a`; keep it that way (merges reach prep only,
the "Promote to Production" workflow is manual and must not be run as part of this work).

## What is in this folder

| File | What it is | Status |
|---|---|---|
| `albert-brief-round6.md` | Albert's rulings for this round + the standing rulings from rounds 1–5. **The constitution: read first.** | final |
| `think-home.md` | Home: interaction rules (what lights up / is clickable), Get-set-up ladder redesign, notifications. | done, reviewed |
| `think-agents.md` | Agent status model (why "runs on request" shows for a live agent, root cause in `agent-detail-archetypes.ts`), run dialog, sidebar, agents-tab roster. | done, reviewed; its six-state rename was CUT by the risk review |
| `think-reporting.md` | SEO/GEO report: "things only you can do" allow-list, new "What we are doing to improve your SEO and GEO" section, Seats card removal. | done, reviewed |
| `risk-review.md` | Fable risk pass over the three docs: derailments (cuts), one ruling per contradiction (B1-B6), 22 code spot-checks, coverage matrix, the 10 consolidated decisions, implementation risks. **Rulings here override the think docs where they differ.** | final |
| `round6-approval.pdf` (+ `.html` source) | The one short document Albert approves. 7 pages: cover, 8 areas, decisions, shipping order. Rebuild: Chrome headless `--print-to-pdf` over the html (brand fonts from `~/Library/Fonts`). | sent to Albert 2026-09-04 |
| `context/` | Rounds 4–5 design docs (ladder, credits, flow audit, UX deep dive with the recommendation status list) and the PR log text sent to Tomer. | implemented |

## State on 2026-09-06: implemented, on this branch, not merged

Everything approved in `round6-approval.pdf` is built on **`claude/portal-round6`** (commits f25ee787 and
28f52767). Typecheck clean, 5753 tests green, `npm run build` passes. No PR is open yet; Albert reviews it
on localhost first. Process record: `impl-brief.md` (the contract the executors worked from, with file
ownership), `risk-review.md`, `alignment-review.md`, `verify-ACF.md`, `verify-BDE.md`, and
`handoffs/INTEGRATION.md` (every integration, review fix and the 2026-09-06 orange restore).

Rulings added during implementation, all final:
- Meters, bars, sparklines and card icon chips KEEP their orange; the one-orange rule is about controls
  (Albert, 2026-09-06). The primitives test pins this.
- One status source: `buildClientRosterEntries` in `src/lib/client-roster.ts` feeds Home's ladder, the
  Agents tab (client and staff scope), the agent page and Reporting. Never assemble `rosterStatus` inputs
  elsewhere.
- Documents are confirmed only by the client (`canConfirm={isClientViewer}`); staff see the read-only line.
- Ladder step 5 is done when the client opened a post or has a deliverable that aged out of the archive
  window; the card hides only when dismissed AND complete, so a later grant can reopen it.

## Next steps

1. Albert walks the portal on localhost (`npm run dev` in a worktree with `node_modules` and `.env.local`;
   the pane needs a normal sign-in, never a minted token). Never click writes on localhost: `.env.local`
   is production Firestore.
2. Before the PR: the ops attribution check from `think-agents.md` §0 against production (combined
   `karos-instagram-tiktok-content-agent` card vs posts imported from the plain `instagram-agent` folder),
   because widening "upcoming" flips every client with imported future drafts to Live at once.
3. Expect existing clients who never pressed "Hide this" to see the checklist at 5 of 6 with "Open your
   first post" on ship day; one click clears it.
4. PR from `claude/portal-round6` to main with auto-merge, lands on **prep only**. Do not run the
   production promote.

Round-7 candidates (from `alignment-review.md`): Profile's two orange saves and the document panel's orange,
the whole-rail restyle beyond the agents block, the phase-2 client notification feed, "More ways to get
value" after the ladder.

## Non-negotiables while implementing (all confirmed by Albert in earlier rounds)

- Staff "client context" == client portal. Staff extras only as additive `StaffOnlySection` /
  `Internal` badge blocks; never a staff-only branch that changes shared layout.
- Ember: ONE rationed orange (`--neon`) per screen; judgment colours only for status; no new colours.
- No em dashes in client-facing copy (a test enforces it).
- Recommended tasks are the fixed setup ladder (`src/lib/setup-ladder.ts`), never content ideas.
- The canned SEO "what we're fixing" plan is gone for good. Facebook is removed everywhere.
  Archive lives on the calendar (`?view=archive`), Meetings is a sub-section, Documents live in Profile.
- Schedule-a-run on the calendar is staff-only.
- Credits v2 stays behind `CREDITS_PLAN_V2_ENABLED`: on for prep, **off in production**
  (`cloudbuild.promote.yaml` pins `"0"`). 2600 credits/month, runs settle to actual cost × 20/USD.
- Still open, do not decide silently: brand-voice editing by the client; credit top-up.
- `.env.local` in the worktrees points at the **production** Firestore. Never click write actions
  on localhost. Never paste session tokens into the page; sign in normally.
