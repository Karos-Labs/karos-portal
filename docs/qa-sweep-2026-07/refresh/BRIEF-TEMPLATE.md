# CD-G7 — per-client refresh team brief (template)

Copy this file per client, fill the `{{...}}` slots, and hand it to one team.
One team, one client, one proposal file. Nothing here reaches Firestore except
through `scripts/refresh-apply.ts`.

```
CLIENT NAME   {{Client Name}}
CLIENT ID     {{firestoreClientId}}
EXPORT FILE   {{/abs/scratchpad/refresh/slug__id.json}}
PROPOSAL OUT  {{/abs/scratchpad/refresh/proposals/slug.proposal.json}}
```

---

## 1. What this is

The portal's own intel pipeline (`src/lib/intel/pipeline.ts`) regenerates a
client from scratch: five live-web research agents, eight document generators,
a condensation pass, then `replaceClientContextDocs` **deletes everything and
writes new rows**. That is not what you are doing.

You are running a **completion pass**. The existing data is largely correct and
some of it was corrected by hand. Your job:

1. **Preserve** everything accurate. If a stored sentence is right, it stays.
2. **Complete** what is missing: every document type the pipeline produces
   exists at every tier it belongs to, every competitor row has a working
   domain, the brand palette has 3-4 colors with internal usage percentages.
3. **Update** what has gone stale: prices, headcount, positioning, competitor
   moves, social handles, anything the market changed since the last run.

You match the pipeline's structure and quality bar exactly. You do not invent a
format, and you do not invent facts.

---

## 2. Inputs

Read the export JSON in full before writing anything. It contains:

| Key | What it is |
|-----|-----------|
| `client` | The client-document fields in scope (name, website, industry, description, brandVoice, brandingGuidelines incl. `dominantColors[].usagePct`, socialLinks, customAgentIds) |
| `coverage.missing` | `docType@tier` rows the pipeline would normally have produced and that do not exist. These are your gaps. |
| `coverage.empty` | Rows that exist with blank content. Treat as missing. |
| `coverage.unexpected` | Rows outside the canonical set (`meeting-notes@internal-only` is legitimate and transcript-owned — leave it alone). |
| `contextDocs[]` | Every stored document, full `content`, plus `version`, `sectionCount`, `updatedAt`. |
| `competitors[]` | Every `clientCompetitors` row with its Firestore `id`. You need those ids to propose updates. |
| `seoGeoSummary` | The measured SEO/GEO numbers, with `trusted: true|false`. |
| `seoGeo` | The full capture: per-engine visibility, gaps, recommendations, answer grid, citation leaderboard. |
| `intelReport` | Metadata of the last Digital Intelligence report. |

### The SEO/GEO boundary — read this twice

`seoGeo` is **machine-measured** by a multi-engine capture (OpenAI / Gemini /
Anthropic). You **cannot** re-measure it and you must never author a number into
it. `refresh-apply.ts` has no write path to `clientSeoGeo` at all.

What you *do* with it: **cite** it. The measured visibility index, share of
voice, per-engine mention rates, the named gaps and the recommendation list are
inputs to `market-strategy`, `competitor-analysis` and `action-plan`. Carry the
numbers across with their provenance and their capture date.

If `seoGeoSummary.trusted` is `false`, the capture predates the 2026-07-23
redeploy cutoff and is unreliable. Then: describe the SEO/GEO position
qualitatively, use `—` for every metric, and note in `action-plan` that a fresh
capture is owed. Do not quote a stale number as if it were current.

---

## 3. The canonical document set

Eight document types, three tiers. This table is enforced in code
(`refresh-apply.ts` `LEGAL_TIERS`) — a proposal that breaks it is rejected.

| docType | `internal` | `client` | `internal-only` |
|---|:--:|:--:|:--:|
| `brand-voice` | yes | yes (condensed) | — |
| `market-strategy` | yes | yes (condensed) | — |
| `competitor-analysis` | yes | yes (condensed) | — |
| `product-information` | yes | yes (condensed) | — |
| `branding-guidelines` | yes | yes (condensed) | — |
| `target-audience` | yes | yes (condensed) | — |
| `client-guidelines` | — | — | **yes** |
| `action-plan` | — | — | **yes** |

- `internal` — full analyst-grade markdown. Staff only.
- `client` — a roughly 50% condensation of the internal twin. **The client sees
  this in the portal.** Every internal section heading must survive.
- `internal-only` — never published. `client-guidelines` and `action-plan` are
  agency rulebooks; putting either at tier `client` would leak internal notes to
  the client and the script refuses it.
- `meeting-notes` is **not** yours. It is written by transcript ingest.

A full client has **14 rows**: 6 internal + 6 client + 2 internal-only.

---

## 4. Per-document structure — use these headings verbatim

These are the actual pipeline templates (`src/lib/intel/templates.ts`). Keep
every `##` and `###` exactly as written, in this order. Do not number them (the
viewer numbers by position). Do not add a `## Change Log` and do not use `---`
horizontal rules in the body — the generator strips both.

Every document starts with YAML frontmatter as its very first characters:

```yaml
---
module: <docType>
client: {{firestoreClientId}}
version: 1
status: original          # tier "client" uses: published
system_of_record: <see per-type below>
client_visible: true      # false for client-guidelines and action-plan
last_updated: <YYYY-MM-DD, today>
sources: []
consumed_by: [<see per-type below>]
---
```

Client-tier documents additionally carry `published_at: <today>` and
`status: published`.

### brand-voice
`system_of_record: source` · `consumed_by: [e10, e11, e12, e13, e14, karos-chat]`
H1: `# Brand Voice & Copywriting Guide — {{Client}}`

```
## Voice in one line
## Five voice adjectives
## Voice dimensions
## Persona
## Writing dos and don'ts
   ### DO
   ### DON'T
## Compliance in copy (HARD GATES)
## Grammar & mechanics
## Vocabulary
   ### Words & phrases we use
   ### Words & phrases we avoid
   ### Names & spellings (exact)
## Blog / long-form guidelines
## Social voice by platform
## CTA taxonomy
## Sample phrases & taglines
## Quick reminder for writers
```

Intent: HOW the brand speaks, in enough detail that any agent produces on-voice
copy first try. Words only — visual rules live in `branding-guidelines`. Five
voice adjectives, each with what it means in practice. Voice dimensions are
five sliders (formal↔casual, serious↔playful, plain↔technical,
reserved↔bold, warm↔neutral) with the position and when it moves. "Social voice
by platform" is a table: Platform | Tone | Format | Focus | Platform-specific
rule, rows Instagram / TikTok / LinkedIn / X-Twitter. "Sample phrases" wants
8-12 concrete examples. Compliance gates are hard: never state or imply X,
always frame Y as Z.

### market-strategy
`system_of_record: source` · `consumed_by: [e10, e11, e12, e13, e14, a3, s5, s6, karos-chat]`
H1: `# Market Strategy — {{Client}}`

```
## Positioning statement
## Value propositions
## Messaging pillars
## Proof points / reasons to believe
## Message hierarchy
## Audience & ICP
   ### Ideal customer profile
   ### Personas
   ### Anti-personas (who we do NOT write for)
   ### Voice-of-customer
## Goals & KPIs
## Where to play
## How to win
## Competitive white space
## Channel priorities & cadence
## Roadmap
## Risks & watch-outs
```

Intent: the strategic brain — WHAT the brand says, to whom, where it plays, how
it wins. Positioning statement uses the blockquote form: "For **audience**,
**brand** is the **category** that **differentiator**, because **reason to
believe**." Three value propositions each with a one-line proof. 3-5 messaging
pillars. Each persona covers: who they are, job-to-be-done, pains and fears,
triggers to act, where they pay attention, objections and answers.

**Goals & KPIs is a table** — `| Area | KPI | Baseline | Target | Cadence |`.
Baseline: a figure from a named verifiable source, otherwise the literal string
`to capture with client`. Target: `to define with client` when the client has
not stated one. Never `data unavailable` in any cell. Omit a row only if the
metric is genuinely irrelevant to the business model.

This is where the measured SEO/GEO position belongs — channel priorities and
"how to win" should reflect `seoGeo` gaps.

### competitor-analysis
`system_of_record: view:client_competitors+research_runs` · `consumed_by: [e12, e13, e14, a3, s5]`
H1: `# Competitor Analysis — {{Client}}`

```
## Executive Summary
## Market Landscape
   ### Market dynamics
   ### How buyers make decisions in this market
   ### Market maturity and trajectory
## Competitive Position Overview
## Where {{Client}} Wins
## Where {{Client}} Lags
## Deep Dives — Top Direct Competitors
   ### Competitor 1: <Name> (<domain.com>)
   ### Competitor 2: <Name> (<domain.com>)
   ### Competitor 3: <Name> (<domain.com>)
## Social Presence Scan
## Competitive White Space
## Watch List
## Sources
```

Intent: elite competitive intelligence. Executive Summary is 4-6 sentences of
strategic judgment for a CEO, not a fact list.

**Quantitative data rule for this document:** pricing is stated only when
published on the competitor's own site, with the URL cited. Follower counts and
engagement metrics only from live measurements, with source and date.

"Competitive Position Overview" is a table: `| Competitor | Category |
Positioning (their words) | Price (stated, with source) | Key Differentiator |
Primary Weakness | Threat to {{Client}} |`. Threat is HIGH/MEDIUM/LOW with a
one-word reason.

Wins and Lags are bullet lists where every entry names the competitor being
beaten or beating them, plus the strategic implication. "Quality" and "service"
are not advantages. Lags are as valuable as wins — do not soften them.

Each deep dive uses these bold labels, in order: **Category:** / **Their
positioning:** / **Why buyers choose them:** / **Where they fall short:** /
**Their ideal customer:** / **Voice and content style:** / **Pricing:** /
**Threat level:** / **How to beat them:**.

The competitor set here must agree with the `competitors` block of your
proposal. Deep-dive the three highest-threat rivals.

### product-information
`system_of_record: source` · `consumed_by: [e10, e11, e12, e13, e14, a3, s6, karos-chat]`
H1: `# Product Information — {{Client}}`

```
## Overview
## What it does
## Target customers
## Business model
## Key features / offerings
## Primary CTAs
## Regulatory, compliance & claims (HARD GATES)
## Proof points & credibility
## Channels & how customers interact
## Tech signals / stack
## FAQ (foundational)
## Do-not-misstate
## Sources
```

Intent: the factual core. Overview is a bold-label list: Product/company name,
Website, One-liner (who it's for + what it does + unique mechanism), Founded /
HQ / market, Category, Product type (SaaS | DTC e-commerce | marketplace |
services | hybrid | other), Stage (pre-launch | early | growth | established).
"What it does" is 2-4 plain-language paragraphs. FAQ is a
`| Question | Answer |` table. Regulatory section covers: regulatory status,
required disclosures, banned claims, required framing, substantiation required.
Capture registration numbers — they are public facts on the footer or /legal.

### branding-guidelines
`system_of_record: references clients/{{slug}}/brand/` · `consumed_by: [e12, s6]`
H1: `# Branding Guidelines (Visual) — {{Client}}`

```
## Logo
## Color
## Typography
## Imagery & photography
## Iconography & graphic elements
## Layout & composition
## Motion (if applicable)
## Asset inventory
## Source / status
```

Intent: the VISUAL identity, read by products that generate images.
`## Color` is a table: `| Role | Name | Hex | Where used |` with rows Primary /
Secondary / Accent / Background / Text.

**This document and `client.brandingGuidelines.dominantColors` must agree.** If
your proposal changes the palette, every new hex must appear in this document's
text or `refresh-apply.ts` rejects the whole proposal. Typography: at most two
type families. Asset inventory is `| Asset | Variant | Location |`.

### target-audience
`system_of_record: source` · `consumed_by: [e10, e11, e12, e13, e14, karos-chat]`
H1: `# Target Audience — {{Client}}`

```
## ICP Persona Profile
   ### Demographics & Firmographics
   ### Job Title & Organizational Role
   ### Core Operational Pain Points
   ### Success Metrics They're Judged On
## Tech Stack & Current Solutions
   ### Incumbent Tools & Methods
   ### Where Those Solutions Fall Short
   ### Switching Triggers
## Content Engagement Patterns
   ### Primary Channels
   ### Content Formats That Hook Them
   ### Attention-Grabbing Hooks
   ### Trust Builders
## Linguistic Profile & Vocabulary
   ### Professional Vocabulary They Use
   ### How They Describe Their Problem — Verbatim Triggers
   ### How They Describe Their Ideal Outcome
   ### Words & Phrases to Avoid in Copy
```

Intent: the definitive ICP blueprint. This one has the strictest bar in the set.
Every bullet must trace to client onboarding data, a named review platform, a
competitor's hero copy, or a clearly-labelled industry pattern. A bullet that
cannot meet that standard is **omitted silently** — never placeholdered.

Header line: `**Primary ICP: <Role Title> at <Company / Customer Type>**`. Add a
"Secondary ICP" block only if two genuinely distinct buyers exist.

Hard minimums, enforced by the template's own instructions:
- Core Operational Pain Points: 4-6, each granular and mapped to something the
  client actually addresses. Not "they need better efficiency".
- Incumbent Tools & Methods: a table `| Tool / Method | Category | Why They Use
  It | Source |`, Source ∈ client-stated / website-observed / industry pattern.
  Named products, never category labels.
- Professional Vocabulary: a table `| Term | Full Form (if abbreviated) | When /
  how they use it |`, **minimum 8 rows**.
- Verbatim Triggers: **minimum 6** phrases, each sourced, each usable as a hook.
  The audience's raw voice, not the client's marketing language.
- Ideal Outcome: **minimum 4** phrases.
- Words to Avoid: a table `| Phrase to Avoid | Why It's a Trust-Killer for This
  Persona |`, minimum 5 rows.

### client-guidelines (INTERNAL, never shown to the client)
`system_of_record: source` · `client_visible: false` · `consumed_by: [all]`
H1: `# Client Guidelines — {{Client}}  (INTERNAL, never shown to the client)`

```
## How to use this
## Hard do-nots (never do these)
## Always do these
## Observed patterns
## Approval & workflow preferences
## Sensitivities & escalation
## Quick facts agents keep getting wrong
```

Intent: the standing rulebook. Every entry carries its source and date. A rule
here overrides a general default; on conflict the most recent dated entry wins.
Mine the client's stored doc corrections, meeting signals, and anything in the
export that reads as a standing instruction. Do not invent preferences.

### action-plan (INTERNAL)
`system_of_record: view:research_runs.payload.recommendations` · `client_visible: false` · `consumed_by: [all]`
H1: `# Action Plan — {{Client}}  (INTERNAL)`

```
## How to use this
## Recommendations
```

Intent: onboarding and refresh recommendations mapped to Karos products.
`## Recommendations` is a table:
`| # | Recommendation | Vertical | Impact | product_ids | Status |`
Impact ∈ high/med/low. `product_ids` is a bracketed list like `[e12]`,
`[a3, e14]`. Status starts `open`. This is the natural home for the `seoGeo`
gaps and recommendations — convert each measured gap into an owned action.

---

## 5. House rules the pipeline enforces — you inherit all of them

From `src/lib/intel/brain.ts` and the generation prompt. Non-negotiable.

**Source labelling.** Carry the label with the fact, in this priority order:

1. `client-stated:` — entered by the client's team. Absolute ground truth.
2. `web-observed (URL, YYYY-MM-DD):` — you fetched or searched it live, today.
3. `training knowledge:` — recalled, could not be verified live.
4. `industry pattern:` — general market inference.

Never launder a training-knowledge claim into a web-observed one. When a live
observation contradicts memory, the live observation wins.

**Two standards.**
- *Quantitative* (followers, revenue, pricing, headcount, ratings, growth %):
  cite only a figure from a named verifiable source. Otherwise `—` (em dash) in
  a table cell, or omit it silently in prose. Never `0` to mean unknown.
- *Qualitative* (voice, positioning, strategy, audience, competitive gaps):
  never a placeholder. Reason from evidence and label the inference. If a bullet
  genuinely cannot be supported, delete the bullet.

**Banned strings, anywhere in a document.** `refresh-apply.ts` rejects the
proposal if it finds any of them: "data unavailable", "information not found",
"no information available", "cannot determine", "as an AI", "I cannot access",
"I don't have real-time data".

**High-risk fields — training data is routinely wrong.**
- *Pricing*: only what is live on the site today. Otherwise write
  "see [URL] for current pricing".
- *Founding / launch date*: only from a primary source. Otherwise
  `[launch date — verify with client]`.
- *Headcount*: only from LinkedIn, a filing, or a dated press release. Otherwise
  `[team size — verify with client]`.
- *Revenue / AUM*: official source or client disclosure only. Never extrapolate.

**Regulatory identifiers are public facts — capture them.** Footer, /about,
/legal, /compliance. CNPJ, CVM Ato Declaratório, ANBIMA código, SEC/FCA
registrations, certifications. Never mark one unavailable without having
checked those pages.

**Never write meta-claims about your own access.** No "a live scrape was
performed" or "real-time data was unavailable". Use the four labels only, and
keep every document in the proposal consistent about what was reached.

**Window anchoring.** Every metric names its measurement date, e.g.
`14,230 followers (web-observed, instagram.com/handle, 2026-07-28)`.

---

## 6. The client tier — condensation contract

The `client` tier is not a separate piece of writing. It is a ~50% condensation
of the internal twin, and the client reads it in the portal.

**Keep:** positioning and value propositions · voice rules (dos/don'ts/tone
dimensions) · competitive leaders and the client's differentiator · measured
metrics **with their sources** (drop the methodology, keep the sourcing) ·
visual basics (primary colors, fonts, key logo rules) · strategy headline and
channel priorities · the recommendations summary.

**Remove:** internal methodology and "how we built this" · sourcing workflow
detail · instructions addressed to agents · competitor-derogatory labels
("weak", "poor execution", "failing" → neutral factual observation) · internal
weights, `product_ids`, agent routing tables.

**Hard rules:**
- Every `##` heading from the internal document appears in the client version.
  Condense *within* sections, never by dropping one.
- Never invent content that is not in the internal document.
- Never soften or omit a compliance/regulatory hard gate — those transfer
  verbatim.
- Frontmatter: `status: published`, `last_updated: <today>`,
  plus a `published_at: <today>` line.
- **No `[VERIFY]` tokens.** The script rejects them at this tier outright.

---

## 7. Competitors

The roster lives in `clientCompetitors`. Rules:

- **Never delete a row.** There is no delete path. A rival that no longer
  matters gets `overlap: "Low"` and a note in `positioning`, not removal.
- **Every row needs a working domain.** `url` is stored as a bare lowercase host
  (`okara.ai`, not `https://www.okara.ai/`) — that is what the favicon and
  brand-key matching read. Verify the domain resolves before proposing it.
- **Fix URL-shaped names.** A row whose `company` is a raw pasted URL is a
  legacy quick-add. Replace it with the canonical brand name and set `url`.
- **Fill the analysis fields**: `positioning`, `keyStrengths`, `keyWeaknesses`,
  `marketTier` (Leader | Challenger | Niche | Other), `overlap` (High | Medium |
  Low-Med | Low), `threatLevel` (HIGH | MEDIUM | LOW), `founded`, `scale`,
  `minInvestment`, `deepDive`.
- **Never blank a field**, and never empty a list that currently has entries.
  The script refuses both.
- **Do not touch** `llmMentions` / `llmMentionsAt`. Those are written by the
  visibility capture and there is no way to set them here.
- **Adding rivals**: put genuinely missing competitors in `competitors.create`.
  They land with `source: "manual"`. `company` and `url` are required. A create
  that duplicates an existing row by name or domain is rejected — use `update`
  with that row's id instead. Roster cap is 40.
- Cross-check against `seoGeo.competitorsNamed` and `seoGeo.discoveredBrands`:
  brands the answer engines actually named are the ones that matter most.
- The roster and `competitor-analysis` must tell the same story.

---

## 8. Brand colors (CD-E2)

`client.brandingGuidelines.dominantColors` is an ordered array, rank 1 = most
dominant. Every gate below is enforced in code:

- **3 or 4 entries.** Not 2, not 5.
- `hex`: 6-digit **lowercase**, `#rrggbb`. Unique within the array.
- `dominanceRank`: exactly the 1-based array position. Array order is dominance
  order.
- `usagePct`: an integer 0-100 on **every** entry, and the set must sum to
  **exactly 100**.
- `role`: optional, ≤60 chars, e.g. "Logo fill", "Primary CTA".

`usagePct` is the agency's internal mix guidance. It is stripped at the client
boundary — clients see swatches only — so write it for a designer, not for the
client.

Derive the palette from the live brand: logo, site, real marketing assets.
Percentages describe the share of visual surface each color should occupy, not a
guess dressed up as data.

Changing the palette **requires** shipping an updated `branding-guidelines`
document at tier `internal` in the same proposal, and every new hex must appear
in its text. The app regenerates that document from the palette on every save;
a proposal that moves one without the other leaves agents reading stale hexes,
so the script refuses it.

---

## 9. The `[VERIFY]` protocol

When you cannot confirm a claim from a primary source and the claim matters,
write the claim followed by the literal token `[VERIFY]`:

```
Founded 2019 [VERIFY] — no founding year on the site or in press coverage.
```

Rules:
- `[VERIFY]` is allowed **only** in `internal` and `internal-only` documents.
  The script rejects it at tier `client`.
- It is not a substitute for the pipeline's own conventions. Use
  `to capture with client` / `to define with client` in KPI tables, `—` for
  unmeasured quantitative cells, and `[launch date — verify with client]` /
  `[team size — verify with client]` for those two named fields. `[VERIFY]` is
  for everything else you had to assert but could not source.
- Never invent a fact instead of marking it. A `[VERIFY]` is cheap; a
  fabricated regulatory number is not.
- `refresh-apply.ts` counts every token and prints the total. Albert reviews
  them.

---

## 10. Web research

Use it wherever you have it, and lead with it.

1. Fetch the client's own site first: homepage, /about, /pricing, blog,
   footer, /legal. Quote what is live today.
2. Search the client by name + industry: entity confirmation, news, funding.
3. For each competitor: fetch the homepage, quote the current tagline verbatim,
   check the pricing page.
4. Review platforms: G2 / Capterra / Trustpilot; Reclame Aqui for Brazilian
   companies. Only cite a rating you actually saw.
5. Social: confirm each handle exists before writing it down.

Label every finding. If a fetch fails, fall back to labelled training knowledge
or `—`. Never claim to have fetched a page you did not fetch.

---

## 11. Proposal JSON schema

One file per client. `schemaVersion` is `1`. Unknown keys anywhere are a hard
rejection — the schema below is exhaustive.

```jsonc
{
  "schemaVersion": 1,
  "clientId": "{{firestoreClientId}}",   // must match --client
  "clientName": "{{Client Name}}",       // must match the stored name exactly
  "generatedAt": "2026-07-29",           // free-form, informational
  "team": "refresh-{{slug}}",            // free-form, informational
  "notes": "anything the reviewer should know",  // never written to Firestore

  "client": {                            // optional
    "profile": {                         // optional — FILL-ONLY, see below
      "website": "https://example.com",
      "industry": "…",
      "category": "…",
      "description": "…",
      "brandVoice": "…",
      "socialLinks": {                   // keys: instagram, linkedin, x,
        "instagram": "https://…"         //       tiktok, youtube, facebook, website
      }
    },
    "brandingGuidelines": {              // optional
      "dominantColors": [                // 3-4 entries; replaces the array
        { "hex": "#0b1f3a", "dominanceRank": 1, "role": "Brand base", "usagePct": 45 },
        { "hex": "#19e08a", "dominanceRank": 2, "role": "Primary CTA",  "usagePct": 30 },
        { "hex": "#f5f7fa", "dominanceRank": 3, "role": "Surface",      "usagePct": 25 }
      ],
      "fontHeading": "…",                // fill-only
      "fontBody": "…",                   // fill-only
      "visualStyle": "…",                // fill-only
      "guidelines": "markdown",          // fill-only
      "toneKeywords": ["…"]              // fill-only, max 12
    }
  },

  "docs": [                              // optional, one entry per docType@tier
    {
      "docType": "brand-voice",          // one of the 8 canonical types
      "tier": "internal",                // must be legal for that docType
      "content": "---\nmodule: brand-voice\n…",   // full markdown, from `---`
      "sources": ["https://…"],          // optional, max 200
      "shrinkApproved": "reason ≥20 chars"        // optional, see below
    }
  ],

  "competitors": {                       // optional
    "update": [
      {
        "id": "<from export competitors[].id>",   // required
        "company": "Okara",
        "url": "okara.ai",
        "founded": "2021",
        "marketTier": "Challenger",      // Leader | Challenger | Niche | Other
        "overlap": "High",               // High | Medium | Low-Med | Low
        "threatLevel": "HIGH",           // HIGH | MEDIUM | LOW
        "deepDive": true,
        "positioning": "…",
        "scale": "…",
        "minInvestment": "…",
        "keyStrengths": ["…"],           // max 12
        "keyWeaknesses": ["…"]           // max 12
      }
    ],
    "create": [
      {
        "company": "Ploy",               // required
        "url": "ploy.ai",                // required
        "marketTier": "Niche",
        "overlap": "Medium",
        "threatLevel": "MEDIUM",
        "deepDive": false,
        "positioning": "…",
        "keyStrengths": ["…"],
        "keyWeaknesses": ["…"]
      }
    ]
  }
}
```

### Semantics you must design around

| Rule | Effect |
|---|---|
| No delete | There is no key that removes anything. |
| Fill-only profile | A `client.profile` field is written only if the stored value is empty. A human value is skipped and reported, never overwritten. Same for `fontHeading`, `fontBody`, `visualStyle`, `guidelines`, `toneKeywords`. |
| Colors overwrite | `dominantColors` replaces the stored array outright. That is intentional. |
| Section floor | A document update may never have fewer `##` headings than the stored version. No override exists. |
| Length floor | An update may not fall below 90% of the stored length. `shrinkApproved` (a written reason, ≥20 chars) lowers the floor to 50%. |
| Identical content | A byte-identical document is reported `same` and not rewritten. `version` does not move. |
| Version | An update writes `version + 1` and clears the cached `summary`. A create writes `version: 1`. |
| Competitor ids | `update[].id` must be a competitor **of this client**. |

---

## 12. Self-check before you hand the proposal back

- [ ] Every `coverage.missing` and `coverage.empty` row is either supplied in
      `docs[]` or explained in `notes`.
- [ ] Every document begins with `---` and carries today's `last_updated`.
- [ ] Client-tier documents carry `status: published` + `published_at`, and
      contain zero `[VERIFY]` tokens.
- [ ] Every internal document has a client-tier twin, and every twin has all of
      its parent's `##` headings.
- [ ] No banned placeholder string anywhere.
- [ ] No `## Change Log`, no `---` rules in a body.
- [ ] Every number carries a source and a date, or is `—`.
- [ ] Pricing, founding date, headcount, revenue: sourced or explicitly marked.
- [ ] Every competitor row has a resolving bare-host domain.
- [ ] Palette is 3-4 colors, lowercase hex, ranks 1..n, `usagePct` sums to 100.
- [ ] If the palette changed, the `branding-guidelines@internal` document is in
      the proposal and names every new hex.
- [ ] The proposal parses as JSON and contains no key outside the schema above.
- [ ] `clientId` and `clientName` match the export.

Hand back: the proposal file path, the `[VERIFY]` count, and a short list of
what you completed versus what you left alone and why.
