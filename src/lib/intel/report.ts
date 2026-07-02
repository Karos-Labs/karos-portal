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
import { DEFAULT_INTEL_PROMPT } from "./brain";

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

/**
 * Assembles the final LLM system prompt from three instruction layers.
 *
 * Default behavior: the model satisfies ALL layers simultaneously.
 * Conflict-resolution priority (invoked only when layers are mutually exclusive):
 *   Priority 1 (Highest) — Layer C: Run-Specific Directives  (this run only)
 *   Priority 2           — Layer B: Global Admin Configurations (all runs, from DB)
 *   Priority 3 (Lowest)  — Layer A: Core System Architecture  (codebase defaults)
 */
function assemblePromptLayers(
  basePrompt: string,
  globalAdminConfig: string,
  runSpecificContext: string,
): string {
  const hasB = globalAdminConfig.trim().length > 0;
  const hasC = runSpecificContext.trim().length > 0;
  if (!hasB && !hasC) return basePrompt;

  const parts: string[] = [basePrompt];

  parts.push(
    "\n\n## ◈ INSTRUCTION LAYER ARCHITECTURE",
    "",
    "This prompt is assembled from three instruction layers. **Merge and satisfy all three layers simultaneously** — preserving system structure, standing configurations, and run-specific focus at once. Do not treat a higher-priority layer as license to ignore lower-priority layers.",
    "",
    "Invoke the conflict-resolution hierarchy below **only** when two instructions are mutually exclusive and cannot both be honored literally:",
    "",
    "| Priority | Layer | Source | Scope |",
    "|----------|-------|--------|-------|",
    "| **1 — Highest** | Layer C: Run-Specific Directives | Runtime modal input | This run only — expires after completion |",
    "| **2** | Layer B: Global Admin Configurations | Agency admin DB settings | All runs (standing) |",
    "| **3 — Lowest** | Layer A: Core System Architecture | Codebase defaults | Foundational structure |",
    "",
    "*Interpretation example: A Layer C instruction to \"lean heavily into social media\" does not override Layer A's document structure or scoring methodology — it shifts analytical emphasis within that structure. Only treat layers as contradictory when literal simultaneous compliance is impossible.*",
  );

  if (hasB) {
    parts.push(
      "",
      "## ◈ LAYER B — GLOBAL ADMIN CONFIGURATIONS",
      "*(Standing instructions configured by the agency administrator — apply to all runs unless Layer C supersedes them on a specific point)*",
      "",
      globalAdminConfig.trim(),
    );
  }

  if (hasC) {
    parts.push(
      "",
      "## ◈ LAYER C — RUN-SPECIFIC DIRECTIVES ⟨ PRIORITY 1 / HIGHEST ⟩",
      "*(Temporary directives entered at execution time for this single run. They do not modify any global settings and expire the moment this run completes. Apply them with full authority over conflicting instructions from Layers A and B.)*",
      "",
      runSpecificContext.trim(),
    );
  }

  return parts.join("\n");
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
export async function runIntelReportPipeline(
  clientId: string,
  runSpecificContext?: string,
): Promise<void> {
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
  const compiledPrompt = assemblePromptLayers(
    basePrompt,
    additionalInstructions,
    runSpecificContext ?? "",
  );

  const userMessage = `Generate the complete Karos Intel Report for ${client.name}. Output ONLY the markdown report — no preamble, no explanation. Start immediately with "# Karos Intel: ${client.name}".`;

  // Run all three pipelines concurrently — report text, context docs, and branding bootstrap
  const [{ text: firstPassText }] = await Promise.all([
    generateText({
      model: anthropic(MODELS.SONNET),
      system: compiledPrompt,
      messages: [{ role: "user", content: userMessage }],
      maxOutputTokens: DOC_MAX_TOKENS,
    }),
    // Context-doc pipeline (non-fatal) — forward run-specific context so all sub-agents share it
    import("./pipeline")
      .then(({ runOnboardPipeline }) => runOnboardPipeline(clientId, runSpecificContext))
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
