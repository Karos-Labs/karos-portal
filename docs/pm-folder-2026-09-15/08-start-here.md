# Start here

Status: approved 2026-09-15 · Owner: developers · Changes when: the repo's setup or environments change. Links, not copies: the repo files are the source.

## The system in four lines

- The portal (Next.js, Firestore, this repo) is what clients and staff use: onboarding, documents, agents catalog, calendar, review, connectors, reporting.
- The engine (agent-engine, a separate repo owned by Tomer and Shlomi) runs every agent. The portal dispatches a run and reads the result back.
- Prep is where merged work lands automatically; production is promoted by hand.
- Every deliverable is reviewed by the client before it is posted; Reddit is never posted by us.

## Day one

1. Install: `SETUP.md` in the repo root. Environments and deploys: `DEPLOY_ENVIRONMENTS.md`. Rollback: `ROLLBACK.md`.
2. Conventions: `CLAUDE.md` (all Firestore access server-side, writes through server actions, the brand system in `globals.css`).
3. Run the checks before a PR: `npm run build`, `npx tsc --noEmit`, `npm test`.
4. Read 01 for what each agent does, 05 for what is decided, 04 for the item you are picking up.

## Testing an agent on prep

1. Sign in as staff, open a client, open the agent, press Run with a one-line note.
2. Watch the run page for the step and the outcome. Open the delivered post.
3. Log one row per finding in 06 (three minutes). Severity: would you post it as delivered.
4. What to expect on the card once D11 ships: the post, its goal, who it is for, why now, the sources. Until then: the post and its sources.
5. The pre-delivery checklist for that platform is section 10 of its Craft page.

## Where things run

- Portal repo: `Karos-Labs/karos-portal`; branches `claude/*` and `s/*`; PRs merge to main; main deploys to prep.
- Engine: Tomer and Shlomi; ask them for the run trace when a finding is engine-side.
- Secrets and flags per environment: the env inventory script in the repo, never a list in a document.
