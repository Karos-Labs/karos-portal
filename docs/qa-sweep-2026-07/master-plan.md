# QA Sweep 2026-07 — Master plan

Status: DRAFT (pending: verification pass over inventory, Albert sign-off)

Inputs:
- `inventory/` — 137 findings extracted from Daniel's 27 Jul PDF (+ 87 screenshots,
  killed-list, colophon). Verified field-by-field against the PDF by Opus agents.
- `call-directives-2026-07-27.md` — Albert's call directives, incl. items not in the PDF.
- `team-design.md` — the three-step risk/drift/verification system + model tiers.

Caveats that govern all fixers:
- PDF line numbers were taken on branch `claude/portal-bug-sweep-abcd41` — re-locate
  every citation in current code before editing; treat file:line as a strong hint.
- Two v1 fixes shipped 22 Jul (db573d0) were silently reverted by merge de0d414
  (F152) — several findings are revert-of-a-revert; check git history before rewriting.
- Guard zones: no deep rework of AI Insights (call directive B5); never expose that
  content is pre-generated (churn rule A3); CLAUDE.md conventions (server-action-only
  writes, epoch-millis, credits vocabulary) are hard constraints.

## Phasing model

Clusters are **by subsystem/file first, severity second** — parallel fixers must never
share files; merges into this branch are serial. Track A/B labels stay on each finding
(they drive reviewer attention + the Tomer split), but phases are not tracks.

### Phase 0 — Foundations (this phase is running now)
- Extract + verify inventory, screenshots, directives, team design. ✅/🔄
- Coverage audit: every finding number in the PDF index accounted for in the ledger.
- `LEDGER.md`: one row per finding — status (OPEN / IN-PROGRESS / RESOLVED /
  DEFERRED-TOMER / STRUCK), cluster, owner, evidence links. Single source of truth.
- Dev server smoke test on the worktree; mock-client baseline walk of golden paths.

### Phase 1 — Repair & re-mount (highest value density)
The dominant PDF theme: correct machinery already exists, unmounted or unreached.
Re-mounting the action plan (F1/F152), wiring parsers/actions/prompts with zero
callers, applying existing patterns to missed cases. Low new-code risk, big visible
wins. Includes the 8 BLOCKERs that fall in this bucket.

### Phase 2 — Subsystem fix clusters (the long middle)
Parallel Opus fixers, one worktree per cluster, file-disjoint. Provisional clusters
(final assignment after verification pass): SEO/GEO panel+presenter · AI Agents
surface (custom-agents.tsx + friends) · Workspace/tasks/deliverables · Documents
viewer/corrections/PDF-export (incl. the XSS-shaped hole — priority) · Copilot ·
Client dashboard · Settings/credits/billing · Calendar · Shell/nav/notifications ·
Meetings. Each cluster passes the three-step gate before its serial merge.

### Phase 3 — Architecture build: launch-vs-runs (F148 umbrella)
The call's core product decision, built portal-side as far as possible:
unify Instagram/social agents (F147) · parent/child agent model · launch flow with
guided progress · live-agent view with templates · calendar slots + per-slot client
notes · mark-as-posted → archive (F149) · two-level feedback model · launch-vs-run
cost split in analytics/credits. Data-model changes designed for Tomer's runtime
wiring (agent-service contract changes flagged, not guessed).

### Phase 4 — Handover assembly
`TOMER-HANDOVER.md`: every DEFERRED item with file pointers, stub locations, env/infra
needs (GCP block storage for video F150, TikTok connector verification, credit
reloads, password rotation), the exact contract each stub expects, and what was
deliberately left un-built and why.

### End loop — Fable alignment (team-design.md)
Repeats until two consecutive clean passes: full-ledger re-walk → alignment review
against call directives + PDF tracks → mock-client regression sweep of golden paths →
cross-cluster consistency/optimization pass → handover refresh.

## Verification (every phase, per team-design.md)
1. Deterministic: `npx tsc --noEmit` · `npm run build` · lint.
2. Opus risk/drift/mock-client lenses (browser-only verifier walks the flow on
   localhost against the finding's screenshot).
3. Fable brief review of each diff; serial merge.

## Deferred-to-Tomer criteria (a finding row gets DEFERRED only if)
- Needs external credentials/infra we don't hold (GCP storage, TikTok verification,
  Resend domain, real credit top-ups), OR
- Changes the agent-service runtime contract beyond the portal's side of the webhook,
  OR
- Albert explicitly deferred it on the call.
Everything else gets built here, including data-model groundwork for deferred items.
