# Karos CMO — Setup

Your AI marketing-agency operating system: manage employees, give clients a portal,
build & run AI agents, and auto-ingest meeting transcripts from Fireflies.

Stack: **Next.js 16 · Firebase Auth · Firestore · Anthropic (Claude) · Resend · Fireflies**

---

## 1. Install

```bash
npm install
cp .env.example .env.local   # then fill in the values below
```

## 2. Firebase

1. In the [Firebase console](https://console.firebase.google.com), open your project.
2. **Authentication → Sign-in method**: enable **Email/Password** and **Google**.
3. **Project settings → General → Your apps**: copy the web SDK config into the
   `NEXT_PUBLIC_FIREBASE_*` vars in `.env.local`.
4. **Project settings → Service accounts → Generate new private key**: download the JSON
   and paste the whole thing (one line) into `FIREBASE_SERVICE_ACCOUNT_KEY`.
5. **Firestore Database → Create database** (production mode). Then publish the rules:

   ```bash
   # with the Firebase CLI (npm i -g firebase-tools)
   firebase deploy --only firestore:rules
   ```

   `firestore.rules` denies all *direct browser* access on purpose — the app reads/writes
   Firestore only from the server via the Admin SDK, which bypasses rules.

No composite indexes are required; queries are sorted in application code.

## 3. Anthropic (the platform's brain)

Add `ANTHROPIC_API_KEY` from <https://console.anthropic.com>. The copilot, task
autopilot, and intel research pipeline all run on Claude. (Content-producing
agents run in the external agent service — see the agent-service section of
`.env.example`.)

## 4. Resend (emailing clients)

1. Create a key at <https://resend.com> → `RESEND_API_KEY`.
2. Verify a sending domain and set `EMAIL_FROM` (e.g. `Karos CMO <hello@yourdomain.com>`).
   For quick tests you can use `onboarding@resend.dev`.

## 5. Fireflies (transcript ingestion)

1. Get your API key from Fireflies → Settings → Developer → `FIREFLIES_API_KEY`.
2. Set a `FIREFLIES_WEBHOOK_SECRET` (any random string).
3. In Fireflies, set the webhook URL to:

   ```
   https://YOUR_APP_URL/api/ingest/fireflies?secret=YOUR_SECRET
   ```

   When a meeting finishes, Karos fetches the transcript, summarises it with Claude,
   extracts action items, and **auto-assigns it to the matching client** by attendee
   email domain. Unmatched meetings land in **Meetings** for one-click assignment.
   You can also paste a transcript manually from the Meetings page.

---

## 6. Run

```bash
npm run dev      # http://localhost:3000
```

**First login becomes the admin.** Any email listed in `ADMIN_EMAILS` is also promoted to
admin automatically (yours is pre-filled). Everyone else who signs up lands in a
"pending approval" state until an admin enables them from **Team**.

### Roles
- **Admin** — full control: clients, agents, jobs, meetings, and the team.
- **Employee** — runs/builds agents for their assigned clients.
- **Client** — a read/approve portal for their own assets and meeting summaries.

### First run checklist
1. Sign in (you're the admin).
2. **Clients → New client** — add a brand, fill in its **brand voice** and **contact email**
   (that's where generated content gets emailed) and **email domains** (for meeting routing).
3. **Agents → Add starter agents** — seeds the **Instagram + Email Agent** and others.
4. Open a client → **Run an agent** → pick the Instagram agent → it generates on-brand
   posts, saves them to the asset library, and emails the client for review.
5. **Team** — create employee and client logins and assign clients.

---

## Deploy to Vercel

```bash
vercel
```

Add every variable from `.env.local` in the Vercel project's Environment Variables, then
redeploy. Point your Fireflies webhook at the production URL.
