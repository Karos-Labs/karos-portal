# Karos CMO

An AI marketing-agency operating system. Manage your team, give clients a portal,
**build and run AI agents** that produce on-brand content, and **auto-ingest meeting
transcripts** from Fireflies.

Dark, neon-green UI. Built on **Next.js 16 · Firebase Auth · Firestore · Anthropic (Claude) · Resend**.

## What's inside

- **Role-based workspace** — Admin / Employee / Client, each with a tailored view.
- **Agent builder** — employees create reusable AI "skills" in-app: prompt, model,
  inputs, capabilities (use brand voice, use meeting context, save assets, email client).
- **Flagship: Instagram + Email Agent** — generates on-brand posts (caption, hashtags,
  visual brief), stores them as assets, and emails the drafts to the client for review.
- **Jobs** — every agent run is logged with inputs, output, deliverables and a run trace.
- **Client portal** — clients see and approve their assets and read meeting summaries.
- **Fireflies ingestion** — webhook → fetch transcript → Claude summary + action items →
  auto-route to the matching client by attendee email domain.

## Quick start

See **[SETUP.md](SETUP.md)**. TL;DR:

```bash
npm install
cp .env.example .env.local   # fill in Firebase + Anthropic + Resend + Fireflies
npm run dev
```

## Architecture

```
src/
  app/
    (app)/…            authenticated workspace (dashboard, clients, agents, jobs, assets, meetings, team)
    api/auth/session   Firebase session-cookie exchange
    api/ingest/fireflies  Fireflies webhook receiver
    login, pending     auth entry points
  lib/
    firebase/          client + admin SDK init
    data.ts            Firestore data-access layer (server only)
    auth.ts            session cookies, getCurrentUser, role guards
    actions.ts         server actions (the app's write API)
    agents/run.ts      the agent execution engine
    transcripts/       Fireflies fetch + ingestion/summarisation
    email.ts           Resend delivery
  components/          UI primitives + feature components
```

All Firestore access is server-side through the Admin SDK; the browser uses Firebase
only for auth.
