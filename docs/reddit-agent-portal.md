# Reddit agent (e15) — portal surfaces

How the Reddit agent runs through this portal. Spec of record: the lab repo's
`products/building/reddit-agent/SKILL.md` (§Portal feedback loop, §"the
non-negotiable: never auto-post"), its `PORTAL-INTEGRATION-PLAN.md` +
`DEV-BUILD-ORDER.html` (the portal page mockup and the 7-step build order,
MVP = 1–5), `references/CATALOG-ENTRY-e15.json` (the input contract), and
`docs/product-feedback/reddit.md` (Albert's 2026-06-30 scope ruling, promoted to
the default skill).

Read that scope ruling before changing anything here: the deliverable is a
**lightweight daily-engagement system** — one listing pull, one thread, **one
drafted reply per run**, max 5 a week. A run that burns a big budget is a build
failure. This is not a weekly batch agent like e13 or e10.

## The one canonical set of Reddit surfaces

| Surface | Where |
|---|---|
| Account form + free-form feedback | `src/components/reddit-agent-intake.tsx`, rendered inside the run dialog on `/clients/<id>/agents` — inline on a first run, then collapsed behind the "Reddit agent data" button on the agent card and at the top of the run brief — and by the `/clients/<id>/reddit-agent` deep link, which no navigation points at. Both get their props from `buildRedditAgentIntakeView` in `src/lib/agent-intake-views.ts` — one mapping, two mounts |
| Agent registration | `customAgents` doc `pwUIj4jayaJ3S8yuUaQ7`, key `karos-reddit-agent` → `products/building/reddit-agent` (imported from the lab manifest) |
| Per-client binding | **None — shared and unbound.** `perClientAgentSlug("karos-reddit-agent")` is null, so one doc serves every client, like the X agent. If the lab ever emits per-client instances (`karos-reddit-…-<slug>`), widening `isRedditAgent` is NOT enough: `PER_CLIENT_AGENT_KEY_PREFIXES` in `src/lib/custom-agent-launch.ts` must learn the prefix in the same change, or the instance is offered to every client |
| Run launcher | `/clients/<id>/agents` (custom agents hub; exact-key e15 profile in `src/lib/custom-agent-launch.ts`) |
| Stored data | Firestore: `agentIntake` (agent="reddit", `seatId: null`), `redditDraftFeedback`. **No seats** — Reddit's accounts are managed per client and the portal collects one account form. **No news drop** — Reddit answers recurring questions, it does not broadcast company news, so it is deliberately absent from SCRUM-51 |
| Run-time injection | `src/lib/agent-service/reddit-agent-context.ts` on every e15 run (**both** submit cores); overrides any older repo copies. Injects the account + mode + off-limits subreddits + disclosure wording, the learning log, **the per-subreddit verdicts the client's own outcomes have earned**, and 12 prior drafts for anti-duplication (higher than the weekly agents' 3, because one draft per day means 3 batches is 3 days and the no-repeat guard spans 30) |
| Run gate | The account form must be SAVED, gated on the `seatId: null` intake doc. Saving it empty satisfies the gate — the same deliberate portal policy as e13/e10. A shared `ClientSeat` never satisfies it; Reddit does not use seats at all, so reading one would accept a run set up for a different platform |
| Schedule gate | The shared `unfireableScheduleReason` in `src/lib/jobs/schedule-gate.ts`. This matters more for Reddit than the others: the cadence is daily, so most runs arrive through a schedule rather than the run dialog |
| Review | Webhook → job status `review` + one library asset (type `note`, unpublishable). `client/DRAFTS.md` becomes the asset content; the reader (`src/components/reddit-drafts-review.tsx`) renders the mockup's card per reply |
| Hand-off | **There is no compose deep link, because a Reddit reply is typed in the thread itself.** Posting copies the reply text and opens the target thread; the human pastes and presses reply. Clipboard write is AWAITED before `window.open` (Chrome rejects a clipboard write once the new tab takes focus), and the copy is what carries the reply — a thread URL cannot prefill a comment box |
| Posting | **None, ever.** No credential, no code path. `reddit` is absent from `PUBLISHABLE_PLATFORMS` and present in `READ_ONLY_PLATFORM_IDS`; `guessAssetType` maps a Reddit folder to `note` (empty publish list) so a reply cannot be cross-posted to X or LinkedIn. Pinned by `src/lib/__tests__/platforms-publishable.test.ts` |

The subreddit roster, the recurring-question pool, the answer formulas and the
voice profile are BUILT by the agent from the client's audience and category —
the form never asks for them (ASK vs BUILD). What it asks is only what research
cannot reach: which account we draft as, an honest read of its history, where
the client has already been burned, and their disclosure wording.

## The four outcome actions

The lab contract's four, which the LinkedIn feedback rail already uses verbatim
(`posted` / `posted_with_edits` / `not_posted` / `edit_request`), plus `note` for
free-form feedback. Reddit adds a **closed `reasonCode` set** on `not_posted`
(`too_promotional`, `wrong_subreddit`, `thread_died`, `rules`, `removed`,
`other`) and the `subreddit` the draft targeted, because the contract's rule is
mechanical and per subreddit:

- **2+ `too_promotional` or `rules` against one subreddit → that subreddit is
  downgraded to value-only**, regardless of what its public rules allow.
- **`removed`** is Reddit's strongest negative signal; that answer pattern is
  never repeated in that subreddit.

`reddit-agent-context.ts` applies both rules BEFORE the run rather than leaving
them to the agent's judgment, because the portal's feedback rows are the only
copy of the client's outcomes and the runner workspace is ephemeral.

**"Request a change"** writes an `edit_request` row that becomes a standing
instruction on the next run — deliberately not a synchronous rewrite. The lab's
build order maps it to an instant Sonnet pass; this portal has no such path for
any agent, and e10 already treats a change request as a standing instruction.

## Canonical instructions for the `karos-reddit-agent` customAgents doc

To be applied in Phase 3 (snapshot the doc first; see `ROLLBACK.md`). This text
replaces the auto-generated import default, which runs the **run-once setup
engine** — that engine reverse-engineers the audience and emits sub-skills; it is
not a drafting generator, so left alone it produces no reviewable reply.

```
Run the Reddit agent as the PRODUCTION drafting engine for this client. Prefer
this client's emitted daily-engagement generator under
clients/<slug>/skills/reddit-agent/ when one exists; only fall back to the
run-once setup flow at products/building/reddit-agent/SKILL.md if no client
Reddit foundation exists yet.

Read first, in this order:
1. client_context/brief.md and every file in client_context/files/. The file
   reddit-portal-intake.md is the portal's LIVE client data and OVERRIDES any
   older copies in the repo (clients/<slug>/internal/reddit-agent/,
   internal/reddit/config.json) on any disagreement. Its per-subreddit rules
   section is BINDING and already decided: do not re-litigate a downgrade.
   Files named prior-batch-*.md are this client's previous portal drafts: never
   answer those threads again, and never repeat the same question pattern in
   the same subreddit within 30 days. The baked repo ledger is STALE for portal
   runs; those files are the durable memory.
2. The client's onboarding profile (clients/<slug>/profile/) and the Reddit
   foundation + subreddit map + voice profile under
   clients/<slug>/skills/reddit-agent/.

What to produce (default run = ONE reply): find ONE live, active thread this
account is genuinely earned to answer, and draft ONE value-first reply to it.
One listing pull, one thread, one draft — a run that burns a big budget is a
build failure (Albert, 2026-06-30). Never draft for a subreddit the intake
marks off-limits. If no thread is worth answering today, say so plainly in
internal/RUN.md and ship no draft; that is a clean, correct outcome, not a
failure to paper over.

Re-read the target subreddit's rules live every run before drafting. A stale
promo-policy read is a ban risk. Check the subreddit's account age and karma
gates against the account's history from the intake; if the account cannot post
there, pick a different subreddit rather than drafting something unpostable.

Craft gates (each one is a hard auto-reject; fix before delivering):
- Value-first: the reply must help completely even with every product mention
  deleted. If deleting the mention guts it, it is an ad. Rewrite it.
- Warming mode means ZERO product mentions, in every subreddit, no exceptions.
  In established mode a mention ships only where that subreddit's rules allow
  it AND it is genuinely the best answer AND the disclosure line is present.
- Earned-claim: no claim the voice profile or a cited source does not support.
  No invented biography, no borrowed numbers. Reddit fact-checks in the
  replies. The OP's own figures may be quoted back as theirs.
- No AI tells: no em dashes, no exclamation marks, no "great question", no
  rule-of-three closers, no bullet-list answer where a person would write
  prose. Several roster subreddits ban AI-generated content outright.
- Culture fit: match how that specific subreddit actually writes.
- Freshness: the thread must be live and active. Never answer a dead thread —
  no reader, no GEO value.
- Additive: the reply must add an angle the existing comments do not already
  cover. Say what that whitespace is.
- Respect the learning log: never repeat a correction the client already made.
  An "edit_request" entry is a standing instruction, not a one-off.

Pull live Reddit signal for discovery and for the thread's own comment field.
Reddit blocks datacenter egress for keyless reads, so if the run is degraded to
web search, say so explicitly in internal/RUN.md, mark community-voice findings
low-confidence, and NEVER present a thread you could not actually read as if
you had read it. A thread link the client clicks into and finds irrelevant is
worse than no draft.

Deliverables under clients/<slug>/outputs/reddit-agent/<run-folder>/ with the
client/ vs internal/ split: client/DRAFTS.md and internal/RUN.md (method, the
reachability result, the gate checks). client/DRAFTS.md is the deliverable of
record and must keep this exact structure — the portal renders it:

  # Reddit answer drafts — <client name>
  ## Account 1 · <account name> (u/<handle>) · <warming|established>
  ### Draft 1 · <formula name>
  - **Thread:** [<the thread's real title>](<the full reddit.com thread URL>)
  - **Subreddit:** r/<sub> — <value-only | mention-ok>, <the rule in a clause>
  - **Thread posted:** <date, and how active it is>
  - **Why this thread:** <the whitespace this reply fills, one line>
  > the exact reply text to post, as a blockquote
  `NNN chars`
  - **Disclosure:** <the exact disclosure line, or "none needed (no mention)">
  - **Why this is safe here:** <the poster note, one or two lines>
  - **Gates:** value-first PASS · promo/disclosure PASS · no-AI-tells PASS ·
    earned-claim PASS · culture-fit PASS · freshness PASS
  - **Source:** <where each factual claim traces>

The Thread bullet MUST carry a real, complete reddit.com URL — the portal opens
it for the client, and a wrong or invented link is the most visible way this
agent can fail. In internal/RUN.md, only claim a gate passed if you re-checked
it after the final edit; quote the evidence or omit the claim.

DRAFT-ONLY, ALWAYS: a human posts every reply from their own account. There is
no posting credential and no auto-post path, and there never will be — Reddit
bans automated marketing replies. Never imply in a poster note that anything
posts automatically.
```

Two portal-imposed requirements above are NEW for e15 — do not "correct" them
back toward the lab layout:

1. **The `client/` vs `internal/` split with `client/DRAFTS.md`.** The lab's
   emitted generators write to `internal/queue/DRAFT-<date>.md` only ("draft-queue
   + append-ledger, not the `outputs/<agent>/<date>-<run>/` convention"). This
   portal's webhook creates a reviewable asset **only when client-facing
   artifacts exist** (`clientFacingCount > 0`), so an internal-only run finishes
   with a job in `review` and nothing to read. Same override e10 needed.
2. **The pinned DRAFTS.md structure.** The h1 marker `# Reddit answer drafts` is
   what `src/components/asset-card.tsx` sniffs and what `parseRedditDrafts`
   requires. It is distinct from LinkedIn's `# LinkedIn drafts` and from X's h1
   `# Account `, so no format can claim another's batches — but the `## Account`
   headings DO contain X's `# Account ` substring, so **Reddit and LinkedIn must
   both be sniffed before X.** That order is load-bearing and tested in
   `src/lib/__tests__/reddit-drafts.test.ts`.

## Known operational constraint (not a portal bug)

The lab manifest marks `karos-reddit-agent` `status: "blocked"`, and
`clients/karoslabs/internal/reddit-agent/AGENT-MEMORY.md` records exactly what
that means: *"blocked in system inventory ONLY for production egress (datacenter
IP + unprovisioned API app), local drafting is unblocked."*

Reddit blocks datacenter IPs for keyless reads, and the agent service runs on
Cloud Run behind a static proxy. The runner currently receives
`ANTHROPIC_API_KEY`, `APIFY_TOKEN` and `XAI_API_KEY` — no `REDDIT_*`, no
`SCRAPECREATORS_API_KEY`, no `OPENAI_API_KEY` — so a portal run degrades to web
search for thread discovery. `api.scrapecreators.com` is already in
`agent-service/config/egress-allowlist.json`, so wiring `SCRAPECREATORS_API_KEY`
is one secret plus three lines (`config.ts`, `worker.ts`, `cloudbuild.yaml`).
Until then the instructions above require the degradation to be declared, which
is the honest failure mode: a draft whose thread the agent could not read is the
one thing a client will notice immediately.

## Filling the form in for the client

The product promise is that the agent does the work, so the form is a *review*
surface, not a questionnaire. The client types one thing — the account handle —
and presses **"Look it up and fill this in"**; `lookUpRedditAccountAction` reads
that account's own public activity and proposes the rest.

It deliberately **does not write**. Values come back, the form fills them in, the
person presses save. So a later lookup can never overwrite an answer someone
corrected by hand, and nothing is stored that a human has not seen — which is why
there is no per-field provenance tracking to keep in sync.

### What is readable with no credential, measured 2026-07-27

Tested from a residential IP, both with a descriptive User-Agent and a browser one:

| Endpoint | Result | What it gives |
|---|---|---|
| `reddit.com/user/<name>.rss` | **HTTP 200** (browser UA only) | The 25 most recent posts and comments, each with its subreddit and timestamp |
| `reddit.com/user/<name>/about.json` | **HTTP 403** on `www` and `old`, with either UA | nothing |

So, derived today: the subreddits they actually participate in ranked by
frequency, posting cadence, the post-vs-comment mix, how recently they were
active, and whether the account has any usable history at all.

**Not derivable today: karma, account age, removal rate.** `about.json` is the
only public source and it is refused outright. Those are exactly the fields that
decide warming vs established and whether a subreddit's newcomer gate blocks
posting (r/marketing wants 30+ days and 300+ karma), so they stay
human-answered — and the derived summary says so in the client's own words rather
than leaving them blank.

Reddit also blocks datacenter egress, so this read may fail in production while
working locally. That is handled, not assumed: `fetchRedditPublicActivity` never
throws, and each failure mode (`blocked` / `rate_limited` / `not_found` /
`unavailable`) becomes client-facing copy that keeps the form usable and invites
the person to answer by hand.

## What the Reddit OAuth app unlocks (Tomer)

One-time setup. It is **not** a posting credential and grants no posting ability:
there is no post-to-Reddit code path in this portal and there will not be one.
Everything below is read-only.

**What it fixes:** karma, account age and removal rate become readable, so the
last three human-answered fields fill themselves in and the account-safety
judgment stops depending on the client's self-report. The connector code, the
scopes and the callback route already exist and are unused — nothing needs
writing.

**Steps**

1. Log in as the program's Reddit account and go to
   <https://www.reddit.com/prefs/apps> → "create another app…" → type **web app**
   (not "script" — this portal uses the authorization-code flow).
2. Set the redirect URI to the portal's existing callback:
   `https://app.karoslabs.com/api/auth/social/reddit/callback`
   (that route is already implemented and live).
3. Copy the client ID (the string under the app name) and the client secret.
4. Put them in Secret Manager as `REDDIT_CLIENT_ID` and `REDDIT_CLIENT_SECRET`,
   granting the portal's service account `roles/secretmanager.secretAccessor`.
   Values never go in a file, a commit, or chat.

**What is already built and waiting**

- `OAUTH_CONFIGS.reddit` in `src/lib/integrations/oauth.ts` — authorize/token URLs
  and scopes `identity`, `history`, `read`, with `duration: permanent`. Read-only
  by construction: no `submit`, no `edit`, no `modposts`.
- `fetchRedditAccountHealth` and `fetchRedditOwnHistory` in
  `src/lib/integrations/reddit.ts` — karma, account age, and own post/comment
  history including the `removed` flag.
- The Reddit integration card, already `READ_ONLY_PLATFORM_IDS`, so connecting it
  can never add a publish target.

**The one business question, not an engineering one:** Reddit's 2023 API terms
require a paid Data API license for meaningful commercial volume. These reads are
low-volume and account-scoped (one client's own account, on demand), which is the
tier the free terms cover — but volume across many clients is worth a deliberate
decision before it grows. Noted in `integrations/reddit.ts` too.

**Note this does NOT solve thread discovery.** The OAuth app authenticates reads
of *an account's own* data. Finding threads to answer is a different leg, and its
blocker is datacenter egress — see "Known operational constraint" above.

## Out of scope (parked)

- **Posting / Reddit OAuth write scopes.** Not a later track — a hard product
  rule. The existing read-only Reddit integration (`src/lib/integrations/reddit.ts`,
  account health + own history) is untouched by this hookup and is the right
  place to auto-fill the account-history answer later.
- **The mockup's header counters** ("4 to review / 2 posted / 6 subs") and the
  **monthly GEO scoreboard** — steps 6–7 of the lab build order, explicitly
  scoped as after-MVP. Drafts render like every other agent's output: the card
  wherever outputs already appear, no bespoke Reddit page.
- **Per-account seats.** The catalog's scope is `company | execs | both`, but the
  portal collects one account form for now. Widening it means per-seat
  `agentIntake` rows keyed by `seatId`, which the collection already supports.
