/**
 * Google Business Profile (GBP) — read client. Server-only.
 *
 * UNLIKE Search Console / Analytics, the scope alone is not enough here:
 * Google gates the Business Profile APIs (Business Information API,
 * Performance API) behind a manual "Business Profile API access request"
 * form (https://developers.google.com/my-business/content/prereqs) — every
 * call 403s with PERMISSION_DENIED until Google approves that request for
 * this GCP project, which can take days to weeks and asks for a description
 * of the use case. This client is written against the documented API shape
 * but is INERT (untested against a live, approved project) until that
 * approval lands — treat `GBPAccessNotGrantedError` as the expected state
 * until then, not a bug.
 */

import "server-only";
import { TokenExpiredError } from "@/lib/integrations/publishers";

/** Thrown on 403 PERMISSION_DENIED — distinct from an expired token: the fix
 *  is Google approving the access-request form, not reconnecting the account. */
export class GBPAccessNotGrantedError extends Error {
  constructor() {
    super(
      "Google Business Profile API access has not been granted for this project yet — " +
        "submit the access request at https://developers.google.com/my-business/content/prereqs",
    );
    this.name = "GBPAccessNotGrantedError";
  }
}

export interface GBPLocationMetrics {
  locationId: string;
  callClicks: number;
  websiteClicks: number;
  directionRequests: number;
  views: number;
}

/** List the locations this token can read (accounts.locations.list). */
export async function listBusinessProfileLocations(
  accessToken: string,
  accountId: string,
): Promise<string[]> {
  const res = await fetch(
    `https://mybusinessbusinessinformation.googleapis.com/v1/accounts/${encodeURIComponent(accountId)}/locations?readMask=name,title`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
  if (res.status === 401) throw new TokenExpiredError("google_business_profile", res.status);
  if (res.status === 403) throw new GBPAccessNotGrantedError();
  if (!res.ok) throw new Error(`Business Profile locations list failed: ${res.status}`);
  const body = (await res.json()) as { locations?: Array<{ name?: string }> };
  return (body.locations ?? []).map((l) => l.name).filter((n): n is string => !!n);
}

/** Fetch aggregate performance metrics for one location over a date range. */
export async function fetchBusinessProfileMetrics(
  accessToken: string,
  locationId: string,
  params: { startDate: string; endDate: string },
): Promise<GBPLocationMetrics> {
  const metrics = ["CALL_CLICKS", "WEBSITE_CLICKS", "BUSINESS_DIRECTION_REQUESTS", "BUSINESS_IMPRESSIONS_DESKTOP_MAPS"];
  const url = new URL(
    `https://businessprofileperformance.googleapis.com/v1/${encodeURIComponent(locationId)}:fetchMultiDailyMetricsTimeSeries`,
  );
  for (const m of metrics) url.searchParams.append("dailyMetrics", m);
  const setDateParams = (prefix: string, isoDate: string) => {
    const [year, month, day] = isoDate.split("-");
    url.searchParams.set(`${prefix}.year`, String(Number(year)));
    url.searchParams.set(`${prefix}.month`, String(Number(month)));
    url.searchParams.set(`${prefix}.day`, String(Number(day)));
  };
  setDateParams("dailyRange.start_date", params.startDate);
  setDateParams("dailyRange.end_date", params.endDate);

  const res = await fetch(url.toString(), { headers: { Authorization: `Bearer ${accessToken}` } });
  if (res.status === 401) throw new TokenExpiredError("google_business_profile", res.status);
  if (res.status === 403) throw new GBPAccessNotGrantedError();
  if (!res.ok) throw new Error(`Business Profile metrics fetch failed: ${res.status}`);

  const body = (await res.json()) as {
    multiDailyMetricTimeSeries?: Array<{
      dailyMetricTimeSeries?: Array<{
        dailyMetric?: string;
        timeSeries?: { datedValues?: Array<{ value?: string }> };
      }>;
    }>;
  };
  const series = body.multiDailyMetricTimeSeries?.[0]?.dailyMetricTimeSeries ?? [];
  const sum = (metric: string) =>
    series
      .find((s) => s.dailyMetric === metric)
      ?.timeSeries?.datedValues?.reduce((acc, v) => acc + Number(v.value ?? 0), 0) ?? 0;

  return {
    locationId,
    callClicks: sum("CALL_CLICKS"),
    websiteClicks: sum("WEBSITE_CLICKS"),
    directionRequests: sum("BUSINESS_DIRECTION_REQUESTS"),
    views: sum("BUSINESS_IMPRESSIONS_DESKTOP_MAPS"),
  };
}
