/**
 * Google Search Console — Search Analytics read client. Server-only.
 *
 * Requires: the Search Console API enabled on the app's GCP project, the
 * `webmasters.readonly` scope (see OAUTH_CONFIGS.google_search_console in
 * oauth.ts), and — separately, per client — the connecting Google account
 * added as a user on that client's Search Console property (Settings → Users
 * and permissions), or the property verified under this app's account. The
 * scope alone does not grant access to a property Google hasn't associated
 * with the token.
 *
 * Real, live endpoint — UNVERIFIED against a real property (no test property
 * available in this environment); response shape follows Google's documented
 * Search Analytics API. Same "prepare for it, not shipping it blind" honesty
 * as analytics-providers.ts: verify against a real client property before
 * relying on this for client-facing numbers.
 */

import "server-only";
import { TokenExpiredError } from "@/lib/integrations/publishers";

export interface SearchConsoleRow {
  keys: string[]; // [query] or [query, page] depending on `dimensions`
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

export interface SearchConsoleQueryResult {
  rows: SearchConsoleRow[];
}

/**
 * Query Search Analytics for one property over a date range.
 * `dimensions` defaults to ["query"]; pass ["query", "page"] etc. as needed.
 * `siteUrl` must exactly match a verified property, e.g. "https://example.com/"
 * or "sc-domain:example.com".
 */
export async function fetchSearchConsoleAnalytics(
  accessToken: string,
  siteUrl: string,
  params: { startDate: string; endDate: string; dimensions?: string[]; rowLimit?: number },
): Promise<SearchConsoleQueryResult> {
  const res = await fetch(
    `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        startDate: params.startDate,
        endDate: params.endDate,
        dimensions: params.dimensions ?? ["query"],
        rowLimit: params.rowLimit ?? 25,
      }),
    },
  );
  if (res.status === 401 || res.status === 403) throw new TokenExpiredError("google_search_console", res.status);
  if (!res.ok) throw new Error(`Search Console query failed: ${res.status}`);
  const body = (await res.json()) as {
    rows?: Array<{ keys?: string[]; clicks?: number; impressions?: number; ctr?: number; position?: number }>;
  };
  return {
    rows: (body.rows ?? []).map((r) => ({
      keys: r.keys ?? [],
      clicks: r.clicks ?? 0,
      impressions: r.impressions ?? 0,
      ctr: r.ctr ?? 0,
      position: r.position ?? 0,
    })),
  };
}

/** List the properties this token can read — useful to validate `siteUrl` before querying. */
export async function listSearchConsoleSites(accessToken: string): Promise<string[]> {
  const res = await fetch("https://www.googleapis.com/webmasters/v3/sites", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (res.status === 401 || res.status === 403) throw new TokenExpiredError("google_search_console", res.status);
  if (!res.ok) throw new Error(`Search Console sites list failed: ${res.status}`);
  const body = (await res.json()) as { siteEntry?: Array<{ siteUrl?: string }> };
  return (body.siteEntry ?? []).map((s) => s.siteUrl).filter((u): u is string => !!u);
}
