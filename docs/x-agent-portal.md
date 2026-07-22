# X agent (e13) — portal surfaces

How the X agent runs through this portal. Spec of record: the lab repo's
`docs/PORTAL-INPUT-CONTRACT.md` + `clients/karoslabs/internal/x-agent/PORTAL-BUILDOUT-BRIEF.md`.

## The one canonical set of X surfaces

| Surface | Where |
|---|---|
| Company-page form, seats ("add a seat"), what's-new box, per-seat takes box, per-draft feedback | `/clients/<id>/x-agent` (`src/app/(app)/clients/[id]/x-agent/page.tsx`) |
| Agent registration | `customAgents` doc, key `karos-x-agent` → `products/live/x-agent` (imported from the lab manifest) |
| Run launcher | `/clients/<id>/agents` (custom agents hub; X launch prompts in `src/components/custom-agents.tsx`) |
| Stored data | Firestore: `clientSeats`, `agentIntake` (agent="x"), `xNewsUpdates`, `xTakes`, `xDraftFeedback` — flat collections keyed by clientId/seatId |
| Run-time injection | `src/lib/agent-service/x-agent-context.ts` serializes the stored data to context files on every X run; they override any older repo copies |
| Live X reads | `XAI_API_KEY` via the platform secret store only (see `agent-service/DEPLOY.md` "X agent live reads"); never in a file |
| Review | Webhook → job status `review` + one library asset (type `note`, unpublishable). Draft-only is structural; X OAuth posting stays parked |

Voice, pillars, cadence, language, launch-vs-ongoing are BUILT by the agent
(onboarding profile + the account's own posts + the edit loop) — the forms never
ask for them. Feedback is captured per account and serialized back into future
runs as that account's learning log; one account's corrections never bleed into
another's.

## Canonical instructions for the `karos-x-agent` customAgents doc

Applied in the pilot phase (snapshot the doc first; see `ROLLBACK.md`). This text
replaces the auto-generated import default, which described the run-once setup
engine:

```
Run the X agent (products/live/x-agent/SKILL.md) as the PRODUCTION drafting
engine for this client. Only fall back to the run-once setup flow if no client
X foundation exists yet under clients/<slug>/skills/x-agent/.

Read first, in this order:
1. client_context/brief.md and every file in client_context/files/. The files
   x-portal-intake.md, whats-new.json and takes--*.json are the portal's LIVE
   client data (intake forms, drop boxes, per-account learning logs) and
   OVERRIDE any older copies inside the repo (clients/<slug>/internal/x-agent/,
   config.json x block) on any disagreement.
2. The client's onboarding profile (clients/<slug>/profile/) and their emitted
   X sub-skills (clients/<slug>/skills/x-agent/) — prefer emitted sub-skills
   for production drafting.

What to produce (default run = the full batch): on-voice DRAFTS across the
avenues for each account in the intake — the company page (build-in-public,
knowledge/explainer, news-reaction, quote-comment, reply) and each seat (POV
single, POV thread, news-reaction, quote-comment, reply). If the client request
names one account or a subset of avenues, produce exactly that subset. Every
reactive post cites a real, current source, linked in the first reply. Pull
live X signal with the engine's xAI tools when XAI_API_KEY is present;
otherwise use WebSearch and record the degradation in internal/RUN.md.

Hard rules: draft-only — nothing posts and no posting credential exists.
Respect each account's off-limits from the intake. A seat whose handle is
pending still drafts but cannot post or self-sample. Voice, pillars and cadence
are built from the onboarding profile and each account's learning log — never
ask the client for them. Anti-duplication: no idea or phrasing reused across
accounts, within the batch, or against the shared ledger.

Deliverables under clients/<slug>/outputs/x-agent/<run-folder>/ with the
client/ vs internal/ split: client/DRAFTS.md (all drafts in per-account
sections, sources linked, char counts) and internal/RUN.md (method, live
signal, gate checks, ledger notes).
```

## Out of scope (parked)

Auto-posting / X OAuth (`X_API_CLIENT_ID` etc.) — a later, consented per-client
track. The existing "X (Twitter)" integration card serves other content types
and is untouched by this hookup.
