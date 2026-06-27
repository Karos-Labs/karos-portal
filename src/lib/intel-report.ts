import "server-only";

import { generateText } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import type { Client } from "@/lib/types";
import type { ParsedReport } from "@/lib/report-parser";
import {
  getClient,
  getSystemAgent,
  upsertClientReport,
  replaceReportCompetitors,
} from "@/lib/data";
import { parseMarkdownReport, buildClientReport } from "@/lib/report-parser";
import { applyBrandingForClient } from "@/lib/branding";

/* ── Constants ───────────────────────────────────────────────────── */

/** Fixed Firestore document ID for the Intel Report system agent. */
export const INTEL_AGENT_ID = "intel-report-agent";

/* ── Prompt compilation ──────────────────────────────────────────── */

function compilePrompt(template: string, client: Client): string {
  const today = new Date().toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
  return template
    .replace(/\{COMPANY_NAME\}/g, client.name || "the company")
    .replace(/\{WEBSITE_URL\}/g, client.website || "not provided")
    .replace(/\{INDUSTRY\}/g, client.industry || "general")
    .replace(/\{DESCRIPTION\}/g, client.description || "")
    .replace(/\{DATE\}/g, today);
}

/* ── Main pipeline ───────────────────────────────────────────────── */

/**
 * Run the full Intel Report pipeline for a client:
 * 1. Generate the structured ClientReport (monolithic prompt, backward-compatible)
 * 2. Run the new multi-agent onboarding pipeline in parallel to generate context docs
 *    (onboard pipeline failure is non-fatal — report always stored regardless)
 */
export async function runIntelReportPipeline(clientId: string): Promise<void> {
  const client = await getClient(clientId);
  if (!client) throw new Error(`Client not found: ${clientId}`);

  const agent = await getSystemAgent(INTEL_AGENT_ID);
  const template = agent?.systemPrompt ?? DEFAULT_INTEL_PROMPT;
  // Use the legacy prompt only when it looks like the default or a customised version of it.
  // If the agent has been updated to short "additional instructions" text, fall back to default.
  const isShortInstructions = template.length < 500 && !template.includes("## SCORING METHODOLOGY");
  const compiledPrompt = compilePrompt(
    isShortInstructions ? DEFAULT_INTEL_PROMPT : template,
    client,
  );

  // Run all three pipelines concurrently — report text, context docs, and branding bootstrap
  const [{ text }] = await Promise.all([
    generateText({
      model: anthropic("claude-sonnet-4-6"),
      system: compiledPrompt,
      messages: [
        {
          role: "user",
          content: `Generate the complete Karos Intel Report for ${client.name}. Output ONLY the markdown report — no preamble, no explanation. Start immediately with "# Karos Intel: ${client.name}".`,
        },
      ],
      maxOutputTokens: 16000,
    }),
    // Context-doc pipeline (non-fatal)
    import("@/lib/onboard-pipeline")
      .then(({ runOnboardPipeline }) => runOnboardPipeline(clientId))
      .catch((err: unknown) => {
        console.error("[intel] Onboard pipeline failed (non-fatal):", err);
      }),
    // Branding refresh — always regenerate so the brand profile stays in sync with the Intel Report (non-fatal)
    applyBrandingForClient(clientId, client)
      .then((r) => {
        console.info(`[intel] Branding refreshed for ${client.name} (${r.source}): ${r.primaryColor ?? "no color"}`);
      })
      .catch((err: unknown) => {
        console.error("[intel] Branding generation failed (non-fatal):", err);
      }),
  ]);

  const parsed = parseMarkdownReport(text);

  // Atomically replace competitors: delete old + create new in one Firestore batch
  const now = Date.now();
  await replaceReportCompetitors(
    clientId,
    parsed.competitorRows.map((row) => ({
      clientId,
      ...row,
      source: "report" as const,
      createdAt: now,
      updatedAt: now,
    })),
  );

  // Generate the styled HTML report and store it inline in Firestore
  const reportHtml = generateReportHtml(client, parsed);
  const reportData = { ...buildClientReport(clientId, parsed, text), reportHtml };
  await upsertClientReport(reportData);
}

/* ── HTML report generator ───────────────────────────────────────── */

function esc(s: string) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function scoreColor(score: number) {
  if (score >= 85) return "#22C55E";
  if (score >= 70) return "#84CC16";
  if (score >= 55) return "#EAB308";
  if (score >= 40) return "#F59E0B";
  return "#EF4444";
}

function generateReportHtml(client: Client, parsed: ParsedReport): string {
  const companyName = esc(client.name);
  const websiteUrl = esc(client.website ?? "");
  const grade = esc(parsed.overallGrade);
  const score = parsed.overallScore;

  const ownRank = parsed.competitorRankings.find((r) => r.score === score)?.rank ?? "—";
  const totalCompetitors = parsed.competitorRankings.length;

  /* ── Dimension bars ── */
  const dimensionBars = parsed.dimensionScores
    .map(
      (d) => `
    <div class="dim-row">
      <div class="dim-label">${esc(d.dimension)}</div>
      <div class="dim-track"><div class="dim-fill" style="width:${d.score}%;background:${scoreColor(d.score)}"></div></div>
      <div class="dim-score">${d.score}</div>
    </div>`,
    )
    .join("");

  /* ── Wide scan table rows ── */
  const wideScanRows = parsed.competitorRows
    .map(
      (c) => `
    <tr>
      <td>${esc(c.company)}</td>
      <td>${esc(c.marketTier)}</td>
      <td>${esc(c.overlap)}</td>
      <td>${c.deepDive ? '<span class="badge-yes">Deep Dive</span>' : ""}</td>
    </tr>`,
    )
    .join("");

  /* ── SWOT ── */
  const swotQuad = (label: string, items: string[], color: string) => `
    <div class="swot-quad">
      <div class="swot-label" style="color:${color}">${label}</div>
      <ul>${items.map((i) => `<li>${esc(i)}</li>`).join("")}</ul>
    </div>`;

  const swotGrid = `
    ${swotQuad("Strengths", parsed.swot.strengths, "#22C55E")}
    ${swotQuad("Weaknesses", parsed.swot.weaknesses, "#EF4444")}
    ${swotQuad("Opportunities", parsed.swot.opportunities, "#84CC16")}
    ${swotQuad("Threats", parsed.swot.threats, "#F59E0B")}`;

  /* ── Recommendations ── */
  const recsHtml = (() => {
    const byPriority: Record<string, typeof parsed.recommendations> = {};
    for (const r of parsed.recommendations) {
      const key = r.priorityLabel || `Priority ${r.priority}`;
      (byPriority[key] ??= []).push(r);
    }
    return Object.entries(byPriority)
      .map(
        ([label, recs]) => `
      <div class="rec-group">
        <div class="rec-group-label">${esc(label)}</div>
        ${recs
          .map(
            (r) => `
          <div class="rec-item">
            <div class="rec-num">${r.number}.</div>
            <div class="rec-body">
              <div class="rec-title">${esc(r.title)}</div>
              ${r.tag ? `<div class="rec-tag">[Karos: ${esc(r.tag)}]</div>` : ""}
            </div>
          </div>`,
          )
          .join("")}
      </div>`,
      )
      .join("");
  })();

  /* ── Competitor rankings table ── */
  const rankingRows = parsed.competitorRankings
    .sort((a, b) => a.rank - b.rank)
    .map(
      (c) => `
    <tr>
      <td>${c.rank}</td>
      <td>${esc(c.company)}</td>
      <td style="font-weight:700;color:${scoreColor(c.score)}">${c.score}/100</td>
      <td><span style="color:${scoreColor(c.score)};font-weight:700">${esc(c.grade)}</span></td>
    </tr>`,
    )
    .join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Karos Intel: ${companyName}</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Outfit:wght@400;600;700;800&family=JetBrains+Mono:wght@400;500&display=swap">
  <style>
    @page { size: A4; margin: 15mm 18mm; }
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: 'Outfit', sans-serif; background: #fff; color: #0A0A0A; font-size: 13px; line-height: 1.5; }
    .accent { color: #C8FF00; }
    h2 { font-size: 18px; font-weight: 700; margin-bottom: 4px; }
    h3 { font-size: 14px; font-weight: 600; margin-bottom: 8px; color: #333; }
    .section { margin-bottom: 32px; page-break-inside: avoid; }
    .section-rule { height: 2px; background: #C8FF00; margin-bottom: 16px; }

    /* Cover */
    .cover { min-height: 60mm; padding: 32px 0 24px; border-left: 6px solid #C8FF00; padding-left: 20px; margin-bottom: 32px; page-break-after: always; }
    .cover-tag { font-family: 'JetBrains Mono', monospace; font-size: 10px; font-weight: 500; background: #C8FF00; color: #0A0A0A; padding: 3px 10px; border-radius: 2px; letter-spacing: 1px; text-transform: uppercase; display: inline-block; margin-bottom: 16px; }
    .cover-company { font-size: 40px; font-weight: 800; line-height: 1.05; letter-spacing: -1px; margin-bottom: 4px; }
    .cover-domain { font-family: 'JetBrains Mono', monospace; font-size: 13px; color: #666; margin-bottom: 16px; }
    .cover-title { font-size: 16px; font-weight: 600; color: #333; }
    .cover-date { font-family: 'JetBrains Mono', monospace; font-size: 11px; color: #888; margin-top: 8px; }
    .cover-branding { margin-top: 32px; font-size: 14px; font-weight: 700; }
    .cover-branding span { font-family: 'JetBrains Mono', monospace; font-size: 10px; font-weight: 400; color: #888; display: block; }

    /* Score overview */
    .score-box { display: flex; gap: 24px; align-items: flex-start; margin-bottom: 20px; }
    .score-big { font-size: 64px; font-weight: 800; line-height: 1; }
    .score-label { font-family: 'JetBrains Mono', monospace; font-size: 11px; color: #888; }
    .grade-badge { display: inline-block; padding: 3px 10px; border-radius: 4px; font-family: 'JetBrains Mono', monospace; font-size: 14px; font-weight: 700; background: #C8FF00; color: #0A0A0A; margin-top: 6px; }
    .rank-label { font-size: 11px; color: #888; margin-top: 4px; }

    /* Dimension bars */
    .dim-row { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
    .dim-label { width: 160px; font-size: 11px; flex-shrink: 0; }
    .dim-track { flex: 1; height: 14px; background: #F0F0F0; border-radius: 3px; overflow: hidden; }
    .dim-fill { height: 100%; border-radius: 3px; }
    .dim-score { width: 28px; text-align: right; font-family: 'JetBrains Mono', monospace; font-size: 11px; font-weight: 600; }

    /* Tables */
    table { width: 100%; border-collapse: collapse; font-size: 11.5px; margin-bottom: 12px; }
    th { padding: 7px 10px; text-align: left; font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; color: #666; border-bottom: 2px solid #C8FF00; }
    td { padding: 7px 10px; border-bottom: 1px solid #F0F0F0; }
    tr:last-child td { border-bottom: none; }
    .badge-yes { background: #C8FF00; color: #0A0A0A; padding: 2px 8px; border-radius: 10px; font-size: 10px; font-weight: 600; font-family: 'JetBrains Mono', monospace; }

    /* SWOT */
    .swot-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
    .swot-quad { background: #FAFAFA; border-radius: 8px; padding: 14px; page-break-inside: avoid; }
    .swot-label { font-size: 12px; font-weight: 700; margin-bottom: 8px; }
    .swot-quad ul { padding-left: 16px; }
    .swot-quad li { font-size: 11.5px; margin-bottom: 4px; color: #333; }

    /* Recommendations */
    .rec-group { margin-bottom: 16px; page-break-inside: avoid; }
    .rec-group-label { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; color: #888; margin-bottom: 8px; }
    .rec-item { display: flex; gap: 10px; padding: 10px 12px; margin-bottom: 6px; background: #FAFAFA; border-left: 3px solid #C8FF00; border-radius: 0 4px 4px 0; page-break-inside: avoid; }
    .rec-num { font-family: 'JetBrains Mono', monospace; font-size: 11px; font-weight: 700; color: #888; flex-shrink: 0; width: 18px; }
    .rec-title { font-size: 12px; font-weight: 600; margin-bottom: 2px; }
    .rec-tag { font-family: 'JetBrains Mono', monospace; font-size: 9px; color: #999; }

    /* Print button (hidden when printing) */
    .print-btn { position: fixed; top: 16px; right: 16px; padding: 8px 16px; background: #C8FF00; color: #0A0A0A; border: none; border-radius: 6px; font-family: 'Outfit', sans-serif; font-size: 13px; font-weight: 600; cursor: pointer; z-index: 100; }
    @media print { .print-btn { display: none; } }
  </style>
</head>
<body>
  <button class="print-btn" onclick="window.print()">Print / Save PDF</button>

  <!-- Cover -->
  <div class="cover">
    <div class="cover-tag">Karos Intel</div>
    <div class="cover-company">${companyName}</div>
    <div class="cover-domain">${websiteUrl}</div>
    <div class="cover-title">Digital Intelligence &amp; Competitive Report</div>
    <div class="cover-date">${esc(parsed.reportDate)}</div>
    <div class="cover-branding">
      Karos Labs
      <span>karoslabs.com</span>
    </div>
  </div>

  <!-- Overall Score -->
  <div class="section">
    <h2>Overall Assessment</h2>
    <div class="section-rule"></div>
    <div class="score-box">
      <div style="flex-shrink:0">
        <div class="score-big" style="color:${scoreColor(score)}">${score}</div>
        <div class="score-label">out of 100</div>
        <div class="grade-badge">${grade}</div>
        <div class="rank-label">Rank #${ownRank} of ${totalCompetitors}</div>
      </div>
      <div style="flex:1">
        ${dimensionBars}
      </div>
    </div>
  </div>

  <!-- Competitive Ranking -->
  ${
    rankingRows
      ? `<div class="section">
    <h2>Competitive Ranking</h2>
    <div class="section-rule"></div>
    <table>
      <thead><tr><th>Rank</th><th>Company</th><th>Score</th><th>Grade</th></tr></thead>
      <tbody>${rankingRows}</tbody>
    </table>
  </div>`
      : ""
  }

  <!-- Wide Scan -->
  ${
    parsed.competitorRows.length > 0
      ? `<div class="section">
    <h2>Competitor Landscape</h2>
    <div class="section-rule"></div>
    <table>
      <thead><tr><th>Company</th><th>Market Tier</th><th>Overlap</th><th></th></tr></thead>
      <tbody>${wideScanRows}</tbody>
    </table>
  </div>`
      : ""
  }

  <!-- SWOT -->
  <div class="section">
    <h2>SWOT Analysis</h2>
    <div class="section-rule"></div>
    <div class="swot-grid">
      ${swotGrid}
    </div>
  </div>

  <!-- Recommendations -->
  ${
    parsed.recommendations.length > 0
      ? `<div class="section" style="page-break-before:always">
    <h2>Strategic Recommendations</h2>
    <div class="section-rule"></div>
    ${recsHtml}
  </div>`
      : ""
  }

  <!-- Brand Voice -->
  ${
    parsed.brandVoiceRows.length > 0
      ? `<div class="section">
    <h2>Brand Voice</h2>
    <div class="section-rule"></div>
    <table>
      <thead><tr><th>Dimension</th>${Object.keys(parsed.brandVoiceRows[0]?.scores ?? {}).map((c) => `<th>${esc(c)}</th>`).join("")}</tr></thead>
      <tbody>${parsed.brandVoiceRows
        .map(
          (r) =>
            `<tr><td><strong>${esc(r.dimension)}</strong></td>${Object.values(r.scores)
              .map((v) => `<td>${esc(v)}</td>`)
              .join("")}</tr>`,
        )
        .join("")}</tbody>
    </table>
    ${parsed.brandVoiceTerritory ? `<p style="font-size:11.5px;margin-top:8px;font-style:italic;color:#555"><strong>Voice Territory:</strong> ${esc(parsed.brandVoiceTerritory)}</p>` : ""}
  </div>`
      : ""
  }

  <!-- Customer Sentiment -->
  ${
    parsed.customerSentiment.length > 0
      ? `<div class="section">
    <h2>Customer Sentiment</h2>
    <div class="section-rule"></div>
    <table>
      <thead><tr><th>Company</th><th>Rating</th><th>Response Time</th><th>Would Return</th></tr></thead>
      <tbody>${parsed.customerSentiment
        .map(
          (e) =>
            `<tr><td>${esc(e.company)}</td><td>${esc(e.rating ?? "")} ${e.ratingLabel ? `(${esc(e.ratingLabel)})` : ""}</td><td>${esc(e.responseTime ?? "")}</td><td>${esc(e.wouldReturn ?? "")}</td></tr>`,
        )
        .join("")}</tbody>
    </table>
    ${
      parsed.whitespaceOpportunities.length > 0
        ? `<h3 style="margin-top:14px">Whitespace Opportunities</h3>
      <ol style="padding-left:18px;font-size:11.5px">${parsed.whitespaceOpportunities.map((o) => `<li style="margin-bottom:4px">${esc(o)}</li>`).join("")}</ol>`
        : ""
    }
  </div>`
      : ""
  }

  <!-- Footer -->
  <div style="text-align:center;padding-top:24px;border-top:1px solid #E5E5E5;font-size:10px;color:#888;font-family:'JetBrains Mono',monospace">
    Prepared by Karos Labs · karoslabs.com · Confidential
  </div>
</body>
</html>`;
}

/* ── Default prompt template ─────────────────────────────────────── */

export const DEFAULT_INTEL_PROMPT = `You are the Karos Intel AI — a world-class digital marketing intelligence analyst. Your task is to generate a complete Digital Intelligence & Competitive Report for {COMPANY_NAME} ({WEBSITE_URL}), operating in the {INDUSTRY} industry.

Additional context: {DESCRIPTION}

## RESEARCH APPROACH

Before writing a single word, cross-reference every knowledge source available in your training data:
- **Company website**: homepage, About/Team/Careers, Pricing, Blog, Portfolio, Case Studies
- **LinkedIn**: company page, employee headcount, founding year, industry classification, recent posts
- **Crunchbase / PitchBook / AngelList**: funding rounds, founding year, HQ location, headcount range
- **Social profiles**: Instagram, TikTok, X/Twitter, YouTube, Facebook, Pinterest — follower counts, posting frequency, engagement signals, pinned content
- **Review platforms**: G2, Capterra, Trustpilot, Trustradius, Glassdoor, Reclame Aqui (Brazilian market only)
- **News & press**: TechCrunch, Product Hunt launches, PR Newswire, industry publications, founder interviews
- **App stores**: Google Play / Apple App Store listing if any mobile product exists

For companies with modern, ambiguous, or short names (digital agencies, studios, neo-brands, fintechs like "XO Digital"): explicitly search by (a) the provided domain, (b) the company name combined with its industry keyword, and (c) the LinkedIn company URL pattern, to identify the correct entity before scoring. Never guess or conflate with a similarly-named unrelated brand.

## SCORING METHODOLOGY

Evaluate {COMPANY_NAME} and identify 8-15 real competitors in this market. Score each company on 8 dimensions (0-100):

1. **Content & Messaging** (15%): headlines, value prop, copy quality, voice, social proof, content depth
2. **Conversion Optimization** (15%): CTAs, UX flow, forms, trust signals, pricing clarity, checkout experience
3. **SEO & Discoverability** (12%): title tags, meta descriptions, headers, schema markup, indexability
4. **GEO & AI Discoverability** (8%): structured data, AI platform mentions, llms.txt, citability
5. **Competitive Positioning** (15%): positioning clarity, differentiation, category definition, pricing vs. comps, reviews
6. **Brand & Trust** (10%): visual consistency, trust signals, testimonials, press, voice coherence
7. **Growth & Strategy** (10%): business model, pricing, growth loops, retention, market timing
8. **Social Media & Community** (15%): multi-platform presence, engagement, UGC, community, influencer use

Overall Score = (C&M×0.15) + (Conv×0.15) + (SEO×0.12) + (GEO×0.08) + (Pos×0.15) + (Brand×0.10) + (Growth×0.10) + (Social×0.15)

Grades: A (85+), B (70-84), C (55-69), D (40-54), F (0-39)

## INSTRUCTIONS

- Be evidence-based and specific. Every score, bullet, and claim must reference something observable.
- Score conservatively when uncertain — mid-range scores are safer than extreme scores without evidence.
- Generate realistic competitor data — name real, verifiable companies in this space.
- The client's overall score reflects rank 4 or lower when 3 competitors score higher.
- Make recommendations specific, actionable, and tied to real gaps in the score data.
- For the Wide Scan, include at least 8 competitors spanning Leader / Challenger / Niche tiers.
- Write each dimension analysis as crisp bullet points, not dense paragraphs.

## DATA QUALITY RULES — STRICTLY ENFORCED

1. **Zero placeholder rule** — Never write "Data Unavailable", "N/A", "Unknown", "Not provided", "Not applicable", "—", "-", or any similar placeholder for any field, row, cell, or bullet. If a specific value cannot be substantiated with real knowledge, omit that line, bullet, or table row entirely. A missing data point is always preferable to a fake or filler one.
2. **Section omission** — If an entire section has no real data, omit that section's heading and all its content from the output entirely. Do not include the heading with empty or placeholder content beneath it.
3. **Metadata omission** — Only include header fields (Business Type, Founded, Tech Stack, etc.) when you have a specific, confident value. Omit any metadata line you cannot fill accurately.
4. **Reclame Aqui is Brazil-only** — Only include the Reclame Aqui sub-section if {COMPANY_NAME} serves the Brazilian market. For other markets, substitute with real data from G2, Capterra, or Trustpilot if available. Omit the entire Customer Sentiment section if no review data exists.
5. **No generic statements** — Every bullet must cite specific, observable evidence: a named page, a specific feature, a pricing tier, a particular post, or a named competitor action. Vague or filler statements are not acceptable.

## REQUIRED OUTPUT FORMAT

Generate ONLY the following markdown structure. Heading names must match EXACTLY — they drive automated parsing.

---

# Karos Intel: {COMPANY_NAME}
**Digital Intelligence & Competitive Report**

**Date:** {DATE}
**URL:** {WEBSITE_URL}
**Business Type:** [SaaS | E-commerce | Agency | Local | Marketplace — omit this line if uncertain]
**Founded:** [year — omit this line if uncertain]
**Industry:** {INDUSTRY}

---

## Overall Score

| Company | Score | Grade | Rank |
|---------|-------|-------|------|
| [Top competitor] | [score]/100 | [grade] | 1 |
| [2nd competitor] | [score]/100 | [grade] | 2 |
| [3rd competitor] | [score]/100 | [grade] | 3 |
| {COMPANY_NAME} | [score]/100 | [grade] | 4 |

---

## Dimension Scores

| Dimension | Weight | {COMPANY_NAME} | [Comp1] | [Comp2] | [Comp3] |
|-----------|--------|----------------|---------|---------|---------|
| Content & Messaging | 15% | [score] | [score] | [score] | [score] |
| Conversion Optimization | 15% | [score] | [score] | [score] | [score] |
| SEO & Discoverability | 12% | [score] | [score] | [score] | [score] |
| GEO & AI Discoverability | 8% | [score] | [score] | [score] | [score] |
| Competitive Positioning | 15% | [score] | [score] | [score] | [score] |
| Brand & Trust | 10% | [score] | [score] | [score] | [score] |
| Growth & Strategy | 10% | [score] | [score] | [score] | [score] |
| Social Media & Community | 15% | [score] | [score] | [score] | [score] |

---

## Wide Scan

| Company | Market Tier | Price Range | Overlap | Deep Dive |
|---------|-------------|-------------|---------|-----------|
[8-15 rows. Market Tier: Leader | Challenger | Niche. Overlap: High | Medium | Low-Med | Low. Deep Dive: Yes for top 3, No for rest. Omit Price Range cell if unknown — leave it blank, not "N/A".]

---

## Competitive Ranking

| Rank | Company | Score | Grade | Best Dimension | Weakest Dimension |
|------|---------|-------|-------|----------------|-------------------|
[Top 4: 3 competitors + {COMPANY_NAME}, sorted by rank]

---

## Content & Messaging

[4-6 crisp bullet points. Cover: headline clarity, value prop strength, copy quality, social proof use, voice consistency. Compare against named competitors. Omit this section entirely if no confident data.]

---

## Conversion Optimization

[4-6 crisp bullet points. Cover: CTA placement & wording, UX flow, trust signals, pricing transparency, signup/checkout friction. Omit this section entirely if no confident data.]

---

## SEO & Discoverability

[4-6 crisp bullet points. Cover: title tags & meta, primary keyword targeting, content depth, backlink signals, technical indexability issues. Omit this section entirely if no confident data.]

---

## GEO & AI Discoverability

[4-6 crisp bullet points. Cover: structured data markup, mentions in ChatGPT/Perplexity/Gemini responses, llms.txt presence, citability signals. Omit this section entirely if no confident data.]

---

## Competitive Positioning

[4-6 crisp bullet points. Cover: positioning clarity, differentiation angle, pricing vs. competitors, category ownership, messaging contrast with named rivals. Omit this section entirely if no confident data.]

---

## Brand & Trust

[4-6 crisp bullet points. Cover: visual consistency across channels, social proof quality, testimonials & press mentions, brand voice coherence. Omit this section entirely if no confident data.]

---

## Growth & Strategy

[4-6 crisp bullet points. Cover: business model, pricing architecture, growth loops, retention signals, strategic direction & timing. Omit this section entirely if no confident data.]

---

## SWOT

### Strengths
- [Specific strength backed by observable evidence — min 4 bullets, no placeholders]

### Weaknesses
- [Specific weakness backed by observable evidence — min 4 bullets, no placeholders]

### Opportunities
- [Specific market opportunity — min 3 bullets, no placeholders]

### Threats
- [Specific threat, naming competitor where relevant — min 3 bullets, no placeholders]

---

## Customer Sentiment

[Only include this section if real review data exists. For Brazilian companies use Reclame Aqui. For other markets use G2, Capterra, or Trustpilot. Omit the entire section if no reliable review data is available — do not write placeholder rows.]

### Reclame Aqui [substitute heading if using a different platform]

| Company | Rating | Response Time | Would Return |
|---------|--------|---------------|--------------|
[Only include rows where real data exists. Do not write placeholder values.]

### Whitespace Opportunities

1. [Specific unmet customer need or market gap — only if substantiated]
2. [Another opportunity]
3. [Another opportunity]

---

## Brand Voice

| Dimension | {COMPANY_NAME} | [Comp1] | [Comp2] | [Comp3] |
|-----------|----------------|---------|---------|---------|
| Tone | [descriptor] | [descriptor] | [descriptor] | [descriptor] |
| Messaging Style | [descriptor] | [descriptor] | [descriptor] | [descriptor] |
| Visual Language | [descriptor] | [descriptor] | [descriptor] | [descriptor] |
| Archetype | [archetype] | [archetype] | [archetype] | [archetype] |

**Voice Territory Opportunity:** [1-2 sentences on the positioning opportunity {COMPANY_NAME} can own in its voice territory]

---

## Competitor Profiles

### [Competitor1 Name] ([competitor1domain.com])
**Founded:** [year — omit line if uncertain]
**Scale:** [description of size, revenue, or users — omit line if uncertain]
**Key Strengths:** [comma-separated list of specific, observable strengths]
**Key Weaknesses:** [comma-separated list of specific, observable weaknesses]
**Threat Level:** HIGH

### [Competitor2 Name] ([competitor2domain.com])
**Founded:** [year — omit line if uncertain]
**Scale:** [description — omit line if uncertain]
**Key Strengths:** [comma-separated list]
**Key Weaknesses:** [comma-separated list]
**Threat Level:** MEDIUM

### [Competitor3 Name] ([competitor3domain.com])
**Founded:** [year — omit line if uncertain]
**Scale:** [description — omit line if uncertain]
**Key Strengths:** [comma-separated list]
**Key Weaknesses:** [comma-separated list]
**Threat Level:** MEDIUM

---

## Strategic Recommendations

### Priority 1: Quick Wins

1. [Specific recommendation — what exactly to do and why, tied to a real gap] [Karos: SEO]
2. [Another quick win with specific action] [Karos: Content]

### Priority 2: Growth Strategy

3. [Strategic growth recommendation with specific rationale] [Karos: Brand]
4. [Another growth rec] [Karos: Email]

### Priority 3: Long-Term Positioning

5. [Strategic positioning play with specific rationale] [Karos: GEO]
6. [Another long-term rec] [Karos: Analytics]

---
`;
