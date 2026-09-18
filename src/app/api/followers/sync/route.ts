import { type NextRequest, NextResponse } from "next/server";
import { requireCronSecret } from "@/lib/cron-auth";
import {
  listClients,
  listClientIntegrations,
  markIntegrationForReauth,
  recordClientFollowerSnapshot,
} from "@/lib/data";
import { fetchLinkedInOrgFollowers, fetchTwitterFollowerGrowth } from "@/lib/integrations/analytics-providers";
import { fetchInstagramFollowerCount } from "@/lib/integrations/instagram-insights";
import { TokenExpiredError } from "@/lib/integrations/publishers";
import { integrationMayBeRevivable, runWithFreshCredentials } from "@/lib/integrations/token-refresh";
import { integrationIsUsable } from "@/lib/integration-status";
import type { ClientIntegration } from "@/lib/types";

// Same posture as /api/analytics/sync: a per-client sweep over network calls,
// triggered by Cloud Scheduler, governed by the container timeout.
export const maxDuration = 300;

/**
 * FOLLOWER INGESTION — the missing writer (SCRUM-495, 04 Build plan N6).
 *
 * Every other piece of this feature already existed and none of them had ever
 * run. `clientFollowerSnapshots` (the append-only, one-row-per-client-per-
 * platform-per-day collection), `recordClientFollowerSnapshot`, the four pure
 * helpers in `follower-tracking.ts`, the Home KPIs audience cell, and three
 * platform fetchers — all built, all tested, all unreachable, because nothing
 * anywhere called the write side. `follower-tracking.ts`'s own header names the
 * gap and predicts this file: *"the moment an ingestion cron writes to
 * `clientFollowerSnapshots` … the audience cell lights up on its own"*.
 *
 * So the third learning source — performance — contributed nothing, and the
 * audience half of reporting had no data behind it.
 *
 * ## What is written, and what is deliberately not
 *
 * One row per client per platform per day: `{clientId, platform, count,
 * capturedAt}`, with `capturedAt` floored to the UTC day so the doc id
 * (`${clientId}_${platform}_${capturedAt}`) is idempotent — running this twice
 * on the same day rewrites one row rather than growing the series, and a
 * missed day is a gap rather than a lie.
 *
 * NOTHING IS WRITTEN FOR A PLATFORM THAT COULD NOT BE READ. That is the same
 * rule `/api/analytics/sync` was rewritten to follow in 2026-08 and the reason
 * `follower-tracking.ts`'s mock was deleted: an invented audience size rendered
 * as the first number on a dashboard is worse than an empty cell. A platform
 * this run could not answer for is counted in `unavailable` and reported by
 * name, which makes the response the honest size of the measurement gap.
 *
 * ## Which platforms, and why only these
 *
 * - **twitter** — `user.fields=public_metrics` on the connected account. No
 *   extra scope, no extra id: the cheapest real number in the system, and the
 *   one `follower-tracking.ts` nominated.
 * - **instagram** — `?fields=followers_count` on the IG business account. Needs
 *   that account's id. It is read from the integration's own `pageId` (what the
 *   manual setup stores); a client connected through OAuth without one is
 *   reported `unavailable` rather than having this cron re-walk `me/accounts`
 *   and every page's `instagram_business_account` the way `publishInstagram`
 *   does. That walk belongs in a shared resolver, not in a second copy here,
 *   and adding a copy is how the two drift.
 * - **linkedin_community** — the company page's follower count, which LinkedIn
 *   serves only to the separate Community Management app (see
 *   `OAUTH_CONFIGS.linkedin_community`). Needs the org URN, stored as
 *   `organizationId`.
 *
 * Reddit, TikTok and the primary `linkedin` integration have no follower
 * endpoint wired in this repo, so they are simply not attempted — an absent
 * platform is not an error.
 *
 * Schedule via Cloud Scheduler, daily: GET, `Authorization: Bearer <CRON_SECRET>`.
 * Daily is the right cadence and also the maximum useful one: `capturedAt` is a
 * day, so a second run in the same day overwrites rather than adds.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The day this run belongs to, in UTC.
 *
 * Exported because it is the whole of the idempotence claim: the doc id is
 * built from it, so "two runs on one day produce one row" is a property of this
 * function and is tested as one rather than inferred from the route.
 */
export function followerCaptureDay(now: number): number {
  return Math.floor(now / DAY_MS) * DAY_MS;
}

/**
 * The channel a count is FILED under, which is not always the integration it
 * came from.
 *
 * `linkedin_community` is a second LinkedIn connection — a different developer
 * app against the same company page — not a second channel a client has. Its
 * followers ARE the client's LinkedIn followers, and filing them under the
 * integration id would put a row called "linkedin_community" beside "twitter"
 * in a growth chart a client reads. The primary `linkedin` integration has no
 * follower endpoint in this repo, so there is nothing for this to collide with.
 */
function channelFor(platform: string): string {
  return platform === "linkedin_community" ? "linkedin" : platform;
}

type FollowerAction = "written" | "unavailable" | "expired" | "skipped";

interface FollowerResult {
  clientId: string;
  /** The integration read, not the channel filed under — a report has to name what it actually called. */
  platform: string;
  action: FollowerAction;
  count?: number;
  detail?: string;
}

/**
 * One integration's current follower count, or `null` when this platform
 * cannot answer with what is stored.
 *
 * `null` is a first-class answer rather than an exception: "no id on file" and
 * "platform not wired" are both ordinary states of a real client's account,
 * and neither is a failure of the sweep.
 */
async function followerCountFor(integration: ClientIntegration): Promise<number | null> {
  const { credentials } = integration;
  switch (integration.platform) {
    case "twitter": {
      const token = credentials.accessToken;
      if (!token) return null;
      return (await fetchTwitterFollowerGrowth(token)).followersCount;
    }
    case "instagram": {
      const token = credentials.accessToken;
      const igUserId = credentials.pageId;
      if (!token || !igUserId) return null;
      return await fetchInstagramFollowerCount(token, igUserId);
    }
    case "linkedin_community": {
      const token = credentials.accessToken;
      const organizationUrn = credentials.organizationId;
      if (!token || !organizationUrn) return null;
      return (await fetchLinkedInOrgFollowers(token, organizationUrn)).followerCount;
    }
    default:
      return null;
  }
}

/** The integrations worth calling at all — everything else is skipped silently. */
const FOLLOWER_PLATFORMS = new Set(["twitter", "instagram", "linkedin_community"]);

export async function GET(req: NextRequest) {
  const denied = requireCronSecret(req);
  if (denied) return denied;

  const capturedAt = followerCaptureDay(Date.now());
  const clients = await listClients();

  const results: FollowerResult[] = [];
  let written = 0;
  let unavailable = 0;
  let expired = 0;

  for (const client of clients) {
    try {
      const integrations = await listClientIntegrations(client.id);
      const readable = integrations.filter(
        (i) =>
          FOLLOWER_PLATFORMS.has(i.platform) &&
          // Same revival rule as the analytics sweep: a channel flagged expired
          // whose refresh token is on record is re-tested rather than skipped,
          // because the flag came from a 401 on the ACCESS token.
          (integrationIsUsable(i) || integrationMayBeRevivable(i)),
      );

      for (const integration of readable) {
        // Every integration in its own try/catch: one dead connection must
        // never end another client's sweep, or another platform's.
        try {
          const count = await runWithFreshCredentials(integration, (fresh) => followerCountFor(fresh));
          if (count === null) {
            unavailable++;
            results.push({
              clientId: client.id,
              platform: integration.platform,
              action: "unavailable",
              detail:
                integration.platform === "instagram"
                  ? "no IG business account id on the integration — nothing written"
                  : "no follower source for this connection — nothing written",
            });
            continue;
          }
          await recordClientFollowerSnapshot({
            clientId: client.id,
            platform: channelFor(integration.platform),
            count,
            capturedAt,
          });
          written++;
          results.push({ clientId: client.id, platform: integration.platform, action: "written", count });
        } catch (e) {
          if (e instanceof TokenExpiredError) {
            // The real 401/403, after `runWithFreshCredentials` already tried a
            // forced refresh. Flag it the way the analytics sweep does, so the
            // client sees one reconnect prompt rather than two silent crons.
            await markIntegrationForReauth(client.id, integration.platform).catch(() => {});
            expired++;
            results.push({
              clientId: client.id,
              platform: integration.platform,
              action: "expired",
              detail: "token expired — reconnect required",
            });
            continue;
          }
          results.push({
            clientId: client.id,
            platform: integration.platform,
            action: "skipped",
            detail: e instanceof Error ? e.message : "unknown error",
          });
        }
      }
    } catch (e) {
      results.push({
        clientId: client.id,
        platform: "-",
        action: "skipped",
        detail: `client sweep failed: ${e instanceof Error ? e.message : "unknown"}`,
      });
    }
  }

  return NextResponse.json({
    capturedAt,
    checked: { clients: clients.length },
    recordsWritten: written,
    unavailable,
    integrationsExpired: expired,
    results,
  });
}
