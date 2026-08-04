# LinkedIn agent (v2) — portal surfaces

How the LinkedIn agent runs through this portal. Spec of record: the lab repo's
`products/building/linkedin-agent-v2/` — `setup/SKILL.md` (the run-once setup),
`SKILL.md` (the writer), `manager/SKILL.md` (the manager), plus
`references/run-protocol.md` (run folders, resume, the three outcomes),
`references/lanes.md` (the lane menu, the mix, the eight gates) and
`docs/PORTAL-INPUT-CONTRACT.md`.

Read this before changing anything here: **v2 is three skills, not one**, and it
is built around **files that persist between runs**. The portal is what makes
that second part true — the runner clones the lab repo fresh every run and
destroys the container, so without the capture described below the manager steers
nothing and the ledger stays permanently empty, which is the exact v1 failure v2
was built to fix (`run-protocol.md` §12).

Draft-only, always: LinkedIn has no scheduling API and bars unattended
auto-posting, so a person posts every time.

## The one canonical set of LinkedIn surfaces

| Surface | Where |
|---|---|
| Company form, seats (shared `clientSeats` — one person, one seat across agents), **"What should we cover next?"** (v2 Section A0), the shared what-happened-this-week box, the setup band, per-seat voice setup, per-draft feedback | `src/components/linkedin-agent-intake.tsx`, rendered inside the run dialog on `/clients/<id>/agents` — inline on a first run, then collapsed behind the "LinkedIn agent data" button — and by the `/clients/<id>/linkedin-agent` deep link, which no navigation points at. Both get their props from `buildLinkedInAgentIntakeView` in `src/lib/agent-intake-views.ts` — one mapping, two mounts |
| Agent registration | THREE `customAgents` docs imported from the lab manifest: `karos-linkedin-writer-v2` → `products/building/linkedin-agent-v2`, `karos-linkedin-setup-v2` → `…/setup`, `karos-linkedin-manager-v2` → `…/manager` |
| Per-client binding | **None, and that is the v2 design.** One generic writer and one generic manager serve every client (setup emits no per-client agent code — the v1 generation did, which is why a fix had to be hand-applied to every client's copy). The keys carry no `<slug>`, so `perClientAgentSlug` is null and `PER_CLIENT_AGENT_KEY_PREFIXES` does not apply to them. The e10 doc `karos-linkedin-company-karoslabs` keeps its prefix and stays disabled as the fallback |
| What the client sees | ONE card. First press runs SETUP; after that, Run runs the writer. The manager has no card — it runs inside every writer press (below). "Add a seat" then "Build their voice" runs setup for that person |
| Run launcher | `/clients/<id>/agents`; exact-key profiles for all three v2 keys in `src/lib/custom-agent-launch.ts`, above the loose `/linkedin/` brief. "Post as" options are per client — `withLinkedInIdentityOptions` lists the company page plus every seat whose voice is built |
| Stored data | Firestore: `clientSeats` (shared), `agentIntake` (agent="linkedin"), `xNewsUpdates` (the SHARED news drop — SCRUM-51), `liDraftFeedback`, **`liDirectionRequests`** (new), **`liAgentState`** (new — the durable state), `seatVoiceProfiles` (agent="linkedin") |
| Run-time injection | `src/lib/agent-service/linkedin-agent-context.ts` on every LinkedIn run (**both** submit cores). Per skill: setup gets the answers, the writer gets everything, the manager gets the state it audits and no CVs |
| State capture | `src/lib/agent-service/linkedin-state-capture.ts` + the delivery handler. Internal state artifacts are fetched for their TEXT only — never re-hosted, never on an asset — and upserted into `liAgentState`. `agent-service/runner/src/artifacts.ts` `outputRoots` was widened to reach `clients/<slug>/internal` and `clients/<slug>/linkedin-agent` or the memory file and the calendar were collected from nowhere |
| Run gate | Two rungs above the injection, both refusing what the AGENT would refuse anyway, one press earlier: the company form must be SAVED (saving it empty satisfies it — the deliberate portal policy), and for a writer/manager run the client must have been SET UP (asked of the `foundation` row, the same file setup's own join check treats as the source of truth). A seat identity with no voice card is refused by name |
| Review | Webhook → job status `review` + one library asset (type `note`, unpublishable). `client/DRAFTS.md` becomes the asset content; the reader (`src/components/li-drafts-review.tsx`) renders per-identity cards with Pick & post on LinkedIn / Pick with edits / Request a change / Skip |
| Pick-to-post | `linkedin.com/feed/?shareActive=true&text=<urlencoded>` — verified live 2026-07-24, and **identical to the URL the lab's own `assets/engine/share_link.py` builds**, so `publish-link.txt` and the reader agree by construction. Undocumented, so the pick copies the text to the clipboard FIRST (awaited before `window.open`) |
| Credentials | Nothing new. The manager needs `XAI_API_KEY`, already wired service → worker → runner, and `api.x.ai` + `www.reddit.com` are already in the `custom` task type's `research` egress group |

Voice, pillars, lanes, cadence and language are **BUILT** by the agent (setup
derives them from the onboarding documents; the edit loop moves them). The forms
never ask for them — ASK vs BUILD, `PORTAL-INPUT-CONTRACT` §1.

## Three decisions this portal made, and why they are not to be "corrected"

**1. One press runs the manager, then the writer.** Ben, 2026-08-04: *"Run every
run. If the pool is full, then just check that there is nothing more relevant or
more up to date to talk about."* Both skills live inside the writer's entry
directory (the manager is a subfolder of it), so this is ONE job, one charge and
one delivery rather than a chain across two webhooks with a cross-delivery
dependency. The manager's cache rule is what makes it affordable: a same-day pull
is reused and never re-bought, which only holds because the cache is captured
into `liAgentState` and re-injected. The standalone manager card is staff's, for a
bigger refill.

Two honest costs: a press is slower (~20–40 min, reflected in the brief), and a
death mid-manager costs the whole press.

**2. ONE combined identity file, not one file per identity.** The lab pins
`linkedin-voice-card-<id>.json` and `linkedin-learning-log-<id>.md` per identity
and tells the writer never to infer a location. The portal ships one
`linkedin-portal-intake.md` carrying the company AND every seat. Ben,
2026-08-04: *"the seat belongs to the company and needs to know the master
context of company. So if on the first run you create a file during set up for
company, for the seat creation, you add to that file, not create a new one."*

This is only safe because the instructions below say so: the file's sections ARE
each identity's voice card and learning log. **Without that line a seat run looks
for a per-identity path, does not find it, and honestly reports
`blocked_intake`** — the file layout and the instruction text are one change.

**3. `client/DRAFTS.md` is the deliverable of record**, alongside the lab's native
`client/<nn>-post/{post.md,publish-link.txt}`. The webhook prefers DRAFTS.md as
asset content, the reader parses it, and the next run's anti-duplication
re-injects it. Same portal-imposed override e10 and e15 already carry.

## Seats: a portal-driven mode of the setup skill

**The lab has no seat-onboarding skill.** `setup/SKILL.md` S3 says outright that
setup stands up the company page and "a seat is stood up by seat onboarding when
that seat is bought"; S8 creates only the `-company` files, and the README parks
personal seats as "not in this pass". The WRITER is ready for seats — one identity
per run, `blocked_intake` when the voice card is missing — but nothing in the repo
produces that card.

So the portal drives it: "Build their voice" fires the SAME setup agent with the
identity as a run input (`runLinkedInSetupAction`), and the instructions pin the
seat variant. Consequences worth knowing:

- **It is not the client-agent launch flow.** That allows one launch per umbrella
  and refuses a second with "already live", which is wrong for an act that repeats
  every time a person is added. LinkedIn v2 has no `clientAgents` umbrella at all.
- **The voice card lands in `seatVoiceProfiles`**, via the delivery handler's
  existing `voice-profile--<slug>.md` capture — which was already generic across
  X/LinkedIn/Reddit and needed only its gate widened, because `isLaunchRun`
  requires an umbrella this flow does not have. Keyed to the SETUP agent and never
  the writer: a drafting run must not overwrite the voice it drafted with.
- **Seat setup reads the person's real posts** via Apify (`APIFY_TOKEN`, already
  wired; a LinkedIn profile URL cannot be fetched directly — HTTP 999). That
  breaks the setup skill's "touches the network NEVER" rule for seat runs only,
  deliberately and stated in the instructions: a voice card built from documents
  alone is a worse voice card, and this is the one input research cannot reach.
- **Repoint when the lab ships real seat onboarding.** This is a divergence, and
  it is written down here so it is found.

## Canonical instructions for the three `customAgents` docs

To be applied in Phase 3 (snapshot each doc first; see `ROLLBACK.md`).

### `karos-linkedin-setup-v2`

```
Set this client up on LinkedIn. Run the setup skill at
products/building/linkedin-agent-v2/setup/SKILL.md end to end, with the portal
overlay below.

Read first: client_context/brief.md and every file in client_context/files/.
linkedin-portal-intake.md is the portal's LIVE client data and OVERRIDES any
older copy in the repo. Then the client's onboarding profile documents under
clients/<slug>/profile/ — S2 and S3 derive everything from them.

WHICH IDENTITY: the brief names it. "the company page" is the normal case, the
full eleven steps. If the brief names a PERSON, run the SEAT variant instead:

  - Do NOT rewrite the foundation, the lanes, the topic catalog, the ledger or
    the company's voice card. They exist and they are shared. S8's rule is
    absolute here: never overwrite a file that is already present.
  - Build THAT PERSON's voice card and their empty learning record, and add them
    to the identities list in the settings block.
  - Read their real LinkedIn posts for voice when linkedin-portal-intake.md
    carries their profile URL, via Apify (APIFY_TOKEN). This is the one step in
    this skill permitted to touch the network, and it is permitted because a
    person's own posts are the only genuine source of how they write. A profile
    URL cannot be fetched directly (LinkedIn answers HTTP 999) — use the Apify
    actor. If it is unavailable, fall back to their voice sample, then their CV
    for SUBSTANCE ONLY (never voice), and record which sources you used.
  - Deliver the voice card as a CLIENT-FACING artifact named
    voice-profile--<their identity slug>.md, where the slug is the one
    linkedin-portal-intake.md gives for them. The portal stores that file as this
    person's voice card, and a person with no voice card cannot be posted for.

Deliver the eight state files at the exact contract paths — the portal captures
them from those paths and hands them back on every later run:
  clients/<slug>/skills/_shared/LINKEDIN-FOUNDATION.md
  clients/<slug>/skills/_shared/linkedin-voice-card-company.json
  clients/<slug>/skills/linkedin-agent-v2/company-page/topic-catalog.yaml
  clients/<slug>/skills/_shared/linkedin-ledger.json
  clients/<slug>/internal/linkedin-agent/AGENT-MEMORY.md
Write the join check (S11) and report `complete` or `blocked` naming the file.

Do not draft or deliver any posts in this run. Nothing publishes, ever.
```

### `karos-linkedin-writer-v2`

```
Produce this client's next LinkedIn post. ONE run does TWO passes, in this order.

PASS 1 — the manager (manager/SKILL.md, nine steps). Every run, per the portal's
cadence decision. Audit what shipped and what the client did with it, adjust the
plan, and refill the topic pool. Check the research cache FIRST: research-cache.json
is attached when one exists, and if its date is TODAY you reuse it and record the
reuse — never re-buy a same-day pull. If the pool is already at its floor, do not
pad it; spend the pass checking whether anything more relevant or more up to date
has appeared, and record what you found. Deliver AGENT-MEMORY.md, the updated
topic-catalog.yaml and your 05-plan.json at their contract paths — the portal
captures them and hands them back next run. Never draft in this pass, and never
write the ledger.

PASS 2 — the writer (SKILL.md, twelve numbered steps), on the plan pass 1 just
produced.

Read first, in this order:
1. client_context/brief.md and every file in client_context/files/.
   - linkedin-portal-intake.md is the portal's LIVE client data for EVERY
     identity, in ONE file. Read its header: its `### Voice card — <identity>`
     sections ARE those identities' voice cards and its `### Learning log —
     <identity>` sections ARE their learning logs. Do NOT look for
     linkedin-voice-card-<id>.json or linkedin-learning-log-<id>.md on disk, and
     do NOT report blocked_intake because a per-identity file is absent — absent
     from THIS file is the only absence that counts, and a missing voice card
     says so in its own section.
   - company-updates.md is the live section. An OPEN Section A0 row addressed to
     this run's identity is THE BRIEF for this batch. Precedence: the run note in
     this prompt (freshest of all) → those direction requests → the Section A
     drops → the topic catalog.
   - linkedin-ledger.json, topic-catalog.yaml, LINKEDIN-FOUNDATION.md and
     manager-plan.json are the LIVE copies. The baked repo's versions are STALE
     for portal runs; where they disagree, the attached files win.
   - Files named prior-batch-*.md are this client's previous portal deliveries:
     every subject, angle, hook and phrasing in them is already posted. Never
     reuse one and never echo its wording.
   - Files named cv--*.* are private CVs: substance only, never voice, never
     quoted, never shown to a client.
2. The client's onboarding profile documents under clients/<slug>/profile/.

WHICH IDENTITY: the brief's "Post as" names it, and linkedin-portal-intake.md
repeats it. One identity per run, never mixed. A seat is a personal profile: its
post is natively text and the text is the whole deliverable.

What to produce: the number of posts the brief asks for (default ONE). At one
post per run, variety lives in the rotation, not in the batch — never the same
lane as this identity's last post, the backbone lanes carry it, a timely post only
when a fresh anchor genuinely exists, promotional at most one in six.

The gates are the lab's eight and every one is a hard reject:
- The deterministic anti-slop gate (lint.mjs). Exit 0 pass, 1 redraft within the
  cap, 2 is OUR tooling breaking — never a content verdict, never reported to a
  client as a quality outcome.
- Any number carries a source URL and a date, or the claim comes out.
- Every claim traces to this client's own documents or a cited source.
- A regulated post carries its required framing or it is HELD immediately —
  compliance never redrafts.
- A spotlight, quote or customer story holds until consent is recorded.
- FORMAT: text posts ship. No visual is required and bare text is NOT held (lab
  decision, 2026-08-03). Do not source an image, a document or a video. An asset
  the CLIENT supplied through their drop box does ship with its post.
- Nothing under client/ is unfinished, and no slot is ever filled with a weak
  post. A run with nothing worth posting reports `held` with the reason and ships
  nothing. That is a correct outcome, not a failure — never pad to avoid it.

Deliverables under clients/<slug>/outputs/linkedin-agent-v2/<run-folder>/ with
the client/ vs internal/ split, INCLUDING the lab's native
client/<nn>-post/{post.md,publish-link.txt}. In addition, and this is a portal
requirement: client/DRAFTS.md is the deliverable of record (make it the LARGEST
client-facing text file) and must keep this exact structure, because the portal
renders it:

  # LinkedIn drafts — <client name>
  ## Account 1 · <client name> — Company page   (the title must contain "Company page";
                                                 a seat's section carries the person's name)
  ### Post 1 · <lane>
  > the exact post text to publish, as a blockquote
  `NNN chars`
  - **Topic:** <the catalog row, direction request or drop this came from>
  - **Suggested date:** <YYYY-MM-DD from the calendar step — a suggestion; the
    client owns the actual date>
  - **First comment:** <the link + one line, when a source link exists>
  - **Source:** <where each factual claim traces>
  - **Media:** <only when the CLIENT supplied an asset — exact client/ file names>

Also write the calendar (step 11) at
clients/<slug>/linkedin-agent/calendar/CALENDAR-<YYYY-MM>.md, and deliver the
updated linkedin-ledger.json and topic-catalog.yaml at their contract paths.

In internal/12-commit.json, alongside the contract's own records, include
  "direction_requests_covered": ["<the exact request text>", …]
for every Section A0 request this run covered. The portal closes those rows on
that list and on nothing else — a row you covered but did not report stays open
and will be offered again. Report only what you genuinely covered.

In internal/RUN.md, only claim a gate passed if you re-checked it after the final
edit; quote the evidence or omit the claim.

DRAFT-ONLY: nothing posts, no posting credential exists, and a person publishes
every post from the portal. Never imply otherwise in a note to the client.
```

### `karos-linkedin-manager-v2`

```
Run the LinkedIn manager for this client — the standalone pass (a normal post run
already includes one). Run manager/SKILL.md end to end, nine steps.

Read first: client_context/brief.md and every file in client_context/files/.
The attached AGENT-MEMORY.md, linkedin-ledger.json, topic-catalog.yaml,
LINKEDIN-FOUNDATION.md and manager-plan.json are the LIVE copies — the baked
repo's are stale. linkedin-portal-intake.md carries every identity's learning log
and outcomes; company-updates.md carries the client's live section.

Check research-cache.json before pulling: if its date is TODAY, reuse it and
record the reuse. One pull serves every identity and every run that day. When you
do pull, the raw payload lands in the cache before anything parses it.

Bounded authority. You may reweight lanes, retire an exhausted subject, and add
topic rows — every new row citing a source URL with a date AND the client profile
document that makes it relevant to this client. You may NOT invent a post type,
change the default posts-per-run, change a voice, or alter a compliance rule:
those become recorded requests for a human, in memory and in the report.

Deliver AGENT-MEMORY.md, the updated topic-catalog.yaml and 05-plan.json at their
contract paths — the portal captures them from there and hands them back to every
later run. Never draft a post, never publish, never write the ledger.

Write client/report.md: what went out per identity, what they did with it, what
changed in the plan and why, what is coming, and anything we need from them.
Client-facing prose — sentence case, no em dashes, no jargon, no placeholders,
every number carrying its source or stated as client-reported. LinkedIn's own
performance numbers are CLIENT-REPORTED until the API is wired; say so.
```

## Out of scope (parked)

- **Auto-posting / LinkedIn OAuth write scopes.** A later consented per-seat
  track. The existing LinkedIn integration card, employee-advocacy seats,
  publisher and analytics surfaces serve other content types and are untouched.
- **The standing point-of-view box** (the live section's §A sub-table). The
  injected file carries the empty table so the engine contract holds; a portal
  input for it is a fast-follow. The X agent's `xTakes` box is the shape it would
  take, and it is deliberately NOT reused here — takes are per-seat X data.
- **Scheduling from the calendar.** The calendar is captured and its per-post date
  is surfaced as a suggestion on the card. Nothing auto-schedules, because a
  human posts every LinkedIn post anyway.
- **Pricing.** `creditCost` and `launchCreditCost` are `null` on these docs, so a
  billable client cannot self-serve a run until an admin sets a number — the
  deliberate F130 policy (a price nobody consciously set is not a price). Staff
  runs are free and are what produce the measurement. **A press is two passes now,
  so the number must be measured, not carried over from e10.**
