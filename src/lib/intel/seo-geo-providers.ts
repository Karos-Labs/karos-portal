import "server-only";

import { streamText, stepCountIs } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { MODELS, SEO_GEO_CAPTURE } from "@/lib/constants";
import type { EngineAnswer, EngineId, ProviderSource } from "@/lib/seo-geo";
import { rootDomain } from "@/lib/seo-geo";
import { logger } from "@/services/logger";

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
/** Hard wall-clock cap per engine call. */
const CAPTURE_TIMEOUT_MS = 90_000;

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

async function askOpenAI(prompt: string, clientId: string): Promise<{ answerText: string; citations: string[] }> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY not configured");

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: SEO_GEO_CAPTURE.OPENAI_MODEL,
      messages: [{ role: "user", content: prompt }],
      max_completion_tokens: CAPTURE_MAX_TOKENS,
    }),
    signal: AbortSignal.timeout(CAPTURE_TIMEOUT_MS),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`OpenAI capture failed: HTTP ${res.status} ${body.slice(0, 300)}`);
  }
  const data = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  // Multi-model provenance: log OpenAI token usage against this client.
  logger.logUsage({
    clientId, agentId: null, agentName: "GEO Capture · ChatGPT",
    provider: "openai", modelName: SEO_GEO_CAPTURE.OPENAI_MODEL, operation: "geo_capture",
    inputTokens: data.usage?.prompt_tokens ?? 0,
    outputTokens: data.usage?.completion_tokens ?? 0,
  });
  const answerText = data.choices?.[0]?.message?.content ?? "";
  if (!answerText.trim()) throw new Error("OpenAI capture returned an empty answer");
  return { answerText, citations: domainsFromText(answerText) };
}

/* ── Gemini (engine: gemini, search-grounded) ─────────────────────── */

interface GeminiResponse {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }> };
    groundingMetadata?: {
      groundingChunks?: Array<{ web?: { uri?: string; title?: string } }>;
    };
  }>;
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
}

async function askGemini(prompt: string, clientId: string): Promise<{ answerText: string; citations: string[] }> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY not configured");

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${SEO_GEO_CAPTURE.GEMINI_MODEL}:generateContent`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        // Search grounding makes this a MEASURED_grounded surface (a3 capture tiers).
        tools: [{ google_search: {} }],
        generationConfig: { maxOutputTokens: CAPTURE_MAX_TOKENS },
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
    provider: "google", modelName: SEO_GEO_CAPTURE.GEMINI_MODEL, operation: "geo_capture",
    inputTokens: data.usageMetadata?.promptTokenCount ?? 0,
    outputTokens: data.usageMetadata?.candidatesTokenCount ?? 0,
  });
  const candidate = data.candidates?.[0];
  const answerText = (candidate?.content?.parts ?? [])
    .map((p) => p.text ?? "")
    .join("")
    .trim();
  if (!answerText) throw new Error("Gemini capture returned an empty answer");

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
  const stream = streamText({
    model: anthropic(MODELS.HAIKU),
    tools: { web_search: anthropic.tools.webSearch_20250305({ maxUses: 3 }) },
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
    modelName: MODELS.HAIKU, operation: "geo_capture",
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
