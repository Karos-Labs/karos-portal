# QA Sweep 2026-07 — Master plan

Status: READY FOR ALBERT'S REVIEW — inventory verified (137/137 coverage, 5-agent
adversarial pass), clusters assigned in LEDGER.md.

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

### Phase 0 — Foundations ✅
- Inventory extracted and adversarially verified (137/137 vs PDF index, 0 dups;
  severity tally matches cover: 8/46/63/20). 87 screenshots mapped 1:1.
- `LEDGER.md` generated — single source of truth, one row per finding + the
  call-directive (CD) items with no finding number.
- Remaining before Phase 1: dev-server smoke test; mock-client baseline walk.

### Phase 1 — Blocker wave (8 findings)
F1 (action plan unmounted — revert-of-a-revert), F24 (failed agent shows Live),
F131 ("Run now" enabled on Setup-needed), F46 (client can't act on drafts),
F47 (archive shows raw text + unapproved drafts), F97 (top CTA promises impossible
approval), F125 (AI Insights demo-data advice), F127 (raw skill manifests shown to
clients). Each blocker is its own fixer + full three-step gate; serial merges.

### Phase 2 — Subsystem clusters (127 findings + 3 CD items)
One Opus fixer per cluster in its own worktree; severity order inside a cluster.
| Cluster | Findings | Hot files |
|---|---|---|
| SEO (+CD-B2/B3/B4) | 19 | seo-geo-panel, presenter, gap-list, seo-geo.ts |
| AGENTS (+CD-D2) | 27 | custom-agents.tsx, run-scheduled, webhook, intake |
| WORKSPACE | 26 | archive-view, asset-card, chatbot-widget, notification-bell |
| DOCS | 16 | client-documents.tsx, chat route, correct-info-modal, PDF export (XSS hole — priority) |
| COPILOT | 9 | chatbot-widget, chat route, strategy-war-room |
| DASHBOARD | 7 | client-analytics, ai-insights (guard zone B5) |
| CREDITS | 6 | credits-panel, account-menu, credits.ts surfaces |
| CALENDAR | 8 | run-calendar, schedule-run-modal, notification-bell |
| SHELL | 12 | sidebar, app-header, globals.css (contrast), data.ts (meetings sort) |
Shared files across clusters (chatbot-widget, chat route, notification-bell,
client-rail, archive-view): the orchestrator computes parallel waves at execution
time from each fixer's actual edit set — clusters sharing a file never run
simultaneously; merges are serial for everyone regardless.

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
