# Blog Agent v2 — the portal contract

The fifth intake family, and the second product to arrive as a **migration**:
`blog_article` was a managed task type until 2026-08-06. `RETIRED_BLOG_TASK_TYPE`
in `src/lib/types.ts` is what the readers of historical rows go through.

It is also the first agent that **reads another agent's output**.

## Three skills, one product

| Key | What it is | Listed? |
| --- | --- | --- |
| `karos-blog-writer-v2` | **The agent.** One press, one article, 13 steps. | Yes — this is the card |
| `karos-blog-setup-v2` | Run-once stand-up. Builds the post index, clusters, voice card. | No — `parentKey` |
| `karos-blog-manager-v2` | Monthly pass: published?, dead links, runway, performance. | No — `parentKey` |

**Three, not four.** There is no blog compliance lock — the blog reuses the
newsletter's `karos-compliance-lock-v2`, whose behaviour the framework re-decides:
it stops hand-editing blog posts and flags "re-render needed" instead, because
the site tree is derived from completed runs and a hand-applied fix would be
overwritten by the next press.

## The newsletter handoff — the part unique to this agent

> "The blog is almost dependent on the newsletter, and 'almost' is the design.
> The newsletter pays for finding out what happened this week. The blog pays for
> going deep on one thing it found."

Step 04 walks the **six most recent shipped issues** and reads, per issue:

| What | Portal storage | Kind |
| --- | --- | --- |
| Which issues to consider | `newsletterAgentState` | `issue-index` |
| The candidate list — **the handoff** | `newsletterLedger` | `issue-items` |
| The week's fuller research | `newsletterLedger` | `scan-log` |
| What the newsletter actually said | `newsletterLedger` | `issue-markdown` |

`items[]` carries `topic_id`, `heading`, `role` (lead\|brief) and **`depth`**
(developed\|mentioned) plus that item's own `sources[]`. **`mentioned` is the
pick**: the newsletter stated the subject and deliberately stopped where it got
interesting, and that unspent depth is the handoff.

**Why the portal has to hold these.** They live in the newsletter's run
workspace, which is destroyed with the runner — and unlike the blog's own state
the blog cannot regenerate them: they record what another product's paid research
found. `newsletterLedger` is one row per (issue, kind), not one per kind, because
the window is six issues deep.

**Never the newsletter's `internal/` trail.** The handoff file exists so the blog
does not reach into another product's internals.

## The blog's own durable state

`blogAgentState`, one row per kind:

| Kind | Why losing it hurts |
| --- | --- |
| `post-index` | The numbering authority AND the pending-link register. Lose it and a run re-claims a published number. |
| `clusters` | The **subject-claim** register, keyed by `subject_key`. Lose it and two runs write the same article. |
| `voice-card` | The style target, built once at setup. |
| `v1-posts` | Without it the first v2 press **deletes the client's existing articles** — the rebuild removes any post directory no completed run backs. |
| `next-request` | The client's requested subject. Theirs wins over the agent's pick. |

Three claims per run: post number (01), subject (05), slug (10). All three are
released by step 13 on a closed run.

**Not state:** the brand file (shared, additively completed) and
`CONTENT-FOUNDATION.md` (already a `newsletterAgentState` kind — one file, one
stored copy, re-injected from there).

## What the client gets

Five files per article (D40+D56), stored as a `blog-post-v2` envelope in
`asset.content`: the branded page, the **CMS body fragment**, the markdown,
`about.txt` (leading with review flags), and `publish-notes.txt` (meta title,
description, slug, canonical, keywords, structured data as copy-pasteable text).

We prepare, they publish. There is no publishing credential and no publish path.

## Pricing

`BLOG_RUN_CREDITS = 10` in `src/lib/credits.ts`, carried unchanged from
`TASK_EXECUTION_COSTS.blog_article`. Arguably low now — v2 pays for real deep
research at step 06 that the managed product did not do — but holding the price
is the right default for a migration. Revisit after a live month.

## Canonical instructions for the three `customAgents` docs

`scripts/register-blog-agent-v2.ts` reads the fenced block under each heading and
writes it as that agent's `instructions`.

### `karos-blog-writer-v2`

```
Write this client's next article. Run the writer skill at
products/building/blog-agent-v2/SKILL.md end to end — thirteen numbered
resumable steps — with the portal overlay below.

Read first, in this order:
1. client_context/brief.md and every file in client_context/files/.
   - blog-portal-intake.md is the portal's LIVE client data and OVERRIDES any
     older copy in the repo: the domains that count as theirs for internal
     linking, their correction to the voice we derived (it WINS over the voice
     card where the two disagree), who the articles are for, the subjects they
     will not touch, and where they publish.
   - post-index.json is THE NUMBERING AUTHORITY and the pending-link register,
     and the portal's copy is the live one. Claim the next number at step 01 by
     appending a row keyed by the number itself; next = 1 + the highest number in
     ANY row state INCLUDING released, because a reused number lands a new run on
     a closed run's folder. Flip to shipped at step 13.
   - clusters.json is THE SUBJECT-CLAIM REGISTER and the cluster map. Claim the
     subject at step 05 with a key COMPUTED from the candidate and nothing else:
     `issue-<NNN>/<topic id>`, or `request/<slugified subject>` for a client
     request. Two runs choosing the same candidate must compute the identical key
     so the second claim is refused — an invented id means both runs write the
     same article at full length. It is a map and a register, NEVER a queue: do
     not pick subjects from it.
   - voice-card.md is the style target, built once at setup. Match it.
   - v1-posts.json lists this client's pre-v2 articles. Step 13's rebuild treats
     them as completed runs. WITHOUT IT the rebuild deletes them from the
     client's own site.
   - next-request.md is the client's requested subject if they gave one. THEIRS
     WINS — and record which candidate you would have chosen and why.
   - CONTENT-FOUNDATION.md is the editorial brain, SHARED with the newsletter.
     Read it by HEADING TEXT, never by section number.
   - newsletter-issue-<NNN>-items.json is THE HANDOFF for each of the six most
     recent shipped issues. See step 04 below.
2. The client's onboarding profile documents under clients/<slug>/profile/.

PRECEDENCE, at step 02: the profile documents are the authority on WHAT THE
BUSINESS IS; the content foundation is the authority on EDITORIAL CHOICES. Where
they disagree about the business, the profile wins AND you write the
disagreement down so the stale file gets fixed. A real run once found the
foundation describing a business that had pivoted a month earlier.

STEP 04 — THE SUBJECT COMES FROM THE NEWSLETTER. Walk the attached issue item
lists, newest first. Each item carries `topic_id`, `heading`, `role` and
`depth`. PREFER A `mentioned` ITEM: the newsletter stated it and deliberately
stopped where it got interesting, and that unspent depth is what was left for
you. A `developed` lead stays available when it is genuinely the strongest
piece; record which you chose. Use a scan log ONLY to add material to a subject
the newsletter already covered — NEVER to introduce a new one. If no unused
candidate exists across the window and there is no client request, HALT with:
"no unused newsletter subject and no request; run the newsletter, or write what
you want in next-request.md". Say which case it was.

STEP 06 IS REAL RESEARCH AND IT IS WHAT THIS AGENT PAYS FOR. Every claim carries
a source and every number carries the date it was true — a figure the newsletter
used is RE-CHECKED as of today, not trusted. Every load-bearing claim rests on
TWO UNRELATED PRIMARY SOURCES: two organisations, not two pages from one. Write
raw responses to internal/raw/ BEFORE reading them, and on a resume read that
directory first and search only for what is missing — otherwise the resume buys
the research twice.

Steps 07-09: outline first (a failed body re-drafts against an approved plan
rather than from the subject up), then write, then the quality and compliance
pass. Strip every machine-writing pattern: no em dashes, no en dashes, no double
hyphens, no exclamation marks, sentence case. Leave the three legal footer fields
EMPTY — the renderer injects the locked wording from the brand file, so a legal
change reaches every future article with nobody remembering to. Step 09 also
produces the REVIEW FLAGS: any claim you could not source to the standard, any
precedence conflict from step 02, any compliance question the client has to
answer, and "no compliance rules configured" when that is the case.

Step 10 writes a link ONLY if its target exists. A wanted-but-absent internal
link is recorded as a PENDING link on the post's index row — never invented,
never left as a dead address.

Step 11 renders behind the hard gates and WRITES NOTHING OUTSIDE THE RUN FOLDER.
The compliance stop is code, not judgment: if a banned phrase survived step 09
the engine throws and writes nothing. A gate failure is RETURN: 09 with the
violation quoted, at most twice, then HELD. Never patch silently.

Step 12 delivers FIVE files to client/01-<slug>/: <slug>.html (the standalone
branded page), <slug>-body.html (the paste-into-your-CMS fragment), <slug>.md,
about.txt and publish-notes.txt. about.txt LEADS WITH THE REVIEW FLAGS.
publish-notes.txt carries the meta title, description, slug, canonical URL,
keywords and structured data as plain copy-pasteable text, plus what is left for
the client to do.

Step 13 is the memory step and it always runs. Deliver the updated
post-index.json and clusters.json at their contract paths; the portal captures
them and hands them back next run. On a HELD or FAILED run release ALL THREE
claims — the number, the subject AND the slug.

WE PREPARE, THE CLIENT PUBLISHES. There is no publishing credential and no
auto-publish path, and there never will be. Say plainly in publish-notes.txt
what is left for them: add it to your sitemap, submit it to Search Console.
```

### `karos-blog-setup-v2`

```
Set this client up on the blog. Run the setup skill at
products/building/blog-agent-v2/setup/SKILL.md end to end.

Read the client's onboarding profile documents FIRST — they are the authority on
what the business is. Derive everything derivable and ask the client nothing.

Produce, as DATA only and never as code:
- The blog's own tokens in the brand file at
  clients/<slug>/skills/newsletter-agent/<slug>.json, completed ADDITIVELY:
  blog.index_title, blog.index_dek, blog.meta_description, the eight blog.ui
  labels, and the four article-page labels that used to be hardcoded. NEVER
  rename a field and NEVER remove one — the still-live v1 engine, the newsletter
  v2 and the compliance lock all read this same file.
- The client's compliance patterns into `compliance.banned_extra` in that same
  brand file, which is the field the code gate already reads. Do NOT invent a
  second home for them. Store every pattern in PROMISE form, never as a bare
  word: a bare "guaranteed" refuses the sentence "authorised by the regulator is
  not the same as a guaranteed investment", which is exactly the kind of sentence
  a compliant article is made of.
- clusters.json: the intent-grouped cluster map AND the claim register. A map and
  a register, never a queue — the writer takes its subjects from the newsletter.
- post-index.json: the numbering authority, seeded empty.
- voice-card.md, distilled from the client's own existing posts. Their past posts
  are wanted, never required.
- v1-posts.json: the one-time list of their articles under outputs/blog-agent/,
  so the site rebuild keeps them instead of deleting a client's own work.

THIS IS RE-RUNNABLE, AND A RE-RUN VERIFIES RATHER THAN RE-SEEDS. A post index
holding rows holds articles that have already published; re-seeding hands the
next run a number already used. Check each file: build what is missing, verify
what is there, and say which you did for each.

Hard-gate on three things only: the profile documents, the brand file complete to
the full token list, and the content foundation. Everything else is wanted,
recorded if absent, never blocking.

Do not write or deliver an article. This is the setup.
```

### `karos-blog-manager-v2`

```
Run the blog manager pass for this client. Run the manager skill at
products/building/blog-agent-v2/manager/SKILL.md end to end. Six steps, no
internet, and a failure here never blocks an article.

Read your own previous manager run first, so this run's judgments do not
flip-flop against last month's.

The four things only a blog has:
1. DID THEY ACTUALLY PUBLISH IT. A newsletter is sent or not within a week; an
   article can sit as a draft for a month. Report every article's real fate and
   HOW LONG it has been sitting. Read the run folders directly — a held run
   appears in no ledger except its error row.
2. THE LINK GRAPH. Derive it from disk, list every pending link, and FIX the ones
   whose target now exists. The repair edits the affected run's PAYLOAD and
   re-renders only the derived site tree. A delivered client/ folder is immutable
   evidence and is never rewritten.
3. RUNWAY, and it is NOT a pool count. It is how many unused newsletter topics
   remain across the window the writer reads. Below eight is a flag, and name the
   honest cause: either the client has not run their newsletter recently, or the
   blog has consumed everything it covered. Those need different actions from the
   client.
4. PERFORMANCE, in honest lighter mode: what we published plus whatever the
   client shared. Never invented traffic numbers. Name what would unlock the real
   read, and record the date if it ever flips.

Close with the client report and the ledger rows.
```
