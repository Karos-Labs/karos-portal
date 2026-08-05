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

## X agent v2 hookup — 2026-08-03 (agent-service branch: main, direct commits, per-agent-service's own manual-deploy discipline; portal: this branch)

karos-agents PR #28 (`products/building/x-agent-v2/`) rebuilds the X drafting
run as on-demand/per-identity/resumable. v1 (`products/live/x-agent`) is
untouched. Everything below is additive — no existing agent's behavior
changes except where noted.

| # | What | Where | Undo |
|---|---|---|---|
| V1 | `client_path` on context files: the runner also materializes a context file at `clients/<slug>/<client_path>`, not just `client_context/files/<name>` | `agent-service/src/types.ts`, `agent-service/src/schemas/validate.ts`, `agent-service/runner/src/context-files.ts`, `src/lib/agent-service/types.ts` | remove the `client_path` field + the second-write branch in `downloadContextFiles`; no existing caller sets it, so behavior for every current agent is unchanged either way |
| V2 | `outputRoots()` widened to also capture `clients/<slug>/skills` and `clients/<slug>/profile` as artifacts (not just `outputs/`) | `agent-service/runner/src/artifacts.ts` | revert to the 2-root array; this affects EVERY custom/managed agent, not just X v2 — an unchanged baked-in file costs nothing extra (before/after diff skips it), but reverting is one line if it turns out to upload more than intended |
| V3 | Whole-run `model` override on `CustomAgent`, threaded as `brief.model` | `agent-service/src/task-types.ts` (`parseModelOverride`), `agent-service/src/schemas/task-types/custom.json`, `src/lib/types.ts` (`CustomAgent.model`), `src/lib/jobs/submit-custom.ts`, `src/lib/agent-service/run-custom-agent.ts` | remove the field + the two `...(agent.model ? {model: agent.model} : {})` spreads; absent field is a no-op today for every existing agent (`stepModels` is separate) |
| V4 | `isXAgent`/`isXAgentIdentity` recognize `karos-x-agent-v2` alongside `karos-x-agent` | `src/lib/agent-service/x-agent-context.ts`, `src/lib/custom-agent-launch.ts` | drop the `\|\| key === "karos-x-agent-v2"` clause from both |
| V5 | Launch-profile matcher recognizes v2's key (was `startsWith("karos-x-agent ")` only, which v2's key never matches) + batch-size (5/10/21) field on the X profile | `src/lib/custom-agent-launch.ts` (X profile block) | drop the `\|\| identity.startsWith("karos-x-agent-v2 ")` clause and the `batch_size` field |
| V6 | `BATCH_SIZE_FIELD_KEY`/`batchSizeFrom` — reserved field key excluded from prompt prose, read separately as `chargeMultiplier` | `src/lib/custom-agent-launch.ts` | delete both exports; only the X v2 profile uses the key today |
| V7 | `runCustomAgentAction` accepts `chargeMultiplier`; the run dialog passes `batchSizeFrom(fields)` | `src/lib/actions/custom-agent-actions.ts`, `src/components/custom-agents.tsx` | remove the param and the dialog's `...(batchSizeFrom(fields) ? {...} : {})` spread — every other agent's fields never set `batch_size`, so this is a no-op for them |
| V8 | `X_V2_MAX_OUTPUTS_PER_RUN = 21` — otherwise the generic 5-per-run ceiling silently clamps a client's "21 drafts" pick | `src/lib/scheduled-runs.ts` (`scheduleLimitsFor`, `isXAgentV2Identity`) | remove the `X_V2_MAX_OUTPUTS_PER_RUN` branch; falls back to the generic 5 |

### Data changes

| # | What | Doc(s) | Undo |
|---|---|---|---|
| V-D1 | New `karos-x-agent-v2` CustomAgent doc, **`enabled: false`** — hidden from every run surface until someone reviews and flips it on (karos-agents manifest still marks both v2 skills "unreviewed") | `customAgents/Ji7p4nLTzDcbcKgDhtee` | delete the doc; nothing else references it (a brand-new doc, not a modification of v1's) |

### Deliberately NOT done this pass (named so nothing goes missing quietly)

| What | Why deferred |
|---|---|
| Durable cross-run sync of `x-ledger.json`/`topic-catalog.yaml` for ONGOING (non-launch) runs | The existing contract (`docs/one-pagers/x-agent-v2-integration-contract.md` item 2) only syncs a launch run's `voice-profile--<slug>.md` back into Firestore via the webhook. V2 is chosen together across a whole batch, so a first run works without this — it only matters for run 2+ avoiding repeats. Needs a webhook extension (generalize the artifact-parsing beyond the one filename pattern) plus a durable store for the ledger/catalog content, which is real, un-shipped design work. |
| Lane-preference input (shift the default 3/3/2/1/1 mix) | No existing data model or UI anywhere in the portal — genuinely new, not an extension. Framework.md itself calls the default mix "a default, not a rule," so v2 works without it; it's a refinement, not a blocker. |
| Review UI for v2's per-post output shape | v2 writes numbered `client/<NN>-post/{post.md,about.txt}` folders (multiple independent posts) instead of v1's single `DRAFTS.md` batch file that `x-drafts-review.tsx` parses. Needs either a webhook change to create one asset per surviving post, or a new parser — a real UI task, not done here. |
| Per-identity file-path materialization (`client_path`) | Built the mechanism (V1) but did not use it for X v2's specific paths — v2's run-protocol.md expects per-run, per-identity file placement that the current `buildXAgentContextFiles` (whole-client, all-identities-at-once) doesn't cleanly map onto without a redesign. Relying instead on the existing, already-negotiated contract (items 1/3/4) that tells the lab team to read `client_context/files/x-portal-intake.md` etc. — confirm with them this still holds for v2 specifically. |

## X agent v1 retirement + v2 promotion — 2026-08-03 (explicit operator instruction: "the old X agent is unneeded, remove this old agent - it shouldnt be on any piece of code and the db - deploy the v2 - this is the official version - do it on prep and production")

v1 (`karos-x-agent`, `products/live/x-agent`) is fully removed from code and
from BOTH Firestore databases (production `(default)` and `prep`). v2
(`karos-x-agent-v2`) is promoted from `enabled: false` "unreviewed" to
`enabled: true`, display copy dropped the "(unreviewed)"/"separate from
production" framing, in both databases. **Flag for the record**: the
karos-agents repo's own runtime manifest (`catalog/agent-runtime-manifest.json`)
still marks both x-agent-v2 skills `status: "unreviewed"` as of this date —
this promotion is a deliberate operator override of that upstream status, not
a correction of it. The `source.status` field on the v2 doc is left as
`"unreviewed"` on purpose, mirroring upstream honestly, while `enabled: true`
reflects the portal-side decision.

Pre-mutation snapshot of every doc touched (both databases: v1 doc, v2 doc,
and the 7 client docs whose `customAgentIds` referenced v1) —
`_backup/2026-08-03/x-agent-v1-removal-snapshot.json`.

| # | What | Where | Undo |
|---|---|---|---|
| P1 | `isXAgent`/`isXAgentV2` — dropped the `karos-x-agent` (v1) branch, only `karos-x-agent-v2` recognized | `src/lib/agent-service/x-agent-context.ts` | restore `agentKey === "karos-x-agent" \|\| agentKey === "karos-x-agent-v2"` |
| P2 | `isXAgentIdentity`/`isXAgentV2Identity` — same drop, client-safe twin | `src/lib/custom-agent-launch.ts` | same as P1 |
| P3 | Launch-profile matcher — dropped `identity.startsWith("karos-x-agent ")`, only the v2 (`-v2 `) prefix matches | `src/lib/custom-agent-launch.ts` (X profile block) | restore the `\|\| identity.startsWith("karos-x-agent ")` clause |
| P4 | `buildXAgentIntakeView`'s job-name lookup now reads the `karos-x-agent-v2` doc (was `karos-x-agent`, which no longer exists) | `src/lib/agent-intake-views.ts` | change the key back |
| P5 | Keyed client-blurb fallback line retargeted from `startsWith("karos-x-agent ")` to `startsWith("karos-x-agent-v2 ")` | `src/lib/agent-blurbs.ts` | change the matcher back |
| P6 | Backfill script's key regex retargeted to `/^karos-x-agent-v2$/` (was `/^karos-x-agent$/`) | `scripts/backfill-agent-blurbs.ts` | change the regex back |
| P7 | Comment-only key references updated for accuracy (no behavior change) | `src/app/api/clients/[id]/agents/mentionable/route.ts`, `src/lib/custom-agent-launch.ts` (`perClientAgentSlug` doc comment) | cosmetic; no undo needed |
| P8 | Test fixtures repointed from the now-nonexistent v1 key to v2, where the assertion exercises X-specific gating (`isXAgentIdentity`, `intakeFamilyFor`, launch-profile matching, `optionsMode`, `requireIntakeAgentAccess`, keyed blurb fallback) | `src/lib/__tests__/agent-intake-gate.test.ts`, `agent-detail-sections.test.ts`, `agent-launch-ui.test.ts`, `agent-blurbs.test.ts`, `client-agent-rows.test.ts`, `backfill-client-agents.test.ts`, `client-run-offer-destinations.test.ts` | revert each fixture's key string; full suite diffed clean against the pre-change baseline (same 61 pre-existing Windows-path-separator failures, zero new) |
| P9 | One-time script that performed the Firestore mutation (idempotent-by-key, not safe to re-run against a database that no longer has a v1 doc — it will just no-op the delete/swap and re-upsert v2) | `scripts/promote-x-agent-v2.ts` (new) | n/a — a script, not a standing change |

### Data changes (both databases: production `(default)` and prep `"prep"`)

| # | What | Doc(s) | Undo |
|---|---|---|---|
| P-D1 | Deleted v1 `customAgents` doc | production `customAgents/Qv6qtlZOObDVlSUXDzbb`; prep `customAgents/Qv6qtlZOObDVlSUXDzbb` (same id in both — prep was seeded from a production export) | recreate from `_backup/2026-08-03/x-agent-v1-removal-snapshot.json` (`<db>.v1`) |
| P-D2 | `enabled: true` + display copy (name "X Agent", description/clientBlurb dropped "unreviewed"/"separate" framing) on v2 doc | production `customAgents/Ji7p4nLTzDcbcKgDhtee`; prep `customAgents/uPlQt5A02Hp3eGaJf7N0` (newly created — prep never had a v2 doc) | production: restore fields from snapshot's `(default).v2`; prep: delete the doc entirely (it did not exist before) |
| P-D3 | Swapped v1's id for v2's id inside `customAgentIds` on the 7 clients that had v1 (Hanky Panky, XO Digital, Geektime, Sitti, Karos Labs, Pitch by Deel, Kindly Yours) — a judgment call: removing v1 without granting v2 would have silently taken the X agent away from every client that had it, which the "this is the official version" framing did not ask for | both databases, `clients/{CRqzRpcpuDRiMjjDoYCJ, E19TT5yiWxpvbetkhxGt, QwQFkfsCXQdwJIKjfeg9, T6VFmudahXAAaKUHx579, iZLc0mtwSFXNKE2KkC2d, jzgdl738dq7DclAdqky1, vj8pJxRGLtiN2YbBuPwR}` | restore each doc's `customAgentIds` array from the snapshot's `<db>.clients[]` |
| R22 | `SCRAPECREATORS_API_KEY` secret + runner wiring, if Daniel provisions it | remove the secret reference from `cloudbuild.yaml` and the two config lines; the domain is already allowlisted |

---

## LinkedIn agent v2 hookup (2026-08-05, branch `feat/linkedin-agent-v2`)

Base `04d0809` (= origin/main at branch time). Replaces the e10 LinkedIn agent
with the lab's three-skill v2 product (`products/building/linkedin-agent-v2/`:
setup, writer, manager). Read `docs/linkedin-agent-portal.md` before undoing any
of it — three of these changes are portal-imposed decisions with reasons, not
mechanical adaptations.

**The e10 doc is not deleted.** `karos-linkedin-company-karoslabs`
(`JOhXFFV2rHZ9IyQNFLvA`) stays in `customAgents`, disabled, as the fallback. It
was already `enabled: false` before this work, so there is no state to restore.

Pre-mutation snapshots of every doc this touches, taken before any change:
`_backup/2026-08-04/` — the e10 customAgents doc, the 4 `agentIntake` rows
(Karos Labs company page + 3 seats), the 3 `clientSeats`, the 3 `xNewsUpdates`.
`liDraftFeedback` and `seatVoiceProfiles` were verified EMPTY at snapshot time.

### Code changes (all on this branch; undo for any one item = revert its hunk, undo for everything = delete the branch)

| # | What | Where | Undo |
|---|---|---|---|
| L1 | This rollback section | `ROLLBACK.md` | delete the section |
| L2 | `LiDirectionRequest` + `LiAgentState` types | `src/lib/types.ts` (appended before the client-agents section) | delete the two interfaces |
| L3 | 2 new Firestore collection handles + CRUD (`liDirectionRequests`, `liAgentState`), both added to the delete-cascade list and its mirror | `src/lib/data.ts`, `scripts/purge-orphaned-client-docs.ts` | remove the 2 `col` entries, the 2 type imports, the appended CRUD sections, and the 2 names from both cascade lists. New collections hold only data these surfaces wrote; docs can be deleted wholesale |
| L4 | Run-time injection rewritten: the three v2 keys, the ONE combined identity file (company + every seat, with each identity's voice card and learning log inline), the live section with Section A0 direction requests, the durable-state attachments, per-skill file sets, identity scoping | `src/lib/agent-service/linkedin-agent-context.ts` | `git checkout main -- src/lib/agent-service/linkedin-agent-context.ts`. The file's exports are consumed by both submit cores, the webhook and `agent-intake-views.ts`, so reverting it alone will not typecheck — revert L5–L8 with it |
| L5 | Both submit cores: the v2 keys, two new refusal rungs (not set up; a seat with no voice), the injection call's new object signature, and `briefValues` on the input | `src/lib/jobs/submit-custom.ts`, `src/lib/agent-service/run-custom-agent.ts` | restore each `if (isLinkedInAgent(...))` block and drop `briefValues` from `SubmitCustomAgentInput` |
| L6 | `isLinkedInAgentIdentity` widened to the v2 keys; `LINKEDIN_IDENTITY_FIELD_KEY`; `linkedInSeatIdentityToken`; `withLinkedInIdentityOptions`; three new exact-key launch profiles (writer / setup / manager) placed above the loose `/linkedin/` matcher | `src/lib/custom-agent-launch.ts` | remove the three profile blocks and the four new exports, and restore the two-branch predicate. The e10 profile block is untouched |
| L7 | State capture: which artifacts are durable state, their dates, and the `12-commit.json` direction-request receipt | `src/lib/agent-service/linkedin-state-capture.ts` (new file) | delete the file + its import in the webhook |
| L8 | Delivery handler: resolves whether the producing agent is LinkedIn v2 before the artifact loop; fetches internal state artifacts for their TEXT only (never re-hosted, never on an asset); upserts `liAgentState`; closes reported direction requests; widened the per-seat voice-profile capture gate to the v2 SETUP agent | `src/app/api/agent-service/webhook/route.ts` | remove the `isLinkedInStateJob`/`isLinkedInSetupJob` resolution, the `liStateArtifacts`/`liCommitJson` branch inside the artifact loop, the two post-claim blocks, and restore `isLaunchRun &&` on the voice-profile gate |
| L9 | `outputRoots` widened to `clients/<slug>/internal` and `clients/<slug>/linkedin-agent` — without it `AGENT-MEMORY.md` and the posting calendar are collected from nowhere. Everything under `internal/` is already `client_facing: false`, so this widens the WALK and not what a client can see | `agent-service/runner/src/artifacts.ts` | remove the two entries. **Needs an agent-service deploy to take effect** (the runner is baked into the image) |
| L10 | Direction-request actions (add / delete) and `runLinkedInSetupAction` (the company-page setup run AND the per-seat one) | `src/lib/actions/linkedin-agent-actions.ts` (appended) | delete the appended sections + the 6 added imports |
| L11 | Intake surface: the setup band, the "What should we cover next?" box, per-seat "Build their voice", `voiceReady` on the seat view, the `directionRequests`/`isSetUp` props | `src/components/linkedin-agent-intake.tsx` | delete the three new components, their mounts, and the two props (both optional, so callers still compile) |
| L12 | Intake view builder reads direction requests, seat voice-readiness and setup state | `src/lib/agent-intake-views.ts` (`buildLinkedInAgentIntakeView`) | restore the 6-item `Promise.all` and drop the 3 new returned fields |
| L13 | The inputs band gained a LinkedIn-only `direction` row (X keeps `takes`, Reddit keeps neither) | `src/lib/agent-detail-sections.ts` | remove the `agent === "linkedin"` block, the `directionRequests` arg and its read |
| L14 | Run dialog: specializes the profile with this client's identity options, and passes `briefValues` | `src/components/custom-agents.tsx` | restore `const profile = launchProfileFor(agent)` and drop `briefValues` |
| L15 | Parser + reader: `suggestedDate`, and copy that no longer implies we produce a visual | `src/lib/li-drafts.ts`, `src/components/li-drafts-review.tsx` | remove the field, its match and the copy branch |
| L16 | Canonical portal doc rewritten for v2, carrying the three agents' instruction blocks | `docs/linkedin-agent-portal.md` | `git checkout main -- docs/linkedin-agent-portal.md` (the e10 version) |
| L17 | 24 new tests for the v2 contract (keys, binding, briefs, identity options, state capture, receipt parsing, the parser, the doc's load-bearing lines) | `src/lib/__tests__/linkedin-agent-v2.test.ts` (new file) | delete the file |
| L18 | Existing tests repointed at the new contract, none deleted: the LinkedIn row set now includes `direction` (+2 new cases pinning that X does NOT get it and that a covered row is not "filled"); the intake-gate sweep accepts MORE than one refusal per kind while newly asserting every one of them opens with its prefix, ends "Nothing has run.", and that the scheduled core's set is a subset of the interactive core's; 3 data mocks added; 2 new persisted enum fields classified | `agent-detail-sections.test.ts`, `agent-intake-gate.test.ts`, `agent-intake-navigation.test.ts`, `agent-intake-feedback-rows.test.ts`, `seat-remove-run-warning.test.ts`, `client-copy-boundary.test.ts` | revert each file |

| L19 | `isUnlistedAgentIdentity` / `listableAgentKeys`: v2's setup and manager (another agent's machinery) AND the whole e10 generation (`karos-linkedin-agent`, `karos-linkedin-company-*`, superseded by v2 — a disabled-but-granted agent renders as "Coming soon", which left a client looking at two LinkedIn cards) are filtered off EVERY roster — the client roster and its paused list, the staff roster and its paused list, the dashboard tiles, the copilot's @-mention list, and the intake page's family resolution. They stay ENABLED and GRANTED, because a client-fired run is refused unless granted; the listing and the grant are different questions | `src/lib/custom-agent-launch.ts`, `src/app/(app)/clients/[id]/agents/page.tsx` (4 filters), `src/app/(app)/dashboard/page.tsx`, `src/app/api/clients/[id]/agents/mentionable/route.ts`, `src/lib/agent-intake-views.ts` | remove the predicate and the six call sites. Reverting brings back three LinkedIn cards, which is the state this fixed |
| L20 | `standUpDone`: the run dialog opens on the agent's DATA when its one-time stand-up run has not happened, so pressing Run the first time lands on the step that unblocks it instead of showing a brief, taking the press and refusing. Also applied to the schedule gate and the schedule dialog's setup notice. TRUE for X and Reddit, which have no such run | `src/components/custom-agents.tsx` | remove the helper and the three uses; the server gate is unaffected |
| L22 | `IdentityPicker`: the company form stays above, then a name strip picks one person, plus "Add someone". Replaces the stack of a company form and one card per seat, which read as several things to set up rather than one agent with a roster. Every seat keeps its `#intake-seat-<id>` anchor (in an `sr-only` block when the strip is not showing it) so #85's per-row links still land | `src/components/linkedin-agent-intake.tsx` | delete the component, restore the flat `seats.map(...)` + `AddSeatForm` |
| L23 | The unlisted filter sits on the intake DESTINATION, not the intake GATE. On the gate it 404'd the client whose only LinkedIn agent is the superseded e10 instance — that rung is deliberately coarser because being coarse cannot refuse anyone. Caught by `client-run-offer-destinations.test.ts` #114 | `src/lib/agent-intake-views.ts` (`requireIntakeAgentAccess`) | move the predicate back into the family filter |
| L24 | Setup-first copy ("We need to set this up first") and no identity choice until the stand-up run has happened | `src/components/linkedin-agent-intake.tsx` | restore "Set up LinkedIn" and render the picker unconditionally |
| L21 | "Add a seat" fires that seat's setup on success, through the intake funnel, with its outcome deliberately unsurfaced (the seat saved; their card carries "Build their voice" as the retry) | `src/components/linkedin-agent-intake.tsx` (`AddSeatForm`) | remove the `runLinkedInSetupAction` call |

| L25 | `CustomAgent.parentKey?: string \| null` — the agent a step belongs to, by KEY (the stable identity; a doc can be re-imported with a new id and the same key) | `src/lib/types.ts` | delete the field; the predicates below fall back to their legacy behaviour only if L26 is also reverted |
| L26 | Replaced the hardcoded key list with three predicates: `isSubAgent(agent)` reads `parentKey` STRUCTURALLY, `isSupersededAgentKey(key)` keeps the e10 generation out (null-safe — the copilot roster can hand it a row with no key), `isUnlistedAgent(agent)` is the OR every roster calls. Plus `listableAgents` and `groupAgentsByParent` (which returns orphans rather than swallowing a typo'd parentKey) | `src/lib/custom-agent-launch.ts` | restore `isUnlistedAgentIdentity(key)` with its four literals and repoint the call sites |
| L27 | The "+ Add / Set up an agent for this client" dropdown filters STRUCTURALLY only (`isSubAgent`, not `isUnlistedAgent`). Bindability and listing are different questions: a superseded agent must not advertise itself on a roster, but binding one is a staff act on an agent that still exists — using the wider predicate broke the rule that dropdown is actually for, keeping a client's OWN per-client instance available (`client-agent-projection-bind-offer.test.ts`) | `src/lib/client-agent-rows.ts` (`bindableAgents`) | remove the clause |
| L28 | `/agents` library NESTS steps under the parent card instead of hiding them: a `SubAgentRow` with the live toggle, Edit and Run, no price lines and no platform badges. An orphan renders as a top-level card with a "Step with no parent" badge | `src/components/custom-agents.tsx` | delete `SubAgentRow`, the children block and `libraryEntries`; restore `agents.map(...)` |

Verified: `npx tsc --noEmit` clean, `npm run build` clean, full vitest **3,700
passed / 11 failed**. Those 11 are **all `Test timed out`**, all inside two AST-sweep
files (`client-copy-boundary.test.ts`, `client-model-charge-boundary.test.ts`)
that walk every file in `src`. Both pass in isolation. Measured against a
`git worktree` of clean `origin/main` on the same machine at the same time: **main
fails the same 11 tests in the same 2 files** — 3,666 passed / 11 failed there
versus 3,700 passed / 11 failed here. Pre-existing fragility under parallel load:
the suite runs in 44s idle and ~145s loaded, and these sweeps carry 5s and 20s
per-test budgets. Not caused by this work, not fixed by it, and worth raising on
its own — those budgets will flake on any busy CI box.

### Data changes (production `karoscmo`, applied 2026-08-05)

All three docs were CREATED, not modified, so no pre-state exists to restore —
the undo for each is a delete. `scripts/register-linkedin-agent-v2.ts` performed
them and is idempotent (re-running refreshes instructions from the doc, snapshotting
the previous text first).

| # | What | Doc(s) | Undo |
|---|---|---|---|
| L-D1 | Created `customAgents` doc `karos-linkedin-setup-v2` → `products/building/linkedin-agent-v2/setup`, **`enabled: false`**, `source.status: "blocked"`, instructions (2,393 chars) from `docs/linkedin-agent-portal.md` | `customAgents/n9dB3L5ryKsUiYEHIFtr` | delete the doc |
| L-D2 | Created `karos-linkedin-writer-v2` → `products/building/linkedin-agent-v2`, **`enabled: false`**, instructions (5,972 chars) | `customAgents/w2SnN4Pn0T2xjkdU2ZQ9` | delete the doc |
| L-D3 | Created `karos-linkedin-manager-v2` → `products/building/linkedin-agent-v2/manager`, **`enabled: false`**, instructions (1,773 chars) | `customAgents/tZuMasTzAuX2PxHPGLv6` | delete the doc |
| L-D4 | e10 doc untouched: still `enabled: false`, still granted, still the fallback | `customAgents/JOhXFFV2rHZ9IyQNFLvA` | n/a — unchanged |

**All three land DISABLED and UNGRANTED, on purpose.** Upstream marks every v2
skill `status: "blocked"` ("in build, no pilot run yet"), and the import rule is
that a blocked skill lands disabled so nobody fires it by accident — the script
reproduces that rather than overriding it. Enabling or granting them before the
portal code on this branch is deployed would let a client press Run and get a run
with none of its data attached, since main has no v2 injection. So no client's
surface changes until three things happen in order: this branch merges (which IS
the portal deploy), the agent service is redeployed (L9 lives in the runner
image), and then an admin enables and grants them.

### Data changes for the sub-agent grouping (both databases, 2026-08-05)

| # | What | Doc(s) | Undo |
|---|---|---|---|
| L-D5 | `parentKey: "karos-linkedin-writer-v2"` written onto the setup and manager docs in BOTH `(default)` and `prep`, by `scripts/set-agent-parent-keys.ts` (idempotent; refuses to name a parent absent from the same database, since a typo there is how an orphaned step gets created) | `customAgents` where key is `karos-linkedin-setup-v2` / `karos-linkedin-manager-v2` | set `parentKey` to `null` on the four docs. The field was previously absent, so there is no prior value to restore |
