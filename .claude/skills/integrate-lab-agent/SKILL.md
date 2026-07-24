---
name: integrate-lab-agent
description: Integrate a karos-agents lab product into this portal at the e13 (X agent) standard — inspect + gap report first, then adapt in place with full reversibility. Args = the agent to integrate (e.g. "linkedin").
---

Integrate the lab agent named in the arguments into this portal.

**Read `docs/agent-integration-playbook.md` in full and follow it exactly.**
It carries the binding ground rules (plan-first approval gate, branch-only,
additive, snapshot-before-modify, ROLLBACK.md, secrets via Secret Manager),
the architecture map of every reusable primitive with its X-agent reference
file, the five-phase protocol, and the known landmines.

Non-negotiables, restated:

1. Phase 1 is INSPECT ONLY. Cross-reference the karos-agents repo (local
   checkout at `/Users/danielherbert/Developer/karos-agents`, remote
   `karoslabs/karos-agents`) for the agent's contract docs and reference
   outputs, and the portal (latest origin/main + the live customAgents doc +
   prior runs) for existing work. Deliver a state report and a
   KEEP/MODIFY/ADD/REMOVE gap report, then STOP and wait for Daniel's
   explicit approval.
2. Verify origin/main is fetched fresh and matches the deployed build before
   and during work — others push to main daily. Same for the lab repo: fetch
   karos-agents and confirm the local clone matches its origin (0 ahead / 0
   behind) before reading contracts from it — the runner bakes the lab repo
   FROM GITHUB, so on any divergence GitHub is the source of truth for what
   the agent actually runs on.
3. The finished integration must match the X agent standard end to end:
   agent-specific documents page (setup-gated), run-time data injection in
   BOTH submit cores, prior-batch run memory, the parsed drafts reader with
   pick-to-post hand-off, per-account feedback loops, versioned agent
   instructions with snapshots, and an adversarial acceptance audit against
   the lab repo's reference runs.
