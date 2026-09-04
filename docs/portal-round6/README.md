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

## Where the process stopped

1. Three "thinking" docs written in parallel, complete.
2. Risk review done (`risk-review.md`). Main cuts: no six-state status rename, no client uploads in the run
   dialog, no "Ask about it", no site-access flag, "Coming Soon" is not "Paused". Main rulings: one
   `RosterStatusBadge` everywhere; the run/setup/launch control keeps the one `accent`, the dialog confirm
   and kickoff strip go `primary`; Live = `rosterStatus` with `isUpcomingPost` + 14-day ceiling, read by the
   ladder too; Reporting's per-agent control is `Button outline` "Open {name}"; not-on-plan rows get Support
   only (clients get `notFound()` on ungranted agent pages).
3. The approval PDF is written and sent to Albert (`round6-approval.pdf`). **Waiting on his approval and
   his answers to the 10 decisions on page 6.**

## Next steps, in order

1. Albert approves the PDF and answers the decisions (a plain "yes" takes every recommendation).
2. Branch from **`origin/main`** (never the stale local `main`). Ship in the PDF's order, one PR each, prep
   only: primitives + status predicate; Reporting; status badge + Agents tab + rail; Get set up; Create a
   post; notifications clean-up. Executors on Opus 5, logic/copy on Fable 5.1, a risk agent reads each PR
   against `albert-brief-round6.md` and `risk-review.md` before merge.
3. Test pins that change on purpose are listed in `risk-review.md` §F; invert
   `agent-detail-archetypes.test.ts` ~:726 with the predicate fix or CI fails.

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
