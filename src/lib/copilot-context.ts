import "server-only";

import type { Agent, Asset, Client, ClientCompetitor, ClientReport, Job } from "@/lib/types";

export function buildCopilotSystemPrompt(
  client: Client,
  report: ClientReport | null,
  competitors: ClientCompetitor[],
  agents: Agent[],
  jobs: Job[],
  assets: Asset[],
): string {
  const today = new Date().toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  const parts: string[] = [
    `You are the AI Copilot for **${client.name}** — an intelligent account manager embedded in the Karos CMO platform.`,
    `You have complete visibility into this client's digital performance, brand identity, competitor landscape, and content history.`,
    `Be concise, strategic, and specific. Never hallucinate data — only reference what is listed below. Today is ${today}.`,
    "",
  ];

  // Client profile
  parts.push("## CLIENT PROFILE");
  parts.push(`- **Name:** ${client.name}`);
  if (client.website) parts.push(`- **Website:** ${client.website}`);
  if (client.industry) parts.push(`- **Industry:** ${client.industry}`);
  if (client.description) parts.push(`- **Description:** ${client.description}`);
  if (client.contactEmail) parts.push(`- **Contact:** ${client.contactEmail}`);
  parts.push(`- **Status:** ${client.status}`);
  parts.push("");

  // Intel report
  if (report) {
    parts.push("## INTELLIGENCE REPORT");
    parts.push(`- **Score:** ${report.overallScore}/100 — Grade **${report.overallGrade}**`);
    parts.push(`- **Report Date:** ${report.reportDate}`);
    if (report.businessType) parts.push(`- **Business Type:** ${report.businessType}`);
    if (report.techStack) parts.push(`- **Tech Stack:** ${report.techStack}`);
    if (report.reportStatus) parts.push(`- **Status:** ${report.reportStatus}`);
    if (report.url) parts.push(`- **Reported URL:** ${report.url}`);

    if (report.dimensionScores.length > 0) {
      parts.push("", "### Dimension Scores");
      for (const d of report.dimensionScores) {
        parts.push(
          `- ${d.dimension}: **${d.score}/100**${typeof d.weight === "number" ? ` (weight ${d.weight}%)` : ""}`,
        );
      }
    }

    if (report.competitorRankings.length > 0) {
      parts.push("", "### Competitive Ranking");
      for (const r of report.competitorRankings) {
        parts.push(`- #${r.rank} ${r.company ?? ""}: ${r.score}/100`);
      }
    }

    if (report.swot) {
      const { strengths, weaknesses, opportunities, threats } = report.swot;
      parts.push("", "### SWOT");
      if (strengths?.length) parts.push(`- **Strengths:** ${strengths.join(" | ")}`);
      if (weaknesses?.length) parts.push(`- **Weaknesses:** ${weaknesses.join(" | ")}`);
      if (opportunities?.length) parts.push(`- **Opportunities:** ${opportunities.join(" | ")}`);
      if (threats?.length) parts.push(`- **Threats:** ${threats.join(" | ")}`);
    }

    if (report.recommendations.length > 0) {
      parts.push("", "### Priority Recommendations");
      for (const r of report.recommendations.slice(0, 6)) {
        const tag = r.tag ? ` [${r.tag}]` : "";
        const desc = r.description ? ` — ${r.description}` : "";
        parts.push(`${r.number}. **${r.title}**${desc}${tag}`);
      }
    }

    // Analysis text (first 400 chars each to stay within context)
    const analyses: [string, string | undefined][] = [
      ["Content & Messaging", report.contentAnalysis],
      ["SEO & Discoverability", report.seoAnalysis],
      ["Conversion Optimization", report.conversionAnalysis],
      ["GEO & AI Discoverability", report.geoAnalysis],
      ["Competitive Positioning", report.positioningAnalysis],
      ["Brand & Trust", report.brandAnalysis],
      ["Growth & Strategy", report.growthAnalysis],
    ];
    const nonEmpty = analyses.filter(([, t]) => t?.trim());
    if (nonEmpty.length > 0) {
      parts.push("", "### Analysis Summaries");
      for (const [label, text] of nonEmpty) {
        const excerpt = text!.slice(0, 400);
        parts.push(`**${label}:** ${excerpt}${text!.length > 400 ? "…" : ""}`);
        parts.push("");
      }
    }
  }

  // Competitors
  if (competitors.length > 0) {
    parts.push("## COMPETITOR TRACKER");
    for (const c of competitors) {
      const meta: string[] = [c.company];
      if (c.marketTier) meta.push(c.marketTier);
      if (c.threatLevel) meta.push(`${c.threatLevel} threat`);
      if (c.overlap) meta.push(`overlap: ${c.overlap}`);
      if (c.url) meta.push(c.url);
      parts.push(`- ${meta.join(" · ")}`);
      if (c.keyStrengths) parts.push(`  Strengths: ${c.keyStrengths}`);
      if (c.keyWeaknesses) parts.push(`  Weaknesses: ${c.keyWeaknesses}`);
      if (c.positioning) parts.push(`  Positioning: ${c.positioning}`);
    }
    parts.push("");
  }

  // Branding
  const g = client.brandingGuidelines;
  if (g) {
    parts.push("## BRANDING GUIDELINES");
    if (g.primaryColor) parts.push(`- **Primary Color:** ${g.primaryColor}`);
    if (g.secondaryColor) parts.push(`- **Secondary/Accent Color:** ${g.secondaryColor}`);
    if (g.fontHeading) parts.push(`- **Heading Font:** ${g.fontHeading}`);
    if (g.fontBody) parts.push(`- **Body Font:** ${g.fontBody}`);
    if (g.toneKeywords?.length) parts.push(`- **Tone Keywords:** ${g.toneKeywords.join(", ")}`);
    if (g.guidelines) parts.push(`- **Written Guidelines:** ${g.guidelines}`);
    parts.push("");
  }

  // Active agents
  const activeAgents = agents.filter((a) => a.isActive && !a.isSystem);
  if (activeAgents.length > 0) {
    parts.push("## ACTIVE AI AGENTS");
    for (const a of activeAgents) {
      const caps = a.capabilities?.length ? ` [${a.capabilities.join(", ")}]` : "";
      parts.push(`- **${a.name}**: ${a.description ?? ""}${caps}`);
    }
    parts.push("");
  }

  // Recent jobs (last 10)
  if (jobs.length > 0) {
    parts.push("## RECENT JOB HISTORY");
    for (const j of jobs.slice(0, 10)) {
      parts.push(`- ${j.agentName}: "${j.title}" — **${j.status}**`);
    }
    parts.push("");
  }

  // Asset summary by type
  if (assets.length > 0) {
    const byType = assets.reduce<Record<string, number>>((acc, a) => {
      acc[a.type] = (acc[a.type] ?? 0) + 1;
      return acc;
    }, {});
    parts.push("## GENERATED ASSETS");
    for (const [type, count] of Object.entries(byType)) {
      parts.push(`- ${type}: ${count} asset${count !== 1 ? "s" : ""}`);
    }
    parts.push("");
  }

  parts.push(
    "## TOOLS",
    "You have two tools you can call:",
    "- **update_branding_guidelines** — updates brand colors, fonts, or tone keywords in real-time. Always state exactly what you will change and get the user's confirmation before calling this tool.",
    "- **send_support_email** — sends a support request to the Karos Labs admin team. Use when the user reports a problem or asks to escalate an issue.",
  );

  return parts.join("\n");
}
