@AGENTS.md

# Karos CMO — agent notes

AI marketing-agency OS. Next.js 16 (App Router, Turbopack) · Firebase Auth · Firestore
(Admin SDK only) · Anthropic via AI SDK v6 · Resend · Fireflies. Dark + neon-green theme.

## Conventions
- **All Firestore access is server-side** through `src/lib/data.ts` (Admin SDK). The browser
  uses Firebase **only for auth**. `firestore.rules` denies all direct client access.
- **Writes go through server actions** in `src/lib/actions.ts` (the app's write API). Each
  action authorizes via `getCurrentUser()` / `requireStaff()` / `requireAdmin()`.
- **Auth**: `src/lib/auth.ts` — Firebase session cookie (`karos_session`), `getCurrentUser`,
  `requireUser(roles?)`. First user or `ADMIN_EMAILS` → admin; others land disabled (pending).
- **Roles**: admin / employee / client. Route group `src/app/(app)/` is the workspace;
  pages guard with `requireUser([...])`.
- **Agents** = ONLY the managed karos-agents lab products (social_post, newsletter_issue,
  blog_article, landing_page) run by the external agent service (`agent-service/`). Catalog:
  `src/lib/agent-service/products.ts`; submit/cancel: `src/lib/actions/external-job-actions.ts`;
  results arrive via `/api/agent-service/webhook` and mirror into `jobs` (agentId
  `"agent-service"`). The old in-app agent systems (builder agents + `lib/agents` engine,
  intel system agent, Claude-platform launcher, content-engine e12, newsletter e11) were
  removed 2026-07 — don't reintroduce them.
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

## Commands
- `npm run dev` · `npm run build` · `npx tsc --noEmit`
- Env: see `.env.example` / `SETUP.md`. Build is env-safe (Firebase client has placeholders).
