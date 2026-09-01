import "server-only";

import { DOC_MAX_TOKENS } from "@/lib/constants";
import { runGuardedReportPass, REPORT_IDLE_TIMEOUT_MS } from "./report-stream";
import type { Client } from "@/lib/types";
import { clientCategoryValue } from "@/lib/utils";
import type { ParsedReport } from "@/lib/report-parser";
import {
  getClient,
  getClientSeoGeo,
  upsertClientReport,
  replaceReportCompetitors,
} from "@/lib/data";
import { ENGINE_LABELS, categoryMetrics, type SeoGeoInsights } from "@/lib/seo-geo";
import { parseMarkdownReport, buildClientReport } from "@/lib/report-parser";
import { applyBrandingForClient, effectiveDominantColors } from "@/lib/branding";
import type { BrandingGuidelines } from "@/lib/types";
import { DEFAULT_INTEL_PROMPT } from "./brain";
import { logger } from "@/services/logger";
import { aiFor, usageFor } from "@/lib/ai/provider";

/* ── Constants ───────────────────────────────────────────────────── */

/** Provenance key used when logging feedback on intel-generated context docs. */
export const INTEL_AGENT_ID = "intel-report-agent";

/**
 * SCRUM-274 (T-B19). How long Phase B waits for each agent-engine deliverable
 * before giving up — see the call site below for the full rationale. 70
 * minutes: above `seo-geo-agent`'s real 1-hour gate auto-approve (T-A20/
 * SCRUM-273) with a 10-minute margin for poll latency and the auto-approved
 * gate's own resume-and-finish work, without ballooning so far past the hour
 * that "completes within the hour" stops meaning anything.
 */
export const ONBOARDING_DELIVERABLE_TIMEOUT_MS = 70 * 60_000;

/** Minimum chars for a viable first-pass report. Below this = a swallowed upstream failure. */
const MIN_REPORT_CHARS = 500;

/**
 * Max agentic steps per report pass. Anthropic returns `stop_reason: "pause_turn"`
 * when its server-side web tools run long; the AI SDK's default `stopWhen` is
 * `stepCountIs(1)`, so it stops at the FIRST pause and resolves `.text` with only
 * the pre-pause intro (~150 chars) — no error, just a truncated stub. Allowing
 * multiple steps lets the SDK resume the paused turn until the model finishes.
 * Bounded well above the tool budget (15 searches + 12 fetches) to cap cost.
 */
const REPORT_MAX_STEPS = 24;

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
 * Compiles the measured SEO/GEO baseline (from the platform's multi-model capture)
 * into a context block for the Intel prompt. When present, the report's SEO and GEO
 * dimension analysis anchors on these MEASURED numbers instead of re-deriving them
 * from browsing alone. Returns "" when no capture has run yet (first onboarding).
 */
function compileSeoGeoContext(insights: SeoGeoInsights | null): string {
  if (!insights) return "";
  const date = new Date(insights.capturedAt).toISOString().slice(0, 10);
  const lines = [
    "## Measured SEO & GEO Baseline",
    `(Captured ${date} by the platform's SEO/GEO research vertical — MEASURED data, treat as ground truth for the SEO and GEO dimension analysis. Do not contradict these numbers with browsing-based estimates.)`,
    "",
    `- SEO score: ${insights.seoScore}/100 (coverage ${insights.seoDataCoveragePct}%)`,
    `- GEO readiness: ${insights.geoReadiness}/100 (coverage ${insights.geoReadinessCoveragePct}%)`,
    `- GEO visibility index: ${insights.geoVisibilityIndex}/100 (coverage ${insights.geoVisibilityCoveragePct}%)`,
  ];
  // CD-B3: CATEGORY prompts only. The branded questions name the client by
  // construction, so full-set mentionRate/shareOfVoice runs high and would have
  // told this model a different story than every rendered surface — the tile,
  // the engine cards and the score all read `categoryMetrics`. Same accessor, so
  // the prompt and the UI cannot drift; it carries the legacy fallback for
  // snapshots captured before `category` existed.
  const live = insights.perEngine.filter(
    (e) => e.captureTier !== "UNAVAILABLE" && categoryMetrics(e).promptsMeasured > 0,
  );
  if (live.length) {
    lines.push(
      "",
      "Per-engine visibility across CATEGORY (non-brand) buyer-intent prompts — branded questions are excluded because they name the client by construction. Each row is labeled with the model provider that measured it:",
    );
    for (const e of live) {
      const c = categoryMetrics(e);
      lines.push(
        `- ${ENGINE_LABELS[e.engine]} (source: ${e.source}): named in ${Math.round(c.mentionRate * 100)}% of category answers, ${Math.round(c.shareOfVoice)}% share of voice${c.topCompetitor ? `, leading competitor ${c.topCompetitor.name} at ${Math.round(c.topCompetitor.shareOfVoice)}%` : ""}`,
      );
    }
  }
  const topGaps = insights.gaps.slice(0, 5);
  if (topGaps.length) {
    lines.push("", "Top measured gaps (score-lift ordered):");
    for (const g of topGaps) lines.push(`- [${g.lever}/${g.severity}] ${g.title} — ${g.measured}`);
  }
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
    .replace(/\{INDUSTRY\}/g, clientCategoryValue(client) || "general")
    .replace(/\{DESCRIPTION\}/g, client.description || "")
    .replace(/\{DATE\}/g, today)
    .replace(/\{BRANDING_CONTEXT\}/g, brandingContext ? "\n\n" + brandingContext + "\n" : "")
    .replace(/\{BRAND_VOICE\}/g, brandVoiceBlock);
}

/* ── Main pipeline ───────────────────────────────────────────────── */

/**
 * Diagnose why a report pass ended short. When there is no stream error, a stub
 * means the model ended its turn early — the finish reason, warnings (e.g. a tool
 * dropped as unsupported), step/tool counts, and the literal text reveal which.
 * Every read is guarded so a missing field never masks the diagnosis.
 */
async function describeStub(
  stream: {
    finishReason: PromiseLike<unknown>;
    warnings: PromiseLike<unknown>;
    steps: PromiseLike<unknown[]>;
    toolCalls: PromiseLike<unknown[]>;
    toolResults: PromiseLike<unknown[]>;
  },
  text: string,
): Promise<string> {
  const safe = async <T>(p: PromiseLike<T>, fallback: T): Promise<T> => {
    try {
      return await p;
    } catch {
      return fallback;
    }
  };
  const [finishReason, warnings, steps, toolCalls, toolResults] = await Promise.all([
    safe<unknown>(stream.finishReason, "unknown"),
    safe<unknown>(stream.warnings, undefined),
    safe<unknown[]>(stream.steps, []),
    safe<unknown[]>(stream.toolCalls, []),
    safe<unknown[]>(stream.toolResults, []),
  ]);
  const warnText =
    Array.isArray(warnings) && warnings.length
      ? warnings
          .map((w) =>
            w && typeof w === "object" && "message" in w
              ? String((w as { message: unknown }).message)
              : JSON.stringify(w),
          )
          .join("; ")
      : "none";
  const snippet = text.trim().replace(/\s+/g, " ").slice(0, 300);
  return `finishReason=${String(finishReason)}, steps=${(steps as unknown[]).length}, toolCalls=${(toolCalls as unknown[]).length}, toolResults=${(toolResults as unknown[]).length}, warnings=[${warnText}], text="${snippet}"`;
}

/**
 * Run the full Intel Report pipeline for a client:
 * 1. Generate the structured ClientReport (monolithic prompt, backward-compatible)
 * 2. Run the real agent-engine onboarding path (SCRUM-274/T-B19) in parallel
 *    to generate the context documents — FATAL when it fails (see the call
 *    site below); the report itself is still stored either way, since Phase A
 *    already completed before Phase B starts.
 */
export async function runIntelReportPipeline(
  clientId: string,
  runSpecificContext?: string,
): Promise<void> {
  const [client, priorSeoGeo] = await Promise.all([getClient(clientId), getClientSeoGeo(clientId)]);
  if (!client) throw new Error(`Client not found: ${clientId}`);

  const brandingContext = compileBrandingContext(client.brandingGuidelines);

  // Cross-reference: a prior multi-model SEO/GEO capture (if any) anchors the
  // report's SEO/GEO dimensions on measured data instead of browsing estimates.
  const seoGeoContext = compileSeoGeoContext(priorSeoGeo);
  const basePrompt =
    compilePrompt(DEFAULT_INTEL_PROMPT, client, brandingContext) +
    (seoGeoContext ? `\n\n${seoGeoContext}\n` : "");
  const compiledPrompt = assemblePromptLayers(basePrompt, "", runSpecificContext ?? "");

  const userMessage = `Generate the complete Karos Intel Report for ${client.name}. Output ONLY the markdown report — no preamble, no explanation. Start immediately with "# Karos Intel: ${client.name}".`;

  // Live-web tools: the Intel Report must operate on the client's CURRENT state.
  // web_search + web_fetch run server-side, verifying competitors and review
  // platforms before scoring. maxUses bounds per-run cost. Resolved through the
  // shared provider layer's role resolver — not a hardcoded vendor call — so the
  // model AND its tools come from the same vendor resolution that
  // `usageFor("intel.report.pass")` logs below; see AU70/SCRUM-370. The main
  // pass and the continuation pass each resolve independently, right next to
  // where they call it, so both stay visible to the manifest coverage test in
  // provider-wiring.test.ts.
  const reportPassBudgets = {
    web_search: { maxUses: 15 },
    web_fetch: { maxUses: 12, maxContentTokens: 6000 },
  };
  const reportAi = aiFor("intel.report.pass", { budgets: reportPassBudgets });
  const liveTools = reportAi.tools;

  // Phase A: main report. streamText is used throughout (not generateText) because Anthropic
  // starts sending response headers within ~1 second of receiving a streaming request, whereas
  // non-streaming requests buffer the entire generation server-side before sending any headers.
  // At 16k max tokens, non-streaming generation can exceed undici's default 5-minute
  // headersTimeout (UND_ERR_HEADERS_TIMEOUT), causing connection resets on every retry.
  // The AI SDK routes provider-side stream errors (overload, 429 rate-limit, web-tool
  // failures, pause_turn interruptions) to onError and resolves `.text` with whatever
  // partial text streamed before the error — it does NOT reject. We capture that error,
  // retry once, and on final failure throw it as the root cause instead of the opaque
  // "returned N chars" stub. Only a clean pass (no stream error AND ≥ min chars) is used.
  let firstPassText = "";
  let passSucceeded = false;
  let lastPassError: unknown;
  for (let attempt = 1; attempt <= 2 && !passSucceeded; attempt++) {
    const pass = await runGuardedReportPass(reportAi.model, {
      system: compiledPrompt,
      messages: [{ role: "user", content: userMessage }],
      tools: liveTools,
      maxOutputTokens: DOC_MAX_TOKENS,
      maxSteps: REPORT_MAX_STEPS,
    });
    if (pass.stream) {
      logger.trackStream(pass.stream, {
        clientId, agentId: null, agentName: "Intel Report",
        ...usageFor("intel.report.pass"), operation: "intel_report",
      });
    }

    if (pass.streamError || pass.timedOut) {
      lastPassError = pass.streamError ?? new Error(`report stream stalled — no output for ${REPORT_IDLE_TIMEOUT_MS}ms`);
      console.warn(
        `[intel] Report generation attempt ${attempt}/2 for ${client.name} failed${pass.timedOut ? " (stalled/timed out)" : " upstream"}:`,
        lastPassError,
      );
      continue;
    }
    if (pass.text.trim().length < MIN_REPORT_CHARS) {
      firstPassText = pass.text;
      // Instrument the stub: with no stream error, a short pass means the model
      // ended the turn early. Capture WHY (finish reason, warnings, steps, tool
      // usage, and the literal text) so the failure is self-diagnosing.
      const diag = pass.stream ? await describeStub(pass.stream, pass.text) : "(no stream)";
      lastPassError = new Error(`returned ${pass.text.trim().length} chars (min ${MIN_REPORT_CHARS}) — ${diag}`);
      console.warn(`[intel] Report generation attempt ${attempt}/2 for ${client.name}: ${String(lastPassError)}`);
      continue;
    }
    firstPassText = pass.text;
    passSucceeded = true;
  }

  // Live-data integrity gate: after one retry, a failed/stub first pass means the
  // generation failed upstream (auth, overload, tool errors). Fail loudly with the
  // captured root cause — never store an empty report as if it were a successful run.
  if (!passSucceeded) {
    const cause = lastPassError instanceof Error ? lastPassError.message : String(lastPassError ?? "unknown");
    throw new Error(
      `[intel] Report generation for ${client.name} failed after 2 attempts — aborting run (no partial/stub report will be stored). Upstream cause: ${cause}`,
      { cause: lastPassError },
    );
  }

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
    // Independently resolved rather than reusing `reportAi` above — same role,
    // same budgets, but its own call so this site is not hidden behind the
    // first pass's resolution (AU70/SCRUM-370).
    const continuationAi = aiFor("intel.report.pass", { budgets: reportPassBudgets });
    const cont = await runGuardedReportPass(continuationAi.model, {
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
      tools: continuationAi.tools,
      maxOutputTokens: DOC_MAX_TOKENS,
      maxSteps: REPORT_MAX_STEPS,
    });
    if (cont.stream) {
      logger.trackStream(cont.stream, {
        clientId, agentId: null, agentName: "Intel Report (continuation)",
        ...usageFor("intel.report.pass"), operation: "intel_report",
      });
    }
    // Non-fatal: the first pass already cleared the integrity gate. If the continuation
    // errored/timed out, log the real cause and keep the first pass rather than aborting.
    if (cont.streamError || cont.timedOut) {
      console.warn(
        `[intel] Continuation pass for ${client.name} failed${cont.timedOut ? " (timed out)" : " upstream"} (using first pass as-is):`,
        cont.streamError ?? "timeout",
      );
    } else {
      text = text + cont.text;
    }
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

  // Phase B: background pipelines — run after the report is safely stored so their
  // concurrent connections never compete with the main report generation.
  // The context-doc pipeline is now FATAL when it fails: those documents are the
  // ground truth every downstream agent consumes, so a run that silently skips
  // them must surface as failed (onboardingStatus: "failed"), not as "done".
  // Branding stays non-fatal — it is cosmetic relative to the intel outputs.
  //
  // SCRUM-274 (T-B19) — the cutover. This used to call the hardcoded
  // `runOnboardPipeline` (`./pipeline`, now deleted — D1/SCRUM-277 decision 5).
  // It now calls `runAgentOnboardingForClient`, which dispatches the real
  // `seo-geo-agent`/`intel-report-agent` through agent-engine, awaits both
  // deliverables, composes the 8 context documents, and writes them through
  // the same `replaceClientContextDocs` the old pipeline used — same
  // collection, same shape, gated by `assertContextDocSetShape` before the
  // write (see `agent-onboarding.ts`).
  //
  // `deliverableTimeoutMs` is deliberately raised above the library default
  // (15 min, `agent-onboarding.ts`'s own `deliverableTimeoutMs ?? 15 * 60_000`).
  // In the real, now-merged agent-engine, `seo-geo-agent`'s two human gates
  // auto-approve after 1 hour of no human response (T-A20/SCRUM-273 —
  // `timeout: { duration: "1h", onTimeout: "auto_approve" }` in
  // create-seo-geo-agent-workflow.ts, enforced by `runStepGate` in
  // step-gate.ts). Fifteen minutes is shorter than that hour, so wiring the
  // default as-is would fail an unattended run before the auto-approve ever
  // fires. `ONBOARDING_DELIVERABLE_TIMEOUT_MS` sits safely above the 1-hour
  // mark without being so generous it defeats "completes within the hour" —
  // see this ticket's report for the exact value chosen and why, and for the
  // real, unresolved cross-repo gap this does NOT close (intel-report-agent's
  // own gate has no such auto-approve, and a fresh onboarding client's first
  // run structurally can't reach the SEO/GEO gates gracefully either — see
  // the report's "intel-report-agent gate gap" and "T-A9/T-A10 grounding"
  // sections).
  const [onboardResult] = await Promise.allSettled([
    import("./agent-onboarding").then(({ runAgentOnboardingForClient }) =>
      runAgentOnboardingForClient(clientId, { deliverableTimeoutMs: ONBOARDING_DELIVERABLE_TIMEOUT_MS }),
    ),
    applyBrandingForClient(clientId, client)
      .then((r) => {
        console.info(`[intel] Branding refreshed for ${client.name} (${r.source}): ${r.primaryAccent ?? "no color"}`);
      })
      .catch((err: unknown) => {
        console.error("[intel] Branding generation failed (non-fatal):", err);
      }),
  ]);

  if (onboardResult.status === "rejected") {
    console.error("[intel] Context-doc pipeline failed:", onboardResult.reason);
    throw new Error(
      `Intel Report stored, but the context-document pipeline failed: ${onboardResult.reason instanceof Error ? onboardResult.reason.message : String(onboardResult.reason)}`,
      { cause: onboardResult.reason },
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
