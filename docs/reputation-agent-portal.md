# Reputation Agent v2 — the portal contract

The sixth intake family, and the first that is **purely additive**: there has
never been a managed `reputation` task type, so unlike the newsletter and the
blog there is no deprecation phase, no `RETIRED_*` constant, and no price to
carry across.

Two things make it unlike its five siblings.

**It is the first agent with DYNAMIC egress.** The runner reaches five external
review platforms. Every previous v2 family was `finite` (one or two named hosts)
or `none`. See the egress note at the bottom — the widening is shared.

**Its most important stored answer is a person, not a preference.** The agent is
draft-only, so when it finds something urgent the portal's entire answer is
telling a human. `crisisRoutingTag` is who. It exists in no document we hold, it
is the only intake field with a same-day consequence, and it is the only one the
form nudges about rather than shrugging at.

## Two skills, one product

| Key | What it is | Listed? |
| --- | --- | --- |
| `karos-reputation-runner` | **The agent.** One pulse: read, triage, draft. | Yes — this is the card |
| `karos-reputation-setup` | Run-once. Resolves the real listings, the voice, the bounds. | No — `parentKey` |

A third skill, `karos-reputation-manager` (a monthly review: what came in, what
was sent, what recurs), used to be registered alongside these two. It was
retired in full 2026-08-29 (SCRUM-377/T-B25a) — no engine equivalent was ever
planned, and product ruled it fully gone rather than left dormant. Removed
from code and the db, do not reintroduce.

**The keys carry no `-v2` suffix while the directory does** — `karos-reputation-runner`
lives at `products/building/reputation-agent-v2/`. That is the manifest's own
shape, matching the Reddit pair and unlike the newsletter and blog fours.

## The seven durable files

`reputationAgentState`, one row per kind, under
`clients/<slug>/skills/reputation-agent-v2/`:

| Kind | File | Why losing it hurts |
| --- | --- | --- |
| `facts` | `01-facts.md` | Background for judging whether a complaint is fair |
| `config` | `02-config.json` | The surfaces and cadence settled at setup |
| `autonomy` | `03-autonomy.json` | **The bounds.** What may run unattended, what must escalate |
| `roster` | `roster.json` | The real listings. **No roster, nowhere to read** |
| `response-voice` | `response-voice.md` | How a reply sounds, plus the manager's learning log |
| `response-ledger` | `response-ledger.json` | **The no-repeat memory.** Lose it and a review gets a second public reply |
| `crisis-ledger` | `crisis-ledger.jsonl` | The audit trail on the only events with a same-day cost |

**Whole-file replace, including the `.jsonl`.** The crisis ledger is append-only
in the workspace, but the portal stores whatever the run delivers as one blob and
hands the whole thing back — the RUN appends, the portal never merges. Appending
on the portal side would put two writers on one audit trail with no ordering
guarantee. The cost is stated rather than hidden: a run delivering a truncated
ledger overwrites the full one, so `reputationStateHasContent` refuses an empty
body and the webhook reports a failed capture loudly. A *partial* truncation is
an open residual.

**The setup gate asks the ROSTER**, not the response ledger. An empty ledger is
correct for a set-up client who has never had a pulse; gating on it would refuse
every first run.

## What the client is asked

Five things, all optional, none of them editorial. The roster proper, the
response voice, the autonomy bounds and the recurring themes are BUILT by setup.

`reviewSurfaces` · `reviewMarkets` · `reputationContext` · **`crisisRoutingTag`** ·
`responseNoGos`

`reviewSurfaces` is a **seed, not the roster**: a client naming three sites may
hold five listings or one. Resolving that is setup's job and the reason it exists.

## The deliverable

The client contract is a folder, stored as a `reputation-pulse-v2` envelope in
`asset.content`:

| Folder | Envelope field |
| --- | --- |
| `client/01-response-drafts/` | `drafts[]` |
| `client/02-flags/` | `flags[]` |
| `client/about.txt` | `about` |

`flags` is its own field rather than more prose, because a flagged item is the
only thing this draft-only product produces that has a deadline. And
`reputationEnvelopeHasContent` counts **flags alone**: a pulse that found nothing
safe to answer but did find something urgent has zero drafts and is the single
most important run this product can produce.

## Pricing

`REPUTATION_RUN_CREDITS = 25` in `src/lib/credits.ts`. **A decision, not a
carried price** — nothing preceded it. 25 is the generic `customAgentRun` rate,
chosen deliberately: a pulse reaches five external surfaces, triages everything
new, and drafts a reply per review rather than one deliverable per run. Because
it equals the default, the rate card's existing "Agent run · from 25" line
already quotes it and no separate row was added.

## Egress

The runner needs five hosts no group carried:
`mybusiness.googleapis.com`, `api.yelp.com`, `itunes.apple.com`,
`api.trustpilot.com`, `graph.facebook.com`. (`api.anthropic.com` was already in
`core`.)

They are a new `review_platforms` group in
`agent-service/config/egress-allowlist.json`, attached to the **`custom`** task
type in `agent-service/src/task-types.ts`. **That is a widening for every custom
agent**, because `custom` is one shared task type — there is no per-agent egress
today. Regenerate `config/proxy-filter.txt` with `npm run gen:proxy-filter` after
any edit; the generated file is committed and is what tinyproxy reads.

## Canonical instructions for the two `customAgents` docs

`scripts/register-reputation-agent-v2.ts` reads the fenced block under each
heading and writes it as that agent's `instructions`.

### `karos-reputation-runner`

```
Run this client's next reputation pulse. Run the runner skill at
products/building/reputation-agent-v2/SKILL.md end to end with the portal
overlay below.

Read first, in this order:
1. client_context/brief.md and every file in client_context/files/.
   - reputation-portal-intake.md is the portal's LIVE client data and OVERRIDES
     any older copy in the repo. Read WHO AN URGENT REVIEW GOES TO before
     anything else: this product does not act, so when you flag something the
     whole of the response is naming that person in about.txt. If nobody is
     named, say so plainly rather than guessing at a name or an inbox.
   - roster.json is the client's REAL listings per surface and market, and the
     portal's copy is the live one. Read ONLY the surfaces named there. Never
     infer a listing from the business name: a wrong listing means drafting
     replies to another business's customers.
   - response-ledger.json is THE NO-REPEAT MEMORY. Check it BEFORE drafting.
     Answering a review a second time posts a duplicate public reply under the
     client's own name, which is the worst thing this product can do. Append
     what you answer and deliver the WHOLE updated file back.
   - 03-autonomy.json is THE BOUNDS: what may be drafted unattended, what must
     be escalated, what must never be touched. When it and any other file
     disagree about what is allowed, IT WINS, and you say so in the run record.
   - response-voice.md is how a reply from this client sounds, with the
     manager's learning log beneath it - what a human edited before sending.
     Match it. Do not re-derive it during a pulse.
   - crisis-ledger.jsonl is what has already been escalated, so the same
     incident is not escalated twice. Append your own rows and deliver the whole
     file back; the portal stores it as one blob and never merges.
2. The client's onboarding profile documents under clients/<slug>/profile/.

TRIAGE BEFORE DRAFTING. Not every review is worth answering, and a reply to a
review that did not need one is noise on a public page. Say in about.txt what
you chose not to answer and why - that list is as much of the deliverable as
the drafts.

FLAG, DO NOT REPLY, when the autonomy bounds say so. A flagged item goes in
client/02-flags/ and is named in about.txt with the client's routing contact.
A pulse with zero drafts and one flag is a successful, important run, not an
empty one.

REFUSE rather than write around a rule. A reply that dodges the client's own
never-claim list reads as evasive in public, which is worse than no reply.
Hold it and say which rule stopped you.

Deliverables under clients/<slug>/outputs/reputation-agent-v2/<date>-pulse-<NNN>/
with the client/ vs internal/ split: client/01-response-drafts/ one file per
reply, client/02-flags/ one file per flagged item, and about.txt leading with
anything urgent and naming who it goes to.

WE NEVER POST. There is no posting credential for any surface and no auto-post
path, and there never will be. A human posts every reply from the client's own
account.
```

### `karos-reputation-setup`

```
Set this client up on reputation monitoring. Run the setup skill at
products/building/reputation-agent-v2/setup/SKILL.md end to end.

Produce the seven standing files every pulse reads: the business facts, the
surface config, the autonomy bounds, the roster, the response voice, and the two
ledgers.

THE ROSTER IS THE WORK. reputation-portal-intake.md carries where the client
THINKS they are reviewed; that is a seed, not the answer. Resolve it to real
listings per surface and market, and record how each one was confirmed. A
business may hold a Google Business Profile under a trading name, duplicate Yelp
entries from a merge, and an App Store listing nobody mentioned. A wrong listing
means drafting replies to another business's customers.

SET THE AUTONOMY BOUNDS EXPLICITLY. This product is draft-only either way, so
the bounds are not about permission to post - they decide what counts as urgent
enough to put in front of a person instead of drafting a reply. Write them so a
later run can apply them without re-deciding.

Derive the response voice from the client's own past replies where they have
any, and from their brand voice where they do not.

IF A RESPONSE LEDGER ALREADY EXISTS AND HOLDS ROWS, VERIFY IT, never re-seed it.
Those rows are reviews already answered in public, and an emptied ledger makes
the next pulse answer them a second time.

Do not draft any replies in this run. This is the setup.
```

`karos-reputation-manager`'s instruction block — the monthly review pass,
reporting what came in, what was drafted, what the client actually sent, and
what keeps recurring — used to live here. Retired in full 2026-08-29
(SCRUM-377/T-B25a), removed from code and the db, do not reintroduce.
