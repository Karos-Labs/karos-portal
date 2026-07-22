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

## Deploy/config changes

_None yet. The planned `XAI_API_KEY` addition is a Cloud Run env/secret set by Daniel;
undo = remove the env var from the service (one gcloud command, listed when applied)._
