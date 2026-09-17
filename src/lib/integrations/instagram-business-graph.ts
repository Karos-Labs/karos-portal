/**
 * "Instagram API with Instagram Login" — reads on the CLIENT'S OWN
 * `instagram_business` token (see oauth.ts), against `graph.instagram.com`
 * (NOT `graph.facebook.com` — see meta-graph.ts's note on why these are two
 * separate hosts). Distinct from both `instagram-insights.ts` (Karos Labs'
 * own System User token, `graph.facebook.com`) and `analytics-providers.ts`'s
 * `fetchInstagramAudience`/`fetchInstagramComments` (the "instagram" card's
 * Facebook-Login token, also `graph.facebook.com`) — three different tokens
 * against two different hosts, all under the "Instagram" name.
 *
 * Server-only, same shape as those: the token stays inside this module, the
 * caller passes it and gets back plain data.
 */

import "server-only";
import { TokenExpiredError } from "@/lib/integrations/publishers";
import { metaInstagramGraphUrl } from "@/lib/integrations/meta-graph";

interface GraphErrorBody {
  error?: { message?: string; code?: number };
}

async function assertGraphOk(res: Response): Promise<void> {
  if (res.ok) return;
  if (res.status === 401 || res.status === 403) throw new TokenExpiredError("instagram_business", res.status);
  let body: GraphErrorBody = {};
  try {
    body = (await res.json()) as GraphErrorBody;
  } catch {
    // no JSON body — fall through with the raw status
  }
  throw new Error(`Instagram Business API request failed: ${body.error?.message ?? res.status}`);
}

export interface InstagramBusinessProfile {
  id: string;
  username: string;
  accountType: string | null;
  mediaCount: number | null;
}

/** `instagram_business_basic`: the logged-in account's own profile. `/me` — no id lookup needed, unlike the Facebook-login host. */
export async function fetchInstagramBusinessProfile(accessToken: string): Promise<InstagramBusinessProfile> {
  const res = await fetch(
    metaInstagramGraphUrl(`me?fields=id,username,account_type,media_count&access_token=${encodeURIComponent(accessToken)}`),
  );
  await assertGraphOk(res);
  const body = (await res.json()) as {
    id?: string;
    username?: string;
    account_type?: string;
    media_count?: number;
  };
  return {
    id: body.id ?? "",
    username: body.username ?? "",
    accountType: body.account_type ?? null,
    mediaCount: typeof body.media_count === "number" ? body.media_count : null,
  };
}

export interface InstagramBusinessAccountInsights {
  reach: number | null;
  profileViews: number | null;
}

/** `instagram_business_manage_insights`: account-level insights, last full day. */
export async function fetchInstagramBusinessAccountInsights(
  accessToken: string,
): Promise<InstagramBusinessAccountInsights> {
  const res = await fetch(
    metaInstagramGraphUrl(
      `me/insights?metric=reach,profile_views&period=day&access_token=${encodeURIComponent(accessToken)}`,
    ),
  );
  await assertGraphOk(res);
  const body = (await res.json()) as { data?: Array<{ name?: string; values?: Array<{ value?: number }> }> };
  const valueOf = (name: string): number | null => body.data?.find((d) => d.name === name)?.values?.[0]?.value ?? null;
  return {
    reach: valueOf("reach"),
    profileViews: valueOf("profile_views"),
  };
}
