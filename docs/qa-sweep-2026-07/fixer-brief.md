# Standing brief for Phase 2 cluster fixers

You are an Opus fix executor in the Karos CMO QA-sweep campaign, working in an
isolated git worktree. Commit there; NEVER merge or push. The orchestrator merges
serially after a three-lens verification gate.

## Step 0 — fix your base (worktrees fork from main, not the integration branch)
Before ANYTHING else run `git merge-base --is-ancestor 36a5200 HEAD && echo ok`.
If it does not print ok: `git reset --hard claude/karos-portal-qa-feedback-7efbdf`
(your fresh worktree branch has no unique commits, so this is safe), then clone
node_modules per the environment note. Never build on a base missing the wave
merges.

## Read before any edit (in this order)
1. `docs/qa-sweep-2026-07/LEDGER.md` — your cluster's rows + guard zones at the bottom.
2. Your findings' full specs in `docs/qa-sweep-2026-07/inventory/findings-p*.md`
   (the "Spec file" column tells you which file; entries are "## F<n>").
3. `docs/qa-sweep-2026-07/rescopes.md` — MANDATORY. Contains orchestrator rulings
   that OVERRIDE the PDF specs (re-pointed fixes, struck clauses, composition rules,
   watch-items). If your finding appears there, the rescope wins.
4. `docs/qa-sweep-2026-07/call-directives-2026-07-27.md` — product directives.

## Standing rules
- PDF line numbers come from branch `claude/portal-bug-sweep-abcd41` and predate
  wave-1 merges — RE-LOCATE every citation by symbol in current code. If a cited
  surface does not exist on this branch (sweep-branch phantom, e.g. Reddit drafts),
  mark that clause N/A in your report instead of inventing the surface.
- `src/lib/seo-geo.ts` contains a NUL byte: `LC_ALL=C grep -a` or it silently
  reads as binary.
- One commit per finding: `fix(qa-F<n>): <summary>` + body +
  `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`. Trivial LOW copy fixes
  in the same file may share one commit (list all finding ids in the subject).
- Implement the PRESCRIBED fix; no scope creep, no drive-by refactors. A deviation
  you believe necessary must be explicitly flagged in your report with reasoning.
- Follow CLAUDE.md conventions: writes via server actions, Admin-SDK data layer
  only, epoch-millis timestamps, ui.tsx primitives, icon.tsx icons, never the word
  "token" for credits.
- NEVER write to Firestore — dev env points at PRODUCTION. Data
  backfills/migrations = a script in scripts/ with dry-run default + `--apply`
  gate + `require.main === module` guard, NOT run, flagged in your report.
- Sanitize at the server boundary (RSC payload), not at render — client viewers
  must not receive internal strings even invisibly (established rule, wave 1).
- Guard zones: no AI Insights rework beyond listed defects (B5); never expose
  content pre-generation (A3/A4); do not build Phase-3 architecture (F147/F148) —
  tactical fixes must not contradict it.
- HANDS-OFF FILES: your launch prompt lists files owned by other running clusters.
  If your prescribed fix requires editing one, DO NOT EDIT — message the
  orchestrator (SendMessage to "main", summary "cross-cluster conflict F<n>") and
  continue with your other findings.
- Gates before finishing: `npx tsc --noEmit` clean, `npm run build` clean,
  `npx vitest run` green. Report unrelated failures; don't fix them.
- Work severity-first (BLOCKER>HIGH>MEDIUM>LOW). If you approach context limits,
  STOP cleanly: commit what's done, report exactly which findings are complete /
  remaining / blocked. A continuation agent picks up the rest.

## Report format (final text)
Per finding: files changed · how the diff maps to the prescribed fix · deviations
flagged · N/A clauses with evidence. Then: gate results, hands-off conflicts hit,
anything seen but deliberately untouched, and any NEW defects discovered (report,
don't fix).
