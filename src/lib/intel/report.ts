import "server-only";

import type { Client } from "@/lib/types";
import type { ParsedReport } from "@/lib/report-parser";
import { getClient, upsertClientReport, replaceReportCompetitors } from "@/lib/data";
import { buildClientReport } from "@/lib/report-parser";
import { applyBrandingForClient } from "@/lib/branding";
import {
  agentOnboardingDeps,
  dispatchAndAwaitResearch,
  writeContextDocsFromResearch,
} from "./agent-onboarding";
import { parsedReportFromDeliverable, rawMarkdownFromDeliverable } from "./deliverable-to-report";

/* ── Constants ───────────────────────────────────────────────────── */

/** Provenance key used when logging feedback on intel-generated context docs. */
export const INTEL_AGENT_ID = "intel-report-agent";

/**
 * SCRUM-274 (T-B19). How long the pipeline waits for each agent-engine
 * deliverable before giving up — see the call site below for the full
 * rationale. 70 minutes: above `seo-geo-agent`'s real 1-hour gate auto-approve
 * (T-A20/SCRUM-273) with a 10-minute margin for poll latency and the
 * auto-approved gate's own resume-and-finish work, without ballooning so far
 * past the hour that "completes within the hour" stops meaning anything.
 */
export const ONBOARDING_DELIVERABLE_TIMEOUT_MS = 70 * 60_000;

/** A deliverable arrives as `unknown` off the wire; every reader here wants a record. */
function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/* ── Main pipeline ───────────────────────────────────────────────── */

/**
 * Run the Intel Report pipeline for a client.
 *
 * Three steps, in this order and for these reasons:
 *
 *   1. Dispatch `intel-report-agent` and `seo-geo-agent`, and wait for both
 *      deliverables.
 *   2. Store the Intel Report the first one produced.
 *   3. Compose the eight context documents from BOTH — fatal on failure — and
 *      refresh branding alongside, non-fatal.
 *
 * ## What used to be here
 *
 * Step 1 used to be step 3. This function opened with a "Phase A" that
 * generated the entire report in-process: `DEFAULT_INTEL_PROMPT` compiled with
 * the client's branding and prior SEO/GEO, streamed through the AI SDK with
 * server-side `web_search`/`web_fetch`, retried once, continued for a second
 * pass when a required section went missing, then handed to
 * `parseMarkdownReport` to be regexed back into structured fields. Only when
 * all of that finished — six minutes on a real client — did "Phase B" dispatch
 * the agents.
 *
 * SCRUM-274 deleted the hardcoded CONTEXT-DOCUMENT pipeline (`./pipeline.ts`)
 * and left that half standing, so the portal kept a second, independent report
 * writer alongside the agent whose entire purpose was to be the report writer.
 * It is gone now. `intel-report-agent` emits every field the report needs as
 * typed structured output — RFC-05 §4 ported `DEFAULT_INTEL_PROMPT` to it
 * deliberately, and SCRUM-267 (T-A18) then made its persisted record the
 * portal's `ClientReport` field for field — so the markdown round trip bought
 * nothing that a rename could not (`./deliverable-to-report.ts`).
 *
 * Two consequences worth stating plainly. Both agent runs now appear in the
 * Jobs list within seconds of pressing Regenerate, because the dispatch is the
 * first thing that happens rather than the last. And a client with no
 * `agentsRepoSlug`, or an unreachable agent-engine, now fails outright instead
 * of quietly falling back to an in-process report — there is no longer anything
 * to fall back TO, which is the point of a cutover.
 *
 * @param runSpecificContext Optional run-specific instructions entered at
 *   execution time. Forwarded to both agents as `customPrompt` — the shared
 *   wire field they already read — rather than compiled into a local prompt.
 */
export async function runIntelReportPipeline(
  clientId: string,
  runSpecificContext?: string,
): Promise<void> {
  const deps = await agentOnboardingDeps();

  // Step 1. Every job document this run will ever have exists by the end of
  // this call; everything after it is waiting.
  const research = await dispatchAndAwaitResearch(clientId, deps, {
    deliverableTimeoutMs: ONBOARDING_DELIVERABLE_TIMEOUT_MS,
    ...(runSpecificContext?.trim() ? { runSpecificContext: runSpecificContext.trim() } : {}),
  });
  const { client, intelReport } = research;
  const deliverable = asRecord(intelReport);

  // Step 2. Same three writes as before, from the same `ParsedReport` shape —
  // only its provenance changed.
  const now = Date.now();
  const parsed = parsedReportFromDeliverable(deliverable, {
    ...(client.website ? { fallbackUrl: client.website } : {}),
    now,
  });

  // Atomically replace competitors: delete old + create new in one Firestore batch
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

  // The styled HTML report, still generated HERE and stored inline. The engine
  // renders its own (`karos-intel`'s `renderReportHtml`) for its own store, but
  // this one is the portal's: it is the portal's markup, its score colours and
  // its layout, and reading the engine's would make the client-facing report
  // change shape whenever agent-engine deployed.
  const reportHtml = generateReportHtml(client, parsed);
  const reportData = {
    ...buildClientReport(clientId, parsed, rawMarkdownFromDeliverable(deliverable)),
    reportHtml,
  };
  await upsertClientReport(reportData);

  // Step 3. Context documents are FATAL when they fail: those documents are the
  // ground truth every downstream agent consumes, so a run that silently skips
  // them must surface as failed (onboardingStatus: "failed"), not as "done".
  // Branding stays non-fatal — it is cosmetic relative to the intel outputs.
  const [docsResult] = await Promise.allSettled([
    writeContextDocsFromResearch(research, deps),
    applyBrandingForClient(clientId, client)
      .then((r) => {
        console.info(`[intel] Branding refreshed for ${client.name} (${r.source}): ${r.primaryAccent ?? "no color"}`);
      })
      .catch((err: unknown) => {
        console.error("[intel] Branding generation failed (non-fatal):", err);
      }),
  ]);

  // Branding just rewrote the client's palette; the projection that ran inside
  // the doc pipeline read the client BEFORE that landed. Re-project brand and
  // profile now so the engine's `client/brand.json` is the palette the portal
  // shows — the intel report was describing a background the portal had
  // already corrected. Best-effort, like everything on this side channel.
  try {
    const [{ projectClientToWorkspace }, freshClient] = await Promise.all([import("@/lib/agent-engine/context-doc-projection"), getClient(clientId)]);
    if (freshClient) await projectClientToWorkspace(freshClient, undefined);
  } catch (err) {
    console.error("[intel] brand/profile projection failed (non-fatal):", err);
  }

  if (docsResult.status === "rejected") {
    console.error("[intel] Context-doc pipeline failed:", docsResult.reason);
    throw new Error(
      `Intel Report stored, but the context-document pipeline failed: ${docsResult.reason instanceof Error ? docsResult.reason.message : String(docsResult.reason)}`,
      { cause: docsResult.reason },
    );
  }
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
