import "server-only";

import type { Asset, Client, ClientCompetitor, ClientContextDoc, ClientReport, Job } from "@/lib/types";
import { effectiveDominantColors } from "@/lib/branding";
import { assetTypeLabel } from "@/lib/asset-type-copy";
import { contextDocLabel } from "@/lib/context-doc-copy";
import { jobStatusLabel } from "@/lib/job-status-copy";

/* ── Shared helpers ──────────────────────────────────────────────────── */

/*
 * The doc-type name map used to be a private copy here, spelled in Title Case.
 * It now comes from context-doc-copy.ts, because the same map is needed in
 * PROSE a client reads (activity titles, credit-ledger reasons) and a second
 * copy is how the two come apart. The names arrive sentence case, which is what
 * the heading below wanted anyway: this text is read by the model, and the model
 * paraphrases whatever case it is handed straight back to the client.
 */

export function buildCopilotSystemPrompt(
  client: Client,
  report: ClientReport | null,
  competitors: ClientCompetitor[],
  jobs: Job[],
  assets: Asset[],
  contextDocs: ClientContextDoc[] = [],
  /**
   * `canUpdateBranding` mirrors the tool registry the route actually hands to the
   * model. The branding tool is staff-only (copilot-tool-access.ts), and
   * describing a tool a client session does not have just teaches the model to
   * promise it.
   *
   * `viewerIsClient` is WHOSE VOCABULARY THIS PROMPT IS WRITTEN IN, and it is a
   * separate question from capability on purpose.
   *
   * THE SYSTEM PROMPT IS PAYLOAD, NOT PLUMBING. Everything below is text the
   * model reads and paraphrases back into the dock, so an interpolated enum here
   * reaches a client as prose exactly the way an interpolated `asset.status` in a
   * tool result did — one indirection further out, and with no render to gate.
   * The block above literally instructs the model "Never show the client raw
   * field names, database ids, or internal status codes" and then handed it
   * `paused`, `review` and `instagram_post` to work from; an instruction the
   * prompt itself breaks is the weakest kind of guarantee there is.
   *
   * Defaults to the SAFE answer (client) so a caller that forgets the flag
   * withholds internal vocabulary rather than leaking it.
   */
  opts: { canUpdateBranding?: boolean; viewerIsClient?: boolean } = {},
): string {
  const viewerIsClient = opts.viewerIsClient !== false;
  const today = new Date().toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  const parts: string[] = [
    `You are the AI Copilot for **${client.name}** — an intelligent account manager embedded in the Karos CMO platform.`,
    `You have complete visibility into this client's brand profile, competitor landscape, content history, and strategy documents.`,
    `Be concise, strategic, and specific. Never hallucinate data — only reference what is listed below. Today is ${today}.`,
    "",
    // The panel renders replies through the portal's document renderer, which
    // supports exactly the marks listed here. Anything outside that set reached
    // the client as literal characters — hash marks, table pipes, stray
    // asterisks (QA F89) — and this prompt being written in Markdown is what
    // taught the model to answer in it.
    "## HOW TO WRITE YOUR REPLIES",
    "Your replies are rendered in a narrow chat panel that supports only: **bold**, *italics*, `code`, hyphen bullets, numbered lists, and > blockquotes.",
    "- Do NOT use ## or ### headings. For a multi-section answer, open each section with a short **bold label** on its own line.",
    "- Do NOT use tables — a table is unreadable at this width. Use bullets instead.",
    "- Sentence case, no title case. Keep paragraphs to two or three sentences.",
    "- Never show the client raw field names, database ids, or internal status codes.",
    "",
  ];

  // Client profile
  parts.push("## CLIENT PROFILE");
  parts.push(`- **Name:** ${client.name}`);
  if (client.website) parts.push(`- **Website:** ${client.website}`);
  if (client.industry) parts.push(`- **Industry:** ${client.industry}`);
  if (client.description) parts.push(`- **Description:** ${client.description}`);
  if (client.contactEmail) parts.push(`- **Contact:** ${client.contactEmail}`);
  // DROPPED for a client session rather than relabelled, and that is the fix.
  //
  // `Client.status` is `"active" | "paused" | "archived"` — the ACCOUNT's
  // lifecycle in our books, not a property of the client's marketing. There is
  // no client-facing register for it and there should not be one: "paused" and
  // "archived" are commercial states a client learns from their account manager,
  // not from a chatbot that would relay them on request ("what's my account
  // status?"), and "active" tells them nothing they cannot see by being logged
  // in. Inventing a euphemism would only make the copilot fluent about something
  // it has no business discussing.
  //
  // NOTE this is NOT the asset-status question. `assetStatusLabel` would be the
  // wrong home for this union — different key domain, different reader, and the
  // words do not overlap.
  //
  // Staff keep the real value: for them it is operational context, and the staff
  // dock is where "why is this account paused" is a legitimate question.
  if (!viewerIsClient) parts.push(`- **Status:** ${client.status}`);
  parts.push("");

  // Context documents (new pipeline — primary source of truth)
  // Staff/internal docs take priority; client-tier docs as fallback
  const priorityDocs = contextDocs.filter(
    (d) => d.tier === "internal" || d.tier === "client",
  );
  if (priorityDocs.length > 0) {
    parts.push(
      "## CLIENT CONTEXT DOCUMENTS",
      "Generated by the multi-agent research pipeline. These are the primary source of brand and strategy intelligence.",
      "",
    );
    // Deduplicate per docType, actually preferring the internal tier. The old
    // pass only claimed to: it kept the FIRST row seen, so which tier won was
    // whatever order the data layer happened to return (QA F81). Callers may
    // pre-filter by tier — the chat route hands a CLIENT_USER client-tier docs
    // only — but this must be right on its own rather than lean on a filter in
    // another file.
    const byDocType = new Map<string, ClientContextDoc>();
    for (const doc of priorityDocs) {
      const kept = byDocType.get(doc.docType);
      if (!kept || (kept.tier !== "internal" && doc.tier === "internal")) {
        byDocType.set(doc.docType, doc);
      }
    }
    for (const doc of byDocType.values()) {
      const label = contextDocLabel(doc.docType);
      const tierLabel = doc.tier === "internal" ? "Internal" : "Client-facing";
      parts.push(`### ${label} [${tierLabel} · v${doc.version}]`);
      // Include up to 800 chars of content per doc (strip frontmatter)
      const stripped = doc.content.replace(/^---[\s\S]*?---\n?/, "").trim();
      const excerpt = stripped.slice(0, 800);
      parts.push(excerpt + (stripped.length > 800 ? "\n[…truncated]" : ""));
      parts.push("");
    }
  }

  // Legacy intel report (metadata only — scores/grades are deprecated from display)
  if (report) {
    parts.push("## REPORT METADATA");
    if (report.reportDate) parts.push(`- **Report Date:** ${report.reportDate}`);
    if (report.businessType) parts.push(`- **Business Type:** ${report.businessType}`);
    if (report.techStack) parts.push(`- **Tech Stack:** ${report.techStack}`);
    if (report.founded) parts.push(`- **Founded:** ${report.founded}`);

    if (report.swot) {
      const { strengths, weaknesses, opportunities, threats } = report.swot;
      parts.push("", "### SWOT");
      if (strengths?.length) parts.push(`- **Strengths:** ${strengths.join(" | ")}`);
      if (weaknesses?.length) parts.push(`- **Weaknesses:** ${weaknesses.join(" | ")}`);
      if (opportunities?.length) parts.push(`- **Opportunities:** ${opportunities.join(" | ")}`);
      if (threats?.length) parts.push(`- **Threats:** ${threats.join(" | ")}`);
    }

    if (report.recommendations.length > 0) {
      parts.push("", "### Strategic Recommendations");
      for (const r of report.recommendations.slice(0, 6)) {
        const tag = r.tag ? ` [${r.tag}]` : "";
        const desc = r.description ? ` — ${r.description}` : "";
        parts.push(`${r.number}. **${r.title}**${desc}${tag}`);
      }
    }
    parts.push("");
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
      if (c.keyStrengths?.length) parts.push(`  Strengths: ${c.keyStrengths.join(", ")}`);
      if (c.keyWeaknesses?.length) parts.push(`  Weaknesses: ${c.keyWeaknesses.join(", ")}`);
      if (c.positioning) parts.push(`  Positioning: ${c.positioning}`);
    }
    parts.push("");
  }

  // Branding — always use effectiveDominantColors() to support both legacy scalar fields
  // and the new dominantColors[] array. Never read g.primaryAccent etc. directly here.
  const g = client.brandingGuidelines;
  if (g) {
    parts.push("## BRANDING GUIDELINES (Agent-Active)");
    const colors = effectiveDominantColors(g);
    colors.forEach((c) => {
      const label = c.role ? `Color ${c.dominanceRank} (${c.role})` : `Color ${c.dominanceRank}`;
      parts.push(`- **${label}:** ${c.hex}`);
    });
    if (g.fontHeading) parts.push(`- **Heading Font:** ${g.fontHeading}`);
    if (g.fontBody) parts.push(`- **Body Font:** ${g.fontBody}`);
    if (g.toneKeywords?.length) parts.push(`- **Tone Keywords:** ${g.toneKeywords.join(", ")}`);
    if (g.guidelines) parts.push(`- **Written Guidelines:** ${g.guidelines}`);
    parts.push("");
  }

  // Recent jobs
  if (jobs.length > 0) {
    parts.push("## RECENT JOB HISTORY");
    for (const j of jobs.slice(0, 10)) {
      // RELABELLED, not dropped: run state is something a client legitimately
      // reads — the same words JobStatusBadge already paints for them on the
      // dashboard and every intake surface — so the content belongs here and only
      // the vocabulary was wrong. `job-status-copy` is the register those badges
      // read, asked here so the dock and the badge cannot say different words
      // about the same run ("review" vs "In review").
      //
      // Not viewer-split, because that register is not: unlike a deliverable's
      // publish status, a run's state reads the same to whoever is watching it.
      parts.push(`- ${j.agentName}: "${j.title}" — **${jobStatusLabel(j.status)}**`);
    }
    parts.push("");
  }

  // Asset summary
  if (assets.length > 0) {
    const byType = assets.reduce<Record<string, number>>((acc, a) => {
      acc[a.type] = (acc[a.type] ?? 0) + 1;
      return acc;
    }, {});
    // RELABELLED: a client knowing they have twelve Instagram posts on file is
    // the point of the block; being handed `instagram_post` is not. The register
    // is the one client-home-overview's deliverable cards already read, so the
    // dock and the cards name a kind of post the same way.
    //
    // The NOUN is viewer-split even though the type label is not: "asset" is
    // internal vocabulary (staff say it, the §3 tools say "output" to clients),
    // and this heading is prose the model paraphrases.
    parts.push(viewerIsClient ? "## OUTPUTS PRODUCED SO FAR" : "## GENERATED ASSETS");
    const noun = viewerIsClient ? "output" : "asset";
    for (const [type, count] of Object.entries(byType)) {
      parts.push(`- ${assetTypeLabel(type)}: ${count} ${noun}${count !== 1 ? "s" : ""}`);
    }
    parts.push("");
  }

  parts.push("## TOOLS");
  if (opts.canUpdateBranding) {
    parts.push(
      "- **update_branding_guidelines** — updates brand colors, fonts, or tone keywords. Confirm the specific change with the user before calling.",
    );
  } else {
    parts.push(
      "- You cannot change this client's branding guidelines yourself. If they ask, point them at the brand panel in the left rail (the pencil beside Brand colors), or offer to escalate.",
    );
  }
  parts.push(
    "- **send_support_email** — escalates issues to the Karos Labs team. Use when the user reports a problem.",
  );

  return parts.join("\n");
}
