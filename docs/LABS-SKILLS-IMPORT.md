# Importing the karos-labs skill library as Agents

karosCMO can seed its **Agents** from the karos-labs skill library. Each karos-labs skill is a
`SKILL.md` file (frontmatter + a long runbook). This importer turns each one into a karosCMO Agent
whose **system prompt** is that runbook, picking a best-fit `outputKind`, capabilities, and input
fields. The result is a runnable Agent you can test and run per-client like any other.

## How to run it

1. Sign in as an **admin**.
2. Go to **Agents**.
3. Click **Import Karos skills** (top-right, or in the empty-state when there are no agents yet).

It imports in a few seconds and the new agents appear in the live grid.

## What gets imported

Scope (decided with the product owner): the **karos library** (`skills/karos/*`) **plus the XO
Digital client skills** (`skills/clients/xodigital/*`) — about 72 skills. Other clients are skipped.

Source data lives in this repo (copied from `karos-labs/karos-ops/src/data`):

- `src/data/labs-skills-catalog.json` — clean library metadata (name/description).
- `src/data/labs-skills-content.json` — every `SKILL.md` body, keyed by skill id.

The mapping lives in [`src/lib/agents/labs-import.ts`](../src/lib/agents/labs-import.ts):

| SKILL.md → | Agent field |
|---|---|
| frontmatter `name` / catalog name | `name` (XO skills get a “ — XO Digital” suffix) |
| catalog desc / frontmatter `description` | `description` |
| body (frontmatter stripped) + an operating preamble | `systemPrompt` |
| id / path / parent heuristic | `outputKind` (`instagram_posts` · `social_posts` · `email` · `article` · `freeform`) |
| derived from `outputKind` | `capabilities`, `icon`, `color`, input `fields` |
| skill id | `labsSkillId` (provenance + idempotency key) |

For XO client skills, the **parent playbook** (e.g. `karos-instagram-tiktok-content-agent`) is
inlined into the system prompt as an “INHERITED PLAYBOOK” section, since the client skill’s
voice/format rules live upstream.

## Idempotency

Re-running is safe. Agents are keyed by `labsSkillId`:

- **New** skills are created (published, active).
- **Existing** imported agents are **updated in place** (name/description/prompt/config refreshed
  from the latest library) — no duplicates.
- The agent’s **lifecycle is preserved**: if an admin unpublished or paused an imported agent, a
  re-import does **not** silently republish it, and run counts are kept.

## Important limitation — this imports the *methodology*, not the *pipeline*

A karos-labs skill, in its home repo, is more than a prompt: the content-engine skills also run a
render/sourcing/QA toolchain and write deliverables to Supabase + a client portal. karosCMO has no
host for that machinery — an Agent here is a single Claude call.

So an imported agent produces the **text/copy** the skill describes:

- Library skills (intel, scope, brand, reports, email, blog/SEO) — these are text/report
  producers, so the import captures essentially their full value.
- XO **content-engine** skills (Giro, Lendas, Você Sabia, clips, Nova Oferta) — you get the
  **caption/script/post copy** (and, for Instagram, a structured post + image concept), **not** a
  rendered carousel, sourced podcast clip, or any portal/ledger write.

The operating preamble in each system prompt tells the model to follow the strategy/voice/format
rules but ignore the file/pipeline/database steps it cannot perform here.

## Other behavior to know

- **No auto-email.** Imported agents create assets and stop at “review” — none get the
  `email_client` capability, so a bulk import never wires up auto-delivery for dozens of agents.
  Turn on email delivery per-agent in the builder if a specific skill should deliver.
- **Single-output formats.** XO content formats (one post per run) default the Instagram “How
  many posts” field to 1; the generic library content agent defaults to 3.

## Possible follow-ups

- **Model tiering** — everything imports on `claude-sonnet-4-6` (the app default). Heavy report
  skills (full competitive intel, proposals) could be bumped to a larger model per skill.
- **Deeper context** — the direct parent playbook is inlined; the shared
  `_shared/CONTENT-FOUNDATION.md` is not in the build artifact and is not inlined.
- **Live sync** — this is a snapshot import. The two JSON files carry a `_generated` timestamp
  (from karos-labs) so you can tell how old the snapshot is. Re-copy them from
  `karos-labs/karos-ops/src/data` and re-run the import to pick up upstream skill edits.
