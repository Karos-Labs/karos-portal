import "server-only";

import { streamText, stepCountIs } from "ai";
import { SEO_GEO_CAPTURE } from "@/lib/constants";
import type { EngineAnswer, EngineId, ProviderSource } from "@/lib/seo-geo";
import { rootDomain } from "@/lib/seo-geo";
import { logger } from "@/services/logger";
import { aiFor, usageFor } from "@/lib/ai/provider";

/**
 * Multi-model answer-engine connectors for the GEO visibility capture.
 *
 * Every connector reads its credential strictly from the environment
 * (GCP Secret Manager injects these in production — never hardcode values):
 *   - OpenAI  → OPENAI_API_KEY   (answers for the "chatgpt" engine column)
 *   - Gemini  → GEMINI_API_KEY   (answers for the "gemini" engine column, search-grounded)
 *   - Claude  → ANTHROPIC_API_KEY (already wired platform-wide via @ai-sdk/anthropic)
 *
 * Resilience contract (mirrors runResearchAgent in pipeline.ts):
 *   - each probe validates output and retries once before being declared failed
 *   - a missing key or a dead engine degrades that engine to captureTier
 *     "UNAVAILABLE" — it never aborts the run; dataCoveragePct reflects the hole
 *   - per-call token caps + hard timeouts bound cost per run
 */

/** Per-answer output cap — capture answers are short; this bounds per-run cost. */
const CAPTURE_MAX_TOKENS = 1024;
/**
 * Gemini gets a larger cap: it's a thinking model whose reasoning (even at the
 * "low" floor, which can't be disabled) is drawn from the same output budget, so
 * 1024 truncates the answer to MAX_TOKENS. This leaves room for thinking + a full
 * grounded answer while staying bounded.
 */
const GEMINI_MAX_TOKENS = 2048;
/** Hard wall-clock cap per engine call. */
const CAPTURE_TIMEOUT_MS = 90_000;

// Capture model ids default to constants but can be overridden by env so a provider
// deprecation (e.g. "model no longer available to new users") is an ops config change,
// not a code redeploy. Empty/unset falls back to the pinned constant.
const OPENAI_MODEL = process.env.OPENAI_CAPTURE_MODEL || SEO_GEO_CAPTURE.OPENAI_MODEL;
const GEMINI_MODEL = process.env.GEMINI_CAPTURE_MODEL || SEO_GEO_CAPTURE.GEMINI_MODEL;

/** Extract unique registrable domains from URLs appearing in an answer text. */
function domainsFromText(text: string): string[] {
  const urls = text.match(/https?:\/\/[^\s)\]}"'<>]+/g) ?? [];
  const seen = new Set<string>();
  for (const u of urls) {
    const d = rootDomain(u);
    if (d) seen.add(d);
  }
  return [...seen];
}

/** One retry, matching the research-agent resilience pattern. */
async function withRetry<T>(name: string, fn: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      console.warn(`[seo-geo] ${name} capture attempt ${attempt}/2 failed:`, err);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/* ── OpenAI (engine: chatgpt) ─────────────────────────────────────── */

interface OpenAIResponsesResult {
  output?: Array<{
    type: string;
    content?: Array<{
      type: string;
      text?: string;
      annotations?: Array<{ type: string; url?: string; title?: string }>;
    }>;
  }>;
  usage?: { input_tokens?: number; output_tokens?: number };
}

async function askOpenAI(prompt: string, clientId: string): Promise<{ answerText: string; citations: string[] }> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY not configured");

  // The ChatGPT column must be MEASURED via a FORCED web_search on the Responses API.
  // A plain chat/completions call answers from parametric memory with ZERO citations
  // (a3 dev handoff, 2026-07-14) — the tool MUST be forced via tool_choice, and real
  // citations come back as url_citation annotations on the message output_text.
  const res = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      input: prompt,
      tools: [{ type: "web_search" }],
      tool_choice: { type: "web_search" },
      max_output_tokens: CAPTURE_MAX_TOKENS,
    }),
    signal: AbortSignal.timeout(CAPTURE_TIMEOUT_MS),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`OpenAI capture failed: HTTP ${res.status} ${body.slice(0, 300)}`);
  }
  const data = (await res.json()) as OpenAIResponsesResult;
  // Multi-model provenance: log OpenAI token usage against this client.
  logger.logUsage({
    clientId, agentId: null, agentName: "GEO Capture · ChatGPT",
    provider: "openai", modelName: OPENAI_MODEL, operation: "geo_capture",
    inputTokens: data.usage?.input_tokens ?? 0,
    outputTokens: data.usage?.output_tokens ?? 0,
  });

  let answerText = "";
  const cited = new Set<string>();
  for (const item of data.output ?? []) {
    if (item.type !== "message") continue;
    for (const part of item.content ?? []) {
      if (part.type !== "output_text") continue;
      answerText += part.text ?? "";
      for (const ann of part.annotations ?? []) {
        if (ann.type === "url_citation" && ann.url) {
          const d = rootDomain(ann.url); // strips the ?utm_source=openai tracking suffix
          if (d) cited.add(d);
        }
      }
    }
  }
  if (!answerText.trim()) throw new Error("OpenAI capture returned an empty answer");
  for (const d of domainsFromText(answerText)) cited.add(d);
  return { answerText, citations: [...cited] };
}

/* ── Gemini (engine: gemini, search-grounded) ─────────────────────── */

interface GeminiResponse {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }> };
    finishReason?: string;
    groundingMetadata?: {
      groundingChunks?: Array<{ web?: { uri?: string; title?: string } }>;
    };
  }>;
  promptFeedback?: { blockReason?: string };
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; totalTokenCount?: number };
}

async function askGemini(prompt: string, clientId: string): Promise<{ answerText: string; citations: string[] }> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY not configured");

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        // Search grounding makes this a MEASURED_grounded surface (a3 capture tiers).
        tools: [{ google_search: {} }],
        generationConfig: {
          // gemini-flash-latest now resolves to a Gemini 3.x flash model, and its
          // thinking budget can no longer be forced to 0 — `thinkingConfig.thinkingBudget:0`
          // hard-400s ("invalid argument") on gemini-3.6-flash / -latest, which silently
          // degraded EVERY Gemini cell to UNAVAILABLE (2026-07-22). Gemini 3 replaces the
          // numeric budget with `thinkingLevel`; "low" is the floor (thinking can't be
          // fully disabled) and is accepted across all live 3.x flash models. Left ON but
          // minimal, thinking still costs output tokens, so we give Gemini its own larger
          // cap (below) to keep the answer from truncating to MAX_TOKENS.
          maxOutputTokens: GEMINI_MAX_TOKENS,
          thinkingConfig: { thinkingLevel: "low" },
        },
      }),
      signal: AbortSignal.timeout(CAPTURE_TIMEOUT_MS),
    },
  );
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Gemini capture failed: HTTP ${res.status} ${body.slice(0, 300)}`);
  }
  const data = (await res.json()) as GeminiResponse;
  // Multi-model provenance: log Gemini token usage against this client.
  logger.logUsage({
    clientId, agentId: null, agentName: "GEO Capture · Gemini",
    provider: "google", modelName: GEMINI_MODEL, operation: "geo_capture",
    inputTokens: data.usageMetadata?.promptTokenCount ?? 0,
    outputTokens:
      data.usageMetadata?.candidatesTokenCount ??
      Math.max(0, (data.usageMetadata?.totalTokenCount ?? 0) - (data.usageMetadata?.promptTokenCount ?? 0)),
  });
  const candidate = data.candidates?.[0];
  const answerText = (candidate?.content?.parts ?? [])
    .map((p) => p.text ?? "")
    .join("")
    .trim();
  if (!answerText) {
    // Distinguish a real empty answer from a truncated/blocked one: a MAX_TOKENS
    // (grounding overhead ate the budget), SAFETY, or RECITATION finishReason — or a
    // prompt-level block — is a capture problem, not a genuine "engine had nothing to
    // say". Surface it so the UNAVAILABLE cell is diagnosable in logs rather than silent.
    const reason =
      data.promptFeedback?.blockReason
        ? `blocked: ${data.promptFeedback.blockReason}`
        : candidate?.finishReason
          ? `finishReason: ${candidate.finishReason}`
          : "no content returned";
    throw new Error(`Gemini capture returned an empty answer (${reason})`);
  }

  // Grounding chunks carry the real cited sources; title is usually the bare domain.
  const cited = new Set<string>(domainsFromText(answerText));
  for (const chunk of candidate?.groundingMetadata?.groundingChunks ?? []) {
    const d = rootDomain(chunk.web?.uri) ?? rootDomain(chunk.web?.title);
    if (d && !d.includes("vertexaisearch")) cited.add(d);
    else if (chunk.web?.title?.includes(".") && !chunk.web.title.includes(" ")) {
      // Grounding redirect URIs hide the origin; the title carries the domain.
      cited.add(chunk.web.title.toLowerCase().replace(/^www\./, ""));
    }
  }
  return { answerText, citations: [...cited] };
}

/* ── Claude (engine: claude, web_search) ──────────────────────────── */

async function askClaude(prompt: string, clientId: string): Promise<{ answerText: string; citations: string[] }> {
  // Capture uses the fast model (a3 rule: the report model is never used for raw capture).
  // Resolved through the shared role resolver, same as every other call site —
  // even though this role is vendor-pinned to anthropic (it measures the real
  // Claude product, see roles.ts), so model and tools still come from one
  // resolution rather than a hardcoded vendor call that could silently drift
  // from the pin. AU70/SCRUM-370.
  const claudeAi = aiFor("geo.capture.claude", { budgets: { web_search: { maxUses: 3 } } });
  const stream = streamText({
    model: claudeAi.model,
    tools: claudeAi.tools,
    // Continue past Anthropic pause_turn during web search (default stepCountIs(1)
    // would return only the pre-search intro).
    stopWhen: stepCountIs(8),
    messages: [{ role: "user", content: prompt }],
    maxOutputTokens: CAPTURE_MAX_TOKENS,
    abortSignal: AbortSignal.timeout(CAPTURE_TIMEOUT_MS),
  });
  const answerText = await stream.text;
  // web_search cost is captured too (this capture grants Claude live search).
  logger.trackStream(stream, {
    clientId, agentId: null, agentName: "GEO Capture · Claude",
    ...usageFor("geo.capture.claude"), operation: "geo_capture",
  });
  if (!answerText.trim()) throw new Error("Claude capture returned an empty answer");

  const cited = new Set<string>(domainsFromText(answerText));
  try {
    for (const s of await stream.sources) {
      if (s.sourceType === "url") {
        const d = rootDomain(s.url);
        if (d) cited.add(d);
      }
    }
  } catch {
    // Sources are best-effort; the answer text itself is the frozen record.
  }
  return { answerText, citations: [...cited] };
}

/* ── Unified probe surface ────────────────────────────────────────── */

const CONNECTORS: Partial<
  Record<EngineId, { source: ProviderSource; tier: "MEASURED" | "MEASURED_grounded"; ask: (p: string, clientId: string) => Promise<{ answerText: string; citations: string[] }>; configured: () => boolean }>
> = {
  chatgpt: { source: "OpenAI", tier: "MEASURED", ask: askOpenAI, configured: () => !!process.env.OPENAI_API_KEY },
  gemini: { source: "Gemini", tier: "MEASURED_grounded", ask: askGemini, configured: () => !!process.env.GEMINI_API_KEY },
  claude: { source: "Anthropic", tier: "MEASURED", ask: askClaude, configured: () => !!process.env.ANTHROPIC_API_KEY },
};

/** Engines that have a wired + configured connector for this deployment. */
export function configuredEngines(): EngineId[] {
  return (Object.keys(CONNECTORS) as EngineId[]).filter((e) => CONNECTORS[e]!.configured());
}

/**
 * Ask one engine one buyer-intent prompt. Never throws: a failed or unconfigured
 * engine returns an UNAVAILABLE cell (a3: "engine failed" is a measured absence
 * of data, not a run failure).
 */
export async function probeEngine(engine: EngineId, prompt: string, clientId: string): Promise<EngineAnswer> {
  const connector = CONNECTORS[engine];
  const source: ProviderSource = connector?.source ?? "Anthropic";
  if (!connector || !connector.configured()) {
    return { engine, source, prompt, answerText: "", citations: [], captureTier: "UNAVAILABLE" };
  }
  try {
    const { answerText, citations } = await withRetry(`${engine}(${connector.source})`, () =>
      connector.ask(prompt, clientId),
    );
    return { engine, source, prompt, answerText, citations, captureTier: connector.tier };
  } catch (err) {
    console.error(`[seo-geo] ${engine} capture unavailable after retry:`, err);
    return { engine, source, prompt, answerText: "", citations: [], captureTier: "UNAVAILABLE" };
  }
}
