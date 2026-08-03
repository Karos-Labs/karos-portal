/**
 * WHICH PLATFORM A PIECE OF CONTENT TARGETS (AF-20).
 *
 * Every calendar item — upcoming and past — and every copilot @-agent tag
 * carries the mark of the platform the content is FOR, so a client reading a
 * chip knows what post they are going to get before they open anything.
 *
 * ONE RESOLVER, NOT A GUESS PER SURFACE. This is the F147 lesson applied to the
 * second half of an identity: the label already has one home
 * (lib/agent-identity-map), and a per-surface `asset.type === "instagram_post"
 * ? …` would be the same defect wearing a platform's clothes — the chip, the
 * day card and the copilot row would drift into three answers for one post.
 *
 * HONESTY IS THE POINT, and it is why every rung below is a fact somebody
 * RECORDED rather than a shape somebody inferred. A wrong logo is worse than no
 * logo: it tells the client, in one glyph and with no hedge, that Tuesday's
 * work is going somewhere it is not. So `null` is a first-class answer and the
 * caller falls back to today's product icon (`AgentMark`), which already
 * degrades through the landing-page marks to the agent's stored lucide glyph.
 *
 * WHAT IS DELIBERATELY NOT ASKED: the asset's TITLE. `agentLabelForAsset` names
 * the producing agent, and that is the only free-ish text this module reads. A
 * post titled "5 ways to grow on Instagram" written for a LinkedIn audience is
 * exactly the wrong-logo case above, and asking the title is how you get it.
 * (asset-card's own `AgentMark` does feed the title in; it is drawing the AGENT,
 * beside a separate platform badge, so a loose match there costs a fallback
 * glyph rather than a false claim about where the post is going.)
 *
 * PURE and client-safe — no data layer, no `server-only`. Callers hand it
 * whatever they hold. The calendar resolves server-side and ships the token, so
 * the wire carries `"instagram"` and not the asset fields it was read from.
 */

import {
  platformForIntegrationId,
  socialPlatformsFor,
  type SocialPlatform,
} from "@/components/agent-identity";
import {
  resolveContentIdentity,
  type ClientAgentIdentity,
  type ContentIdentity,
  type IdentityJob,
} from "@/lib/agent-identity-map";
import {
  isLinkedInAgentIdentity,
  isRedditAgentIdentity,
  isXAgentIdentity,
} from "@/lib/custom-agent-launch";
import { agentLabelForAsset } from "@/lib/post-chain";
import type { Asset, PlannedScheduledRun } from "@/lib/types";

export type { SocialPlatform };

/** The asset fields a platform can honestly be read from. Never the title. */
export type AssetPlatformFields = Pick<
  Asset,
  "type" | "meta" | "agentId" | "scheduledPlatform" | "channels"
>;

/**
 * The umbrella's own answer, as `resolveContentIdentity` returns it — passed
 * through in that shape so a caller that already resolved the identity hands
 * the result straight over instead of re-deriving half of it.
 */
export type IdentityPlatformHint = { platform?: string } | null | undefined;

/**
 * The one asset type whose NAME claims a platform. It is listed alone on
 * purpose: `PUBLISHABLE_PLATFORMS` offers `instagram_post` to instagram AND
 * tiktok, so even this rung is the weaker of two readings and sits below the
 * umbrella below. `social_post` is not here at all — its publish targets are
 * twitter/linkedin/facebook/tiktok, so the `DEFAULT_PLATFORM_FOR_ASSET` entry
 * pointing it at instagram is a SCHEDULING default (which channel to try first)
 * and not a statement about the content. Rendering a logo off it would put an
 * Instagram mark on a post whose own type cannot be published to Instagram.
 * `article` → linkedin is the same class of default and is likewise omitted.
 */
const PLATFORM_NAMED_BY_TYPE: Partial<Record<Asset["type"], SocialPlatform>> = {
  instagram_post: "instagram",
};

/** First entry of a channel list that maps onto a mark, ignoring the rest. */
function firstMarkablePlatform(ids: readonly string[] | undefined): SocialPlatform | null {
  for (const id of ids ?? []) {
    const platform = platformForIntegrationId(id);
    if (platform) return platform;
  }
  return null;
}

/**
 * The platform an asset targets, or null when nothing recorded says.
 *
 * Rungs, in order — the first that answers wins:
 *   1. `scheduledPlatform`, the channel this post is actually booked to reach.
 *      Explicit and operational: the publish cron reads the same field.
 *   2. `channels`, the platform the run itself declared (the agent-service
 *      webhook writes `metadata.platform` here) or the producing agent's
 *      distribution list. Same source asset-card's platform badge reads.
 *   3. the producing umbrella's STORED platform, when the caller resolved an
 *      identity. Derived once at bind time from the agent's identity and
 *      written down, so renaming the lab agent cannot re-platform it.
 *   4. an asset type that names a platform — see PLATFORM_NAMED_BY_TYPE.
 *   5. the producing agent's own label ("Reddit agent", "Instagram agent"),
 *      through the same regex `AgentMark` already draws every agent with.
 *
 * Rung 3 carries most of the coverage in practice: a placeholder or draft post
 * has no booked channel yet, and its type is the generic social one.
 */
export function platformForAsset(
  asset: AssetPlatformFields,
  identity?: IdentityPlatformHint,
): SocialPlatform | null {
  const booked = asset.scheduledPlatform ? platformForIntegrationId(asset.scheduledPlatform) : null;
  if (booked) return booked;

  const declared = firstMarkablePlatform(asset.channels);
  if (declared) return declared;

  const umbrella = identity?.platform ? platformForIntegrationId(identity.platform) : null;
  if (umbrella) return umbrella;

  const named = PLATFORM_NAMED_BY_TYPE[asset.type];
  if (named) return named;

  const label = agentLabelForAsset(asset);
  return label ? socialPlatformsFor(label)[0] ?? null : null;
}

/**
 * The platform an AGENT posts to, from the strings that travel with it.
 *
 * The three exact-key predicates go first because they are exact: they answer
 * "is this THE karos X / LinkedIn / Reddit agent doc", including the per-client
 * LinkedIn company instances, and an exact key beats a regex over a name a
 * client may have renamed. There is no fourth predicate — Instagram, TikTok and
 * YouTube agents are recognised only by their identity strings, which is what
 * rung 2 is for, and `socialPlatformsFor` is the one place that spelling lives.
 *
 * `name` is asked AFTER `key`: a renamed umbrella ("Acme's voice") loses the
 * platform word its key still carries, and the reverse case — a key with no
 * platform word under a name that has one — is what a lab import looks like.
 */
export function platformForAgentIdentity(key?: string | null, name?: string | null): SocialPlatform | null {
  const agentKey = key?.trim() ?? "";
  if (agentKey) {
    if (isXAgentIdentity(agentKey)) return "x";
    if (isLinkedInAgentIdentity(agentKey)) return "linkedin";
    if (isRedditAgentIdentity(agentKey)) return "reddit";
  }

  for (const identity of [agentKey, name?.trim() ?? ""]) {
    if (!identity) continue;
    const platform = socialPlatformsFor(identity)[0];
    if (platform) return platform;
  }
  return null;
}

/* ── Row helpers: the one call each surface makes ────────────────────── */

/**
 * The mark for a row that stands for an AGENT rather than for one post: its
 * STORED platform first, then the strings that name it.
 *
 * The stored value leads because it was derived from the agent's identity ONCE,
 * at bind time, and written down — so an umbrella renamed to "Acme's voice"
 * keeps its Instagram mark instead of losing the only platform word it had.
 * When there is no stored value the key and the name answer, which is what a
 * catalog agent nobody has bound yet has to fall back on.
 *
 * Used by the calendar's run and schedule rows and by the copilot's @-mention
 * roster, which is why it takes loose strings rather than one row shape: those
 * three surfaces hold three different records of the same agent.
 */
export function platformForAgentRow(
  stored: string | null | undefined,
  key: string | null | undefined,
  name: string | null | undefined,
): SocialPlatform | null {
  const bound = stored ? platformForIntegrationId(stored) : null;
  return bound ?? platformForAgentIdentity(key, name);
}

/**
 * The same question asked of a resolved identity. The printed LABEL is what
 * gets sniffed, not the row's raw `agentName`, so the mark and the caption
 * beside it always agree — and it is the same string `AgentMark` would have
 * been handed at the fallback, so a row with no umbrella renders exactly what
 * it renders today.
 */
function platformForIdentity(identity: ContentIdentity): SocialPlatform | null {
  return platformForAgentRow(identity.platform, null, identity.label);
}

/**
 * The mark a RUN row carries — the platform twin of `runRowLabel`.
 *
 * Split across two modules on purpose: agent-identity-map owns the one NAME a
 * row prints, this owns the one PLATFORM, and each surface makes one call for
 * each. Folding the platform into the label helper would change a signature
 * four surfaces already depend on to answer a question only some of them ask.
 */
export function runRowPlatform(job: IdentityJob, clientAgents: ClientAgentIdentity[]): SocialPlatform | null {
  return platformForIdentity(resolveContentIdentity({ job }, clientAgents));
}

/** The same, for a row that has not fired yet — the twin of `scheduleRowLabel`. */
export function scheduleRowPlatform(
  scheduledRun: Pick<PlannedScheduledRun, "clientAgentId" | "customAgentId" | "agentName">,
  clientAgents: ClientAgentIdentity[],
): SocialPlatform | null {
  return platformForIdentity(resolveContentIdentity({ scheduledRun }, clientAgents));
}

/**
 * The mark ONE delivered or scheduled post carries.
 *
 * The asset's own fields lead (see `platformForAsset`) because a booked channel
 * is a stronger statement than the agent that produced it: an umbrella can
 * publish one post to a platform it is not named after, and the post is the
 * thing being drawn.
 */
export function assetRowPlatform(
  asset: AssetPlatformFields & Pick<Asset, "templateKey" | "templateName">,
  clientAgents: ClientAgentIdentity[],
): SocialPlatform | null {
  return platformForAsset(asset, resolveContentIdentity({ asset }, clientAgents));
}
