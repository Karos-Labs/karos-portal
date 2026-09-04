# Client portal, round 6 — planning handoff (2026-09-04)

State of play: **planning only, no code written for round 6.** Everything from rounds 1–5 is
merged and live on **prep** (PRs #73, #76, #79, #81 on top of `532bf1b`). Production has not
been touched since the manual promote of `0fef40a`; keep it that way (merges reach prep only,
the "Promote to Production" workflow is manual and must not be run as part of this work).

## What is in this folder

| File | What it is | Status |
|---|---|---|
| `albert-brief-round6.md` | Albert's rulings for this round + the standing rulings from rounds 1–5. **The constitution: read first.** | final |
| `think-home.md` | Home: interaction rules (what lights up / is clickable), Get-set-up ladder redesign, notifications. | done, unreviewed |
| `think-agents.md` | Agent status model (why "runs on request" shows for a live agent, root cause in `agent-detail-archetypes.ts`), run dialog, sidebar, agents-tab roster. | done, unreviewed |
| `think-reporting.md` | SEO/GEO report: "things only you can do" allow-list, new "What we are doing for your SEO and GEO" section, Seats card removal. | done, unreviewed |
| `context/` | Rounds 4–5 design docs (ladder, credits, flow audit, UX deep dive with the recommendation status list) and the PR log text sent to Tomer. | implemented |

## Where the process stopped

1. Three "thinking" docs above were written in parallel and are complete.
2. A **risk review** of the three docs against the brief was started and died on a rate limit
   before writing anything. Its task: find derailments (re-opened settled decisions, a second
   orange CTA, parity breaks, em dashes in client copy, unasked features), contradictions
   between the three docs (status vocabulary, "Support" vs "Ask about it", ladder step 3 vs the
   status model), spot-check 12+ `file:line` claims, list Albert's asks covered / not covered,
   and merge the three "Decisions Albert must make" lists into one deduplicated list.
3. **Not started:** the ONE short high-level PDF Albert asked for ("what can be changed, where it
   breaks, what can be done better"; he will not read details). He approves that PDF **before**
   any implementation.

## Next steps, in order

1. Run the risk review (step 2 above) and apply its cuts to the three docs.
2. Write the short PDF (brand fonts are installed locally as `karos-Hanken_Grotesk-*`,
   `karos-Spectral-*`, `karos-JetBrains_Mono-*` in `~/Library/Fonts`; Ember light "paper"
   treatment; one section per area; end with the consolidated decisions list). Send to Albert.
3. Only after his approval: branch from **`origin/main`** (never the stale local `main`),
   implement, PR with auto-merge, lands on prep.

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
