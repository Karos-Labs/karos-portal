# Lab-agent portal integration playbook

The repeatable method for hooking a karos-agents lab product into this portal,
distilled from the X agent (e13) integration (2026-07-21 → 07-24, PRs #12–#20).
The X files named throughout are the reference implementation — read them
before building; adapt in place, never build parallel surfaces.

## Ground rules (binding, from the e13 buildout brief §0)

1. **Plan first.** Phase 1 is inspect-only: map what exists (portal AND lab
   repo), produce a gap report (KEEP / MODIFY / ADD / REMOVE per contract
   item), present it, and get Daniel's explicit approval before any change.
2. **Branch only.** All code on one `dh/<agent>-hookup`-style branch, PR'd.
   Main auto-deploys on every push (Cloud Build trigger `^main$`), so merging
   IS deploying the portal.
3. **Additive over destructive.** New files/collections/guarded blocks over
   edits to shared paths. Adapt others' prior work in place — never delete it
   without listing it in the gap report.
4. **Never overwrite data.** Snapshot every Firestore doc to
   `_backup/<date>/<collection>-<docId>.json` (committed) before modifying,
   with a `ROLLBACK.md` row stating the exact undo. New-collection docs list
   their IDs in ROLLBACK.md too.
5. **Secrets only via Secret Manager** → Cloud Run `--set-secrets` → worker
   `buildRunnerEnv` → runner `sdkEnv` allowlist. Never in files or chat.
   Create the secret BEFORE any deploy that references it.
6. If a step cannot be made reversible, stop and surface it.

## Architecture map (what already exists — reuse it)

- **Agent registration**: `customAgents` Firestore collection; imported from
  the lab repo's `catalog/agent-runtime-manifest.json` via GitHub API
  (`src/lib/agent-service/custom-agent-import.ts`). The doc's `instructions`
  field is the agent's system prompt — version it via the canonical block in
  a `docs/<agent>-portal.md` file, applied with snapshots (see
  `docs/x-agent-portal.md` + ROLLBACK rows D6–D11 for the pattern).
- **Run path**: TWO parallel submit cores (known debt): `src/lib/jobs/
  submit-custom.ts` (web action + /api/run-scheduled + MCP `run_agent`) and
  `src/lib/agent-service/run-custom-agent.ts` (/api/scheduler). Anything
  gating or injecting per-agent data must live in BOTH.
- **Guided launch**: `src/lib/custom-agent-launch.ts` — per-agent-family
  profiles rendered by `RunCustomAgentModal` in `src/components/
  custom-agents.tsx`, serialized into the single `prompt`. Rules learned the
  hard way: match profiles by EXACT agent key when the profile presumes
  stored intake; never ask for what the agent BUILDS (voice, audience,
  pillars, cadence) or already stores; setup-gate the modal via an
  `xSetup`-style prop threaded from the server page (`hasXAgentIntake`
  pattern) plus the shared error-prefix constant (`X_SETUP_REQUIRED_PREFIX`).
  Gate on the company-page intake doc (`agentIntake` with `seatId: null`),
  NEVER on `clientSeats` — seats are shared across agents, so a seat added
  for one platform reads as "set up" on every other and the intake form the
  gate exists to raise never appears. Any `ready` flag derived on a page must
  read the same row as the server gate; state the equivalence in a comment.
- **Per-agent client data**: flat collections keyed by clientId/seatId.
  `clientSeats` is PLATFORM-AGNOSTIC (one person = one seat, shared across
  agents). `agentIntake` is keyed `(clientId, agent, seatId|null)` — widen
  its `agent` union in `src/lib/types.ts` for each new platform instead of
  new collections. X-only collections: `xNewsUpdates`, `xTakes`,
  `xDraftFeedback` — check the contract before duplicating (see SCRUM-51
  below).
- **Run-time injection**: `src/lib/agent-service/x-agent-context.ts` is the
  template — serialize stored data into engine-exact file shapes, upload via
  `uploadBytes`, attach as `context_files`, header says portal data OVERRIDES
  repo copies. Includes: intake + per-account learning logs + program notes,
  ongoing drops, and **prior-batch injection** (the runner workspace is
  ephemeral — ledger writes inside a run are DISCARDED; each run must receive
  the previous batches' deliverables for anti-duplication).
- **The reader**: `src/lib/x-drafts.ts` (parser, structure pinned in the
  agent instructions) + `src/components/x-drafts-review.tsx` (chrome-less,
  embedded by `AssetCard` for the Library/archive AND the job page). Per
  draft: pick / pick-with-edits / skip-with-reason → `addXDraftFeedbackAction`
  (account resolved server-side from the section title). Picking is the
  posting hand-off: copy text + open the platform's compose deep link. The
  order is load-bearing, and it is the rule for the next integration: `await`
  the clipboard write, THEN `window.open`, THEN the server action. Chrome
  refuses a clipboard write once the new tab takes focus, so opening first
  loses the copy silently — and the copy is what carries thread posts 2..N and
  what saves the pick if an undocumented deep link stops prefilling. The await
  stays inside the click gesture's transient activation, so the open still
  counts as user-initiated. Accepted trade-off: the draft is flagged
  handed-off before the open, so if a popup blocker rejects it the pick is
  recorded anyway and the "Reopen on X →" link on the card is the recovery.
  Also: guard retries so a failed feedback write never re-opens compose, and
  only claim "copied" when the clipboard promise resolved.
- **Findability**: the agent data lives in the agent, not in a sidebar — the
  "Agent-specific documents" sidebar section is gone, and nothing may send a
  person out of the dialog to fill a form. The client Agents page builds the
  intake props with `src/lib/agent-intake-views.ts` and hands them to the run
  dialog, which renders the form INLINE: the data pane opens in place of the
  brief while the intake is unset (so pressing Run the first time IS the form),
  and afterwards the form collapses behind the "<platform> agent data" button,
  which sits both on the agent card and at the top of the run brief. The dialog
  carries forms + ongoing boxes + free-form feedback box; outputs do NOT live
  there. `/clients/[id]/<agent>` still mounts the same component with the same
  props as a full-page deep link and is the fallback when a caller ships the
  setup flag without the inline payload, but nothing in the navigation points
  at it.
- **Deploys**: portal auto-deploys from main. The agent service is manual:
  `gcloud builds submit --config agent-service/cloudbuild.yaml --substitutions
  _REGION=europe-west1,_REPO=karos,_AGENTS_REF=main,_VPC_CONNECTOR=agent-vpc,
  _INTERNAL_API_URL=https://agent-service-api-zc6vfwnzsq-ew.a.run.app,
  _JOB_HTTP_PROXY=http://10.132.0.2:8888,COMMIT_SHA=$(git rev-parse HEAD)`
  (manual builds do NOT populate COMMIT_SHA — pass it). Everything lives in
  **europe-west1**, GCP project `karoscmo`. The runner bakes the lab repo at
  `_AGENTS_REF`; re-deploy the service to pick up new lab-repo content.
- **Ops facts**: Daniel's gcloud ADC expires every day or two — have him
  rerun `gcloud auth application-default login` (+ `set-quota-project
  karoscmo`) when Firestore/gcloud calls fail. Re-fetch origin/main before
  every work round (Yair pushes frequently; expect merges). Run `npm install`
  in the worktree after main moves. Model for custom runs is pinned
  `claude-opus-4-8` in `agent-service/src/task-types.ts`.

## The phase protocol

1. **Inspect + gap report.** Read the lab repo's contract docs for the agent
   AND everything already in the portal (git log all branches, the
   customAgents doc — recover its stored fields via a run transcript or
   Firestore read — prior runs, launch profile, scheduler wiring). Deliver a
   state report + KEEP/MODIFY/ADD/REMOVE table. STOP for approval.
2. **Adapt in place** on one branch: types → data CRUD → server actions →
   intake component (mounted in the run dialog, plus the deep-link page) →
   launch profile + setup gate → run-time injection in BOTH submit cores →
   reader/pick-to-post deltas → canonical instructions doc.
   Typecheck, full vitest, production build. Update any existing tests that
   pin old behavior (don't delete them — repoint them at the new contract).
3. **Data + acceptance.** Seed the pilot client's values (snapshots +
   ROLLBACK rows), apply the instructions to the customAgents doc (snapshot
   first), deploy what needs deploying, then run the agent through the
   portal and benchmark the output against the lab repo's reference runs.
4. **Adversarial audit.** Never trust the run's self-reported gate checks.
   Fan out reviewer agents: one fact/claim audit against the raw pulled
   signal + profile docs, one craft judge against the lab reference batches.
   Fix what survives verification; fold recurring failures into the
   instructions as hard gates.
5. **Polish rounds** with Daniel's review: presentation, copy (sentence
   case, no em dashes in client-facing strings, no jargon, each field says
   what we do with the answer), placement (inputs inside the agent's run
   dialog, outputs where deliverables live).

## X-specific vs generalizable

Generalizes as-is: seats, `agentIntake` (widen the union), the setup gate,
prior-batch injection, the feedback loop (incl. `"note"`/`"program"`), the
reader/parser pattern, the instructions-versioning discipline, the audit
workflow, ROLLBACK discipline.

Per-agent deltas to analyze every time: the platform's compose deep link
(X has `x.com/intent/post` with `text`/`in_reply_to`; LinkedIn and others
need their own research — verify empirically, have a copy-to-clipboard
fallback), character/length rules (X: 280 default, Premium long-form),
the lane/avenue set and DRAFTS.md structure, platform credentials
(X: XAI_API_KEY; LinkedIn: APIFY_TOKEN already wired), and any
platform-specific scheduler already built on main.

**SCRUM-51 (shared news):** the lab contract says ONE "what happened this
week" drop feeds BOTH X and LinkedIn. `xNewsUpdates` currently carries it
for X. Do NOT build a second news box for LinkedIn — generalize the existing
one (rename/alias, fan the injection into both agents' formats) per the
contract in the lab repo's `docs/PORTAL-INPUT-CONTRACT.md` §3.

## Quality bar

The lab repo's reference outputs are the bar. For e13 that was
`clients/karoslabs/outputs/x-agent/2026-07-21-*-avenues/`. Acceptance =
full batch through the deployed portal, transcript-verified reads of the
injected portal data, every factual claim checkable against the pulled
signal, zero reuse against prior batches, gates honored — confirmed by the
adversarial audit, not by the agent's own RUN.md claims.
