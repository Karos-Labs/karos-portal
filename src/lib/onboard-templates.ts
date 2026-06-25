import "server-only";

/**
 * Core research invariants from RESEARCH-ENGINE.md.
 * Hardcoded — prepended to every agent prompt; cannot be overridden by agent config.
 */
export const RESEARCH_ENGINE_RULES = `
## RESEARCH ENGINE — CORE RULES (NON-NEGOTIABLE)

ONE RULE, NO EXCEPTIONS: Never write a number you did not observe from a named, verifiable source.

### What counts as measured
- A number pulled from a specific URL (name the URL and the date accessed)
- A number from a tool or scrape output (name the tool + date)
- A number the client stated explicitly (prefix with "client-stated:")
- A number from a public filing, audit, or press release (cite document + date)

### What is NOT measured — never use
- Training-knowledge estimates of audience sizes, revenue, or market share
- Industry averages applied to this specific company without a source
- Extrapolations or projections from partial data
- Ranges introduced by hedging ("approximately", "around", "roughly", "~")

### When you cannot source a figure
Write "data unavailable" — not zero, not a range, not a guess.
The reader needs to know it is unknown, not approximated.

### Social metrics (Apify-backed in production; mark as training knowledge when no live scrape available)
- followers: exact integer count — note source and date
- eng_per_1k: (likes + comments) / followers × 1000, averaged over measured posts — cite the posts used
- cadence: posts per week — count from actual post dates in a defined window
- growth: % follower change — only if two measured data points exist, else "data unavailable"

### Qualitative claims
Evidence-backed statements only. "Leads on Instagram" requires citing what you observed.
"Strong brand" without evidence is not allowed. Say what you specifically found.
`.trim();

/**
 * Social metrics methodology from METRICS-V1.md.
 * Defines the three verticals and null taxonomy for onboarding.
 */
export const METRICS_RULES = `
## METRICS-V1 — ONBOARDING SCOPE

Onboarding uses ONLY the social_content vertical. SEO/GEO and web/UX metrics are deferred.

### social_content metrics (required per platform, if handle exists)
| Metric | Definition | Source |
|--------|-----------|--------|
| followers | Exact count at scrape time | Apify / platform scrape |
| eng_per_1k | (likes+comments)/followers×1000, avg last 10 posts | Measured posts |
| cadence | Posts/week, avg last 4 weeks | Measured post dates |
| growth | % follower change over period | Two measured points only |
| competitor_outrank | null at onboarding (no baseline yet) | — |

### NULL TAXONOMY
- "data unavailable" — no handle found, account private, or scrape blocked
- Never write 0 to mean unknown (zero means zero followers; unknown means "data unavailable")
- Never combine a measured metric with a guessed one in the same sentence

### WINDOW ANCHORING
Every metric must note the measurement date. Example: "14,230 followers (Apify scrape, 2026-06-24)"
`.trim();

/**
 * Condensation rules from CLIENT-CONTEXT-OS.md §5.
 * Applied when generating client-tier docs from internal-tier docs.
 */
export const CONDENSATION_RULES = `
## CONDENSATION CONTRACT (internal → client-facing)

You are condensing an internal analyst document into a client-facing version.

### Keep (required in the output)
- Core positioning statement and value propositions
- Key voice rules (dos / don'ts / tone dimensions)
- Competitive leaders and the client's main differentiator
- Measured metrics with their sources (keep sourcing, drop methodology explanation)
- Visual basics (primary colors, fonts, key logo rules)
- Strategy headline and channel priorities
- Actionable recommendations summary

### Remove (never appear in client output)
- Internal methodology notes and "how we built this" commentary
- Sourcing workflow details (which tool, which scrape run, how we resolved handles)
- Internal reminders to agents (e.g. "agents must read this before producing")
- Competitor-derogatory labels (e.g. "weak", "poor execution", "failing")
- Internal weights, product_ids, agent routing tables
- Any content tagged internal-only (client-guidelines, action-plan)

### Hard rules
- Target ~50% of the internal document's length
- Never invent content not in the internal doc
- Never soften or omit a hard compliance gate (those must transfer verbatim)
- Stamp the output with: status: published, published_at: <today>
- Never publish client-guidelines or action-plan — those are always internal-only
`.trim();

/**
 * Template markdown for each context document type.
 * Sourced verbatim from karolabs-data/skills/karos/prospecting/onboard/templates/.
 * Embedded here so the Next.js app has no runtime filesystem dependency.
 */
export const TEMPLATES: Record<string, string> = {
  "brand-voice": `---
module: brand-voice
client: <slug>
version: 1
status: original
system_of_record: source
client_visible: true
last_updated: <YYYY-MM-DD>
sources: []
consumed_by: [e10, e11, e12, e13, e14, karos-chat]
---

# Brand Voice & Copywriting Guide — <Client>

> HOW the brand speaks, in enough detail that any agent or writer produces on-voice copy on the first try. Visual rules live in branding-guidelines; this is words only.

## 1. Voice in one line
<e.g. "A smart, trustworthy friend who understands finance but never talks down to you.">

## 2. Five voice adjectives
- **<Adjective>** — <what it means in practice, one line>
- **<Adjective>** — <>
- **<Adjective>** — <>
- **<Adjective>** — <>
- **<Adjective>** — <>

## 3. Voice dimensions
- Formal ↔ casual: <position + when it moves>
- Serious ↔ playful: <>
- Plain ↔ technical: <>
- Reserved ↔ bold: <>
- Warm ↔ neutral: <>

## 4. Persona
<Who is "speaking" when the brand posts. The character, relationship to reader, what they would and would not say.>

## 5. Writing dos and don'ts
### DO
- <rule with concrete example>
### DON'T
- <rule with better alternative>
- <buzzwords/jargon to avoid>

## 6. Compliance in copy (HARD GATES)
- Never state or imply: <banned claim>
- Always frame <sensitive topic> as: <required framing>

## 7. Grammar & mechanics
- Person / address: <>
- Tense & active voice: <>
- Sentence length & rhythm: <>
- Punctuation: no em dashes (Karos house rule). <>
- Emoji policy: <>
- Numbers: <>

## 8. Vocabulary
### Words & phrases we use
### Words & phrases we avoid
### Names & spellings (exact)

## 9. Blog / long-form guidelines
- **Target length:** <range>
- **Structure:** <>
- **Headline formula:** <>
- **CTA placement:** <>

## 10. Social voice by platform
| Platform | Tone | Format | Focus | Platform-specific rule |
|----------|------|--------|-------|------------------------|
| Instagram | <> | <> | <> | <> |
| TikTok | <> | <> | <> | <> |
| LinkedIn | <> | <> | <> | <> |
| X / Twitter | <> | <> | <> | <> |

## 11. CTA taxonomy
<Which CTA per post intent: visibility / sell / both.>

## 12. Sample phrases & taglines
<8-12 examples a writer can pattern-match against.>

## 13. Quick reminder for writers
> <The 2-3 non-negotiables.>

## Change Log
- <date> — onboarding — initial version.`,

  "market-strategy": `---
module: market-strategy
client: <slug>
version: 1
status: original
system_of_record: source
client_visible: true
last_updated: <YYYY-MM-DD>
sources: []
consumed_by: [e10, e11, e12, e13, e14, a3, s5, s6, karos-chat]
---

# Market Strategy — <Client>

> The strategic brain of the profile. WHAT the brand says and to whom, where it plays, how it wins.

## 1. Positioning statement
> For **<audience>**, **<brand>** is the **<category>** that **<differentiator>**, because **<reason to believe>**.

## 2. Value propositions
1. **<prop>** — <one-line support / proof>
2. **<prop>** — <>
3. **<prop>** — <>

## 3. Messaging pillars
<3-5 recurring themes everything ladders up to.>

## 4. Proof points / reasons to believe
<Evidence behind every claim: data, credentials, track record, named partners.>

## 5. Message hierarchy
<What we lead with, and the order.>

## 6. Audience & ICP
### Ideal customer profile
<The core buyer in a paragraph.>

### Personas
#### <Persona name>
- Who they are:
- Goal / job-to-be-done:
- Pains & fears:
- Triggers to act:
- Where they pay attention:
- Objections & how we answer:

### Anti-personas (who we do NOT write for)

### Voice-of-customer
<Real language customers use.>

## 7. Goals & KPIs
| Area | KPI | Baseline (measured) | Target (client goal) | Cadence |
|------|-----|---------------------|----------------------|---------|

> Baseline = measured from a named source only. Target = a goal the client stated.

## 8. Where to play
<Segments, channels, and niches to prioritize.>

## 9. How to win
<The strategic play: the wedge, what compounds, the unfair advantage.>

## 10. Competitive white space
<The unowned territory no rival holds.>

## 11. Channel priorities & cadence
<Per channel: role, priority, cadence, format mix.>

## 12. Roadmap
<Phased and qualitative: foundation → execution → optimization.>

## 13. Risks & watch-outs
<Market, competitive, regulatory, and timing risks.>

## Change Log
- <date> — onboarding — initial strategy from research synthesis.`,

  "competitor-analysis": `---
module: competitor-analysis
client: <slug>
version: 1
status: original
system_of_record: view:client_competitors+research_runs
client_visible: true
last_updated: <YYYY-MM-DD>
sources: []
consumed_by: [e12, e13, e14, a3, s5]
---

# Competitor Analysis — <Client>

> Who the client competes with, what each rival does well and badly, and where the open territory is.

**No guessed numbers.** Every figure is either measured (Apify social metrics) or copied verbatim from the competitor's own page with the URL. No scores, no grades, no ranks, no estimated prices.

## TL;DR
<3-5 sentences: who the closest direct rivals are and the single clearest differentiator the client owns.>

## Competitor overview table
| Competitor | Category | Price / minimum (stated, with source) | Positioning | Key differentiator | Primary weakness |
|------------|----------|---------------------------------------|-------------|-------------------|-----------------|

## Deep dives — top direct competitors
### 1. <Competitor> — deep dive
- **What they do well:**
- **Where they fall short:**
- **Their ICP:**
- **Voice & content:**
- **Pricing / accessibility vs us:**

### 2. <Competitor> — deep dive

### 3. <Competitor> — deep dive

## Per-platform reality (measured)
<Social scan: who posts what, cadence, engagement, format mix.>

## Competitive gaps / white space
1. **<gap>** — <why it's open and durable>
2. **<gap>** — <>
3. **<gap>** — <>

## Watch list
<Emerging or fast-moving competitors to monitor.>

## Sources

## Change Log
- <date> — onboarding — initial analysis from wide-scan.`,

  "product-information": `---
module: product-information
client: <slug>
version: 1
status: original
system_of_record: source
client_visible: true
last_updated: <YYYY-MM-DD>
sources: []
consumed_by: [e10, e11, e12, e13, e14, a3, s6, karos-chat]
---

# Product Information — <Client>

> The factual core: what it is, what it sells, who it serves, how it makes money, and what may and may not be claimed.

## 1. Overview
- **Product / company name:**
- **Website:**
- **One-liner:** <who it's for + what it does + the unique mechanism>
- **Founded / HQ / market:**
- **Category:**
- **Product type:** <SaaS | DTC e-commerce | marketplace | services | hybrid | other>
- **Stage:** <pre-launch | early | growth | established>

## 2. What it does
<2-4 paragraphs in plain language.>

## 3. Target customers
<Who buys / uses this, in plain terms.>

## 4. Business model
- **How they make money:**
- **Pricing (only figures the client publishes):** <tiers, minimums — with source URL. Write "not published" if not stated.>
- **Unit / entry point:**

## 5. Key features / offerings
1. **<feature>** — <what it is + why it matters>
2. **<feature>** — <>
3. **<feature>** — <>

## 6. Primary CTAs
<Main actions the brand asks for, verbatim.>

## 7. Regulatory, compliance & claims (HARD GATES)
- **Regulatory status:**
- **Required disclosures / disclaimers:**
- **Banned claims (NEVER say or imply):**
- **Required framing:**
- **Substantiation required:**

## 8. Proof points & credibility
<Audits, certifications, track record, named partners. Every figure must have a source.>

## 9. Channels & how customers interact

## 10. Tech signals / stack
<Observable stack and infrastructure.>

## 11. FAQ (foundational)
| Question | Answer |
|----------|--------|

## 12. Do-not-misstate
<Facts commonly gotten wrong.>

## Sources

## Change Log
- <date> — onboarding — initial version from website + research.`,

  "branding-guidelines": `---
module: branding-guidelines
client: <slug>
version: 1
status: original
system_of_record: references clients/<slug>/brand/
client_visible: true
last_updated: <YYYY-MM-DD>
sources: []
consumed_by: [e12, s6]
---

# Branding Guidelines (Visual) — <Client>

> The VISUAL identity and asset inventory. Read by products that produce images.

## 1. Logo
- **Primary lockup:** <description>
- **Variants:** <inverse, icon/symbol, monochrome>
- **Clear space & minimum size:**
- **Do nots:** <stretch, recolor, add effects>

## 2. Color
| Role | Name | Hex | Where used |
|------|------|-----|-----------|
| Primary | <> | <#> | <> |
| Secondary | <> | <#> | <> |
| Accent | <> | <#> | <> |
| Background | <> | <#> | <> |
| Text | <> | <#> | <> |

## 3. Typography
- **Display / headline:** <family, weights>
- **Body:** <family, weights>
- **Rule:** keep to ≤2 type families.

## 4. Imagery & photography
<Style, mood, color treatment, do/don't.>

## 5. Iconography & graphic elements
<Icon style, shapes, recurring motifs.>

## 6. Layout & composition
<Grid, spacing, margins, post/slide rules.>

## 7. Motion (if applicable)
<Transitions, pacing, caption animation.>

## 8. Asset inventory
| Asset | Variant | Location |
|-------|---------|----------|
| Logos | <primary/inverse/icon> | <path> |
| Fonts | <families> | <path> |

## 9. Source / status
<Website-scraped draft | client-uploaded | finalized brand kit.>

## Change Log
- <date> — onboarding — initial draft scraped from website.`,

  "client-guidelines": `---
module: client-guidelines
client: <slug>
version: 1
status: original
system_of_record: source
client_visible: false
last_updated: <YYYY-MM-DD>
sources: []
consumed_by: [all]
---

# Client Guidelines — <Client>  (INTERNAL, never shown to the client)

> The standing rulebook for working with this client. EVERY agent reads this before producing anything.

## How to use this
Before producing any deliverable, read this file and obey it. A rule here overrides a general default. If two rules conflict, the most recent dated entry wins.

## 1. Hard do-nots (never do these)
- <things the client explicitly said they never want> — <source + date>

## 2. Always do these
- <standing requests the client makes every time> — <source + date>

## 3. Observed patterns
- <patterns inferred from repeated feedback> — <evidence>

## 4. Approval & workflow preferences
- <how they like to work: who approves, how fast, what channels>

## 5. Sensitivities & escalation
- <topics to handle carefully; when to escalate>

## 6. Quick facts agents keep getting wrong
- <recurring factual corrections>

## Change Log
- <date> — onboarding — initial guidelines from intake.`,

  "action-plan": `---
module: action-plan
client: <slug>
version: 1
status: original
system_of_record: view:research_runs.payload.recommendations
client_visible: false
last_updated: <YYYY-MM-DD>
sources: []
consumed_by: [all]
---

# Action Plan — <Client>  (INTERNAL)

> The recommendations from onboarding, mapped to Karos products. Internal only.

## How to use this
Before running any product for this client, read the rows tagged with that product's id and treat them as requirements.

## Recommendations
| # | Recommendation | Vertical | Impact | product_ids | Status |
|---|----------------|----------|--------|-------------|--------|
| 1 | <title> | <vertical> | <high/med/low> | [e12] | open |
| 2 | <title> | <> | <> | [a3, e14] | open |
| 3 | <title> | <> | <> | [s6] | open |

## Change Log
- <date> — onboarding — initial recommendations from intel run.`,
};
