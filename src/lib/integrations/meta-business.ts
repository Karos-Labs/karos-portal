/**
 * Meta Business Manager info — `business_management` territory.
 *
 * UNLIKE `instagram-insights.ts` (which reads on Karos Labs' own System User
 * token), this reads on the CLIENT'S OWN per-client OAuth token — the same
 * long-lived token `oauth.ts`'s "instagram" flow already stores in
 * `ClientIntegration.credentials.accessToken`. `business_management` rides
 * along as an extendedScope on that same flow (see oauth.ts) rather than a
 * separate connection: a client who has connected Instagram has already
 * granted it, once `META_ADVANCED_ACCESS_APPROVED=1`.
 *
 * Server-only, same shape as instagram-insights.ts's fetchers: no secrets in,
 * no secrets out — the token stays inside this module, the caller passes it
 * and gets back plain data.
 */

import "server-only";
import { TokenExpiredError } from "@/lib/integrations/publishers";
import { metaGraphUrl } from "@/lib/integrations/meta-graph";

export interface MetaBusinessAccount {
  id: string;
  name: string;
}

interface GraphErrorBody {
  error?: { message?: string; code?: number };
}

async function assertGraphOk(res: Response): Promise<void> {
  if (res.ok) return;
  if (res.status === 401 || res.status === 403) throw new TokenExpiredError("instagram", res.status);
  let body: GraphErrorBody = {};
  try {
    body = (await res.json()) as GraphErrorBody;
  } catch {
    // no JSON body — fall through with the raw status
  }
  throw new Error(`Meta business info request failed: ${body.error?.message ?? res.status}`);
}

/**
 * `business_management`: the Business Manager accounts this client's
 * connected user administers or is an employee of. Read-only here — Karos
 * Labs never creates, edits, or joins a Business Manager on a client's
 * behalf, this is purely "what do you already have" for the client to see.
 */
export async function fetchMetaBusinessAccounts(accessToken: string): Promise<MetaBusinessAccount[]> {
  const res = await fetch(
    metaGraphUrl(`me/businesses?fields=id,name&access_token=${encodeURIComponent(accessToken)}`),
  );
  await assertGraphOk(res);
  const body = (await res.json()) as { data?: Array<{ id?: string; name?: string }> };
  return (body.data ?? [])
    .filter((b): b is { id: string; name: string } => !!b.id && !!b.name)
    .map((b) => ({ id: b.id, name: b.name }));
}
