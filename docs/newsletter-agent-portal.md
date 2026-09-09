# Newsletter Agent v2 — the portal contract

The fourth intake family, and the first product to arrive as a **migration**
rather than as a new agent: `newsletter_issue` was a managed task type until
2026-08-06, and everything below replaces it. The managed product is gone from
`MANAGED_PRODUCTS`, from `ManagedTaskType` and from the agent service's
`TASK_TYPES`; `RETIRED_NEWSLETTER_TASK_TYPE` in `src/lib/types.ts` is what the
readers of historical rows still go through.

## Four skills, one product

| Key | What it is | Listed? |
| --- | --- | --- |
| `karos-newsletter-writer-v2` | **The agent.** One run prepares ONE issue. | Yes — this is the card |
| `karos-newsletter-setup-v2` | Run-once client stand-up. Builds the five data files. | No — `parentKey` |
| `karos-newsletter-manager-v2` | Refills the topic pool and refreshes the voice card. | No — `parentKey` |
| `karos-compliance-lock-v2` | The compliance sweep the issue must clear. | No — `parentKey` |

Three of the four are STEPS. They are hidden structurally, by `parentKey`
pointing at the writer, never by a hardcoded key list — `isSubAgent` in
`custom-agent-launch.ts` reads that field and every roster goes through it.
`isNewsletterAgentIdentity` answers TRUE for the writer **only**: it decides who
gets the newsletter intake surface and the setup gate, and a setup run that gated
on its own output could never run at all.

Four skills is one more than any previous product (LinkedIn has three, Reddit
two). The compliance lock is its own registered skill here rather than a step
inside the writer — but from the portal's side it is still just a step.

## The five durable files

The runner clones the lab repo fresh and the container is destroyed, so anything
written under `clients/<slug>/skills/newsletter-agent-v2/` is discarded. These
five are captured into `newsletterAgentState` on delivery and re-injected as
context files on the next run.

| Kind | Path | Why losing it hurts |
| --- | --- | --- |
| `issue-index` | `skills/newsletter-agent-v2/issue-index.json` | **The numbering authority.** Lose it and the next run claims a number that already went out — real subscribers receive a second "Issue 004" |
| `topic-pool` | `skills/newsletter-agent-v2/topic-pool.json` | The editorial runway; an empty pool is a HELD run, never an improvised topic |
| `voice-card` | `skills/newsletter-agent-v2/voice-card.md` | Built ONCE at setup, so it is not re-derived weekly — the v1 defect this ends |
| `scan-topics` | `skills/newsletter-agent-v2/scan-topics.json` | The niche watch-list the seven-day scan searches |
| `content-foundation` | `skills/_shared/CONTENT-FOUNDATION.md` | Pillars, voice rules, compliance block, keyword targets |

**The brand file is deliberately NOT state.** It lives at
`clients/<slug>/skills/newsletter-agent/<slug>.json` and is read live by v1 and
by the blog agent as well as v2. Setup is its single writer of record. Mirroring
it into portal state would create a second copy with no owner.

## What the portal asks the client, and what it must never ask

Everything editorial — the pillars, the voice, the topic pool, the watch-list,
the compliance block — is BUILT by setup from the onboarding documents. It is
never collected from the client and must never be asked of them.

The form collects five things research cannot reach: the send day, the email
platform, an audience note, banned phrases, and any open compliance question.

`preferredWeekday` is `number | null`, and **null is a real answer**. Three files
in the lab repo assert Tuesday, which contradicts the standing decision that the
weekday belongs to the client. Absent or null prints as "not chosen", never as a
default day.

## The deliverable

D7 is FOUR files per issue, and the portal stores them as one versioned envelope
(`newsletter-issue-v2`) in `asset.content`, because the reader is handed a single
string and a size heuristic would pick one of the two HTML renders and call it
the whole deliverable.

| File | Envelope field |
| --- | --- |
| `issue-<nnn>.html` | `html` (dark) |
| `issue-<nnn>-light.html` | `htmlLight` |
| `issue-<nnn>.md` | `text` |
| `about.txt` | `about` — **leads with review flags** |

`about.txt` leading with anything needing confirmation before sending is a
contract, not a convention: in v1 the only surface showing those flags was a
console nobody was supposed to open.

## Pricing

`NEWSLETTER_RUN_CREDITS = 10` in `src/lib/credits.ts`, carried unchanged from the
managed product's `TASK_EXECUTION_COSTS.newsletter_issue`. The work per issue did
not change when the product moved, so the client's bill must not either. The
submit core applies it as the newsletter family's default; an admin's per-agent
`creditCost` still wins.

## Canonical instructions for the four `customAgents` docs

`scripts/register-newsletter-agent-v2.ts` reads the fenced block under each
heading below and writes it as that agent's `instructions`. The text under
version control is therefore the text in Firestore — edit here, re-run the
script.

### `karos-newsletter-writer-v2`

```
Prepare this client's next newsletter issue. Run the writer skill at
products/building/newsletter-agent-v2/SKILL.md end to end with the portal
overlay below. One run prepares ONE issue.

Read first, in this order:
1. client_context/brief.md and every file in client_context/files/.
   - newsletter-portal-intake.md is the portal's LIVE client data and OVERRIDES
     any older copy in the repo: the send day the client chose (or that they
     have NOT chosen one — never assume a day and never print one), their email
     platform, who they say the issue is for, the phrases they may never print,
     and any open compliance question.
   - issue-index.json is THE NUMBERING AUTHORITY and the portal's copy is the
     live one; the baked repo's is stale. CLAIM the next number here at step 01,
     by appending a row keyed by the number itself, BEFORE any other work, and
     flip it to shipped at step 11. Two runs must never both claim the same
     number: a duplicate here sends a second copy of an issue to a real
     subscriber list, which is the exact v1 defect this product was rebuilt to
     end.
   - topic-pool.json is the live editorial runway. Pick from the unused rows and
     mark what you consume as used at step 11. An EMPTY POOL IS A HELD RUN, never
     an improvised topic: a pool row carries provenance and an invented subject
     does not.
   - voice-card.md is the style target, built once at setup from the client's own
     past newsletters. Match it. Do NOT re-derive it during a run — that weekly
     re-derivation from files that never change is the v1 defect it exists to end.
   - scan-topics.json is what to SEARCH; the topic pool is what to WRITE ABOUT.
     Different files, different sources, not interchangeable. Pass scan-topics to
     the seven-day scan explicitly rather than letting the carried code look
     topics up itself.
   - CONTENT-FOUNDATION.md is the editorial brain. Read it by HEADING TEXT, never
     by section number — the numbering differs per client. Read its compliance
     section together with the brand file's; those two together are the rules the
     step-08 sweep enforces and the step-09 code gate refuses on.
2. The client's onboarding profile documents under clients/<slug>/profile/.

If there is no issue index at all, SETUP HAS NOT RUN. Report `blocked_intake`
naming the missing setup rather than inventing a starting number. An index that
EXISTS AND IS EMPTY is a different thing: that is a set-up client whose first
issue is 001.

Step 02 pins every standing document it reads into internal/inputs/. Those are
frozen copies of what this run READ — deliver the LIVE files back at their
contract paths, never the pinned ones.

The compliance sweep at step 08 and the code gate at step 09 refuse the WHOLE
ISSUE rather than editing it. A phrase on the client's banned list, or a claim
the foundation forbids, means the issue is held and the reason is named. Never
quietly rewrite around a rule.

Deliverables under clients/<slug>/outputs/newsletter-agent-v2/<run-folder>/ with
the client/ vs internal/ split. The client/ side carries FOUR files for the
issue: issue-<nnn>.html (dark), issue-<nnn>-light.html (light, built by the same
command so the two can never disagree), issue-<nnn>.md (the plain-text part), and
about.txt. about.txt LEADS WITH ANYTHING NEEDING CONFIRMATION BEFORE THE CLIENT
SENDS — the client's open compliance question rides every issue as a review flag
until they answer it — and is two lines otherwise.

Deliver the updated issue-index.json and topic-pool.json at their contract paths.
The portal captures them and hands them back next run; the runner workspace does
not survive.

WE NEVER SEND. The client sends the issue from their own email platform, and this
product holds no credential for one. Prepare it; do not deliver it to anybody's
list.
```

### `karos-newsletter-setup-v2`

```
Set this client up on the newsletter. Run the setup skill at
products/building/newsletter-agent-v2/setup/SKILL.md end to end.

Build the five standing files the weekly runs read: the content foundation
(pillars, voice rules, compliance block, keyword targets), the voice card
distilled from the client's OWN past newsletters, the seeded topic pool, the
niche watch-list the seven-day scan searches, and the issue index the writer
claims its numbers in. Derive everything from the client's onboarding documents
and their existing issues. Decide and record why — do not wait for a sign-off and
do not ask the client anything.

newsletter-portal-intake.md carries the only things the client was asked for:
their send day (or that they have NOT chosen one — never assume a day), their
email platform, an audience note, the phrases they may never print, and any open
compliance question. Everything editorial is yours to derive; none of it may be
asked of them.

THIS IS RE-RUNNABLE, AND A RE-RUN VERIFIES RATHER THAN RE-SEEDS. If an issue
index already exists and holds rows, those rows are issues that have ALREADY GONE
OUT to a real mailing list. Re-seeding would erase them and hand the next run a
number that is already used. Check each of the five files: build what is missing,
verify what is there, and say in your readiness verdict which you did for each.

The brand file at clients/<slug>/skills/newsletter-agent/<slug>.json is YOURS to
write and yours alone — setup is its single writer of record. It is read live by
the blog agent and by v1 as well, so never rename a field and never remove one.

Do not draft or deliver an issue in this run. This is the setup. The last step
writes the readiness verdict; a client is not set up until it does.
```

### `karos-newsletter-manager-v2`

```
Run the newsletter manager pass for this client. Run the manager skill at
products/building/newsletter-agent-v2/manager/SKILL.md end to end.

Refill the topic pool from research and refresh the voice card when new reference
issues have arrived. Read what actually shipped and what the client did with it:
feedback rows carry whether they sent the issue, sent it after editing (the diff
against what we wrote is the voice lesson), or held it and why.

Keep the pool healthy rather than merely non-empty: the writer HOLDS a run on an
empty pool, and a pool of stale rows is the same failure a week later. Every row
carries its pillar, its provenance and its status — a row without provenance is
an invented subject and does not belong here.

You do not draft and you do not send. Deliver the updated topic-pool.json,
scan-topics.json and voice-card.md at their contract paths; the portal captures
them and hands them back next run.
```

### `karos-compliance-lock-v2`

```
Run the compliance lock over this client's prepared issue. Run the skill at
products/building/newsletter-agent-v2/compliance-lock/SKILL.md end to end.

Check the issue against BOTH rule sets together: the compliance section of
CONTENT-FOUNDATION.md and the compliance block in the brand file. Read them by
heading text, never by section number. Add the client's own banned phrases from
newsletter-portal-intake.md — those are on top of the house rules, never instead
of them.

REFUSE, DO NOT REWRITE. A violation holds the whole issue and names the rule and
the phrase that broke it. Quietly editing around a rule produces an issue nobody
reviewed against the rule they actually care about, and the client sends it
believing it was checked.

An open compliance question the client has not answered is not a violation. It is
a REVIEW FLAG: it rides the issue and leads about.txt, so whoever presses send
reads it first.
```
