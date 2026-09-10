# Agentic team design — QA sweep 2026-07

Albert's spec (2026-07-28): three-step verification system covering **risk, drift,
and verification**; Opus 5 does the heavy token-heavy lifting AND powers the risk
verification agents; Fable 5 does all orchestration, decision-making, strategizing,
and brief review of Opus output; the run ends with a Fable 5 loop that re-walks the
processes until everything is optimized and aligned.

## Model tiers

| Role | Model | Why |
|---|---|---|
| Orchestrator (main loop), phase planning, work splitting, judgement calls | **Fable 5** | Decision-making tier |
| Fix executors (per-cluster code changes, token-heavy) | **Opus 5** | Heavy lifting |
| Risk verification agents (3-lens, see below) | **Opus 5** | Heavy adversarial reading |
| Brief post-fix review of each Opus executor's diff | **Fable 5** | "Make sure we don't go over anything" — orchestrator-tier eyes on every diff |
| Mechanical chores (ledger updates, file moves, formatting) | Haiku/Sonnet | Cheap, simple |
| Final alignment + optimization loop | **Fable 5** | End-of-run re-pass vs Albert's spec until clean |

## The three-step verification system (per phase)

Every fix cluster passes all three steps before its ledger rows flip to RESOLVED.
A failure at any step bounces the cluster back to its Opus fixer with the evidence.

### Step 1 — Deterministic gates (free, always first)
`npx tsc --noEmit` · `npm run build` · lint. No agent judgement involved; nothing
proceeds past a red gate.

### Step 2 — Risk & drift verification (Opus 5, adversarial)
Independent verifier agents, each with a distinct lens, prompted to REFUTE the fix:
- **Risk lens** — did this change touch anything with blast radius beyond the finding
  (credits/billing paths, role/permission boundaries, webhook contracts, Firestore
  writes)? Flag any diff hunk not required by the finding's prescribed fix.
- **Drift lens** — does the fix match the finding's *prescribed* fix and the call
  directives, or did the agent solve an adjacent problem / reinterpret the spec?
  Checks against the ledger entry verbatim. Also guards the explicit "do NOT touch"
  zones (AI Insights deep-rework, churn-risk exposure of pre-generation).
- **Verification lens (mock client)** — browser-only agent, no source access: walks
  the affected flow in the running app on localhost as a client (and as staff where
  relevant) and confirms the screenshot-level symptom from the PDF is gone and the
  flow around it still works.
Majority/consensus: a cluster needs all three lenses green; any red = bounce.

### Step 3 — Fable review (brief, every cluster)
Fable orchestrator reads the diff summary + verifier verdicts, checks nothing was
"gone over" — scope creep, convention breaks (CLAUDE.md rules, epoch-millis
timestamps, server-action-only writes), missed sibling instances of the same defect
— then merges the cluster serially into the integration branch.

## The end-of-run loop (Fable 5)

After all phases: a closing loop that repeats until two consecutive clean passes —
1. Re-walk the full ledger: every finding RESOLVED, DEFERRED-to-Tomer, or STRUCK,
   with evidence links. No orphans.
2. Alignment review against Albert's lettered directives (call-directives file) and
   the PDF's own tracks — the spec is the contract, not the agents' interpretation.
3. Regression sweep: mock-client agents re-walk the golden paths end to end
   (client dashboard, agent launch/run, docs viewer, calendar, credits surfaces).
4. Optimization pass: anything fixed shallowly that a nearby finding fixed properly?
   Inconsistent patterns introduced between clusters? Unify.
5. Emit/refresh the Tomer handover doc (deferred items, connector stubs, env/infra
   needs, exact file pointers).

## Standing rules

- One integration branch; parallel Opus fixers work in isolated worktrees on
  file-disjoint clusters; merges are serial, never simultaneous.
- The findings ledger (docs/qa-sweep-2026-07/) is the single source of truth;
  agents read specs from it and write status back to it.
- No single agent's output is trusted — fixer, verifier, and reviewer are always
  different agents.
- Deterministic checks always run before any model-judged step (cheapest first).
