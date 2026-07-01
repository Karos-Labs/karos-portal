import "server-only";

import { generateText } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { MODELS, DOC_MAX_TOKENS } from "@/lib/constants";
import type { Client } from "@/lib/types";
import type { ParsedReport } from "@/lib/report-parser";
import {
  getClient,
  getSystemAgent,
  upsertClientReport,
  replaceReportCompetitors,
} from "@/lib/data";
import { parseMarkdownReport, buildClientReport } from "@/lib/report-parser";
import { applyBrandingForClient, effectiveDominantColors } from "@/lib/branding";
import type { BrandingGuidelines } from "@/lib/types";

/* ── Constants ───────────────────────────────────────────────────── */

/** Fixed Firestore document ID for the Intel Report system agent. */
export const INTEL_AGENT_ID = "intel-report-agent";

/* ── Prompt compilation ──────────────────────────────────────────── */

/**
 * Builds a branding context block from established guidelines to inject into
 * the Intel prompt. This ensures the generated report's visual language,
 * brand personality descriptors, and design recommendations are always
 * consistent with the client's actual extracted brand identity.
 *
 * Returns empty string when no meaningful branding data is present (e.g. first run).
 */
function compileBrandingContext(g: BrandingGuidelines | undefined): string {
  if (!g) return "";
  const colors = effectiveDominantColors(g);
  if (!colors.length && !g.visualStyle && !g.toneKeywords?.length) return "";

  const lines = [
    "## Established Brand Visual Parameters",
    "(Extracted from the client's live assets — treat as absolute ground truth)",
    "",
  ];

  if (colors.length) {
    lines.push("**Dominant Color Palette** (1 = most prominent):");
    colors.forEach((c) => {
      const role = c.role ? ` — ${c.role}` : "";
      lines.push(`  ${c.dominanceRank}. \`${c.hex}\`${role}`);
    });
    lines.push("");
  }
  if (g.visualStyle) lines.push(`**Visual Style Archetype:** ${g.visualStyle}`, "");
  if (g.fontHeading || g.fontBody) {
    if (g.fontHeading) lines.push(`**Heading Font:** ${g.fontHeading}`);
    if (g.fontBody) lines.push(`**Body Font:** ${g.fontBody}`);
    lines.push("");
  }
  if (g.toneKeywords?.length) lines.push(`**Tone Keywords:** ${g.toneKeywords.join(", ")}`, "");
  if (g.guidelines?.trim()) {
    lines.push("", "**Brand Guidelines (Voice, Do's & Don'ts — client-authored):**", g.guidelines.trim(), "");
  }

  lines.push(
    "**Sync mandate:** Brand & Trust, Brand Voice, and every Strategic Recommendation must explicitly " +
      "reference these color codes and the visual style archetype. " +
      `A brand positioned as "${g.visualStyle ?? "established"}" must have its entire visual vocabulary, ` +
      "tone descriptors, and design recommendations reflect this identity without exception. " +
      "Never contradict or ignore the established palette.",
  );

  return lines.join("\n");
}

function compilePrompt(template: string, client: Client, brandingContext?: string): string {
  const today = new Date().toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  const brandVoiceBlock = client.brandVoice?.trim()
    ? `\n\n## Client Brand Voice\n(Provided directly by the client — use as authoritative voice reference)\n\n${client.brandVoice.trim()}\n`
    : "";

  return template
    .replace(/\{COMPANY_NAME\}/g, client.name || "the company")
    .replace(/\{WEBSITE_URL\}/g, client.website || "not provided")
    .replace(/\{INDUSTRY\}/g, client.industry || "general")
    .replace(/\{DESCRIPTION\}/g, client.description || "")
    .replace(/\{DATE\}/g, today)
    .replace(/\{BRANDING_CONTEXT\}/g, brandingContext ? "\n\n" + brandingContext + "\n" : "")
    .replace(/\{BRAND_VOICE\}/g, brandVoiceBlock);
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

  // The DB agent prompt is treated as ADDITIONAL INSTRUCTIONS appended to the
  // code base prompt — never a replacement. This means:
  //   - Code changes to DEFAULT_INTEL_PROMPT always take effect immediately
  //   - Admins can add client-specific or market-specific instructions via the UI
  //     without needing to maintain the full base prompt themselves
  // Legacy detection: if the DB contains a full legacy prompt (starts with the old
  // opener and has the old scoring section), ignore it so the new base takes over.
  const isLegacyFullPrompt =
    agent?.systemPrompt?.startsWith("You are the Karos Intel AI") &&
    agent.systemPrompt.includes("## SCORING METHODOLOGY");
  const additionalInstructions =
    agent?.systemPrompt && !isLegacyFullPrompt ? agent.systemPrompt.trim() : "";

  const brandingContext = compileBrandingContext(client.brandingGuidelines);

  const basePrompt = compilePrompt(DEFAULT_INTEL_PROMPT, client, brandingContext);
  const compiledPrompt = additionalInstructions
    ? `${basePrompt}\n\n## ADDITIONAL INSTRUCTIONS (from agent config — apply on top of everything above)\n\n${additionalInstructions}`
    : basePrompt;

  const userMessage = `Generate the complete Karos Intel Report for ${client.name}. Output ONLY the markdown report — no preamble, no explanation. Start immediately with "# Karos Intel: ${client.name}".`;

  // Run all three pipelines concurrently — report text, context docs, and branding bootstrap
  const [{ text: firstPassText }] = await Promise.all([
    generateText({
      model: anthropic(MODELS.SONNET),
      system: compiledPrompt,
      messages: [{ role: "user", content: userMessage }],
      maxOutputTokens: DOC_MAX_TOKENS,
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
        console.info(`[intel] Branding refreshed for ${client.name} (${r.source}): ${r.primaryAccent ?? "no color"}`);
      })
      .catch((err: unknown) => {
        console.error("[intel] Branding generation failed (non-fatal):", err);
      }),
  ]);

  // Detect truncation: the last real ## section in the prompt must appear in the output.
  // Excludes Change Log / Sources that the model is instructed to omit.
  const SKIP_SECTIONS = /^## (Change\s*Log|Sources)\s*$/i;
  const allPromptSections = (DEFAULT_INTEL_PROMPT.match(/^## .+/gm) ?? []).filter(
    (h) => !SKIP_SECTIONS.test(h),
  );
  const lastRequiredSection = allPromptSections.at(-1)?.replace(/^## /, "").trim();

  let text = firstPassText;
  if (lastRequiredSection && !text.includes(lastRequiredSection)) {
    console.info(
      `[intel] Continuation pass triggered for ${client.name} (first pass: ${firstPassText.length} chars, missing: "${lastRequiredSection}")`,
    );
    const { text: continuation } = await generateText({
      model: anthropic(MODELS.SONNET),
      system: compiledPrompt,
      messages: [
        { role: "user", content: userMessage },
        { role: "assistant", content: text },
        {
          role: "user",
          content:
            "You stopped before completing all required sections. Continue the report from exactly where you left off. Do not repeat any content already written. Continue immediately:",
        },
      ],
      maxOutputTokens: DOC_MAX_TOKENS,
    });
    text = text + continuation;
  }

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

export const DEFAULT_INTEL_PROMPT = `You are the Karos Intel AI — the elite intelligence engine of a world-class marketing agency, running on Claude Sonnet at maximum analytical depth. Apply your full reasoning, pattern recognition, and cross-referencing capabilities. Your output is a boardroom-grade competitive report consumed directly by agency leadership and senior strategists. Every word carries professional weight.

## CLIENT BRIEF

**Company:** {COMPANY_NAME}
**Website:** {WEBSITE_URL}
**Industry:** {INDUSTRY}
**Context:** {DESCRIPTION}
{BRAND_VOICE}
{BRANDING_CONTEXT}

---

## ◈ PRIMARY DIRECTIVES — BIND THESE TO EVERY WORD

### DIRECTIVE 1 — ZERO PLACEHOLDER RULE (ABSOLUTE, NO EXCEPTIONS)

The following expressions are **permanently banned** from this document:

> "Data unavailable" · "Information not found" · "N/A" · "Not applicable" · "Unknown" · "Not provided" · "As an AI..." · "I cannot access..." · "I don't have real-time data..." · any dash or blank cell used as a missing-data signal

These phrases signal incompetence to sophisticated clients and destroy the agency's credibility. You have access to deep training knowledge spanning millions of companies, industries, websites, and marketing patterns. Use exhaustive contextual reasoning: infer from website copy and structure, domain naming conventions, industry dynamics, brand signals, UX patterns, pricing page architecture, and competitive behavior.

**Graceful Omission Protocol:** When a specific sub-detail is genuinely impossible to substantiate with any degree of confidence (e.g., private revenue figures, locked internal metrics, restricted user counts) — omit that bullet or field entirely and silently. Do not acknowledge it is missing. Do not write a placeholder. The document must read as 100% complete and intentional. A section with four strong, evidence-backed bullets is dramatically more valuable than six bullets where two are filler.

### DIRECTIVE 2 — BRAND SYNCHRONIZATION PROTOCOL (Cross-Document Ground Truth)

The {BRANDING_CONTEXT} block above contains the client's extracted visual identity — palette, archetype, typography, and tone. The {BRAND_VOICE} block contains the client's own brand voice statement. These are the **absolute source of truth** for every brand-related judgment in this report.

Synchronization is mandatory — not optional:

- **Brand & Trust section:** Reference at least one specific color code or visual archetype from the established brand parameters. Never assess brand coherence in a vacuum.
- **Brand Voice table:** If {BRAND_VOICE} is present, the {COMPANY_NAME} column must directly reflect the client's stated voice — not a generic AI inference. Quote it, adapt it, anchor on it.
- **Competitor voice comparison:** Frame each competitor's voice as a specific contrast against the client's established identity. The table is a positioning map, not a generic descriptor list.
- **Strategic Recommendations:** Every visual or voice recommendation must either reinforce, consciously evolve, or explicitly acknowledge the existing brand parameters. Never recommend a brand direction that contradicts the established palette without explicitly calling it a brand evolution and justifying it with market evidence.

**Dynamic Brand Feedback Loop — CRITICAL REQUIREMENT:** After completing the competitive and positioning analysis, you must synthesize those findings into the **Brand Synchronization Update** section at the end of this report. This section is not a summary — it is a prescriptive intelligence output for the brand team. If the market reveals that the current brand positioning is exposed, misaligned with audience expectations, or has been flanked by a competitor who now occupies a previously-owned positioning territory, this section must state exactly what brand guideline updates are needed and why.

### DIRECTIVE 3 — STRATEGIC "SO WHAT?" MANDATE

Every analysis bullet must carry both the observation AND its strategic implication for a marketing agency. Pure description is not intelligence.

**Banned format:**
> "The homepage uses blue and white with a clean layout."

**Required format:**
> "Homepage relies on corporate navy with zero accent differentiation — in a market where [Competitor X] uses bold gradient branding and [Competitor Y] leads with high-contrast photography, {COMPANY_NAME} risks visual anonymity; introducing one signature accent color would create category recall at a fraction of a full rebrand's cost."

The internal test: after writing any bullet, ask "So what does this mean for their marketing strategy?" If that answer is missing from the bullet, the bullet is incomplete.

### DIRECTIVE 4 — EVIDENCE SPECIFICITY

Every claim must reference something directly observable:
- **Named page or section:** "the /pricing page", "the About hero", "the footer trust bar"
- **Verbatim copy:** quote the actual headline or CTA where possible — e.g. 'their hero reads: "..."'
- **Named competitor contrast:** "unlike [Competitor], who leads with X, {COMPANY_NAME} positions on Y"
- **Labeled inference:** "signals suggest…" / "observable pattern:" / "the UX architecture implies…"

Generic, unsupported statements — "strong brand presence," "active social media," "competitive market" — are invalid. Every adjective needs evidence behind it.

---

## RESEARCH APPROACH

Before scoring, exhaustively cross-reference every knowledge source in your training data:

**Company intelligence layers:**
- Website architecture: homepage, /about, /team, /pricing, /blog, /case-studies — read the actual copy, hero headlines, CTAs, and value proposition framing, not just structural observations
- LinkedIn: company page, headcount band, founding year, industry tag, and posting cadence
- Crunchbase / PitchBook / AngelList: funding stage, founding year, HQ location, headcount range
- Press and news: TechCrunch, Product Hunt launches, industry publications, founder interviews, award mentions
- App stores: Google Play / Apple App Store if a mobile product exists

**Competitive signals:**
- Social profiles: Instagram, TikTok, X/Twitter, YouTube, LinkedIn, Pinterest — content format, posting cadence, engagement quality, pinned or featured content
- Review platforms: G2, Capterra, Trustpilot, Trustradius, Glassdoor; Reclame Aqui for Brazilian market only
- Competitor website copy: hero messaging, pricing page structure, feature naming and framing, testimonial selection

**Entity disambiguation:**
For companies with modern, short, or ambiguous names — explicitly search by (a) the provided domain, (b) company name + industry keyword, (c) LinkedIn URL pattern — confirm the correct entity before scoring. Never conflate with a similarly-named unrelated brand.

**Industry pattern intelligence:**
When company-specific public data is limited, apply known industry dynamics, buyer behavior patterns, and established competitive playbooks for this sector. Label these explicitly: "industry pattern suggests…" — this is intelligent inference, not guessing, and it is expected.

---

## SCORING METHODOLOGY

Score {COMPANY_NAME} and 8-15 real competitors across 8 weighted dimensions (0-100):

1. **Content & Messaging** (15%) — headline clarity, value proposition strength, copy quality, voice consistency, social proof integration, content depth and frequency
2. **Conversion Optimization** (15%) — CTA placement and wording strength, UX flow logic, trust signals at decision points, pricing transparency, signup/contact friction
3. **SEO & Discoverability** (12%) — title tag and meta quality, primary keyword ownership, content depth vs. search intent, backlink signal strength, technical indexability
4. **GEO & AI Discoverability** (8%) — structured data markup quality, llms.txt presence, mentions in ChatGPT/Perplexity/Gemini responses, citability signals vs. competitors
5. **Competitive Positioning** (15%) — differentiation clarity, pricing vs. named competitors, category ownership, messaging contrast against rivals
6. **Brand & Trust** (10%) — visual consistency across all channels, social proof quality, testimonials, press coverage, brand voice coherence
7. **Growth & Strategy** (10%) — business model clarity, pricing architecture, observable growth loops, retention signals, market timing
8. **Social Media & Community** (15%) — multi-platform presence, posting cadence, engagement quality, UGC presence, community or influencer use

**Overall Score** = (C&M × 0.15) + (Conv × 0.15) + (SEO × 0.12) + (GEO × 0.08) + (Pos × 0.15) + (Brand × 0.10) + (Growth × 0.10) + (Social × 0.15)

**Grades:** A (85+) · B (70-84) · C (55-69) · D (40-54) · F (0-39)

---

## OUTPUT QUALITY RULES

1. **Conservative scoring:** When genuinely uncertain, score 50-65. A mid-range score with specific evidence is more credible than an extreme score without proof.
2. **Real competitors only:** Every company in the Wide Scan and Competitive Ranking must be a real, verifiable entity operating in this market. No invented entities.
3. **Client rank:** {COMPANY_NAME} lands at rank 4 or lower unless you have specific, named evidence it outperforms at least 3 named competitors on a majority of dimensions.
4. **Recommendations tied to gaps:** Every strategic recommendation must cite the specific dimension score or section finding that motivated it. Recommendations without a stated gap are generic advice, not intelligence.
5. **Wide Scan minimum:** At least 8 competitors spanning Leader / Challenger / Niche tiers.
6. **Customer Sentiment is conditional:** For Brazilian companies, use Reclame Aqui. For all others, use G2, Capterra, or Trustpilot. If no reliable review data exists, omit the Customer Sentiment section entirely — heading and all content. Never write placeholder rows.
7. **Metadata is optional:** Only include header fields (Business Type, Founded) when you have a specific, confident value. Omit any field you cannot substantiate.
8. **Section-level omission:** If an entire section yields no substantiatable data, omit the heading and all content. Never leave a heading with filler beneath it.
9. **PRICING — treat as high-risk:** Training data for pricing is frequently stale. Only state a price you are highly confident is currently on the live website. If uncertain, write "see [website URL] for current pricing" — never guess a minimum investment, fee, or subscription cost from memory alone.
10. **REGULATORY & COMPLIANCE DATA — always capture:** For any regulated industry (financial services, healthcare, legal, etc.) actively look for registration numbers in the site footer, /about, /legal pages: CNPJ, CVM Ato Declaratório, ANBIMA código, SEC/FCA registration, etc. These are public facts that must appear in the report — marking them "data unavailable" when they are on the website is an error.
11. **DATA SOURCING CONSISTENCY:** Never write "a live scrape was performed" or "a live scrape was not possible". Use "website-observed:" / "training knowledge:" / "industry pattern:" consistently throughout.
12. **Complete all sections:** Do not truncate the report. Every section heading in the required format must appear in the output. If space is tight, write tighter bullets — but never drop a section.

---

## REQUIRED OUTPUT FORMAT

Generate ONLY the markdown below. Heading names must match EXACTLY — they drive automated parsing. Start immediately with the H1 — no preamble.

---

# Karos Intel: {COMPANY_NAME}
**Digital Intelligence & Competitive Report**

**Date:** {DATE}
**URL:** {WEBSITE_URL}
**Business Type:** [SaaS | E-commerce | Agency | Local | Marketplace — omit line if uncertain]
**Founded:** [year — omit line if uncertain]
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
[8-15 rows. Market Tier: Leader | Challenger | Niche. Overlap: High | Medium | Low-Med | Low. Deep Dive: Yes for top 3. Omit Price Range cell if unpublished — leave blank, never write "N/A".]

---

## Competitive Ranking

| Rank | Company | Score | Grade | Best Dimension | Weakest Dimension |
|------|---------|-------|-------|----------------|-------------------|
[Top 4 only: 3 competitors + {COMPANY_NAME}, sorted by rank ascending]

---

## Content & Messaging

[4-6 bullets per DIRECTIVE 3. Quote or paraphrase the actual hero copy or headline. Compare against at least one named competitor. Each bullet = specific observation + strategic implication. Omit section entirely if no confident data.]

---

## Conversion Optimization

[4-6 bullets. Name specific pages and quote CTAs verbatim where possible. Cover: CTA strength, UX flow logic, trust signal placement, pricing transparency, signup friction. Each bullet = observation + strategic implication. Omit if no confident data.]

---

## SEO & Discoverability

[4-6 bullets. Reference specific URL patterns, title tag structures, or content gaps by name. Compare keyword strategy against named competitors. Each bullet = observation + strategic implication. Omit if no confident data.]

---

## GEO & AI Discoverability

[4-6 bullets. Cover structured data quality, llms.txt presence, AI assistant mentions, citability vs. named competitors. Each bullet = observation + strategic implication. Omit if no confident data.]

---

## Competitive Positioning

[4-6 bullets. Quote competitor taglines or hero copy where available. Name the specific positioning territory {COMPANY_NAME} holds or fails to own. Each bullet = observation + strategic implication. Omit if no confident data.]

---

## Brand & Trust

[4-6 bullets. If {BRANDING_CONTEXT} is present, reference at least one specific color code or visual archetype. If {BRAND_VOICE} is present, cross-check whether the client's observed public-facing voice matches their stated brand voice — and name any gaps. Cover: visual consistency, social proof quality, testimonials, press coverage, voice coherence across channels. Each bullet = observation + strategic implication. Omit if no confident data.]

---

## Growth & Strategy

[4-6 bullets. Cover: business model, pricing architecture, growth loops, retention signals, market timing. Each bullet = observation + strategic implication. Omit if no confident data.]

---

## SWOT

### Strengths
- [Specific, evidence-backed strength — min 4 bullets. Reference named features, pricing structure, observed positioning, or specific messaging with supporting evidence.]

### Weaknesses
- [Specific, evidence-backed weakness — min 4 bullets. Each weakness should directly correspond to a low dimension score or observable competitive gap.]

### Opportunities
- [Specific market opportunity grounded in the competitive analysis — min 3 bullets. Reference actual whitespace found in the Wide Scan or positioning gaps named in the Competitive Positioning section.]

### Threats
- [Specific threat — name the competitor or market force — min 3 bullets. Quantify the threat level where possible with observable evidence.]

---

## Customer Sentiment

[Conditional: include ONLY if real review data exists. Platform: Reclame Aqui for Brazilian companies; G2, Capterra, or Trustpilot for all others. If no reliable data exists, omit this entire section — heading and all content.]

| Company | Rating | Response Time | Would Return |
|---------|--------|---------------|--------------|
[Real data rows only. No placeholder rows.]

### Whitespace Opportunities

1. [Specific unmet customer need or market gap — substantiated from sentiment or competitive analysis with named evidence]
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

**Voice Territory Opportunity:** [1-2 sentences on the specific voice territory {COMPANY_NAME} can own that named competitors do not occupy. If {BRAND_VOICE} is present, validate or challenge this opportunity against the client's stated voice direction — the goal is to surface the delta between current state and optimal positioning.]

---

## Competitor Profiles

### [Competitor1 Name] ([competitor1domain.com])
**Founded:** [year — omit if uncertain]
**Scale:** [headcount, funding stage, or user count — omit if uncertain]
**Key Strengths:** [comma-separated list — specific, observable, evidence-backed]
**Key Weaknesses:** [comma-separated list — observable gaps or positioning vulnerabilities]
**Threat Level:** HIGH

### [Competitor2 Name] ([competitor2domain.com])
**Founded:** [year — omit if uncertain]
**Scale:** [description — omit if uncertain]
**Key Strengths:** [comma-separated]
**Key Weaknesses:** [comma-separated]
**Threat Level:** MEDIUM

### [Competitor3 Name] ([competitor3domain.com])
**Founded:** [year — omit if uncertain]
**Scale:** [description — omit if uncertain]
**Key Strengths:** [comma-separated]
**Key Weaknesses:** [comma-separated]
**Threat Level:** MEDIUM

---

## Strategic Recommendations

### Priority 1: Quick Wins

1. [Specific action: exactly what to change, on which page, referencing the dimension gap that motivates it] [Karos: SEO]
2. [Another quick win with specific before/after framing — not generic advice] [Karos: Content]

### Priority 2: Growth Strategy

3. [Strategic growth play tied to a named whitespace or audience gap from the analysis] [Karos: Brand]
4. [Another growth recommendation with specific market rationale from the Competitive Positioning findings] [Karos: Email]

### Priority 3: Long-Term Positioning

5. [Category creation, voice territory ownership, or brand evolution play — cite the competitive evidence that makes this urgent] [Karos: GEO]
6. [Another long-term positioning recommendation] [Karos: Analytics]

---

## Brand Synchronization Update

[This section closes the loop between market intelligence and brand strategy. It is NOT a summary — it is a prescriptive output for the brand team, synthesized directly from what the competitive analysis revealed. This section must exist in every report.]

**Market findings that affect brand strategy:**
- [Specific insight from the competitive or positioning analysis that creates tension with, validates, or creates an opportunity for the current brand guidelines. Be precise — name the competitor, name the gap, name the implication.]
- [Another market signal with direct brand implications — e.g., a voice territory being eroded, a visual positioning gap, an audience shift]

**Recommended brand guideline updates:**
- [Specific update to voice, tone, visual identity, or a messaging pillar — grounded in the market gap or competitive pressure identified above. If the existing brand is already well-positioned, explicitly state this and name the competitive dynamic that confirms it.]
- [Another recommendation, or a confirmation that a specific brand decision should be protected as-is]

**Confirmed competitive moats to protect:**
- [Existing brand decisions — from {BRANDING_CONTEXT} or {BRAND_VOICE} — that this market analysis VALIDATES as differentiators. Name specifically what makes them an advantage and name the competitors who cannot easily replicate them.]

---
`;
