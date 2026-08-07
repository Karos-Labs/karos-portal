# Carousel Agent v2 — the portal contract

The seventh intake family, and the second **purely additive** one. It is
described as the modern replacement for the legacy Instagram agent, but nothing
here retires that agent: `karos-instagram-agent` is a separate document with its
own key, six credentials and its own intake shape, and retiring it is a
deprecation with its own client conversation.

Two things set it apart from the six before it.

**The deliverable is IMAGES.** Every other family's deliverable is text that
travels through `asset.content`. Slides are re-hosted like any other image and
reach the reader through `meta.artifacts`; the envelope carries the caption, the
about note and the slide NAMES so a reader can see ten were made and notice when
nine arrived.

**It depends on a runtime fix, not just on registration.** See the Dockerfile
note at the bottom. Registering these agents before the runner is rebuilt gives
a client a card that renders nothing.

## Three skills, one product

| Key | What it is | Listed? |
| --- | --- | --- |
| `karos-carousel-runner` | **The agent.** One carousel: topic, copy, render, caption. | Yes — this is the card |
| `karos-carousel-setup` | Run-once. Visual system, templates, tokens, topic catalogue. | No — `parentKey` |
| `karos-carousel-manager` | Monthly: what shipped, catalogue top-up, style PROPOSALS. | No — `parentKey` |

Keys carry **no `-v2` suffix** while the directory does — `karos-carousel-runner`
lives at `products/building/carousel-agent-v2/`, matching Reddit and reputation.

## Publishing, stated exactly

> Approval-gated drafts; portal auto-publishing available via Next.js execution.

The **agent** renders PNGs and stops. It holds no Instagram credential and has no
posting code path. What can auto-publish is the **portal**, from an approved
asset, through the same publish cron every other channel uses. The distinction is
load-bearing: saying "the agent publishes" would promise a capability the runner
does not have, and the runner's own instructions say so too.

## Durable state

`carouselAgentState`, one row per kind, under `clients/<slug>/skills/carousel-agent-v2/`:

| Kind | File | Why it matters |
| --- | --- | --- |
| `style-config` | `02-style-config.json` | The visual system every slide obeys. **The setup gate asks this one** |
| `brand-tokens` | `brand-tokens.json` | The colours and type the templates read |
| `topic-catalog` | `topic-catalog.yaml` | **The continuity file.** Rows flip unused → used; lose it and a topic repeats in public |
| `catalog-state` | `03-catalog-state.yaml` | The run's own view of the above. See the discrepancy note |

**One discrepancy, recorded rather than smoothed over.** The integration spec
named `02-style-config.json` and `03-catalog-state.yaml`. Against the manifest
only the first is standing state — setup writes
`{02-style-config.json, brand-tokens.json, templates/, topic-catalog.yaml}`, and
`03-catalog-state.yaml` is a numbered artifact in the RUN's `internal/` trail.
Both are captured, but **`topic-catalog.yaml` is what protects against a repeat**;
`catalog-state` is a snapshot beside it. Anyone dropping one should drop that one.

**`templates/` is a directory and is not captured.** One row holds one file, and
a template set needs a row per file or an archive. That is correct today because
nothing customises templates per client — it stops being correct the moment the
manager starts *applying* style changes rather than proposing them.

**The setup gate asks the style config**, not the catalogue: a client whose
catalogue is momentarily exhausted is a HELD run with a clear message, not an
unconfigured one.

## What the client is asked

Three things, all optional. No design questions — the look is built at setup, and
a colour picker here would put a second author on the one file whose job is that
every slide matches every other slide.

`carouselHandle` (a LABEL, never a credential) · `slideCountPreference` (null is
the better answer and the default) · `bannedTopics` (shared with the blog family,
separate documents)

## Pricing

`CAROUSEL_RUN_CREDITS = 25`. A decision, not a carried price. Above the
newsletter's and blog's tens because a post is a **render** job: the run drafts
copy and then drives headless Chromium over eight to ten full-resolution slides.
It equals the generic agent-run rate, so the rate card's existing
"Agent run · from 25" line already quotes it.

## The Dockerfile fix this depends on

`agent-service/runner/Dockerfile` installs Playwright globally and exposes it via
`NODE_PATH`. **`NODE_PATH` is a CommonJS-only mechanism and Node's ESM loader
ignores it entirely** — there is no ESM equivalent and none is planned. A `.mjs`
renderer doing `import { chromium } from 'playwright'` therefore dies on
`ERR_MODULE_NOT_FOUND`.

The fix is a symlink at the filesystem root:

```dockerfile
RUN npm install -g playwright@1.53.0 \
    && ln -s /usr/local/lib/node_modules /node_modules \
    …
```

The ESM resolver finds a bare specifier by walking **up** from the importing file
checking each `node_modules` directory, so a link at `/` is reachable from
anywhere — including `/opt/karos-agents/products/**/engine/*.mjs`, where the
renderers live. It must be created before `USER agent`, since the root filesystem
is not writable by the unprivileged user.

**A renderer that cannot start is indistinguishable from one that rendered
nothing**: the run ships blank slides rather than failing loudly. That is why
this is a prerequisite rather than a nice-to-have — and it fixes every `.mjs`
engine in the repo, not only the carousel's.

## Canonical instructions for the three `customAgents` docs

`scripts/register-carousel-agent-v2.ts` reads the fenced block under each heading
and writes it as that agent's `instructions`.

### `karos-carousel-runner`

```
Build this client's next carousel. Run the runner skill at
products/building/carousel-agent-v2/SKILL.md end to end with the portal overlay
below.

Read first, in this order:
1. client_context/brief.md and every file in client_context/files/.
   - carousel-portal-intake.md is the portal's LIVE client data and OVERRIDES any
     older copy in the repo: the account these are for, how many slides the
     client wants (absent means YOU choose per topic, which is the default and
     the better answer), and the subjects never to build one about.
   - topic-catalog.yaml is THE CONTINUITY FILE and the portal's copy is the live
     one. Take the next UNUSED row and flip it to used before you finish.
     Deliver the whole updated file back. Losing this means posting a subject
     the client has already posted, on a public grid where the repeat is visible
     to everyone who follows them.
   - 02-style-config.json is the visual system every slide obeys. Do not
     improvise around it: a carousel whose slides do not match each other is
     worse than one that is plain.
   - brand-tokens.json holds every colour and typeface. Never hardcode one. A
     token missing from this file is a reason to stop and say so, not a reason
     to pick something close.
2. The client's onboarding profile documents under clients/<slug>/profile/.

AN EXHAUSTED CATALOGUE IS A HELD RUN, never an invented topic. A catalogue row
carries provenance; a guess does not. Say plainly that the catalogue is empty and
that the manager will top it up.

THE RENDERER EXITS 2 WHEN THE TOOLING IS ABSENT, and exit 2 is NEVER a content
verdict. If Playwright is unavailable, report the run as failed on tooling and
write no client deliverable. Do not ship the slide HTML as if it were the post:
a client cannot post HTML to Instagram, and a deliverable they cannot use is
worse than an honest failure.

Deliverables under clients/<slug>/outputs/carousel-agent-v2/<date>-post-<NNN>/
with the client/ vs internal/ split: client/01-<post-id>/ holding slide-NN.png
for each slide, caption.txt, and about.txt leading with anything needing
confirmation before it goes out.

WE RENDER, A PERSON POSTS. This run holds no Instagram credential and has no
posting path. Approval-gated drafts; portal auto-publishing available via Next.js
execution — that is the PORTAL acting on an approved asset, not this run, and
nothing here should describe it as something the agent does.
```

### `karos-carousel-setup`

```
Set this client up on carousels. Run the setup skill at
products/building/carousel-agent-v2/setup/SKILL.md end to end.

Produce the standing files every post reads: the visual system
(02-style-config.json), the brand tokens every template reads
(brand-tokens.json), the slide templates themselves (templates/), and the topic
catalogue (topic-catalog.yaml).

DATA ONLY: no skill files, no per-client code, never a .mjs or .py.

Derive the visual system from the client's OWN brand material. Where they have
existing posts you like, match them; where they have guidelines, follow them.
Do not import a look from another client.

RENDER ONE SAMPLE as the proof the system works. If the renderer is unavailable,
record the sample check as NOT RUN rather than as passed — a style nobody
rendered is a style nobody has seen, and the first real post is a bad place to
find that out.

IF A TOPIC CATALOGUE ALREADY EXISTS, VERIFY IT, never re-seed it. Its rows record
what has already been posted, and re-seeding would offer those subjects to a
public grid a second time.

Do not build a carousel in this run. This is the setup.
```

### `karos-carousel-manager`

```
Run the monthly carousel review for this client. Run the manager skill at
products/building/carousel-agent-v2/manager/SKILL.md end to end. No internet and
no credentials: read on-disk state only.

Report what shipped, how much catalogue is left, and which templates are earning
their place. Append fresh unused rows to topic-catalog.yaml and deliver the whole
file back.

PROPOSE style-config changes, NEVER APPLY ONE. A look that changes underneath a
client mid-month is a grid that stops matching itself, and the client agreed to
the look at setup. Write the proposal with the reason and let a person take it.
```
