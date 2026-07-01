import "server-only";

/**
 * Core research invariants from RESEARCH-ENGINE.md.
 * Hardcoded — prepended to every agent prompt; cannot be overridden by agent config.
 */
export const RESEARCH_ENGINE_RULES = `
## RESEARCH ENGINE — CORE RULES (NON-NEGOTIABLE)

### TWO SEPARATE STANDARDS — apply them correctly

**QUANTITATIVE METRICS** (follower counts, revenue, pricing, headcount, ratings, growth %):
- Only cite a number you observed from a named, verifiable source
- What counts as measured: a specific URL + date, a tool/scrape output + date, a client-stated figure (prefix "client-stated:"), a public filing or press release
- What is NOT measured: training-knowledge estimates, industry averages without a source, extrapolated ranges, hedged approximations ("approximately", "around", "~")
- When you cannot source a specific figure: use "—" (em dash) in table cells; in prose, omit the unsourced figure silently or note it is not publicly published
- NEVER write "data unavailable" anywhere in a rendered document — tables, sections, or headers

**QUALITATIVE ANALYSIS** (voice, tone, positioning, strategy, audience, brand, competitive gaps, market dynamics):
- NEVER write "data unavailable", "N/A", "not found", "cannot determine", or any placeholder
- You have deep training knowledge across millions of brands, industries, and markets — use it
- Use contextual reasoning, industry pattern recognition, and observable signals to derive every insight
- When inferring rather than directly observing: label it clearly ("signals suggest…", "observable pattern:", "industry pattern:")
- If a specific qualitative bullet genuinely cannot be supported by any signal, omit it silently — but never replace it with a placeholder phrase

### Social metrics (Apify-backed in production; label as training knowledge when no live scrape available)
- followers: exact integer count — note source and date
- eng_per_1k: (likes + comments) / followers × 1000, averaged over measured posts — cite the posts used
- cadence: posts per week — count from actual post dates in a defined window
- growth: % follower change — only if two measured data points exist, else "data unavailable"

### Qualitative evidence standard
Evidence-backed statements only. "Leads on Instagram" requires citing what you observed.
"Strong brand" without evidence is not allowed. Name what you specifically found and why it signals strength.

### PRICING — HIGH-RISK FIELD (training data is frequently stale or wrong)
Pricing changes constantly. A figure from training memory may be months or years out of date.
- ONLY state a price you are highly confident is currently on the live website
- If there is ANY doubt, write "see [website URL] for current pricing" instead of guessing a number
- The website always wins over training memory — never let a training-data price contradict an observed website price
- Never state a minimum investment, subscription cost, or service fee from training memory alone without explicitly flagging it as unverified

### FOUNDING / LAUNCH DATE — HIGH-RISK FIELD (training data frequently confuses registration date, rebrand date, and actual product launch)
- Only state a specific year or date you observed on the company's own website, press release, or primary filing
- If you are unsure or cannot confirm from a primary source, write "[launch date — verify with client]" rather than guessing
- Never state a founding year from training memory alone — training data often uses incorporation dates (years earlier than actual launch), rebrand dates, or data that has since been corrected

### HEADCOUNT / TEAM SIZE — HIGH-RISK FIELD
- Only state headcount from a named source: LinkedIn, official filing, or press release with date
- If not sourced: write "[team size — verify with client]" — never estimate

### REVENUE / AUM / ASSETS UNDER MANAGEMENT — HIGH-RISK FIELD
- Only state financial figures from an official source (press release, filing, news report with citation) or direct client disclosure
- Never estimate, extrapolate, or round to a convenient number from training memory

### CLIENT CONTEXT IS AUTHORITATIVE
The CLIENT CONTEXT block passed in the prompt contains information entered directly by the client's team. This is the most reliable source for basic company facts (name, founding, website, description). If the CLIENT CONTEXT states a fact, it takes absolute precedence over any research finding, website observation, or training knowledge.

### REGULATORY & COMPLIANCE DATA — always capture these
Official registration numbers and regulatory declarations are publicly visible on regulated-industry websites (footer, about, /legal, /compliance, /quem-somos).
- Always check for: company registration numbers (CNPJ in Brazil), regulatory declarations (CVM Ato Declaratório, ANBIMA código, SEC, FCA, CFA, etc.), compliance certifications
- For Brazilian financial/investment companies: look specifically for CVM Ato Declaratório number, código de autorização, CNPJ, and ANBIMA registration — almost always in the site footer or legal page
- Never mark regulatory identifiers as "data unavailable" without having explicitly checked the footer, about, and legal pages
- These are public facts — capture them, do not skip them

### DATA SOURCING LANGUAGE — must be consistent across all documents in a run
- NEVER write "a live scrape was performed", "a live scrape was not possible", "real-time data was unavailable", or any meta-claim about your data access method
- Use consistent labels only: "website-observed:" for things visible on the company's public site, "training knowledge:" for what you know about the company, "industry pattern:" for general market knowledge
- One document claiming it scraped the site while another says it couldn't is a contradiction that destroys client trust
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
- "—" (em dash) — no handle found, account private, scrape blocked, or metric not measured
- Never write 0 to mean unknown (zero means zero followers; unknown means "—")
- Never write "data unavailable" anywhere in the rendered document
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
- COMPLETE ALL SECTIONS. Every section heading from the internal doc must appear in the output. Never drop a section. A truncated document is a failed document.
- Target ~50% of the internal document's length by condensing WITHIN sections — not by dropping sections entirely.
- Never invent content not in the internal doc
- Never soften or omit a hard compliance gate (those must transfer verbatim)
- Stamp the output with: status: published, published_at: <today>
- Never publish client-guidelines or action-plan — those are always internal-only
- Never write "data unavailable" anywhere — use "—" for unknown quantitative fields
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
> Define the recommended KPI framework for this business. Fill in KPI name, area, and cadence from your knowledge of this business type. For Baseline: use only a figure from a named, verifiable source — otherwise write "to capture with client". For Target: if the client has not stated a goal, write "to define with client". NEVER write "data unavailable" in any cell. Omit a row only if the metric is genuinely irrelevant for this business model.

| Area | KPI | Baseline | Target | Cadence |
|------|-----|----------|--------|---------|

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

> Elite competitive intelligence. Starts with the market, positions the client within it, then profiles the key rivals with surgical precision. No filler, no placeholders. Every section is actionable for a senior marketing strategist.

**Quantitative data rule:** Pricing is only stated when published on the competitor's own website (cite the URL). Follower counts and engagement metrics are only cited from live measurements with source and date.

## Executive Summary
<4-6 sentences that a CEO reads before the full briefing. Answer: what kind of market is this, who are the most dangerous rivals, what is the single clearest competitive advantage <Client> can own, and what is the most urgent strategic move. This is not a list of facts — it is a strategic judgment.>

## 1. Market Landscape

### Market dynamics
<What is the nature of this competitive environment? Is the market crowded with undifferentiated players, dominated by 1-2 giants with a long tail, a fragmented niche, or an emerging category? What are the 2-3 macro forces shaping competition right now (pricing pressure, commoditization, audience shifts, new technology enabling new entrants)?>

### How buyers make decisions in this market
<What do buyers compare when evaluating options in this category? What are the top 2-3 decision drivers (price, reputation, specialization, speed, relationships)? What does a typical buying journey look like — who initiates, who approves, how long does it take?>

### Market maturity and trajectory
<Is this market growing, consolidating, or mature? What recent competitive moves, category pivots, or new entrants are reshaping the landscape? What is happening RIGHT NOW that a strategist must account for?>

## 2. Competitive Position Overview

| Competitor | Category | Positioning (their words) | Price (stated, with source) | Key Differentiator | Primary Weakness | Threat to <Client> |
|------------|----------|---------------------------|-----------------------------|--------------------|-----------------|---------------------|
<Fill all rows with real data. For price: only if published on their website with URL. Threat: HIGH / MEDIUM / LOW with one-word reason.>

## 3. Where <Client> Wins
<The specific competitive advantages <Client> holds over the field. Name the competitor being beaten for each advantage. "Quality" and "service" are not advantages — name the observable, defensible edges that buyers actually care about.>

- **<Advantage 1>** — <exactly what the advantage is> vs. <named competitor(s)> who <what they lack>. Strategic implication: <why this matters to buyers and how the agency should amplify it>.
- **<Advantage 2>** — <evidence + competitive contrast + strategic implication>
- **<Advantage 3>** — <evidence + competitive contrast + strategic implication>
- **<Advantage 4 if applicable>** — <>

## 4. Where <Client> Lags
<Honest, specific gaps relative to competitors. This intelligence is what the agency needs to build a realistic strategy. Do not soften or omit these — they are as valuable as the wins.>

- **<Gap 1>** — <competitor who outperforms here> does <specifically what better>. This matters because <buyer reason>. The gap manifests in <observable evidence>. Mitigation: <what <Client> could do to neutralize this gap>.
- **<Gap 2>** — <same format>
- **<Gap 3>** — <same format>
- **<Gap 4 if applicable>** — <>

## 5. Deep Dives — Top Direct Competitors

### Competitor 1: <Name> (<domain.com>)
**Category:** direct / secondary / indirect
**Their positioning:** <their tagline or hero copy verbatim if available — this is what they tell the market they are>
**Why buyers choose them:** <2-3 specific reasons — what problem they solve better than others, what their customers love>
**Where they fall short:** <2-3 specific weaknesses — gaps in their offering, poor UX, pricing friction, voice inconsistency, underserved segments>
**Their ideal customer:** <who specifically buys them — role, company size, context, primary motivation>
**Voice and content style:** <tone archetype, content format mix, platform focus, cadence — observed>
**Pricing:** <published pricing with source URL — if not published, write "not published on their website">
**Threat level:** HIGH — <one sentence on why and specifically which part of <Client>'s market they threaten most>
**How to beat them:** <specific strategic counter — what <Client> must do or say differently to win deals against this rival>

### Competitor 2: <Name> (<domain.com>)
**Category:** direct / secondary / indirect
**Their positioning:** <>
**Why buyers choose them:** <>
**Where they fall short:** <>
**Their ideal customer:** <>
**Voice and content style:** <>
**Pricing:** <>
**Threat level:** MEDIUM — <>
**How to beat them:** <>

---

### Competitor 3: <Name> (<domain.com>)
**Category:** direct / secondary / indirect
**Their positioning:** <>
**Why buyers choose them:** <>
**Where they fall short:** <>
**Their ideal customer:** <>
**Voice and content style:** <>
**Pricing:** <>
**Threat level:** MEDIUM — <>
**How to beat them:** <>

## 6. Social Presence Scan
<For each major platform where competitors are meaningfully active: who leads, what their content approach is, and what <Client> should learn or counter. Follower counts only from live measurements with source and date — omit the count if not measured, describe the presence qualitatively instead.>

## 7. Competitive White Space
<The specific positioning territory, audience segment, or use case that NO current competitor owns effectively. This is where the agency builds sustainable leverage. Each entry must name WHY it is open and WHY <Client> is specifically positioned to claim it.>

1. **<White space 1>** — <what the gap is> + <why no competitor owns it> + <why <Client> can claim it> + <what the first move looks like>
2. **<White space 2>** — <same format>
3. **<White space 3>** — <same format>

## 8. Watch List
<Emerging or fast-moving players to track. For each: name the signal that flags them as a rising threat and what <Client> should monitor.>

- **<Company>** — <why they're on the watch list, what signal to watch>
- **<Company>** — <>

## Sources

## Change Log
- <date> — onboarding — initial analysis from market and competitive research.`,

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
