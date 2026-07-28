# X agent hookup — rollback log

Branch `dh/x-agent-hookup` (base `759b936`, = origin/main at branch time). Per the
buildout brief §0: every change below lists its exact undo. Abandoning the attempt =
close the PR and delete the branch; main is untouched. Data changes (Firestore) are
applied only in Phase 3, each with a `_backup/<date>/` snapshot noted here first.

Format: one line per change — what · where · undo.

## Code changes (all on this branch; undo for any single item = revert the commit that introduced it; undo for everything = delete the branch)

| # | What | Where | Undo |
|---|---|---|---|
| 1 | This rollback log | `ROLLBACK.md` (new file) | delete the file |
| 2 | X intake types (ClientSeat, AgentIntake, XNewsUpdate, XTake, XDraftFeedback) | `src/lib/types.ts` (appended section) | delete the appended "X agent (e13) intake & seats" section |
| 3 | 5 new Firestore collection handles + CRUD | `src/lib/data.ts` (col entries + appended section) | remove the 5 `col` entries, the 5 type imports, and the appended CRUD section. New collections hold only data written by these surfaces; docs can be deleted wholesale without touching anything else |
| 4 | X intake server actions | `src/lib/actions/x-agent-actions.ts` (new file) | delete the file |
| 5 | Run-time context injection for X runs | `src/lib/agent-service/x-agent-context.ts` (new file) + guarded `isXAgent` block in `src/lib/actions/custom-agent-actions.ts` | delete the file, remove the import + the `if (isXAgent(...))` block — restores the exact previous submit flow for every agent |
| 6 | X intake page + components | `src/app/(app)/clients/[id]/x-agent/page.tsx`, `src/components/x-agent-intake.tsx` (new files) | delete both files |
| 7 | "X agent data →" links | `src/app/(app)/clients/[id]/agents/page.tsx` (2 header links) | remove the two `<a href=".../x-agent">` additions |
| 8 | X launch prompts aligned to run modes (was setup-oriented) | `src/components/custom-agents.tsx` `launchConfigFor` X branch | restore Yair's previous X branch text (in git history at `b3817a8`) |
| 9 | `XAI_API_KEY` passthrough (service → worker → runner sandbox) | `agent-service/src/config.ts`, `agent-service/src/queue/worker.ts`, `agent-service/runner/src/main.ts` | remove the three 1-2 line additions; absent key was already a no-op |
| 10 | Deploy wiring for xai-api-key secret + docs | `agent-service/cloudbuild.yaml` (`--set-secrets` entry), `agent-service/DEPLOY.md` (new section) | remove `XAI_API_KEY=xai-api-key:latest` from `--set-secrets` and delete the DEPLOY.md section. NOTE: do not deploy from this branch before the `xai-api-key` secret exists |
| 11 | X portal surfaces doc + canonical agent instructions text | `docs/x-agent-portal.md` (new file) | delete the file |
| 12 | Merge of origin/main (2026-07-22, LinkedIn e10 hookup + scheduler + custom-run refactor). Key resolutions: APIFY_TOKEN and XAI_API_KEY passthroughs coexist (config/worker/runner/cloudbuild); our X context injection MOVED from `custom-agent-actions.ts` into BOTH shared submit cores — `src/lib/jobs/submit-custom.ts` (web/MCP/run-scheduled) and `src/lib/agent-service/run-custom-agent.ts` (/api/scheduler) — as key-gated blocks | merge commit on this branch | revert the merge commit (`git revert -m 1 <sha>`); the two injection blocks + their imports are the only lines in main's files that are ours — removing them restores main's exact flow |

## Data changes (Phase 3, applied 2026-07-22 — Karos pilot seed)

All seeded docs are NEW (collections were empty — verified before writing). Undo for the
whole seed = delete the listed docs; nothing else references them.

| # | What | Doc(s) | Undo |
|---|---|---|---|
| D1 | Albert's seat | `clientSeats/wnk3rbc1EK8dI8XNabgF` | delete doc |
| D2 | Company X intake (@getkaros) | `agentIntake/sAEBPiJL2zDW1kCWECfW` | delete doc |
| D3 | Albert seat X intake (handle pending) | `agentIntake/IPhXqmH8uGyuufsBZr5P` | delete doc |
| D4 | 3 what's-new rows (2026-07-16, verbatim lab whats-new.json) | `xNewsUpdates/cdDVFTJTX6nP7cI6q5mM`, `xp1mDIbb4EXyd7Xbpo4u`, `1EgQZ2hbxYQTNxrbOg3w` | delete docs |
| D5 | Albert's 4 takes (verbatim lab takes.json) | `xTakes/GnRvPzKBzvzvJfPa5iHg`, `LJhwlUcYQQxYmPcQ7Ufw`, `oGfAkLFU7QZIcoa87saW`, `9B91v5GqzsDnkMS7q31H` | delete docs |
| D6 | karos-x-agent instructions replaced with the production text (docs/x-agent-portal.md block) | `customAgents/Qv6qtlZOObDVlSUXDzbb` | restore the `instructions` field from `_backup/2026-07-22/customAgents-Qv6qtlZOObDVlSUXDzbb.json` (full pre-change doc) |
| D7 | karos-x-agent instructions v2 (weekly menu + audit-driven craft gates) | `customAgents/Qv6qtlZOObDVlSUXDzbb` | restore `instructions` from `_backup/2026-07-22/customAgents-Qv6qtlZOObDVlSUXDzbb-v2-pre.json` |
| D8 | Albert's seat handle set to @alberree (was null/pending) | `agentIntake/IPhXqmH8uGyuufsBZr5P` | restore from `_backup/2026-07-22/agentIntake-IPhXqmH8uGyuufsBZr5P-pre-handle.json` |
| D9 | karos-x-agent instructions v3 ("a week of posts", no "menu") | `customAgents/Qv6qtlZOObDVlSUXDzbb` | restore `instructions` from `_backup/2026-07-22/customAgents-Qv6qtlZOObDVlSUXDzbb-v3-pre.json` |
| D10 | karos-x-agent instructions v4 (quote-comment 250-char budget, section-title pinning) + client-facing description replacing the lab setup text | `customAgents/Qv6qtlZOObDVlSUXDzbb` | restore `instructions` and `description` from `_backup/2026-07-24/customAgents-Qv6qtlZOObDVlSUXDzbb-v4-pre.json` |
| D11 | karos-x-agent instructions v5 (X Premium long-form clause) | `customAgents/Qv6qtlZOObDVlSUXDzbb` | restore `instructions` from `_backup/2026-07-24/customAgents-Qv6qtlZOObDVlSUXDzbb-v5-pre.json` |

## Deploy/config changes (applied 2026-07-22)

| # | What | Undo |
|---|---|---|
| C1 | Secret `xai-api-key` created in Secret Manager (by Daniel, console). agent-service-sa already had project-level accessor | `gcloud secrets delete xai-api-key --project karoscmo` |
| C2 | Portal auto-deployed from main by the existing `^main$` Cloud Build trigger (merge commit 0f84f37) | `git revert -m 1 0f84f37` + push (trigger redeploys), or roll the karos-cmo service back to the previous revision |
| C3 | agent-service api + worker + runner deployed at image tag `34b7953...` (build e60db965, 2026-07-22 10:31 UTC; previous tag `a287788...`) via `gcloud builds submit agent-service/cloudbuild.yaml` with `_REGION=europe-west1,_REPO=karos,_AGENTS_REF=main,COMMIT_SHA=34b7953...` | redeploy the previous images: rerun the same build with `COMMIT_SHA=a287788f222fe30e88e2446a1085b7d58518c002` checked out at that commit, or `gcloud run services update-traffic` to the prior revision + `gcloud run jobs update agent-runner --image=...agent-runner:a287788...` |

# LinkedIn agent (e10) hookup — rollback log

Branch `claude/linkedin-agent-integration-104140` (base `1c8f87c`, = origin/main at
branch time). Same rules as above: every change lists its exact undo; abandoning
the attempt = close the PR and delete the branch; data changes are applied only in
Phase 3, each with a `_backup/<date>/` snapshot noted here first.

## Code changes (all on this branch; undo for any single item = revert the commit that introduced it; undo for everything = delete the branch)

| # | What | Where | Undo |
|---|---|---|---|
| L1 | This section of the rollback log | `ROLLBACK.md` (appended section) | delete the section |
| L2 | AgentIntake union widened to "x" \| "linkedin" + LinkedIn seat fields (role, focus, fallbackKind/fallbackText, cvPath/cvUrl/cvName/cvUploadedAt) + LiDraftFeedback type | `src/lib/types.ts` (edits inside the intake section) | restore the union to `"x"`, remove the optional LinkedIn fields and the LiDraftFeedback interface — no existing doc carries these fields |
| L3 | `liDraftFeedback` collection handle + CRUD + `patchAgentIntake` helper | `src/lib/data.ts` | remove the col entry, the LiDraftFeedback import, the two appended functions, and `patchAgentIntake`. The new collection holds only data written by these surfaces |
| L4 | LinkedIn intake server actions (company form, seats incl. CV upload, per-draft feedback) | `src/lib/actions/linkedin-agent-actions.ts` (new file) | delete the file. Uploaded CVs live under `clients/<clientId>/linkedin-agent/cv/` in Storage — delete that prefix to purge |
| L5 | Shared company news box (SCRUM-51) extracted from the X intake; `addXNewsUpdateAction` + `saveXCompanyIntakeAction` revalidate both agent pages | `src/components/company-news-box.tsx` (new file), `src/components/x-agent-intake.tsx`, `src/lib/actions/x-agent-actions.ts` | delete the new file, restore the inline NewsBox in `x-agent-intake.tsx` and the single revalidatePath calls (git history at `1c8f87c`) |
| L6 | LinkedIn intake page + components + sidebar row + LinkedInLogo glyph | `src/app/(app)/clients/[id]/linkedin-agent/page.tsx`, `src/components/linkedin-agent-intake.tsx` (new files), `src/components/client-documents.tsx` (one `<li>`), `src/components/icon.tsx` (LinkedInLogo) | delete the two new files, remove the sidebar `<li>` and the LinkedInLogo export |
| L7 | Exact-key e10 launch profile (before the generic /linkedin/ brief) + `isLinkedInAgentIdentity` + `LINKEDIN_SETUP_REQUIRED_PREFIX` | `src/lib/custom-agent-launch.ts` | remove the inserted profile entry, the function, and the constant — the generic /linkedin/ profile then matches again |
| L8 | `linkedinSetup` gate threading (badge, pre-flight modal, post-error link) | `src/components/custom-agents.tsx`, `src/app/(app)/clients/[id]/agents/page.tsx` | remove the linkedinSetup props/blocks — the xSetup flow is untouched |
| L9 | Run-time context injection for LinkedIn runs (intake + shared news as company-updates.md §A + CVs + learning logs + prior batches) | `src/lib/agent-service/linkedin-agent-context.ts` (new file) + key-gated `isLinkedInAgent` blocks in BOTH submit cores (`src/lib/jobs/submit-custom.ts`, `src/lib/agent-service/run-custom-agent.ts`) | delete the file, remove the two imports + `if (isLinkedInAgent(...))` blocks — restores the exact previous submit flow for every agent |
| L10 | LinkedIn drafts parser + reader (pick-to-post via the verified `feed/?shareActive=true&text=` deep link, clipboard-first) + asset-card sniff (LinkedIn before X) | `src/lib/li-drafts.ts`, `src/components/li-drafts-review.tsx` (new files), `src/components/asset-card.tsx` | delete the two new files, restore the single xBatch sniff in `asset-card.tsx` |
| L11 | LinkedIn portal surfaces doc + canonical agent instructions text | `docs/linkedin-agent-portal.md` (new file) | delete the file |
| L12 | Adversarial-audit fixes (39 findings, 20+2 applied): company form answers optional (gate = form saved, a recorded deviation from the lab's zero-input Path A); shared news box gains source-for-number + consent fields and the template's type list; edit_request feedback action + Request a change in the reader; finalText cap 3,000; clipboard awaited before compose; exact-name media matching; parser account-scope fix + post-window bullet; prior batches scoped across ALL e10 agents; master gate accepts any LinkedIn intake; webhook prefers DRAFTS.md deterministically; asset-card media extension fallback + durable-URL filter; focus/fallback clears (FieldValue.delete); longest-name feedback matching (X too); CV content-type case fix; Section A cell sanitizing + Section B table; copy fixes (X-mention removed from seat form, CV privacy, jargon) | second commit on this branch (see its message for the file list) | revert that commit |

## Data changes (Phase 3, applied 2026-07-25 — Karos pilot seed)

All seeded docs are NEW (agentIntake had zero `agent="linkedin"` docs and the two
seat slugs were free — verified by the seed script's preconditions before writing).
Sources: the lab repo origin/main filled seat intakes + voice-rules.md + the brand
sameAs set. Undo for the whole seed = delete the listed docs.

| # | What | Doc(s) | Undo |
|---|---|---|---|
| LD1 | Company LinkedIn intake (linkedin.com/company/karoslabs, voice + off-limits from voice-rules.md) | `agentIntake/UFLwLZR75QFXVAZA8Hb4` | delete doc |
| LD2 | Albert seat LinkedIn intake (on his existing shared seat `clientSeats/wnk3rbc1EK8dI8XNabgF`) | `agentIntake/M9kQu2PyO9mN279BlsCN` | delete doc |
| LD3 | Daniel's shared seat | `clientSeats/1YPoOPD7xQqy7uoIxgEw` | delete doc |
| LD4 | Daniel seat LinkedIn intake (fallback = his genuine self-description) | `agentIntake/dTvnoTuqunvN0k2T7TXm` | delete doc |
| LD5 | Lola's shared seat | `clientSeats/DW2aAfOMm8Som6v9CmmF` | delete doc |
| LD6 | Lola seat LinkedIn intake (0 posts; biotech-as-learner off-limits) | `agentIntake/8Hy9nbqMRcWmJiQUWcrB` | delete doc |
| LD7 | LinkedIn agent instructions v1 (the canonical block in docs/linkedin-agent-portal.md; replaced the 07-15 seed text that had no portal overlay) | `customAgents/JOhXFFV2rHZ9IyQNFLvA` | restore `instructions` from `_backup/2026-07-25/customAgents-JOhXFFV2rHZ9IyQNFLvA-v1-pre.json` (full pre-change doc) |

CVs were NOT seeded (gitignored in the lab repo — never on GitHub); Daniel/Lola
upload them on the data page.

---

## Reddit agent (e15) portal hookup — code, branch `dh/reddit-hookup`

Additive throughout: new files, one new collection, and guarded blocks keyed on
`isRedditAgent(agent.key)` so no other agent's path changes. No Firestore data
was written by this branch — the Phase 3 seed + instructions rows are listed
below as NOT YET APPLIED.

| # | What | Where | Undo |
|---|---|---|---|
| R1 | `AgentIntake.agent` union widened to include `"reddit"`, plus Reddit-only optional fields (`accountHistory`, `subreddits`, `offLimitsSubreddits`, `disclosurePosture`, `mode`) | `src/lib/types.ts` | drop `"reddit"` from the union and delete the optional fields; no existing doc carries them |
| R2 | `RedditDraftFeedback` interface | `src/lib/types.ts` | delete the interface |
| R3 | `redditDraftFeedback` collection registered in `col`, in `CLIENT_SCOPED_COLLECTIONS`, and in the purge script's mirror list | `src/lib/data.ts`, `scripts/purge-orphaned-client-docs.ts` | remove the three entries; delete the collection in Firestore if any rows exist |
| R4 | `addRedditDraftFeedback` / `listRedditDraftFeedback` | `src/lib/data.ts` | delete both functions |
| R5 | Server actions (account form + per-draft feedback) | `src/lib/actions/reddit-agent-actions.ts` (new) | delete file |
| R6 | Run-time injection, `isRedditAgent`, `hasRedditAgentIntake` | `src/lib/agent-service/reddit-agent-context.ts` (new) | delete file |
| R7 | Guarded gate + injection block in **both** submit cores | `src/lib/jobs/submit-custom.ts`, `src/lib/agent-service/run-custom-agent.ts` | delete the `if (isRedditAgent(...))` block and the import in each |
| R8 | Reddit clause in the shared schedule gate | `src/lib/jobs/schedule-gate.ts` | delete the clause and the import |
| R9 | Exact-key launch profile + `isRedditAgentIdentity` + `REDDIT_SETUP_REQUIRED_PREFIX` | `src/lib/custom-agent-launch.ts` | delete the profile entry, the predicate and the constant |
| R10 | Parser + reader | `src/lib/reddit-drafts.ts`, `src/components/reddit-drafts-review.tsx` (new) | delete both files |
| R11 | Intake form | `src/components/reddit-agent-intake.tsx` (new) | delete file |
| R12 | `buildRedditAgentIntakeView` + `toRedditIntakeView` | `src/lib/agent-intake-views.ts` | delete both functions and the imports |
| R13 | `IntakeKind` widened to `"reddit"`; `redditSetup` threaded through the agents hub and run dialog; per-kind copy maps (`INTAKE_ASKS`, `INTAKE_FIRST_STEP`) replacing two hard-coded X/LinkedIn strings | `src/components/custom-agents.tsx` | revert the union and the threading; the two copy maps can stay (they render identical text for x and linkedin) |
| R14 | `redditSetup` leg in `intakeSetups` | `src/app/(app)/clients/[id]/agents/page.tsx` | delete the `hasReddit` const, the third `Promise.all` leg and the `redditSetup` spread |
| R15 | Deep-link page | `src/app/(app)/clients/[id]/reddit-agent/page.tsx` (new) | delete file (nothing links to it) |
| R16 | `guessAssetType` maps a Reddit folder to `note` instead of `social_post` | `src/lib/lab-outputs-shared.ts` | restore `f.includes("reddit")` to the social bucket — **but note this re-opens the cross-post leak**: `social_post` publishes to twitter/linkedin/facebook/tiktok, so a Reddit reply would be offered for publishing to those |
| R17 | Tests: new `reddit-drafts.test.ts`, new `platforms-publishable.test.ts`, Reddit cases added to `agent-intake-gate.test.ts`, `agent-launch-ui.test.ts`, `lab-outputs.test.ts` | `src/lib/__tests__/` | delete the two new files; revert the added cases (no existing assertion was weakened or removed) |
| R18 | Canonical contract doc | `docs/reddit-agent-portal.md` (new), `CLAUDE.md` reference | delete the doc; revert the CLAUDE.md paragraph |
| R19 | Storage prefix used by injection | `clients/<clientId>/reddit-agent/portal-context/<runKey>/` in the assets bucket | delete the prefix; nothing else reads it |

### NOT YET APPLIED (Phase 3 — needs Daniel)

| # | What | Undo when done |
|---|---|---|
| R20 | Reddit agent instructions v1 (the canonical block in `docs/reddit-agent-portal.md`) → `customAgents/pwUIj4jayaJ3S8yuUaQ7` | snapshot the doc to `_backup/<date>/customAgents-pwUIj4jayaJ3S8yuUaQ7-v1-pre.json` FIRST; undo = restore `instructions` from it |
| R21 | Karos Labs pilot Reddit intake seed (`agentIntake`, agent="reddit", seatId=null) | delete the doc; record its id here when written |
| R22 | `SCRAPECREATORS_API_KEY` secret + runner wiring, if Daniel provisions it | remove the secret reference from `cloudbuild.yaml` and the two config lines; the domain is already allowlisted |
