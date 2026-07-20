import { after } from "next/server";
import { streamText } from "ai";
import { anthropic } from "@ai-sdk/anthropic";

import { getCurrentUser } from "@/lib/auth";
import {
  getClient,
  listAssets,
  listClientMarketingAnalytics,
  getClientInsightsCache,
  upsertClientInsightsCache,
} from "@/lib/data";
import { rankByEngagement } from "@/lib/analytics";
import { logger } from "@/services/logger";
import { MODELS } from "@/lib/constants";
import type { Asset, ClientMarketingAnalytics } from "@/lib/types";

export const maxDuration = 30;

const MODEL = anthropic(MODELS.HAIKU);
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * AI Insights — the human-readable window into the Self-Improving Marketing
 * Loop. Reads the metrics the sync cron persisted, computes a week-over-week
 * digest (this week's published-content cohort vs last week's), and streams a
 * short, scannable plain-language summary + the optimization choices the engine
 * is making off the back of it. Consumed by <AiInsights/> on the client
 * dashboard.
 *
 * Cached by digest content (not time): a plain page load reuses the last
 * briefing unless the underlying digest actually changed since — the LLM only
 * reruns when there's something new to report, or when the widget's explicit
 * "Refresh" button passes `?force=1`. Read-only and cheap (Haiku) — no credit
 * charge, staff and client alike.
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user || user.disabled) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id: clientId } = await params;
  if (user.role === "CLIENT_USER" && user.clientId !== clientId) {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }

  const force = new URL(req.url).searchParams.get("force") === "1";

  const [client, records, assets, cached] = await Promise.all([
    getClient(clientId),
    listClientMarketingAnalytics(clientId),
    listAssets({ clientId }),
    force ? Promise.resolve(null) : getClientInsightsCache(clientId),
  ]);
  if (!client) return Response.json({ error: "Client not found" }, { status: 404 });

  const digest = buildDigest(records, assets);

  // No measured engagement yet — the sync cron hasn't captured any published-content
  // metrics for this client (no connected socials yet, nothing published yet, or the
  // cron simply hasn't run). Rather than a flat "no data" line, summarize the real
  // content pipeline: assets DO exist once agents have run, even before anything's
  // measured. Only the truly-empty case (zero assets, ever) skips the model call.
  if (digest.sampleSize === 0) {
    const activity = buildActivityDigest(assets);
    if (activity.totalAssets === 0) {
      return new Response(
        "No content has been created yet. Once Karos starts generating content for this account, this panel will summarize week-over-week performance and the optimization moves the engine is making.",
        { headers: { "Content-Type": "text/plain; charset=utf-8" } },
      );
    }

    const digestKey = JSON.stringify(activity);
    if (cached && cached.digestKey === digestKey) {
      return cachedResponse(cached.text);
    }

    const pipelineSystem =
      "You are Karos AI, an Elite CMO analyst. Write a short, honest status update about a client's CONTENT PIPELINE — " +
      "no engagement data exists yet, so do NOT invent performance numbers or claim anything about how content is performing. " +
      "Use plain language. Format as 1-2 short sections with bold mini-headers and tight bullets. Cover: (1) what's been " +
      "produced so far and what stage it's in, (2) that once content publishes and gathers engagement, this panel will " +
      "start surfacing real performance and optimization moves. Keep the whole thing under 120 words.";

    const pipelinePrompt = `Client: ${client.name}${client.industry ? ` (${client.industry})` : ""}

CONTENT PIPELINE DATA (measured; do not invent beyond this):
${JSON.stringify(activity, null, 2)}

Write the update now.`;

    const pipelineResult = streamText({
      model: MODEL,
      system: pipelineSystem,
      prompt: pipelinePrompt,
      onFinish: ({ text, usage }) => {
        after(async () => {
          await upsertClientInsightsCache(clientId, { digestKey, text, generatedAt: Date.now() });
          await logger.logUsage({
            clientId,
            agentId: null,
            agentName: "ai_insights",
            modelName: MODELS.HAIKU,
            operation: "ai_insights_pipeline_summary",
            inputTokens: usage.inputTokens ?? 0,
            outputTokens: usage.outputTokens ?? 0,
          });
        });
      },
    });

    return pipelineResult.toTextStreamResponse();
  }

  const digestKey = JSON.stringify(digest);
  if (cached && cached.digestKey === digestKey) {
    return cachedResponse(cached.text);
  }

  const system =
    "You are Karos AI, an Elite CMO analyst. Write a concise, scannable performance briefing for a busy client. " +
    "Use plain language (no jargon, no fabricated numbers — only the figures provided). " +
    "Format as 2–3 short sections with bold mini-headers and tight bullets. Cover: (1) week-over-week movement, " +
    "(2) what's winning and why, (3) the optimization choices the engine is making next (double down on winners, phase out losers). " +
    "Keep the whole thing under 160 words.";

  const prompt = `Client: ${client.name}${client.industry ? ` (${client.industry})` : ""}

PERFORMANCE DATA (measured; do not invent beyond this):
${JSON.stringify(digest, null, 2)}

Write the briefing now.`;

  const result = streamText({
    model: MODEL,
    system,
    prompt,
    onFinish: ({ text, usage }) => {
      after(async () => {
        await upsertClientInsightsCache(clientId, { digestKey, text, generatedAt: Date.now() });
        await logger.logUsage({
          clientId,
          agentId: null,
          agentName: "ai_insights",
          modelName: MODELS.HAIKU,
          operation: "ai_insights_summary",
          inputTokens: usage.inputTokens ?? 0,
          outputTokens: usage.outputTokens ?? 0,
        });
      });
    },
  });

  return result.toTextStreamResponse();
}

/** A cache hit is already fully generated — return it in one shot (still plain
 * text, so <AiInsights/>'s stream reader consumes it identically either way). */
function cachedResponse(text: string): Response {
  return new Response(text, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
}

/* ── Activity digest (fallback before anything's measured) ───────────── */

type ActivityDigest = {
  totalAssets: number;
  createdThisWeek: number;
  createdLastWeek: number;
  byStatus: Record<string, number>;
  byType: Array<{ type: string; count: number }>;
  mostRecentTitles: string[];
};

/**
 * Pure content-pipeline summary built directly from assets — no analytics rows
 * required. Used when the sync cron hasn't captured any engagement data yet
 * (nothing published, nothing connected, or it simply hasn't run), so the panel
 * still shows something real instead of a static placeholder.
 */
function buildActivityDigest(assets: Asset[]): ActivityDigest {
  const now = Date.now();
  const byStatus: Record<string, number> = {};
  const typeCounts = new Map<string, number>();
  let createdThisWeek = 0;
  let createdLastWeek = 0;

  for (const a of assets) {
    byStatus[a.status] = (byStatus[a.status] ?? 0) + 1;
    typeCounts.set(a.type, (typeCounts.get(a.type) ?? 0) + 1);
    const age = now - a.createdAt;
    if (age < WEEK_MS) createdThisWeek++;
    else if (age < 2 * WEEK_MS) createdLastWeek++;
  }

  const byType = [...typeCounts.entries()]
    .map(([type, count]) => ({ type, count }))
    .sort((a, b) => b.count - a.count);

  const mostRecentTitles = [...assets]
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, 3)
    .map((a) => a.title);

  return { totalAssets: assets.length, createdThisWeek, createdLastWeek, byStatus, byType, mostRecentTitles };
}

/* ── Digest builder ──────────────────────────────────────────────────── */

type Digest = {
  sampleSize: number;
  weekOverWeek: {
    thisWeekAvgScore: number;
    lastWeekAvgScore: number;
    deltaPct: number | null;
    thisWeekCount: number;
    lastWeekCount: number;
  };
  perPlatform: Array<{ platform: string; avgScore: number; count: number }>;
  topPerformers: Array<{ label: string; platform: string; score: number; engagementRatePct: number }>;
  bottomPerformers: Array<{ label: string; platform: string; score: number; engagementRatePct: number }>;
};

function avg(nums: number[]): number {
  if (nums.length === 0) return 0;
  return Math.round((nums.reduce((s, n) => s + n, 0) / nums.length) * 10) / 10;
}

/**
 * Turn the raw analytics rows into a compact, model-ready digest. Week-over-week
 * compares cohorts of content by the asset's `publishedAt` (this week vs the
 * prior week), since metrics rows are living snapshots (upserted in place), not a
 * per-asset time series.
 */
function buildDigest(
  records: ClientMarketingAnalytics[],
  assets: Array<{ id: string; publishedAt?: number }>,
): Digest {
  const publishedAtById = new Map(assets.map((a) => [a.id, a.publishedAt]));
  const now = Date.now();

  const thisWeek: number[] = [];
  const lastWeek: number[] = [];
  for (const r of records) {
    const publishedAt = publishedAtById.get(r.assetId);
    if (publishedAt == null) continue;
    const age = now - publishedAt;
    if (age < WEEK_MS) thisWeek.push(r.engagementScore);
    else if (age < 2 * WEEK_MS) lastWeek.push(r.engagementScore);
  }
  const thisWeekAvg = avg(thisWeek);
  const lastWeekAvg = avg(lastWeek);
  const deltaPct =
    lastWeekAvg > 0 ? Math.round(((thisWeekAvg - lastWeekAvg) / lastWeekAvg) * 1000) / 10 : null;

  const platformScores = new Map<string, number[]>();
  for (const r of records) {
    const arr = platformScores.get(r.platform) ?? [];
    arr.push(r.engagementScore);
    platformScores.set(r.platform, arr);
  }
  const perPlatform = [...platformScores.entries()]
    .map(([platform, scores]) => ({ platform, avgScore: avg(scores), count: scores.length }))
    .sort((a, b) => b.avgScore - a.avgScore);

  const { top, bottom } = rankByEngagement(records, 3);
  const flat = (r: ClientMarketingAnalytics) => ({
    label: r.assetLabel ?? r.assetId,
    platform: r.platform,
    score: r.engagementScore,
    engagementRatePct: Math.round(r.metrics.engagementRate * 1000) / 10,
  });

  return {
    sampleSize: records.length,
    weekOverWeek: {
      thisWeekAvgScore: thisWeekAvg,
      lastWeekAvgScore: lastWeekAvg,
      deltaPct,
      thisWeekCount: thisWeek.length,
      lastWeekCount: lastWeek.length,
    },
    perPlatform,
    topPerformers: top.map(flat),
    bottomPerformers: bottom.map(flat),
  };
}
