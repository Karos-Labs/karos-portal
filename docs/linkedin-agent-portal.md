# LinkedIn agent (e10) — portal surfaces

How the LinkedIn agent runs through this portal. Spec of record: the lab repo's
`docs/PORTAL-INPUT-CONTRACT.md` + `products/live/linkedin-agent/docs/DESIGN-two-paths.md`
(two paths off one engine; Path A = company page, Path B = personal seats; both
draft-first — LinkedIn has no scheduling API and bars unattended auto-posting, so
a person always posts).

## The one canonical set of LinkedIn surfaces

| Surface | Where |
|---|---|
| Company-page form, seats ("add a seat", shared `clientSeats` — one person, one seat across agents), the shared what-happened-this-week box, per-draft feedback | `src/components/linkedin-agent-intake.tsx`, rendered inside the run dialog on `/clients/<id>/agents` — inline on a first run, then collapsed behind the "LinkedIn agent data" button on the agent card and at the top of the run brief — and by the `/clients/<id>/linkedin-agent` deep link, which no navigation points at. Both get their props from `buildLinkedInAgentIntakeView` in `src/lib/agent-intake-views.ts` — one mapping, two mounts |
| Agent registration | `customAgents` doc, key `karos-linkedin-company-karoslabs` → `clients/karoslabs/skills/linkedin-agent/company-page` (per-client instance; future clients get their own `karos-linkedin-company-<slug>` doc) |
| Run launcher | `/clients/<id>/agents` (custom agents hub; exact-key e10 profile in `src/lib/custom-agent-launch.ts`, placed before the generic founder-LinkedIn brief) |
| Stored data | Firestore: `clientSeats` (shared), `agentIntake` (agent="linkedin"; seat docs carry role/focus/fallback/CV), `xNewsUpdates` (the SHARED news drop — SCRUM-51), `liDraftFeedback` |
| Run-time injection | `src/lib/agent-service/linkedin-agent-context.ts` serializes the stored data to context files on every e10 run (both submit cores); they override any older repo copies. Prior batches (across ALL of the client's e10 agents — one shared memory, like the lab's shared ledger) ride along for anti-duplication — the runner workspace is ephemeral, so a run's own ledger/catalog writes are discarded |
| Run gate | A deliberate portal policy, stricter than the lab contract: company-page runs refuse to start until the company form in the agent data is SAVED (the form's answers are optional — the lab's Path A can run on onboarding alone, which is why saving an empty form satisfies the gate). The Path B master gates on any LinkedIn intake instead |
| Seat voice collection | Apify (`harvestapi~linkedin-profile-posts`) via `APIFY_TOKEN`, already wired end to end (cloudbuild → worker `buildRunnerEnv` → runner `sdkEnv`); degrades to CV/fallback when unset. A LinkedIn profile URL cannot be fetched directly (HTTP 999) |
| Review | Webhook → job status `review` + one library asset (type `note`, unpublishable). `client/DRAFTS.md` becomes the asset content; the reader (`src/components/li-drafts-review.tsx`) renders per-account cards with Pick & post on LinkedIn / Pick with edits / Skip |
| Pick-to-post | `linkedin.com/feed/?shareActive=true&text=<urlencoded>` — verified live 2026-07-24 (full prefill incl. newlines/emoji/links to the 3,000-char cap; the auth wall carries the link through login via `session_redirect`). Undocumented, so the pick copies the text to the clipboard FIRST; media (slides/PDFs) cannot ride a URL and are listed for download + manual attach |

Voice, pillars, cadence, language, launch-vs-ongoing are BUILT by the agent
(onboarding profile + real posts + the edit loop) — the forms never ask for
them (ASK vs BUILD, PORTAL-INPUT-CONTRACT §1). Feedback is captured per account
and serialized back into future runs as that account's learning log.

**SCRUM-51 (shared news):** the "What happened this week" box is ONE input per
client, stored in `xNewsUpdates` (historical name kept — no migration) and
fanned out at run time: `whats-new.json` for the X agent,
`company-updates.md` Section A for this agent. The box component is
`src/components/company-news-box.tsx`, mounted inside both agent intake
surfaces. Do not build a per-platform copy.

## Canonical instructions for the `karos-linkedin-company-karoslabs` customAgents doc

To be applied in Phase 3 (snapshot the doc first; see `ROLLBACK.md`). This text
replaces the seed instructions from the 07-15 hookup, which ran the emitted
skill against the baked (stale) repo state with no portal data and wrote its
no-repeat state into the discarded workspace:

```
You are the LinkedIn company-page generator for this client (e10 Path A —
draft-first, no auto-post). Run the company-page skill at
clients/<slug>/skills/linkedin-agent/company-page end to end, with the portal
overlay below.

Read first, in this order:
1. client_context/brief.md and every file in client_context/files/. The files
   linkedin-portal-intake.md and company-updates.md are the portal's LIVE
   client data and OVERRIDE any older copies inside the repo
   (clients/<slug>/internal/linkedin-agent/, seat intakes) on any
   disagreement. Files named prior-batch-*.md are this client's previous
   portal runs: treat every subject, angle, hook, and phrasing in them as
   ALREADY POSTED, and treat their topic-catalog rows as flipped to used even
   if the baked topic-catalog.yaml still says unused — the baked catalog and
   shared ledger are STALE for portal runs. Files named cv--*.* are seat CVs:
   substance only, never voice, never quoted.
2. The client's first-party material only: profile/brand-voice.md,
   product-information.md, market-strategy.md, target-audience.md,
   branding-guidelines.md + brand-colors.json, and the injected
   company-updates.md (Section A client drops win over auto-pulled items that
   describe the same event).

What to produce (default run = ONE post): pick the next unused lane from the
topic catalog — excluding everything used by prior batches — prefer a fresh
Section A drop when one is waiting, and draft ONE company-page post with
author = organization. If the client request names a lane or topic, produce
exactly that. First-party only: no external research. The format gate is
hard: every post ships a native asset (document/carousel as PDF + slide PNGs,
multi-image, or 9:16 video brief) — bare text fails.

Craft gates (each one is a hard auto-reject; fix before delivering):
- Never fabricate a number. Any number needs a source URL from the injected
  data or the profile docs; no source = the number comes out or the line says
  data unavailable. Only the published track-record set in
  product-information.md is reusable without fresh sourcing.
- Consent gate: a customer story, spotlight, or quote holds until the
  injected row carries consent.
- No em dashes, no exclamation marks, no hype words (thrilled, excited to,
  honored, game changer, leverage, synergy), no engagement bait, no broetry
  walls, no listicle framing, at most 3 hashtags (default 0), sentence case.
- Restraint is a hard gate: tamer than the CV, no showboating, no filler
  praise. One idea per post.
- No outbound links in the post body — a link belongs in the first comment;
  give it as a "First comment:" bullet in the drafts file.
- Hook lands in the first 1-2 lines (110-140 characters, before "see more"),
  core claim in ~6-8 words; total 800-1,200 characters unless the lane
  genuinely needs more; never past 3,000.
- Respect the company off-limits from linkedin-portal-intake.md, and the
  learning log: never repeat a correction the client already made. A
  "change requested" entry is a standing instruction — apply it whenever the
  subject or style it names comes up.

Deliverables under clients/<slug>/outputs/linkedin-agent/<run-folder>/ with
the client/ vs internal/ split. client/DRAFTS.md is the deliverable of record
(make it the LARGEST client-facing text file) and must keep this exact
structure — the portal renders it:

  # LinkedIn drafts — <client name>
  ## Account 1 · <client name> — Company page   (title must contain "Company page";
                                                 seat sections carry the person's name)
  ### Post 1 · <lane>
  > the exact post text to publish, as a blockquote
  `NNN chars`
  - **Topic:** <the catalog row or Section A drop this came from>
  - **Media:** <file1>.pdf · <file2>.png   (exact client/ file names for this post)
  - **First comment:** <the link + one line, when a source link exists>
  - **Post window:** <the recommended posting window — the schedule's slot
    (Tue/Wed/Thu morning, client timezone) or a Section A preferred date>
  - **Source:** <where each factual claim traces>

Ship the media files in the same client/ folder under the names the Media
bullet uses. In internal/RUN.md, only claim a gate passed if you re-checked
it after the final edit; quote the evidence or omit the claim. Still append
to the shared ledger and flip the catalog row inside the workspace for the
artifact record, but know the portal injection is the durable memory.
Draft-only: nothing posts, and no posting credential exists — a person posts
from the portal.
```

Two portal-imposed requirements in the block above are NEW for e10 — do not
"correct" them back toward the lab layout: (1) the client/ vs internal/ split
and internal/RUN.md come from the X standard (e10's lab reference runs are
internal/-only, with run metadata in file headers), but the webhook only
creates a reviewable asset when client-facing artifacts exist; (2) DRAFTS.md
as the deliverable of record is what the webhook prefers as asset content,
what the reader parses, and what the next run's anti-duplication re-injects.

## Out of scope (parked)

- Auto-posting / LinkedIn OAuth (`w_member_social`, Community Management API) —
  a later, consented per-seat track (tokens expire ~60 days; multi-tenant
  posting boundary unresolved). The existing "LinkedIn" integration card,
  employee-advocacy seats (`EmployeeSeat` on the integration doc), publisher,
  and analytics surfaces serve other content types and are untouched by this
  hookup.
- Path B per-seat generators as portal agents: the seat DATA is collected and
  injected now (profiles, focus, off-limits, CVs), but per-seat drafting
  products are emitted lab-side and become their own customAgents docs when
  sold. The Section A "Who will amplify" and "Preferred date" columns stay
  empty until a portal input exists for them — the amplifier fan-out
  activates then, not now.
- The standing point-of-view drop (company-updates template §A sub-table) —
  the injected file carries the empty table so the engine contract holds; the
  portal input box is a fast-follow if wanted.
