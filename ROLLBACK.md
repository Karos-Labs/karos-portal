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

## Data changes (Phase 3 only — none applied yet)

_None yet. Protocol: before modifying any Firestore doc, export it as JSON to
`_backup/<date>/<collection>-<docId>.json` in this branch and add a row here with the
restore command._

## Deploy/config changes

_None yet. The planned `XAI_API_KEY` addition is a Cloud Run env/secret set by Daniel;
undo = remove the env var from the service (one gcloud command, listed when applied)._
