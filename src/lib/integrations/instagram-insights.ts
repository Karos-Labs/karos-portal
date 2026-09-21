/**
 * Instagram performance insights — read client, System User model. Server-only.
 *
 * UNLIKE the existing `instagram`/`facebook` entries in `oauth.ts` (which are
 * a PER-CLIENT OAuth consent flow used for publishing on that client's own
 * behalf), this module reads on Karos Labs' OWN Meta Business Manager System
 * User token (`META_SYSTEM_USER_TOKEN`): a client grants access by adding
 * Karos Labs as a partner in their Business Settings, not by an individual
 * OAuth popup. One token, every client whose Page granted it access.
 *
 * This is deliberately NOT a "Facebook" integration from the client's point
 * of view — see `platforms.ts`'s note on why Facebook was dropped as a
 * sellable channel (portal feedback round 2, 2026-09). The Facebook Graph API
 * is still the transport (an Instagram professional account is always linked
 * through a Facebook Page), but nothing here posts to, reads, or names a
 * Facebook Page as a product.
 *
 * THREE OF THE FOUR READERS THIS FILE ONCE HELD WERE REMOVED 2026-09-21:
 * `listRecentInstagramMedia` and `fetchInstagramMediaInsights` backed the
 * `instagram_insights` platform card (`platforms.ts`), which had no OAuth
 * flow, no automated setup, and — confirmed by grep — no caller anywhere in
 * `src/` outside this file and its own tests. Nothing ever read what that
 * card's stored `pageId` would have been used for, so the card and both
 * functions were retired together (their only reader was each other).
 * `resolveInstagramBusinessAccountId` was the id-resolver those two relied
 * on to turn a client's Page id into the ids they needed — with both gone,
 * it had no caller left either (confirmed by grep, same day), so it was
 * removed too. `fetchInstagramFollowerCount` below is unrelated and stays:
 * the follower sweep (`src/app/api/followers/sync/route.ts`) calls it
 * against a CLIENT'S OWN `instagram` integration token, never this module's
 * system-user token, and is live.
 *
 * Gated the same way `oauth.ts`'s existing Meta scopes already are:
 * `META_ADVANCED_ACCESS_APPROVED` — this file's calls need `pages_show_list`
 * and `read_insights`-equivalent Advanced Access from the same Meta App
 * Review the OAuth flow's `pages_read_user_content`/`read_insights` scopes
 * are already waiting on (see `SETUP.md`/`.env.example`).
 */

import "server-only";
import { TokenExpiredError } from "@/lib/integrations/publishers";
import { metaGraphUrl } from "@/lib/integrations/meta-graph";

/** Thrown on Meta's "permission not yet approved" shape — distinct from a dead token: the fix is Meta approving App Review, not reconnecting anything. */
export class MetaAccessNotGrantedError extends Error {
  constructor(detail?: string) {
    super(
      "Meta has not approved Advanced Access for this permission yet " +
        "(pages_show_list / pages_read_engagement / instagram_manage_insights) — " +
        `submit App Review in Meta for Developers, then set META_ADVANCED_ACCESS_APPROVED=1${detail ? `. Meta said: ${detail}` : ""}`,
    );
    this.name = "MetaAccessNotGrantedError";
  }
}

interface GraphErrorBody {
  error?: { message?: string; code?: number; error_subcode?: number };
}

async function assertGraphOk(res: Response): Promise<void> {
  if (res.ok) return;
  let body: GraphErrorBody = {};
  try {
    body = (await res.json()) as GraphErrorBody;
  } catch {
    // no JSON body — fall through with the raw status
  }
  const code = body.error?.code;
  const subcode = body.error?.error_subcode;
  if (code === 190) throw new TokenExpiredError("instagram_insights", res.status);
  // Meta's shape for "this permission has not cleared App Review yet for an
  // asset outside the app's own roles": code 10, or a 2xx error_subcode.
  if (code === 10 || (subcode !== undefined && subcode >= 200 && subcode < 300)) {
    throw new MetaAccessNotGrantedError(body.error?.message);
  }
  throw new Error(`Instagram insights request failed: ${body.error?.message ?? res.status}`);
}

/**
 * The account's current follower total — a plain field, not an insights
 * metric. Read daily by `/api/followers/sync` into `clientFollowerSnapshots`
 * (SCRUM-495), which is what it was written for.
 *
 * `igUserId` is the IG BUSINESS ACCOUNT id. The sweep takes it from the
 * integration's own `pageId` and reports the client as unreadable when there is
 * none, rather than re-walking `me/accounts` and each page's
 * `instagram_business_account` the way `publishInstagram` does — that resolver
 * belongs in one place, and a second copy is how the two drift.
 */
export async function fetchInstagramFollowerCount(systemUserToken: string, igUserId: string): Promise<number | null> {
  const res = await fetch(
    `${metaGraphUrl(encodeURIComponent(igUserId))}?fields=followers_count&access_token=${encodeURIComponent(systemUserToken)}`,
  );
  await assertGraphOk(res);
  const body = (await res.json()) as { followers_count?: number };
  return body.followers_count ?? null;
}
