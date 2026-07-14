import { after } from "next/server";
import { streamText } from "ai";
import { anthropic } from "@ai-sdk/anthropic";

import { getCurrentUser } from "@/lib/auth";
import { getClient, listAssets, listClientMarketingAnalytics } from "@/lib/data";
import { rankByEngagement } from "@/lib/analytics";
import { logger } from "@/services/logger";
import { MODELS } from "@/lib/constants";
import type { ClientMarketingAnalytics } from "@/lib/types";

export const maxDuration = 30;

const MODEL = anthropic(MODELS.HAIKU);
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * AI Insights — the human-readable window into the Self-Improving Marketing
 * Loop. Reads the metrics the sync cron persisted, computes a week-over-week
 * digest (this week's published-content cohort vs last week's), and streams a
 * short, scannable plain-language summary + the optimization choices the engine
 * is making off the back of it. Consumed by <AiInsights/> on the client
 * dashboard's Performance section.
 *
 * Read-only and cheap (Haiku) — no credit charge, staff and client alike.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user || user.disabled) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id: clientId } = await params;
  if (user.role === "CLIENT_USER" && user.clientId !== clientId) {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }

  const [client, records, assets] = await Promise.all([
    getClient(clientId),
    listClientMarketingAnalytics(clientId),
    listAssets({ clientId }),
  ]);
  if (!client) return Response.json({ error: "Client not found" }, { status: 404 });

  const digest = buildDigest(records, assets);

  // Nothing measured yet — answer instantly without spending a model call.
  if (digest.sampleSize === 0) {
    return new Response(
      "No performance data has been captured yet. Once your published content is synced, this panel will summarize week-over-week engagement and the optimization moves Karos is making.",
      { headers: { "Content-Type": "text/plain; charset=utf-8" } },
    );
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
    onFinish: ({ usage }) =>
      after(() =>
        logger.logUsage({
          clientId,
          agentId: null,
          agentName: "ai_insights",
          modelName: MODELS.HAIKU,
          operation: "ai_insights_summary",
          inputTokens: usage.inputTokens ?? 0,
          outputTokens: usage.outputTokens ?? 0,
        }),
      ),
  });

  return result.toTextStreamResponse();
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
