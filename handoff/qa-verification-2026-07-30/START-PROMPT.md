# The prompt to paste into a fresh Claude Code session on the other account

Paste everything between the rules. Then paste Albert's meeting notes as your next message.

---

I'm finalising the Karos portal (`karosCMO`). A previous session verified a large merged QA campaign
and left me a handoff branch. **Your job is to fix things — that session deliberately changed no code.**

## Step 1 — get the handoff and read it

```bash
git fetch origin && git checkout claude/portal-qa-review-1b52a2
```

Read `handoff/qa-verification-2026-07-30/CONTINUE-HERE.md` in full before anything else. It is the map.
Alongside it in that directory:

- `VERIFICATION-REPORT-2026-07-30.md` — the detail behind every claim
- `verdicts-137.json` — per-finding state for all 137 QA findings, with `file:line` current as of `5b28c29`
- `nav-sweep-partial.json` — 55 navigation findings (2 blocker, 19 high) with click paths and suggested fixes
- `finding-slices/*.json` — the original findings, including each one's `fix` instruction

**Do not re-verify the 137.** That is done: 114 fixed, 12 partial, 11 done-differently, 0 regressed.
Re-deriving it wastes the budget I'm paying for. Use the `file:line` references in those files instead
of searching from scratch — they are current.

Then work from `main`, not from the handoff branch:

```bash
git checkout main && git pull && git checkout -b fix/portal-finalisation
```

**Never merge `claude/portal-qa-review-1b52a2` into `main`.** It is a paperwork carrier. Committed
report files in the main tree are a sore point with my team — keep your commits to product code.

## Step 2 — take my meeting notes as the priority list

My next message will be **Albert's meeting notes**: what he actually wants fixed. Those notes are the
priority order, ahead of everything in the handoff. Save them to
`handoff/qa-verification-2026-07-30/ALBERT-MEETING-NOTES.md` on the carrier branch so they travel with
the work, then start from them.

Rules on scope:

- Where a note and the handoff describe the same defect, use the handoff's `file:line`.
- Anything in the handoff that Albert's notes **don't** mention is **not automatically in scope**.
  List it for me and let me choose. Do not quietly widen the job.
- If a note is ambiguous, do the unambiguous part and ask me one specific question about the rest.
  Don't stall the whole batch on one question.

## Step 3 — two things I already know I want fixed

Do these regardless of whether Albert's notes mention them; they are mine.

1. **"Account settings" must join the settings row and stop being its own button.** In
   `src/app/(app)/clients/[id]/settings/page.tsx` the `SettingsTabs` row (Profile · Channels · Credits ·
   Automation · Meetings · Team) is built at ~:224 and rendered at ~:259, while "Account settings" sits
   apart as a `PageHeader` action link to `/settings` at ~:238. Bring it onto that row.

   While you are in there, fix the root cause the sweep found: **`SettingsTabs` reads `?tab=` but
   nothing in the app ever sets it**, so every link into settings opens whatever tab survives role
   filtering. My "Credits" pill lands on Channels; every staff "Manage integrations →" lands on
   Profile. Set `?tab=` at the call sites.

2. **A client user cannot sign out below `md`.** `LogoutButton` is mounted only via
   `account-menu.tsx:99` inside `client-rail.tsx:209`, which lives in a `hidden … md:block` aside. The
   mobile Company sheet has no sign-out, and `/settings` is 25 lines of `SettingsForm` with none. This
   is the same job as (1) — `/settings` is where account controls belong.

## Step 4 — finish the sweeps that were cut short

The previous session ran out of credit mid-sweep. Two gaps, both described with re-run briefs in
`CONTINUE-HERE.md` §7b and its appendix:

- **The ~30k lines of unrequested campaign work have never been reviewed at all** — credits, auth/role
  boundaries, scheduler, webhook, regressions, silent reverts, copy QA, Firestore
  backward-compatibility, coherence, test quality. Highest-stakes question in there: **what do existing
  production Firestore documents do when the campaign's new fields are absent?** No backfill has run,
  so that is the live state. A new `.filter()` on a field no historical record carries would silently
  empty a client's screen.
- **Five navigation clusters are unswept**: intake pages, workspace/tasks/archive, calendar/documents,
  notifications/deep-links, and admin-ops-import/jobs/assets/team/connect.

Sequence it as: fix Albert's list first, then sweep, then fix what the sweep finds. Tell me before
starting each phase roughly what it will cost, so I can stop at a phase boundary rather than mid-run.

## Step 5 — how to work in this repo

- Read `CLAUDE.md` and `AGENTS.md` first. **This is Next.js 16 and differs from your training data —
  read the relevant guide in `node_modules/next/dist/docs/` before writing code.**
- All Firestore access is server-side via `src/lib/data.ts` (Admin SDK). The browser uses Firebase only
  for auth. Writes go through server actions in `src/lib/actions/`, each authorizing via
  `getCurrentUser()` / `requireStaff()` / `requireAdmin()` / `requireClientAccess()`.
- Timestamps are epoch millis. Credits are never called "tokens".
- **Client-facing copy**: sentence-case, spell-checked, no lab jargon (`e13`, "sub-skill", "Path A"),
  no raw internal status words, em dash not spaced hyphen, never render raw LLM markdown. This is a
  standing rule — apply it unprompted, don't wait to be asked.
- Reddit is draft-only as a hard product rule. No posting code path may exist. One run drafts one reply.

Verify before you tell me something is done:

```bash
npx tsc --noEmit && npm test && npm run build
```

The baseline is **clean tsc and 1419 passing tests in 97 files** — if your change drops that count or
breaks the build, it isn't done. Where you fix something the 137 covered, add or extend a test so it
can't silently revert; that merge has a documented history of fixes being lost in merge resolutions.

## Step 6 — things that will cost me money or break production

- **The dev `.env.local` points at PRODUCTION Firestore.** Do not run any script in `scripts/` with
  `--apply` without asking me first. Dry-run output is fine to show me.
- On the live portal (`karos-cmo-42999994788.europe-west1.run.app`, pilot client Karos Labs at
  `/clients/iZLc0mtwSFXNKE2KkC2d`) **never click** `Run now`, `Start run`, `Confirm & Run`,
  `Apply Correction`, `Regenerate`, or the competitor `+ Add` — each spends real client credits or
  mutates data. Opening a dialog and pressing Escape is safe.
- For a genuine client-role view use `/team` → "Sign in as" on **`qa-lens@karoslabs.com`** (note the
  hyphen). That path is wired correctly — if clicks appear to do nothing it is browser-tooling
  coordinate scaling, not a portal bug. Don't file it as one.
- Deployment is a Cloud Build trigger on `^main$`; a merge to `main` deploys in ~4 minutes. **Any manual
  `gcloud run deploy` silently outranks the pipeline** and reverts production. Never hand-deploy.

Open a PR for review rather than pushing to `main`. Ask me before anything hard to reverse.
