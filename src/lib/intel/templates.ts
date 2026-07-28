import "server-only";

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

## Voice in one line
<e.g. "A smart, trustworthy friend who understands finance but never talks down to you.">

## Five voice adjectives
- **<Adjective>** — <what it means in practice, one line>
- **<Adjective>** — <>
- **<Adjective>** — <>
- **<Adjective>** — <>
- **<Adjective>** — <>

## Voice dimensions
- Formal ↔ casual: <position + when it moves>
- Serious ↔ playful: <>
- Plain ↔ technical: <>
- Reserved ↔ bold: <>
- Warm ↔ neutral: <>

## Persona
<Who is "speaking" when the brand posts. The character, relationship to reader, what they would and would not say.>

## Writing dos and don'ts
### DO
- <rule with concrete example>
### DON'T
- <rule with better alternative>
- <buzzwords/jargon to avoid>

## Compliance in copy (HARD GATES)
- Never state or imply: <banned claim>
- Always frame <sensitive topic> as: <required framing>

## Grammar & mechanics
- Person / address: <>
- Tense & active voice: <>
- Sentence length & rhythm: <>
- Punctuation: no em dashes (Karos house rule). <>
- Emoji policy: <>
- Numbers: <>

## Vocabulary
### Words & phrases we use
### Words & phrases we avoid
### Names & spellings (exact)

## Blog / long-form guidelines
- **Target length:** <range>
- **Structure:** <>
- **Headline formula:** <>
- **CTA placement:** <>

## Social voice by platform
| Platform | Tone | Format | Focus | Platform-specific rule |
|----------|------|--------|-------|------------------------|
| Instagram | <> | <> | <> | <> |
| TikTok | <> | <> | <> | <> |
| LinkedIn | <> | <> | <> | <> |
| X / Twitter | <> | <> | <> | <> |

## CTA taxonomy
<Which CTA per post intent: visibility / sell / both.>

## Sample phrases & taglines
<8-12 examples a writer can pattern-match against.>

## Quick reminder for writers
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

## Positioning statement
> For **<audience>**, **<brand>** is the **<category>** that **<differentiator>**, because **<reason to believe>**.

## Value propositions
1. **<prop>** — <one-line support / proof>
2. **<prop>** — <>
3. **<prop>** — <>

## Messaging pillars
<3-5 recurring themes everything ladders up to.>

## Proof points / reasons to believe
<Evidence behind every claim: data, credentials, track record, named partners.>

## Message hierarchy
<What we lead with, and the order.>

## Audience & ICP
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

## Goals & KPIs
> Define the recommended KPI framework for this business. Fill in KPI name, area, and cadence from your knowledge of this business type. For Baseline: use only a figure from a named, verifiable source — otherwise write "to capture with client". For Target: if the client has not stated a goal, write "to define with client". NEVER write "data unavailable" in any cell. Omit a row only if the metric is genuinely irrelevant for this business model.

| Area | KPI | Baseline | Target | Cadence |
|------|-----|----------|--------|---------|

## Where to play
<Segments, channels, and niches to prioritize.>

## How to win
<The strategic play: the wedge, what compounds, the unfair advantage.>

## Competitive white space
<The unowned territory no rival holds.>

## Channel priorities & cadence
<Per channel: role, priority, cadence, format mix.>

## Roadmap
<Phased and qualitative: foundation → execution → optimization.>

## Risks & watch-outs
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

## Market Landscape

### Market dynamics
<What is the nature of this competitive environment? Is the market crowded with undifferentiated players, dominated by 1-2 giants with a long tail, a fragmented niche, or an emerging category? What are the 2-3 macro forces shaping competition right now (pricing pressure, commoditization, audience shifts, new technology enabling new entrants)?>

### How buyers make decisions in this market
<What do buyers compare when evaluating options in this category? What are the top 2-3 decision drivers (price, reputation, specialization, speed, relationships)? What does a typical buying journey look like — who initiates, who approves, how long does it take?>

### Market maturity and trajectory
<Is this market growing, consolidating, or mature? What recent competitive moves, category pivots, or new entrants are reshaping the landscape? What is happening RIGHT NOW that a strategist must account for?>

## Competitive Position Overview

| Competitor | Category | Positioning (their words) | Price (stated, with source) | Key Differentiator | Primary Weakness | Threat to <Client> |
|------------|----------|---------------------------|-----------------------------|--------------------|-----------------|---------------------|
<Fill all rows with real data. For price: only if published on their website with URL. Threat: HIGH / MEDIUM / LOW with one-word reason.>

## Where <Client> Wins
<The specific competitive advantages <Client> holds over the field. Name the competitor being beaten for each advantage. "Quality" and "service" are not advantages — name the observable, defensible edges that buyers actually care about.>

- **<Advantage 1>** — <exactly what the advantage is> vs. <named competitor(s)> who <what they lack>. Strategic implication: <why this matters to buyers and how the agency should amplify it>.
- **<Advantage 2>** — <evidence + competitive contrast + strategic implication>
- **<Advantage 3>** — <evidence + competitive contrast + strategic implication>
- **<Advantage 4 if applicable>** — <>

## Where <Client> Lags
<Honest, specific gaps relative to competitors. This intelligence is what the agency needs to build a realistic strategy. Do not soften or omit these — they are as valuable as the wins.>

- **<Gap 1>** — <competitor who outperforms here> does <specifically what better>. This matters because <buyer reason>. The gap manifests in <observable evidence>. Mitigation: <what <Client> could do to neutralize this gap>.
- **<Gap 2>** — <same format>
- **<Gap 3>** — <same format>
- **<Gap 4 if applicable>** — <>

## Deep Dives — Top Direct Competitors

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

## Social Presence Scan
<For each major platform where competitors are meaningfully active: who leads, what their content approach is, and what <Client> should learn or counter. Follower counts only from live measurements with source and date — omit the count if not measured, describe the presence qualitatively instead.>

## Competitive White Space
<The specific positioning territory, audience segment, or use case that NO current competitor owns effectively. This is where the agency builds sustainable leverage. Each entry must name WHY it is open and WHY <Client> is specifically positioned to claim it.>

1. **<White space 1>** — <what the gap is> + <why no competitor owns it> + <why <Client> can claim it> + <what the first move looks like>
2. **<White space 2>** — <same format>
3. **<White space 3>** — <same format>

## Watch List
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

## Overview
- **Product / company name:**
- **Website:**
- **One-liner:** <who it's for + what it does + the unique mechanism>
- **Founded / HQ / market:**
- **Category:**
- **Product type:** <SaaS | DTC e-commerce | marketplace | services | hybrid | other>
- **Stage:** <pre-launch | early | growth | established>

## What it does
<2-4 paragraphs in plain language.>

## Target customers
<Who buys / uses this, in plain terms.>

## Business model
- **How they make money:**
- **Pricing (only figures the client publishes):** <tiers, minimums — with source URL. Write "not published" if not stated.>
- **Unit / entry point:**

## Key features / offerings
1. **<feature>** — <what it is + why it matters>
2. **<feature>** — <>
3. **<feature>** — <>

## Primary CTAs
<Main actions the brand asks for, verbatim.>

## Regulatory, compliance & claims (HARD GATES)
- **Regulatory status:**
- **Required disclosures / disclaimers:**
- **Banned claims (NEVER say or imply):**
- **Required framing:**
- **Substantiation required:**

## Proof points & credibility
<Audits, certifications, track record, named partners. Every figure must have a source.>

## Channels & how customers interact

## Tech signals / stack
<Observable stack and infrastructure.>

## FAQ (foundational)
| Question | Answer |
|----------|--------|

## Do-not-misstate
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

## Logo
- **Primary lockup:** <description>
- **Variants:** <inverse, icon/symbol, monochrome>
- **Clear space & minimum size:**
- **Do nots:** <stretch, recolor, add effects>

## Color
| Role | Name | Hex | Where used |
|------|------|-----|-----------|
| Primary | <> | <#> | <> |
| Secondary | <> | <#> | <> |
| Accent | <> | <#> | <> |
| Background | <> | <#> | <> |
| Text | <> | <#> | <> |

## Typography
- **Display / headline:** <family, weights>
- **Body:** <family, weights>
- **Rule:** keep to ≤2 type families.

## Imagery & photography
<Style, mood, color treatment, do/don't.>

## Iconography & graphic elements
<Icon style, shapes, recurring motifs.>

## Layout & composition
<Grid, spacing, margins, post/slide rules.>

## Motion (if applicable)
<Transitions, pacing, caption animation.>

## Asset inventory
| Asset | Variant | Location |
|-------|---------|----------|
| Logos | <primary/inverse/icon> | <path> |
| Fonts | <families> | <path> |

## Source / status
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

## Hard do-nots (never do these)
- <things the client explicitly said they never want> — <source + date>

## Always do these
- <standing requests the client makes every time> — <source + date>

## Observed patterns
- <patterns inferred from repeated feedback> — <evidence>

## Approval & workflow preferences
- <how they like to work: who approves, how fast, what channels>

## Sensitivities & escalation
- <topics to handle carefully; when to escalate>

## Quick facts agents keep getting wrong
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

  "target-audience": `---
module: target-audience
client: <slug>
version: 1
status: original
system_of_record: source
client_visible: true
last_updated: <YYYY-MM-DD>
sources: []
consumed_by: [e10, e11, e12, e13, e14, karos-chat]
---

# Target Audience — <Client>

> DEFINITIVE ICP BLUEPRINT. Every content agent and copywriter reads this document before producing a single word. Nothing here is generic. Every bullet is traceable to client onboarding data, a named review platform, a competitor's hero copy, or a clearly-labeled industry pattern. If a bullet cannot meet that standard, it is omitted silently — never replaced with a placeholder.

## ICP Persona Profile

> Define the primary ideal customer profile. If two genuinely distinct buyer personas exist, add a "Secondary ICP" sub-section and repeat all sub-bullets. Otherwise one block is sufficient. Every field must name a specific role, context, or metric — not a category.

**Primary ICP: <Role Title> at <Company / Customer Type>**

### Demographics & Firmographics
> B2B: company size band, revenue range, industry vertical, geographic concentration. B2C: age range, income tier, lifestyle markers tied to the client's actual product positioning. Ground in client onboarding data or observed testimonial patterns. No generic demography.
- <specific detail>

### Job Title & Organizational Role
> Exact job title(s) — not "decision-makers". Where in the buying committee: buyer, champion, influencer, or end-user? Do they control budget or require sign-off?
- <specific detail>

### Core Operational Pain Points
> 4-6 specific, functional problems this persona faces. Each maps to something the client directly addresses in their product or service positioning, testimonials, or stated value proposition. Granular is required — not "they need better efficiency" but "they lose X hours per week on [specific task] because [incumbent tool] lacks [specific capability]."
- <pain point — grounded in client positioning or observed testimonial language>
- <pain point>
- <pain point>
- <pain point>

### Success Metrics They're Judged On
> The KPIs or business outcomes this persona's performance is measured against. These are the metrics that make a headline land — or fall flat. Derived from the client's value proposition, customer testimonial language, or industry standard for this role.
- <KPI or outcome>
- <KPI or outcome>

## Tech Stack & Current Solutions

> What this persona uses TODAY to solve the problems the client addresses. Named products, not category labels. Each entry must be traceable: "client-stated:", "website-observed:", or "industry pattern:". This section is the enemy narrative — name it precisely.

### Incumbent Tools & Methods
> Specific products, platforms, or methodologies — not categories. Derived from the client's competitive context, integrations they advertise, or their positioning against named alternatives.
| Tool / Method | Category | Why They Use It | Source |
|---------------|----------|-----------------|--------|
| <Tool Name> | <category> | <specific reason> | <client-stated / website-observed / industry pattern> |
| <Tool Name> | <> | <> | <> |

### Where Those Solutions Fall Short
> The specific failure modes, friction points, or capability gaps in the incumbents that this client's product or service directly addresses. Each gap maps to a concrete claim or differentiator in the client's own messaging.
- **<Incumbent tool>:** <specific failure mode that client addresses>
- **<Incumbent tool>:** <>

### Switching Triggers
> Observable events or thresholds that cause this persona to begin evaluating alternatives. Label as "industry pattern:" when not client-stated.
- <specific trigger — e.g. "end of annual contract cycle", "headcount doubles past 50", "compliance deadline">
- <trigger>

## Content Engagement Patterns

> Where this persona spends attention professionally. Specific enough that a content agent can immediately act: named platforms, named communities, named formats. No generic lists.

### Primary Channels
> Named platforms where this persona actively consumes professional content. For B2B: specific LinkedIn content types, named subreddits, named Slack communities, named newsletters or podcasts. For B2C: named Instagram account styles, TikTok content categories, named YouTube channels. Niche-specific only.
- **<Platform>:** <how they use it, what content types they consume there>
- **<Platform / Community>:** <>

### Content Formats That Hook Them
> The specific formats that generate real engagement from this persona. Name the format AND what makes it work: e.g. "benchmark reports with named peer comparisons — because this persona is judged against competitors and needs external benchmarks to make the internal business case."
- **<Format>:** <why it works for this persona specifically>
- **<Format>:** <>

### Attention-Grabbing Hooks
> Specific headline formulas, subject line patterns, or opening hooks that reliably capture this persona's attention. Name the emotional or functional trigger each exploits. These must feel niche-written, not generic copywriting templates.
- "<Hook formula>" — triggers: <curiosity / identity threat / peer validation / data specificity>
- "<Hook formula>" — triggers: <>

### Trust Builders
> What makes this persona believe a claim before they act. Specific certification bodies, named review platforms, case study format preferences, social proof quantity thresholds.
- <specific trust signal — e.g. "G2 reviews from named peer companies in their exact industry vertical">
- <trust signal>

## Linguistic Profile & Vocabulary

> The most direct input content agents use for calibrating copy register. Copy that uses this persona's vocabulary reads as peer-written. Copy that ignores it reads as vendor-speak and is rejected before the second sentence.

### Professional Vocabulary They Use
> Industry jargon, acronyms, and technical terms this persona uses internally and with peers. Minimum 8 distinct terms. Include full term + abbreviation where both exist.
| Term | Full Form (if abbreviated) | When / how they use it |
|------|---------------------------|------------------------|
| <term> | <full form or —> | <context> |
| <term> | <> | <> |
| <term> | <> | <> |
| <term> | <> | <> |
| <term> | <> | <> |
| <term> | <> | <> |
| <term> | <> | <> |
| <term> | <> | <> |

### How They Describe Their Problem — Verbatim Triggers
> Near-verbatim phrases this persona uses when searching for solutions, posting in forums, or venting to peers. NOT the client's marketing language — the raw, unfiltered voice of the audience. Minimum 6 distinct phrases. Each should be directly usable as a hook or subject line. Source each one.
- "<phrase>" — source: <review platform / community post / competitor testimonial / onboarding data / industry pattern>
- "<phrase>" — source: <>
- "<phrase>" — source: <>
- "<phrase>" — source: <>
- "<phrase>" — source: <>
- "<phrase>" — source: <>

### How They Describe Their Ideal Outcome
> The specific language of success — what this persona says they want, in their words. Drawn from testimonials, case study quotes, community win posts, or job description outcome language. Minimum 4 phrases.
- "<outcome phrase>"
- "<outcome phrase>"
- "<outcome phrase>"
- "<outcome phrase>"

### Words & Phrases to Avoid in Copy
> Terminology that triggers skepticism, signals vendor-speak, or marks copy as generic in this niche. These are the buzzwords their current vendors already abuse, claims so common they've lost signal value, or abstractions that feel hollow to this audience.
| Phrase to Avoid | Why It's a Trust-Killer for This Persona |
|-----------------|------------------------------------------|
| "<phrase>" | <specific reason — e.g. "overused by every competitor in this space since 2019"> |
| "<phrase>" | <> |
| "<phrase>" | <> |
| "<phrase>" | <> |
| "<phrase>" | <> |

## Change Log
- <date> — onboarding — initial target audience profile from intel run.`,
};
