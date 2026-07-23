/**
 * Google Analytics (GA4 Data API) — read client. Server-only.
 *
 * Requires: the Analytics Data API enabled on the app's GCP project, the
 * `analytics.readonly` scope (see OAUTH_CONFIGS.google_analytics in
 * oauth.ts), and — separately, per client — this Google account granted at
 * least Viewer access on the client's GA4 property (Admin → Property Access
 * Management). The scope alone does not grant access to a property Google
 * hasn't associated with the token.
 *
 * Real, live endpoint — UNVERIFIED against a real property (no test property
 * available in this environment); response shape follows Google's documented
 * GA4 Data API `runReport`. Verify against a real client property before
 * relying on this for client-facing numbers.
 */

import "server-only";
import { TokenExpiredError } from "@/lib/integrations/publishers";

export interface GA4ReportRow {
  dimensionValues: string[];
  metricValues: number[];
}

export interface GA4ReportResult {
  dimensionHeaders: string[];
  metricHeaders: string[];
  rows: GA4ReportRow[];
}

/**
 * Run a GA4 report. `propertyId` is the numeric-only id (e.g. "123456789"),
 * NOT the "properties/123456789" resource name — this function builds that
 * path for you.
 */
export async function fetchGA4Report(
  accessToken: string,
  propertyId: string,
  params: {
    startDate: string;
    endDate: string;
    dimensions?: string[]; // e.g. ["sessionDefaultChannelGroup"]
    metrics?: string[]; // e.g. ["sessions", "conversions"]
  },
): Promise<GA4ReportResult> {
  const cleanPropertyId = propertyId.replace(/^properties\//, "");
  const res = await fetch(
    `https://analyticsdata.googleapis.com/v1beta/properties/${encodeURIComponent(cleanPropertyId)}:runReport`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        dateRanges: [{ startDate: params.startDate, endDate: params.endDate }],
        dimensions: (params.dimensions ?? []).map((name) => ({ name })),
        metrics: (params.metrics ?? ["sessions", "conversions"]).map((name) => ({ name })),
      }),
    },
  );
  if (res.status === 401 || res.status === 403) throw new TokenExpiredError("google_analytics", res.status);
  if (!res.ok) throw new Error(`GA4 runReport failed: ${res.status}`);
  const body = (await res.json()) as {
    dimensionHeaders?: Array<{ name?: string }>;
    metricHeaders?: Array<{ name?: string }>;
    rows?: Array<{
      dimensionValues?: Array<{ value?: string }>;
      metricValues?: Array<{ value?: string }>;
    }>;
  };
  return {
    dimensionHeaders: (body.dimensionHeaders ?? []).map((h) => h.name ?? ""),
    metricHeaders: (body.metricHeaders ?? []).map((h) => h.name ?? ""),
    rows: (body.rows ?? []).map((r) => ({
      dimensionValues: (r.dimensionValues ?? []).map((v) => v.value ?? ""),
      metricValues: (r.metricValues ?? []).map((v) => Number(v.value ?? 0)),
    })),
  };
}

/**
 * AI-referral traffic specifically — the recurring "who's sending us AI-answer
 * traffic" question the SEO/GEO vertical wants. Filters sessionSource against
 * known AI-referrer hostnames; GA4 has no first-class "AI referral" dimension,
 * so this is a best-effort classification, not a platform-native metric.
 */
const AI_REFERRER_SOURCES = ["chat.openai.com", "chatgpt.com", "gemini.google.com", "perplexity.ai", "copilot.microsoft.com"];

export async function fetchAIReferralTraffic(
  accessToken: string,
  propertyId: string,
  params: { startDate: string; endDate: string },
): Promise<GA4ReportResult> {
  const full = await fetchGA4Report(accessToken, propertyId, {
    ...params,
    dimensions: ["sessionSource"],
    metrics: ["sessions", "conversions"],
  });
  return {
    ...full,
    rows: full.rows.filter((r) => AI_REFERRER_SOURCES.some((src) => r.dimensionValues[0]?.includes(src))),
  };
}
