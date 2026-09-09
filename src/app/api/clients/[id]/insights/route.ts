import { after } from "next/server";
import { streamText } from "ai";

import { getCurrentUser, isStaff } from "@/lib/auth";
import {
  getClient,
  listAssets,
  listClientIntegrations,
  listClientMarketingAnalytics,
  getClientInsightsCache,
  upsertClientInsightsCache,
} from "@/lib/data";
import { canViewClient } from "@/lib/client-visibility";
import { engagementIsMockOrStale, rankByEngagement } from "@/lib/analytics";
import { integrationNeedsReconnect } from "@/lib/integration-status";
import { logger } from "@/services/logger";
import { CREDIT_COSTS } from "@/lib/credits";
import { chargeClientModelCall, refundOnce } from "@/lib/client-model-charge";
import { clientCategoryValue } from "@/lib/utils";
import type { Asset, ClientMarketingAnalytics } from "@/lib/types";
import { aiFor, usageFor } from "@/lib/ai/provider";

export const maxDuration = 30;

const MODEL = aiFor("insights.summary").model;
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
 * "Refresh" button passes `?force=1`.
 *
 * WHO PAYS, and the line this note used to get wrong. It said "no credit
 * charge, staff and client alike", and for the path it was describing that is
 * still true and deliberate: an automatic rerun is triggered by NEW DATA, not
 * by the client, and a client cannot manufacture analytics rows by clicking. So
 * the cache-miss path stays free.
 *
 * `?force=1` is not that path. It skips the cache read outright, so the Refresh
 * button was an unmetered model call a client could press as often as they
 * liked — the same shape as the four unmetered calls this cluster closed. It is
 * charged at `CREDIT_COSTS.chatMessage` (1), the existing rate for one
 * client-pressed model call, and refunded if the briefing never streams.
 *
 * POST, not GET (2026-08): this route can spend a client's credits
 * (`?force=1`), and a GET is exactly what a cross-site page can trigger
 * unattended — a top-level navigation or an auto-redirecting link fires an
 * authenticated GET from the signed-in visitor's own browser with no
 * confirmation. `<AiInsights/>`'s own fetch never relied on GET semantics (no
 * EventSource, just a streamed fetch), so there was nothing to preserve by
 * keeping it. SameSite=Lax cookies aren't sent on a cross-site POST, which is
 * what actually closes the gap.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user || user.disabled) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id: clientId } = await params;
  if (user.role === "CLIENT_USER" && user.clientId !== clientId) {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }

  const force = new URL(req.url).searchParams.get("force") === "1";

  // The charge for a FORCED refresh, defined once and taken at whichever of the
  // two streaming paths below actually reaches a model. Deliberately not taken
  // up here: every early return between this point and the streams — no
  // connected channel, no assets, an unchanged digest — is a path that runs no
  // model, and a client must not be charged for one.
  const insightsCharge = {
    user,
    clientId,
    amount: CREDIT_COSTS.chatMessage,
    operation: "ai_tool" as const,
    // Client copy: the ledger feed renders ungated to a CLIENT_USER.
    reason: "Insights refresh",
  };
  /**
   * Hand it back when the briefing never made it to the client. ONCE-ONLY, and
   * that is the whole point of the handle: `onError` below is called by the AI
   * SDK once per `error` part, not once per stream, so a run that emits two of
   * them called this twice — and `creditClientCredits` has no idempotency key,
   * so the client was paid twice for one charge. A no-op until the charge is
   * actually taken (unforced reruns are free — see the note above).
   */
  let refundForcedRerun: (reason: string) => Promise<void> = async () => {};
  /** Charge for the forced rerun; returns a 402 response when refused. */
  async function chargeForcedRerun(): Promise<Response | null> {
    if (!force) return null;
    const { denied, chargedAt } = await chargeClientModelCall(insightsCharge);
    if (denied !== null) return Response.json({ error: denied }, { status: 402 });
    refundForcedRerun = refundOnce(insightsCharge, chargedAt);
    return null;
  }

  const [client, records, assets, integrations, cached] = await Promise.all([
    getClient(clientId),
    listClientMarketingAnalytics(clientId),
    listAssets({ clientId }),
    listClientIntegrations(clientId),
    force ? Promise.resolve(null) : getClientInsightsCache(clientId),
  ]);
  if (!client) return Response.json({ error: "Client not found" }, { status: 404 });

  // STAFF SCOPE. The only role test at the top of this handler was the
  // CLIENT_USER branch, so an employee 404'd on /clients/[id] could read that
  // client's briefing — their engagement figures, their winners and losers, and
  // the report prose built from them — through this route. Same predicate the
  // pages ask, asked unconditionally rather than under `role ===
  // "KAROS_EMPLOYEE"`: admins and a client on their own account already pass it,
  // an unknown role must not. Refusal reuses the shape one line up.
  //
  // ABOVE THE CHARGE, and that is a fact about POSITION, not about this line's
  // text. `chargeForcedRerun()` — declared above, called at BOTH streaming paths
  // below — is the only place this handler spends the client's credits, and both
  // of its call sites are further down the same straight-line flow as this
  // statement: nothing between here and them can be entered without passing
  // here. A refused actor therefore cannot reach a charge. The test that holds
  // this asks it that way round — it spies on the charge and asserts the refused
  // actor never reached it — rather than asking whether a fence appears
  // somewhere before a charge in the source.
  if (!canViewClient(user, client)) {
    return Response.json({ error: "Client not found" }, { status: 404 });
  }

  // QA F125 (second half): metrics rows are written per published asset, so they can name a
  // platform the client never connected (an Instagram row on a Google/LinkedIn/YouTube
  // account). Scope the digest — and therefore the prompt — to channels the client actually
  // has, so the briefing can't recommend shifting budget on a channel they don't use.
  // QA F145: "a channel the client actually has" means CONNECTED, not "connected and
  // healthy". A dead token doesn't delete the channel — it stops refreshing it. Scoping to
  // usable integrations made a channel whose login expired vanish from the briefing without
  // a word, the same silent disappearance F145 fixes on the dashboard's channels card. Its
  // rows stay in the digest, flagged stale, so the briefing can say "LinkedIn data is stale —
  // reconnect" instead of quietly pretending the channel isn't there.
  const connectedPlatforms = new Set(integrations.map((i) => i.platform));
  const stalePlatforms = [
    ...new Set(integrations.filter((i) => integrationNeedsReconnect(i)).map((i) => i.platform)),
  ];
  const scopedRecords = records.filter((r) => connectedPlatforms.has(r.platform));

  // Data-honesty signal (QA Fix 8): engagement analytics fall back to deterministic
  // MOCK metrics for platforms with no live token. If EVERY record feeding the digest
  // is mock-sourced, the engagement briefing is narrating demo numbers — tell the client
  // via a response header so <AiInsights/> can badge (or suppress) it.
  // Computed on `scopedRecords`, NOT `records`: the briefing is built from the scoped set,
  // so judging provenance on the unscoped set would let live rows on a dropped platform
  // vouch for a briefing made entirely of mock rows (analytics/sync leaves real historical
  // rows behind when an integration expires).
  // QA F145 verifier bounce: readmitting expired platforms above means their
  // leftover LIVE rows re-enter scopedRecords, and analytics/sync stops writing
  // on a 401/403 — so those rows persist indefinitely and one of them would flip
  // this gate false, releasing a full unbadged briefing over otherwise-mock
  // figures (F125's blocker symptom, narrowed but reachable). A stale channel's
  // history is real but frozen, so it cannot vouch for freshness either:
  // `every(r => r.source === "mock" || staleSet.has(r.platform))`.
  const engagementIsMock = engagementIsMockOrStale(scopedRecords, stalePlatforms);
  const dataSourceHeaders = engagementIsMock ? { "X-Insights-Data-Source": "mock" } : undefined;

  /**
   * THE GATE ABOVE IS ALL-OR-NOTHING, AND THE DIGEST NEEDS PER-ROW (2026-08).
   *
   * `engagementIsMockOrStale` asks `every(...)`, so it only fires when NOTHING
   * is real. A client with one live Instagram row and twelve mock ones failed
   * it: no badge, no `needs-connection`, and `buildDigest` then averaged the
   * invented scores together with the measured one into `thisWeekAvgScore`,
   * `deltaPct`, `perPlatform`, `topPerformers` and `bottomPerformers` — all of
   * it interpolated into the prompt under "PERFORMANCE DATA (measured; do not
   * invent beyond this)".
   *
   * The all-or-nothing gate is still right for the BADGE (it answers "is this
   * whole panel demo data?"). The digest is built from live rows only, so a
   * mixed set can no longer average a fabrication into a real number.
   *
   * Mock rows still exist in Firestore — the sync cron stopped writing them in
   * 2026-08 (analytics-providers.ts), but everything written before that is
   * still there — which is why this filter is a permanent fixture and not a
   * migration step.
   */
  const measuredRecords = scopedRecords.filter((r) => r.source === "live");

  // QA F125: a "Demo data" badge does not offset paragraphs of specific, numbered budget
  // advice derived from invented figures. When every engagement row is mock, a client (or
  // staff viewing as one) gets the empty state + connect link instead of a briefing — no
  // model call at all. Staff keep the demo prose behind the badge so the panel stays
  // testable internally.
  if (engagementIsMock && !isStaff(user)) {
    return new Response(
      "Connect a social account and we'll brief you weekly on what's working.",
      {
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          "X-Insights-State": "needs-connection",
        },
      },
    );
  }

  const digest = buildDigest(measuredRecords, assets, stalePlatforms);

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
    if (cached && cached.digestKey === digestKey && cached.text.trim() !== "") {
      return cachedResponse(cached.text);
    }

    const pipelineSystem =
      "You are Karos AI, an Elite CMO analyst. Write a short, honest status update about a client's CONTENT PIPELINE — " +
      "no engagement data exists yet, so do NOT invent performance numbers or claim anything about how content is performing. " +
      "Use plain language. Format as 1-2 short sections with bold mini-headers and tight bullets. Cover: (1) what's been " +
      "produced so far and what stage it's in, (2) that once content publishes and gathers engagement, this panel will " +
      "start surfacing real performance and optimization moves. Keep the whole thing under 120 words.";

    const pipelineCategory = clientCategoryValue(client);
    const pipelinePrompt = `Client: ${client.name}${pipelineCategory ? ` (${pipelineCategory})` : ""}

CONTENT PIPELINE DATA (measured; do not invent beyond this):
${JSON.stringify(activity, null, 2)}

Write the update now.`;

    const refused = await chargeForcedRerun();
    if (refused) return refused;

    const pipelineResult = streamText({
      model: MODEL,
      system: pipelineSystem,
      prompt: pipelinePrompt,
      onError: ({ error }) => {
        console.error("[ai-insights] Pipeline stream failed:", error);
        void refundForcedRerun("Refund · insights refresh failed");
      },
      onFinish: ({ text, usage }) => {
        after(async () => {
          try {
            if (isCacheable(text)) {
              await upsertClientInsightsCache(clientId, { digestKey, text, generatedAt: Date.now() });
            }
            await logger.logUsage({
              clientId,
              agentId: null,
              agentName: "ai_insights",
              ...usageFor("insights.summary"),
              operation: "ai_insights_pipeline_summary",
              inputTokens: usage.inputTokens ?? 0,
              outputTokens: usage.outputTokens ?? 0,
            });
          } catch (e) {
            console.error("[ai-insights] Post-response cache/usage-log write failed:", e);
          }
        });
      },
    });

    return pipelineResult.toTextStreamResponse();
  }

  const digestKey = JSON.stringify(digest);
  if (cached && cached.digestKey === digestKey && cached.text.trim() !== "") {
    return cachedResponse(cached.text, dataSourceHeaders);
  }

  const system =
    "You are Karos AI, an Elite CMO analyst. Write a concise, scannable performance briefing for a busy client. " +
    "Use plain language (no jargon, no fabricated numbers — only the figures provided). " +
    "Only reference channels that appear in the data below; never name, compare against, or recommend " +
    "spending on a platform that is not listed — the client is not on it. " +
    "Any channel named in staleChannels has a disconnected login: its numbers stopped updating and are " +
    "not current. Say plainly that its data is stale and the channel needs reconnecting, and do not base " +
    "any recommendation on its figures. " +
    "Format as 2–3 short sections with bold mini-headers and tight bullets. Cover: (1) week-over-week movement, " +
    "(2) what's winning and why, (3) the optimization choices the engine is making next (double down on winners, phase out losers). " +
    "Keep the whole thing under 160 words.";

  const category = clientCategoryValue(client);
  const prompt = `Client: ${client.name}${category ? ` (${category})` : ""}

PERFORMANCE DATA (measured; do not invent beyond this):
${JSON.stringify(digest, null, 2)}

Write the briefing now.`;

  const refused = await chargeForcedRerun();
  if (refused) return refused;

  const result = streamText({
    model: MODEL,
    system,
    prompt,
    onError: ({ error }) => {
      console.error("[ai-insights] Briefing stream failed:", error);
      void refundForcedRerun("Refund · insights refresh failed");
    },
    onFinish: ({ text, usage }) => {
      after(async () => {
        try {
          if (isCacheable(text)) {
            await upsertClientInsightsCache(clientId, { digestKey, text, generatedAt: Date.now() });
          }
          await logger.logUsage({
            clientId,
            agentId: null,
            agentName: "ai_insights",
            ...usageFor("insights.summary"),
            operation: "ai_insights_summary",
            inputTokens: usage.inputTokens ?? 0,
            outputTokens: usage.outputTokens ?? 0,
          });
        } catch (e) {
          console.error("[ai-insights] Post-response cache/usage-log write failed:", e);
        }
      });
    },
  });

  return result.toTextStreamResponse({ headers: dataSourceHeaders });
}

/**
 * A generation that fails mid-stream finishes with empty text (the SDK masks the
 * error into the stream, so the response is still a 200 with an empty body).
 * Caching that would pin a blank card in place for every later load with the
 * same digest — a poisoned cache no page load can clear. Never store one; the
 * next load simply regenerates.
 */
function isCacheable(text: string): boolean {
  if (text.trim() !== "") return true;
  console.error("[ai-insights] Generation produced no text — not caching");
  return false;
}

/** A cache hit is already fully generated — return it in one shot (still plain
 * text, so <AiInsights/>'s stream reader consumes it identically either way). */
function cachedResponse(text: string, extraHeaders?: Record<string, string>): Response {
  return new Response(text, {
    headers: { "Content-Type": "text/plain; charset=utf-8", ...extraHeaders },
  });
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
  /** Connected channels whose login has expired — their rows are real but no
   *  longer refreshing (QA F145). Named in the prompt so the briefing reports
   *  the staleness instead of the channel silently going missing. */
  staleChannels: string[];
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
  staleChannels: string[] = [],
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
  /**
   * BOTH cohorts have to be non-empty, not just the denominator (2026-08).
   *
   * `avg([])` returns 0, and the guard only asked `lastWeekAvg > 0` — so a
   * client who published nothing in the last seven days while having
   * prior-week rows got `thisWeekAvg = 0` divided into a real baseline and a
   * **-100%** handed to the model under the header "PERFORMANCE DATA (measured;
   * do not invent beyond this)", with the system prompt asking for a
   * week-over-week section. The briefing then told them engagement had
   * collapsed, when the truth was that nothing shipped — a different fact, with
   * a different fix, and the `sampleSize === 0` escape hatch never fires here
   * because sampleSize counts ALL records rather than this week's.
   *
   * An empty week has no average to compare, so there is no delta. null is the
   * shape the prompt already handles.
   */
  const deltaPct =
    thisWeek.length > 0 && lastWeek.length > 0 && lastWeekAvg > 0
      ? Math.round(((thisWeekAvg - lastWeekAvg) / lastWeekAvg) * 1000) / 10
      : null;

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
    staleChannels,
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
