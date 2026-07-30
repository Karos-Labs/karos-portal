# Continue here — Karos portal finalisation, session handoff

**This branch is a handoff carrier. Never merge it into `main`.** It exists so a Claude Code session
on a different account can pick up mid-stream. Committed report files in the main tree are a live
sore point with the team — if you need any of this on `main`, extract the *fix*, not the paperwork.

Read this file first, then the two prompts in §7.

---

## 0. Division of labour — read this before you touch anything

The session that produced this branch **deliberately changed no portal code.** It was a verification
and preparation session only: `git diff origin/main..<this branch> -- src/ docs/ scripts/` is empty,
and the branch adds nothing but this `handoff/` directory.

**You are the session that makes the changes.** Specifically:

1. Daniel will paste **Albert's meeting notes** — the list of what Albert actually wants fixed. Those
   notes are the priority order. This document is the map you read them against, not a competing
   backlog. Where a note and this document describe the same thing, use the `file:line` references
   here (they are current as of `5b28c29`) instead of searching from scratch.
2. Anything in §3, §4 or §5 that Albert's notes do not mention is **not automatically in scope.**
   Surface it, let Daniel decide, and do not quietly widen the job.
3. Run the deeper sweeps here, on this account — see §7b. Two of them were cut short by a spend limit
   and their findings, where they exist, are appended at the end of this file under
   "Appendix — later sweep results".

Branch from `main` for the fix work. Do not commit to `main`, and do not merge this carrier branch.

---

## 1. Where things stand

The 137-finding QA sweep (Daniel's document, 2026-07-27) was implemented by Albert's agent run over
~20 hours and merged to `main` as **`5b28c29`** — 500 commits, 425 files, +52,413/−4,497 lines.
Pre-campaign baseline is **`ddcef3e`**; every `file:line` in the original QA document refers to it,
so line numbers have moved.

**That merge has now been verified.** Result: **114 fixed · 12 partial · 11 done-differently ·
0 untouched · 0 regressed · 0 fix-was-wrong.** `tsc --noEmit` clean, 1419 tests pass in 97 files.
The merge is live in production. Nothing was ruined.

Settled facts — **do not re-derive these**:

- Albert's `F<n>` is **exactly** Daniel's `#<n>` for all 137. No renumbering, no orphans either way.
- Per-finding verdicts with `file:line` at HEAD: **`verdicts-137.json`** in this directory.
  Keys are finding numbers; each value has `verdict`, `evidenceNow`, `detail`, `agreesWithLedger`,
  `newBug`, `newBugDetail`, `needsHumanEyes`, `humanEyesWhy`.
- The full write-up: **`VERIFICATION-REPORT-2026-07-30.md`** in this directory.
- The source findings, sliced by cluster, with each finding's original `whatYouSee` / `whyItsWrong` /
  `evidence` / `fix`: **`finding-slices/*.json`**.
- Albert's own records live in the repo at `docs/qa-sweep-2026-07/` — `LEDGER.md` (his per-finding
  status), `TOMER-HANDOVER.md` (1,921 lines, his account of what he built and deliberately left),
  `rescopes.md`, `phase3-design.md`, `tomer-reconciliation-map.md`, `call-directives-2026-07-27.md`,
  and `inventory/` (5 findings files + ~88 screenshots). **It is an honest document, including about
  its own gaps** — treat its claims as testable, not as fact, but don't assume bad faith.

## 2. The 11 ledger rows that overstate the result

Albert reports 131/137 RESOLVED. These 11 are really `partial`. None is a lie — a real majority of
each fix landed — but the row should not read RESOLVED:

`#11` `#24` `#27` `#35` `#37` `#50` `#65` `#67` `#71` `#145` `#148`

**`#24` is the one that matters — a blocker, still visible in production, and it is the QA
document's fault rather than Albert's.** The fix instruction only asked for `schedule.lastError`,
which captures *submit-time refusals*. A run that submits fine and then fails at the agent service
never sets it, so the pilot client's Instagram Agent currently shows a green **"Live"** badge while
its only run reads **"Failed"**. Fix = key the badge off last-run outcome, not off `lastError`.

## 3. New defects found while verifying (17, unrefuted)

Full detail in the report, §"New defects found while verifying". The five worth doing first:

| Rank | # | Defect | Where |
|---|---|---|---|
| 1 | #103 | A CLIENT_USER may have **no sign-out at phone width** — `LogoutButton` is only in `account-menu.tsx`, mounted inside the `hidden … md:block` aside | `client-rail.tsx` |
| 2 | #107 | **"Publish Now" renders on unapproved drafts and on "Karos never posts it" placeholders**, and `publishAssetNowAction` refuses neither. Pressing it really posts | `asset-card.tsx:481` |
| 3 | #86 | Client-triggered LLM call with **no credit charge** — `generateDocSummaryAction` fires on every drawer open, no `chargeClientCredits`, no `isBillableClientActor` branch | `client-documents.tsx:460-472` |
| 4 | #16 | Four SEO/GEO checks promoted to lever `"BOTH"` are now **excluded from both markdown briefs** (`buildSeoBrief` filters `=== "SEO"`, `buildGeoBrief` filters `=== "GEO"`; neither accepts `"BOTH"`) | `src/lib/intel/seo-geo.ts:637,734` |
| 5 | #11 | **Duplicate rows with contradictory chips on the client action plan** the `#1` fix just mounted — `healRecommendations` heals copy without deduping, so legacy snapshots show one action twice, and both share a `recId` so approving one flips both | `seo-geo/presenter.ts:945-947` |

## 4. Daniel's own named ask — the "account settings" defect

His words: *"'account settings' should go back to the line that has to do with everything settings
related and stay on that line — it shouldn't be its own button."*

Confirmed and diagnosed. In `src/app/(app)/clients/[id]/settings/page.tsx`:

- The campaign introduced a `SettingsTabs` row — Profile · Channels · Credits · Automation ·
  Meetings · Team — built at **:224-231**, rendered at **:259**.
- **"Account settings" was left where it was at baseline**: a detached `PageHeader` action link to
  `/settings` at **:238-247**. It predates the campaign (it is identical at `ddcef3e:79-90`), so this
  is not a regression — but the campaign created the tab row that it now visibly fails to join.
- The campaign also **deleted the "Account" card** that used to close this page (`ddcef3e:215`),
  which held the Sign out button. That deletion is `#103` above, and it is why the two issues are
  really one: `/settings` is where a client's account controls now live, so the route to it must be
  obvious and reachable at every width.

**The fix Daniel is asking for:** make "Account settings" a member of the settings row rather than a
stranded header link — either a seventh entry in `SettingsTabs` that navigates to `/settings`, or an
item rendered inline on that same row. Do it in `settings-tabs.tsx` + `settings/page.tsx`, and while
you are there resolve `#103` by making sure sign-out is reachable below `md`.

## 5. Waiting on a human, not on code

Six ops steps, none run. **Standing warning from Albert's §2: the dev `.env.local` points at
production Firestore.** Every script is dry-run by default and writes only with `--apply`.

| Step | Unblocks | How |
|---|---|---|
| §2.1 | `#127` | `npx tsx scripts/backfill-agent-blurbs.ts --apply` |
| §2.2 | `#33` | `npx tsx scripts/backfill-asset-titles.ts --apply` |
| §2.8 | Phase 3 on existing clients | `scripts/backfill-client-agents.ts`, per client |
| §2.9 | CD-G7 fleet data quality | `refresh-apply.ts --apply`, per client |
| **§2.10** | **`#130`, and every client Launch button** | set `creditCost` + `launchCreditCost` per agent in the admin editor — **no script exists** |
| §2.11 | roster completeness | `grant-all-agents.ts` sanity pass |

**§2.10 blocks the demo.** The live staff panel reads *"Launch price now: not set — clients cannot
launch it"*. Until an admin types prices in, the entire client Launch flow the campaign built is
inert and every card still shows the flat 25 credits `#130` was raised about.

Product calls Albert explicitly refuses to make (his §5.1). The sharpest:

> **The X agent forgets its clients in ~10 days.** `FEEDBACK_ROWS_PER_ACCOUNT = 30`, and the window
> is per *account bucket*, not per client. Each daily pick auto-writes the two unpicked options as
> `not_posted`, and marking the winner posted writes a third — **3 rows/day**, not the 2 the original
> ruling assumed. A single-account client exhausts the window in ~10 days, evicting the genuine human
> feedback the log exists to carry. Options in his order: raise the cap; split the auto-log into its
> own stream; or decay auto-rows faster than human ones.

Also: `#77` corrections are absolute ground truth with no cap, expiry or supersession, so every
correction ever made is re-injected into every future run at Karos's token cost
(`data.ts:1576-1586` returns up to 100 rows undeduplicated).

One infrastructure item that silently weakens a fix marked resolved: `#78` moved regeneration into
`after()`, but `cloudbuild.yaml:139-142` sets memory/CPU/timeout/concurrency and **no CPU-allocation
flag**, so Cloud Run throttles the CPU once the response is sent and the multi-minute pipeline can be
killed holding its lock. `agent-service/cloudbuild.yaml:92` already sets `--no-cpu-throttling`; the
portal's does not. Albert flagged this himself (handover §3.1).

## 6. Work Albert did that his handover never mentions

Found in the git history, not in his docs. Worth knowing because it is unreviewed and security-shaped:

- `08af8c8` — **XSS fix**: escaped script-context interpolation in the OAuth popup shell. Found by
  his own verifier, not by any of the 137.
- `25dcc0b` — the Ops Import **scans GitHub** for proposals; merged with a **path-traversal fence**.
- `e440f0b` — inverted the copilot tool fence from a denylist to an **allowlist**, so a newly added
  tool is client-invisible until explicitly listed.
- `2dc047b` — **`stripPreamble` data-corruption fix**, three vectors, 38 tests (20 red pre-fix).
- `02f56b4` / `c1adef2` — the §2 guard rail keys on the **billed** actor, and a client can no longer
  **pause-and-resume past it**.
- `b86323f` — fenced the `/clients` counts map so an employee's RSC payload no longer carries data
  for clients outside their assignment.
- `d3c15c9` — fenced the workspace invite key and gave it a rotate control.
- `bba1932` — he found and fixed **his own vacuous tests** ("close the guards that could not fail").

Three PRs are **open** against the repo and are not part of this merge: **#28** `te/prep-prod-environments`
(CI prep/production deploy environments), **#27** `dh/reddit-account-lookup`, **#26**
`claude/reverent-vaughan-c73c1d` (sweep `liDraftFeedback` on client delete).

## 7. What to run next

Two prompts, in this order. Both assume you are in the repo at `main` (or a fresh branch from it).

### 7a. Apply the fixes

> I am finalising the Karos portal. Read `handoff/qa-verification-2026-07-30/CONTINUE-HERE.md`, then
> `VERIFICATION-REPORT-2026-07-30.md` in the same directory for detail, and `verdicts-137.json` for
> the machine-readable per-finding state. Do not re-verify the 137 — that is done.
>
> I will paste meeting notes from Albert listing the fixes he wants. Work from those notes as the
> priority list. Where a note overlaps something already in the report, use the report's `file:line`
> at HEAD rather than searching from scratch. Start with §4 (the "account settings" row placement and
> the phone sign-out, which are one problem) and the top five in §3.
>
> Repo rules are in `CLAUDE.md` and `AGENTS.md` — server-action writes, epoch millis, credits
> vocabulary, and **read the relevant guide in `node_modules/next/dist/docs/` before writing code**;
> this is Next.js 16 and differs from training data. Client-facing copy must be sentence-cased,
> spell-checked, and free of lab vocabulary — that is a standing rule, applied unprompted.
>
> Branch from `main`, never commit to it directly. Do not merge this handoff branch.

### 7b. Finish the two audits that were cut

Both of these were killed mid-run by the org's monthly spend limit and are the largest remaining
holes. The scripts are reusable; re-run them rather than re-authoring:

- **The ~30k lines of unrequested campaign work have never been reviewed** — credits, auth/role
  boundaries, scheduler, webhook, regressions, silent reverts, copy QA, Firestore
  backward-compatibility, coherence, test quality. In particular: **what do existing production
  documents do when the campaign's new fields are absent?** That is the state of the database right
  now, since no backfill has run. A new `.filter()` on a field no historical record carries would
  silently empty a client's screen.
- **The adversarial re-check of all 137 verdicts** never ran, so the 17 new defects in §3 are
  single-pass leads. Refute them before acting on the marginal ones; the top five are solid enough to
  act on directly.

## 8. Two things that are NOT portal bugs — do not file them

1. **`Sign in as` on `/team`.** It is wired correctly (`team-manager.tsx:72-77` →
   `startImpersonationAction` → `startImpersonation`, `auth.ts:317`; `CLIENT_USER`-only target,
   httpOnly `karos_impersonate` cookie). Three clicks produced no navigation in the verifying session,
   but that traced to browser tooling: Daniel's Chrome reported `devicePixelRatio 1.5` at 53% zoom and
   the extension returned a cropped 914px-wide capture of a 1705px page, so ref-derived click
   coordinates landed off-target. Worth one manual confirmation, as
   **`qa-lens@karoslabs.com`** (the purpose-built client account on Karos Labs — note the hyphen).
2. The ~40 client-role findings remain **code-verified only**. A real client-role session was never
   completed, in this round or when the document was written. One manual pass as the account above
   closes that gap.

## 9. Repo hygiene, still outstanding

All still tracked at `origin/main`, and `.gitignore` has no rule for any of it: **7 root-level
`*.png`**, **`dev-error.log`**, **`_backup/`** (7 Firestore snapshots, no credentials). Tomer owns
this and has not done it. Deleting the files does not shrink history.

## 10. Deploy — "merged" is not "live"

Cloud Run service `karos-cmo`, region `europe-west1`, project `karoscmo`. `app.karoslabs.com` and
`karos-cmo-42999994788.europe-west1.run.app` are the same service. Deployment is a Cloud Build
trigger on `^main$`; a push builds and deploys ~4 min later. **There is no deploy workflow in GitHub
Actions.**

The trap, hit on 2026-07-27: traffic routes 100% to `latestRevision: true`, so **any manual
`gcloud run deploy` silently outranks the pipeline** and reverts merged code in production with
nothing wrong on the GitHub side. `--to-latest` does not fix it — latest *is* the bad one. Re-run the
trigger instead. Diagnose with:

```bash
gcloud run services describe karos-cmo --region europe-west1 --project karoscmo --format="yaml(status.traffic,status.latestReadyRevisionName)"
```

`gcloud auth login` expires every day or two and must go through Chrome. `timeout` is not installed
on Daniel's Mac — don't wrap `gcloud` in it.

---

## 11. Slot for Albert's meeting notes

Paste them here (or alongside, as `ALBERT-MEETING-NOTES.md` in this directory) before starting the fix
work, so the priority list travels with the branch instead of living only in a chat scrollback.

Known from Daniel already, ahead of the notes:

- **"Account settings" must join the settings row** and stop being its own button — §4. Bundle the
  phone sign-out lockout (`#103`) into the same change; they are one problem.

---

## Appendix — later sweep results

Two sweeps were commissioned after the main verification and are recorded here when they complete.
If a section below is empty, that sweep did not finish and is still owed:

### A. Unrequested-work audit (credits · auth/roles · scheduler · webhook · regressions · silent
### reverts · copy · data-compat · coherence · test-quality)

_Status: **NEVER COMPLETED — zero results, twice.** Killed by the org spend limit on the first run,
then stopped mid-flight on the re-run when credit ran out. Treat the whole area as unreviewed and re-run it — it is the largest remaining hole, and the Firestore
backward-compatibility question in §7b is the highest-stakes part of it._

### B. Navigation and button-wiring sweep — PARTIAL (5 of 10 clusters)

Stopped early: Daniel ran out of credit. **5 of 10 clusters completed; 55 findings.** The clusters that finished are staff-shell, client-shell, settings, agents and part of dashboard/SEO. **Not yet swept: intake pages, workspace/tasks/archive, calendar/documents, notifications/deep-links, admin/ops-import/jobs/assets/team/connect.** Re-run those five.

**These are UNREFUTED** — the adversarial confirm stage did not run. Two independent clusters found the sign-out blocker separately, and the settings cluster independently confirmed Daniel's own "account settings" complaint, so the high-severity end is credible. Verify before acting on the medium/low tail.

Machine-readable, with full clickPath / control / destination / suggestedFix for each: **`nav-sweep-partial.json`** in this directory.

Severity: **2 blocker · 19 high · 20 medium · 14 low**

| Sev | Kind | Role | Finding | Control |
|---|---|---|---|---|
| blocker | unreachable-at-width | CLIENT_USER | CLIENT_USER has no sign-out at any width below md — the campaign deleted the only phone-reachable one | `src/components/client-rail.tsx:209` |
| blocker | unreachable-at-width | CLIENT_USER | CLIENT_USER cannot sign out at phone width — the only sign-out is inside the desktop-only aside, and the campa | `src/components/client-rail.tsx:280` |
| high | stranded-control | CLIENT_USER | Client shell's "Settings" is built as a nav item and then never rendered in the nav — it hides in a credits pi | `src/components/client-rail.tsx:88` |
| high | 404 | CLIENT_USER | A CLIENT_USER whose client document is gone gets the STAFF sidebar, and two of its nav rows 404 | `src/components/sidebar.tsx:411` |
| high | unreachable-at-width | CLIENT_USER | CLIENT_USER has no sign-out control below md — LogoutButton is only inside the desktop-only aside | `src/components/account-menu.tsx:99` |
| high | wrong-destination | CLIENT_USER | Credits pill in the client rail lands on the Channels tab, not Credits | `src/components/client-rail.tsx:190` |
| high | 404 | CLIENT_USER | Meetings tab links a client to transcripts that are hidden from clients — the destination 404s | `src/app/(app)/clients/[id]/settings/page.tsx:194` |
| high | role-dead-end | CLIENT_USER | A client group admin cannot reach /team above md — the Team tab shows only the invite key and never links to t | `src/components/client-rail.tsx:294` |
| high | wrong-destination | CLIENT_USER | Client attention row "N pending tasks" lands on the board tab that filters those tasks out | `src/components/client-home-overview.tsx:148-155 (Attention` |
| high | unreachable-at-width | CLIENT_USER | Group-admin CLIENT_USER can only reach /team below md — the desktop rail has no Team link at all | `src/components/client-rail.tsx:294` |
| high | param-ignored | CLIENT_USER | The "Credits" pill lands on the Channels tab, not Credits — the destination reads ?tab= and no control in the  | `src/components/client-rail.tsx:191` |
| high | lying-state | CLIENT_USER | Notification-bell rows inside the Company sheet leave the sheet open — the same same-route trap the campaign f | `src/components/client-rail.tsx:307` |
| high | lying-state | CLIENT_USER | "Generate with AI" in the client's Brand Colors editor is enabled for a CLIENT_USER but the server action requ | `src/components/branding-modal.tsx:224` |
| high | lying-state | CLIENT_USER | Client roster badge and agent-page badge disagree for any agent bound with "Add as live" | `src/app/(app)/clients/[id]/agents/page.tsx:124` |
| high | wrong-destination | CLIENT_USER | "Open your Workspace" lands a client on the task board, not the archive that holds the agent's work | `src/app/(app)/clients/[id]/agents/[agentId]/page.tsx:770` |
| high | dead-end | CLIENT_USER | Inputs band badges an agent "Ready to run" on a page that offers a client no way to run it | `src/components/client-agents/agent-sections.tsx:151` |
| high | role-dead-end | KAROS_EMPLOYEE | KAROS_EMPLOYEE's client-context picker is structurally always empty — the layout never passes them a client li | `src/components/sidebar.tsx:617` |
| high | wrong-destination | KAROS_EMPLOYEE | Every staff-facing "manage channels / reconnect" link lands on the Profile tab instead of Channels | `src/app/(app)/clients/[id]/agents/page.tsx:353` |
| high | stranded-control | any | "Account settings" is a detached PageHeader link sitting beside — not inside — the settings tab row | `src/app/(app)/clients/[id]/settings/page.tsx:239` |
| high | wrong-destination | any | LinkedIn seat OAuth returns to the default settings tab and its status param is read by nothing | `src/app/api/integrations/linkedin/employee/callback/route.` |
| high | lying-state | any | Reddit agent renders posting vocabulary throughout the legacy panel | `src/components/client-agents/legacy-agent-panel.tsx:135` |

The medium and low findings are in the JSON; they are mostly copy-and-placement items of the same family. Themes worth reading as a group rather than one at a time:

- **Settings deep links are systematically wrong.** `SettingsTabs` reads `?tab=` but **no control anywhere in the app ever sets it**, so every link into settings opens whatever tab happens to be first after role filtering. The client "Credits" pill lands on Channels; every staff "Manage integrations →" / "reconnect" link lands on Profile. One fix — set `?tab=` at the call sites — closes several findings at once, and it is the same root cause as Daniel's "account settings" complaint: the settings row is the app's weakest-wired surface.
- **Controls enabled where the server refuses.** "Generate with AI" in the client Brand Colors modal is enabled for a CLIENT_USER but the action requires staff, so it fails with a raw "Forbidden". Same family as findings #131 and #25.
- **Client destinations that filter out the thing that sent you there.** The attention row's "N pending tasks" lands on a board tab that excludes them; "Open your Workspace" on an agent page lands on the task board rather than the archive holding that agent's work; the client Meetings tab lists staff-hidden transcripts whose rows 404. Same family as #51/#64/#65.
- **Below-`md` gaps beyond sign-out.** A group-admin client can only reach `/team` on a phone; the desktop rail has no Team link at all. Notification rows inside the Company sheet leave the sheet open on a same-route tap.
- **A CLIENT_USER whose client document is deleted gets the STAFF sidebar**, and two of its nav rows 404. Worth a guard regardless of how rare it is.
- Two things I had already flagged from the 137 verification were independently re-found here, which raises confidence in both: the **employee client-context picker is structurally always empty**, and the **Reddit agent renders posting vocabulary** in the legacy panel.
