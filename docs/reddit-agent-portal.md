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

---

# Reddit agent v2 — the portal surfaces

v2 replaces the e15 agent above. Spec of record: the lab repo's
`products/building/reddit-agent-v2/` plus `docs/one-pagers/reddit-agent-v2-DONE.md`.
The v1 doc `karos-reddit-agent` is **deleted**, not archived (Ben, 2026-08-05).

| Surface | Where |
|---|---|
| Agent registration | TWO `customAgents` docs: `karos-reddit-runner` → `products/building/reddit-agent-v2`, and `karos-reddit-setup` → `…/setup` carrying `parentKey: "karos-reddit-runner"`. **No `-v2` suffix on either key** — the manifest puts the generation in the path, and the guessed suffix matches nothing |
| What is listed | ONE card. The setup is a STEP (`isSubAgent` reads its `parentKey`), so no roster offers it |
| Stored data | `agentIntake` (agent="reddit"), `redditDraftFeedback` (now with `selectedApproach`), **`redditAgentState`** (the eight files v2 assumes outlive a run) |
| Run-time injection | `reddit-agent-context.ts`: the account form, the per-subreddit verdicts the client's own outcomes earned, **`feedback.jsonl`** in the exact shape v2 reads, and every captured state file |
| State capture | `reddit-state-capture.ts` + the delivery handler. The **dated rules audit** is the one that matters: lose it and the next run names a product where it is banned, and Reddit bans rarely reverse |
| Deliverable | `client/<nn>-answer/{approach-1.md,approach-2.md,about.txt}`, flattened by the delivery handler into the versioned JSON envelope both the webhook and the reader import from `lib/reddit-drafts` |
| Review | Two-approach toggle per thread; `selectedApproach` recorded on the two actions that took one |
| Outcomes | Four, and three are not errors: `delivered` / `held` / `blocked_intake` / **`degraded`**. `degraded` means WE could not read Reddit and gets its own copy, never the held wording |
| Posting | **None, ever.** No credential, no code path. `reddit` stays in `READ_ONLY_PLATFORM_IDS` |

## Canonical instructions for the two `customAgents` docs

### `karos-reddit-runner`

```
Draft this client's next Reddit replies. Run the runner skill at
products/building/reddit-agent-v2/SKILL.md end to end — thirteen numbered
resumable steps — with the portal overlay below.

Read first, in this order:
1. client_context/brief.md and every file in client_context/files/.
   - reddit-portal-intake.md is the portal's LIVE client data and OVERRIDES any
     older copy in the repo: which account to draft as, an honest read of its
     karma and age, the subreddits that are permanently off-limits, and the
     client's own disclosure wording.
   - rules-audit.json is THE SAFETY FILE and the portal's copy is the live one.
     One DATED row per subreddit: whether the product may be named, whether
     AI-written comments are banned, the karma gate, the disclosure requirement.
     A reading too old to trust must be RE-VERIFIED before you draft anything.
     Acting on a stale verdict is what gets a client's account banned.
   - reddit-ledger.json, question-pools.json, scan-config.json and foundation.md
     are likewise the live copies. The baked repo's versions are stale.
   - feedback.jsonl is the human's reaction to previous replies. Read
     selected_approach for which of the two replies they took, final_text for
     their edit VERBATIM (the diff against what we wrote is the voice lesson),
     and reason_code for the closed-set skip reason.
   - <account>--learning-log.md and <account>--agent-memory.md belong to THAT
     account only. Never apply one account's earned voice rules to another.
   - Files named prior-batch-*.md are previous portal deliveries: never answer
     those threads again.
2. The client's onboarding profile documents under clients/<slug>/profile/.

The Run click names the account, how many threads to aim for (1 to 3) and an
optional note. No account named means outcome `blocked_intake` — stop and say so
rather than drafting replies nobody can post.

TWO APPROACHES PER THREAD, always. Finding a thread costs ten to fifteen politely
paced requests; a second reply to a thread already found costs one model call. The
client picks, and which one they pick is the voice signal we learn from.

The safety check happens at step 07, BEFORE a word is written: a subreddit the
client was banned from is off-limits for EVERY account of that client (a second
account posting there is ban evasion and escalates to the whole company); the
account must clear the karma and age gate; a thread about the client only counts
where identified vendor participation is permitted.

Gates: assets/check-draft.mjs is mechanical and exits 0 pass / 1 content fail /
2 OUR TOOLING BROKE — exit 2 is never recorded as a content verdict. It rejects
with a reason and NEVER edits the draft; a failed draft returns to step 09 with
the typed reasons, at most twice. Then the judgment gate: delete every product
mention and is the reply still genuinely useful? Does every claim trace to
something real? Does it fit this subreddit's culture?

Deliverables under clients/<slug>/outputs/reddit-agent-v2/<run-folder>/ with the
client/ vs internal/ split: per surviving thread, client/<nn>-answer/ holding
approach-1.md, approach-2.md and about.txt. about.txt MUST carry the clickable
thread link, and where they apply: "REWRITE REQUIRED: this subreddit bans
AI-written comments" (not the softer "edit if you like"), a karma or age warning,
and which approach you would pick.

Record the outcome in internal/13-commit.json as one of `delivered`, `held`,
`blocked_intake` or `degraded`, with the count of threads considered. The portal
reads that field and shows the client a DIFFERENT message for each. `degraded`
means the Reddit search did not come back — say so plainly rather than reporting
it as nothing worth answering, because the portal must never tell a client their
niche was thin when our own search failed.

Deliver the updated rules-audit.json, reddit-ledger.json, question-pools.json and
that account's learning-log.md and agent-memory.md at their contract paths. The
portal captures them and hands them back next run; the runner workspace does not
survive.

DRAFT-ONLY, ALWAYS: a human posts every reply from their own account. There is no
posting credential and no auto-post path, and there never will be.
```

### `karos-reddit-setup`

```
Set this client up on Reddit. Run the setup skill at
products/building/reddit-agent-v2/setup/SKILL.md end to end — eight numbered
resumable steps.

Read first: client_context/brief.md and every file in client_context/files/.
reddit-portal-intake.md is the portal's live client data and OVERRIDES any older
copy: the account to draft as, its history, the subreddits that are off-limits,
and the disclosure wording. Then the client's onboarding profile documents.

Emit DATA, never agent code. One generic runner serves every client.

Learn this client's corner of Reddit and write it down:
  - the subreddits that matter, in three rings — about the client, about their
    category, and where their buyers describe the problem without knowing the
    category exists. The third ring is the most valuable and the least obvious.
  - each of those subreddits' rules, with THE DATE READ AND WHERE: can the
    product be named, must we say who we are, are AI-written comments banned,
    does the account have enough history to post at all. These rules change, and
    a stale reading is how accounts get banned, so the date is not optional.
  - the questions that keep coming back, with real threads proving they repeat.
  - what people already say about the client by name, and the spellings to watch.
  - who we reply as: the account, an honest read of its standing, what it is
    genuinely qualified to claim, and how it discloses the connection.

Deliver to clients/<slug>/skills/reddit-agent-v2/: foundation.md,
rules-audit.json, question-pools.json, scan-config.json, reddit-ledger.json, and
per account voice-profile.md, facts-shelf.md, account.json, live-section.md,
learning-log.md and agent-memory.md. The portal captures these and re-injects
them on every later run.

Finish by parsing every path the runner names in its own read table and dry-firing
the scanner WITHOUT making a request. If anything is missing, report which file
and say the client is not live yet. Never report success on a partial stand-up.

Draft nothing and post nothing in this run.
```
