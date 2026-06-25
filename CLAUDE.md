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
- **Agents** = user-built "skills" (Firestore `agents`). Engine: `src/lib/agents/run.ts`.
  `outputKind: "instagram_posts"` uses `generateObject`; others use `generateText`.
  Capabilities gate behavior (use_brand_voice, use_transcripts, create_assets, email_client).
- **Timestamps** are epoch millis (`number`) for easy server→client serialization.
- **UI primitives** in `src/components/ui.tsx`; icons via `src/components/icon.tsx`
  (lucide v1 — brand icons like Instagram/Twitter were removed, use Camera/Share2/AtSign).
- Theme tokens are CSS vars in `src/app/globals.css`, exposed to Tailwind via `@theme inline`.

## Commands
- `npm run dev` · `npm run build` · `npx tsc --noEmit`
- Env: see `.env.example` / `SETUP.md`. Build is env-safe (Firebase client has placeholders).
