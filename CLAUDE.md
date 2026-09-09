@AGENTS.md

# Karos CMO — agent notes

AI marketing-agency OS. Next.js 16 (App Router, Turbopack) · Firebase Auth · Firestore
(Admin SDK only) · Anthropic via AI SDK v6 · Resend · Fireflies. **Ember** brand system:
two inks (warm charcoal ground + paper white) and ONE rationed orange accent, with a
light mode that reverses every token except the orange. The scheme, its surface ladder
and the rules for each token are documented in `src/app/globals.css`'s own header.

## Conventions
- **All Firestore access is server-side** through `src/lib/data.ts` (Admin SDK). The browser
  uses Firebase **only for auth**. `firestore.rules` denies all direct client access.
- **Writes go through server actions** in `src/lib/actions/` (barrel: `src/lib/actions/index.ts` — the app's write API). Each
  action authorizes via `getCurrentUser()` / `requireStaff()` / `requireAdmin()`.
- **Auth**: `src/lib/auth.ts` — Firebase session cookie (`karos_session`), `getCurrentUser`,
  `requireUser(roles?)`. First user or `ADMIN_EMAILS` → admin; others land disabled (pending).
- **Roles**: admin / employee / client. Route group `src/app/(app)/` is the workspace;
  pages guard with `requireUser([...])`.
- **Agents** = the managed karos-agents lab products (social_post, newsletter_issue,
  blog_article, landing_page) plus **custom agents** (`customAgents` collection: lab-repo
  skills imported via the manifest, granted per client via `client.customAgentIds`, run as
  task_type `"custom"`), all executed by the external agent service (`agent-service/`).
  Catalog: `src/lib/agent-service/products.ts`; submit/cancel:
  `src/lib/actions/external-job-actions.ts` / `custom-agent-actions.ts`; results arrive via
  `/api/agent-service/webhook` and mirror into `jobs` (agentId `"agent-service"`). Three
  agents are custom agents with portal intake surfaces, each with a canonical contract doc
  that pins its deliverable structure: X e13 (`docs/x-agent-portal.md`), LinkedIn e10
  (`docs/linkedin-agent-portal.md`), Reddit e15 (`docs/reddit-agent-portal.md`). All three
  are draft-only; **Reddit is draft-only as a hard product rule** (a human always posts a
  reply from their own account — no posting code path exists or may be added), and one run
  drafts ONE reply.
  The old in-app agent systems (builder agents + `lib/agents` engine, intel system agent,
  Claude-platform launcher, content-engine e12, newsletter e11) were removed 2026-07.
- **agent-engine** (a separate deployable, `getAgentEngineDeliverable` in
  `src/lib/agent-engine/client.ts`) is a second, newer execution path for a growing set of
  products, materialized into karosCMO assets by `src/lib/agent-engine/materialize.ts`.
  `src/lib/agent-engine/product-mapping.ts` holds `KNOWN_ENGINE_PRODUCT_IDS` (the one place
  in this repo naming agent-engine's full product set) plus the custom-agent/managed-task
  routing tables. The SEO/GEO report's fired recommendations carry a cross-repo "routable
  recommendation" contract — canonical shape, invariants, and where the still-unbuilt
  engine-side mapping table needs to land — documented in
  `docs/routable-recommendation-contract.md` (SCRUM-210/C2).
- **Dynamic Agent Studio** (2026-08) is a deliberate, distinct reintroduction of an
  admin-authored agent builder — not the removed `lib/agents` engine. An admin composes a
  `dynamicAgentSpecs` doc (input schema + a step pipeline of AI/code steps) at
  `/admin/agents/builder`; a client runs it from `/clients/[id]/dynamic-agents`. Execution is
  entirely on the `agent-service` side (`agent-service/runner/src/dynamic/*`), routed by a
  frozen `specSnapshot` on the brief (`isDynamicAgentBrief`) rather than a hardcoded task
  type — never the in-app engine that was removed. Server actions: `src/lib/actions/dynamic-agent-actions.ts`;
  validation: `src/lib/dynamic-agent-validation.ts`; submission core:
  `src/lib/jobs/submit-custom.ts`'s `submitDynamicAgentJob`. Code steps (sandboxed script
  execution) ship behind `DYNAMIC_CODE_STEPS_ENABLED` (default OFF) pending a full security
  review of the sandbox — AI-only dynamic agents are fully usable without it.
  Two engine-owned safety features ride on top, both INERT unless configured and both
  documented in `docs/dynamic-agent-guardrails.md`: **topic guardrails** (a client's
  `Client.forbiddenTopics`, injected by the runner into every AI step and verified against
  the finished deliverable by an appended haiku pass — a violation BLOCKS the run (`outcome:
  "failed"`, no asset created, client refunded automatically, draft preserved in the internal
  trace for staff review), updated 2026-08, see `docs/dynamic-agent-guardrails.md` §2.3) and
  **output de-duplication** (opt-in per agent via
  `DynamicAgentSpec.dedupeAgainstHistory`; prior deliverables are injected into the final
  AI step and the result is scored against them by a pure trigram-Jaccard measure). Neither
  lives in `spec.steps`, deliberately — a guardrail an admin can delete is not a guarantee.
- **Credits** = client-billed AI usage. Pricing + window maths are pure in `src/lib/credits.ts`
  (client-safe); transactional charge/grant/ledger in `src/lib/data.ts` (`clientCredits`,
  `creditLedger` collections). Only `isBillableClientActor()` sessions charge — staff and
  admin "View as Client" are free. Weekly/monthly spend caps are the per-client rate limit;
  admins grant credits from the client settings page. Don't reuse the word "token" for
  credits (already claimed by PATs and LLM token counts).
- **Timestamps** are epoch millis (`number`) for easy server→client serialization.
- **UI primitives** in `src/components/ui.tsx`; icons via `src/components/icon.tsx`
  (lucide v1 — brand icons like Instagram/Twitter were removed, use Camera/Share2/AtSign).
- Theme tokens are CSS vars in `src/app/globals.css`, exposed to Tailwind via `@theme inline`.
  Token NAMES are inherited from the pre-Ember theme — `--neon` is the accent and is orange
  (`#ff6b2c`), not green. Components stay portable by referring to the token, never the colour;
  don't "fix" a `text-neon` to a green, and don't re-theme without a brand-guidelines change.

## Commands
- `npm run dev` · `npm run build` · `npx tsc --noEmit`
- Env: see `.env.example` / `SETUP.md`. Build is env-safe (Firebase client has placeholders).
