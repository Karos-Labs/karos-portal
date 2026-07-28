# X agent (e13) — portal surfaces

How the X agent runs through this portal. Spec of record: the lab repo's
`docs/PORTAL-INPUT-CONTRACT.md` + `clients/karoslabs/internal/x-agent/PORTAL-BUILDOUT-BRIEF.md`.

## The one canonical set of X surfaces

| Surface | Where |
|---|---|
| Company-page form, seats ("add a seat"), what's-new box, per-seat takes box, per-draft feedback | `src/components/x-agent-intake.tsx`, rendered inside the run dialog on `/clients/<id>/agents` — inline on a first run, then collapsed behind the "X agent data" button on the agent card and at the top of the run brief — and by the `/clients/<id>/x-agent` deep link, which no navigation points at. Both get their props from `buildXAgentIntakeView` in `src/lib/agent-intake-views.ts` — one mapping, two mounts |
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
   client data and OVERRIDE any older copies inside the repo (clients/<slug>/
   internal/x-agent/, config.json x block) on any disagreement. Files named
   prior-batch-*.md are this client's previous portal batches: treat every
   subject, source, quoted post, and phrasing in them as ALREADY USED — never
   reuse any of it, in addition to the repo ledger.
2. The client's onboarding profile (clients/<slug>/profile/) and their emitted
   X sub-skills (clients/<slug>/skills/x-agent/) — prefer emitted sub-skills
   for production drafting.

What to produce (default run = A WEEK OF POSTS): on-voice DRAFTS across the
avenues for each account in the intake — the company page (build-in-public,
knowledge/explainer, news-reaction, quote-comment, reply) and each seat (POV
single, POV thread, news-reaction, quote-comment, reply). This is one week of
posting for the client to pick favourites from; make every draft strong enough
to be someone's pick. If the client request names one account or a subset of
avenues, produce exactly that subset. Pull live X signal with the engine's xAI
tools when XAI_API_KEY is present; otherwise use WebSearch and record the
degradation in internal/RUN.md.

Craft gates (each one is a hard auto-reject; fix before delivering):
- A quote-comment or reply must ADD a position the original does not state.
  Test each against: "would the original author react 'that is what I just
  said'?" If yes, rewrite with a counter, a consequence, or an earned specific.
- Reactive anchors must be fresh: nothing older than 7 days framed as breaking
  or "just happened"; if an older item is genuinely the best anchor, date it
  honestly in the post text.
- Every reactive post cites a real, current source, linked in the first reply,
  with the source's numbers attributed to the source.
- Quote-comments: keep the post text at 250 characters or fewer — the quoted
  link costs 23 characters of X's 280 budget, and the portal's pick flow
  attaches it to the same post.
- Post length: 280 characters is the default hard cap. LONG-FORM (past 280,
  X Premium only) is allowed ONLY when the intake marks the account
  "X Premium: YES", or intake says auto-detect AND your live read of the
  account confirms Premium (checkmark) — and only where long-form fits the
  account's own posting style or the client asked for it. At most one
  long-form post per account per batch, in the knowledge/explainer or POV
  lane, capped at 2,000 characters, structured like a tight blog post (hook
  first, no filler). Everything else stays under 280. When intake says
  "X Premium: NO", the 280 cap is absolute. This clause supersedes any
  blanket 280 gate in the skill text for the posts it covers; mark such
  drafts' char line past 280 honestly (the portal labels them long-form).
- Banned anywhere in a post: leverage, synergize, holistic, supercharge,
  unlock; em dashes, exclamation marks, hashtags, emoji, thread-boi framing.
- Never make human control/approval the headline of a post; a light aside at
  most.
- Never claim machines cannot create, or that agents do the numbers while
  humans do the creativity. The agents draft too. When touching the division
  of labor use: agents carry the grunt AND augment the craft; a person owns
  the judgment.
- One idea per post AND per batch: before delivering, write each draft's core
  idea in one line; if two drafts share one, rewrite the weaker draft.
- A seat's thread carries that person's earned, sourced specifics (their real
  numbers where they have them). Replies read like a person talking — short,
  conversational — not a polished mini-essay.
- Respect each account's off-limits from the intake. A seat with a pending
  handle still drafts but cannot post or self-sample. Voice, pillars and
  cadence are built from the profile and each account's learning log — never
  ask the client for them.

Deliverables under clients/<slug>/outputs/x-agent/<run-folder>/ with the
client/ vs internal/ split: client/DRAFTS.md and internal/RUN.md (method,
live signal, gate checks). DRAFTS.md must keep this exact structure — the
portal renders it: "# Account N · <name>" headings (the company section's
name must contain "Company page"; seat sections carry the person's name),
"## Avenue N · <lane>"
blocks, the post text as a "> " blockquote (threads: one blockquote per post
with **1/3**-style markers between), a `NNN chars` line after each post, and
"- **" bullets for sources. In RUN.md, only claim a gate passed if you
re-checked it after the final edit; quote the evidence or omit the claim.
Draft-only: nothing posts, and no posting credential exists.
```

## Out of scope (parked)

Auto-posting / X OAuth (`X_API_CLIENT_ID` etc.) — a later, consented per-client
track. The existing "X (Twitter)" integration card serves other content types
and is untouched by this hookup.
