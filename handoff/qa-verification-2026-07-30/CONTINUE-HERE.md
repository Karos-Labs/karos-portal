# Continue here — Karos portal finalisation, session handoff

**This branch is a handoff carrier. Never merge it into `main`.** It exists so a Claude Code session
on a different account can pick up mid-stream. Committed report files in the main tree are a live
sore point with the team — if you need any of this on `main`, extract the *fix*, not the paperwork.

Read this file first, then the two prompts in §7.

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
