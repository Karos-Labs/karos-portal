/**
 * How the archive's sections are keyed (pure, client-safe).
 *
 * WHAT WAS THERE, AND WHY IT WAS WRONG (SCRUM-428). The archive grouped by
 * `agentLabelByAssetId[id] ?? agentLabelForAsset(asset) ?? "Other content"` -
 * that is, by WHICH AGENT MADE IT. So a client with an Instagram agent and a
 * carousel agent and a campaign agent that also posts to Instagram got three
 * sections that all read as "Instagram" from the outside. Lola: "Instagram
 * results are being split up into different categories and it's confusing."
 *
 * The grouping key was an IMPLEMENTATION fact (which of our agents produced
 * this) presented as a CONTENT fact (what this post is). A client thinks in
 * platforms; the agent that produced a post is worth knowing, but it is not a
 * category.
 *
 * THE SAME SOURCE THE PLATFORM BADGE READS. `platformForAsset` already owns
 * "what platform is this for", with five documented rungs and a test file of
 * its own, and asset-card's badge already draws from it. Deriving a second
 * answer here is how the Assets page's channel filter and this page would come
 * to disagree - which the ticket names as the next version of this bug. So this
 * module adds no rule; it only turns that answer into a section key and a
 * heading, and states what happens when the answer is nothing.
 */

import { platformForAsset, type IdentityPlatformHint } from "@/lib/content-platform";
import { platformLabel } from "@/lib/integrations/platforms";
import type { Asset } from "@/lib/types";

/**
 * The section a post with no recorded platform lands in.
 *
 * NOT a platform, and named so it cannot be mistaken for one. `platformForAsset`
 * has already tried the booked channel, the run's declared channel, the
 * umbrella's stored platform, the type, and the producing agent's own label - so
 * reaching this means nothing in the record says where this post is going.
 * "Other content" is the string the archive already used for that case, kept so
 * a client who has seen it does not meet a new word for the same pile.
 */
export const NO_PLATFORM_GROUP = "Other content";

/**
 * The section heading for one asset: a platform's own name, or the one
 * not-a-platform pile.
 *
 * The label comes from `platformLabel`, so "X (Twitter)" and "Instagram" are
 * spelled the way every other surface spells them and a new platform needs no
 * edit here.
 */
export function archiveGroupFor(asset: Asset, identity?: IdentityPlatformHint): string {
  const platform = platformForAsset(asset, identity);
  return platform ? platformLabel(platform) : NO_PLATFORM_GROUP;
}

/**
 * The logo slug for a section heading, or null for the not-a-platform pile.
 *
 * `PlatformLogo` keys off a slug prefix rather than an id, which is why this
 * returns the platform id and not the label: "X (Twitter)" is a label and
 * matches nothing.
 */
export function archiveGroupLogoSlug(
  asset: Asset,
  identity?: IdentityPlatformHint,
): string | null {
  const platform = platformForAsset(asset, identity);
  // `x` alone does not match PlatformLogo's `x-` prefix test - it looks for a
  // slug like "x-agent". Sending the bare id would silently drop the X mark.
  return platform === "x" ? "x-" : platform;
}

/**
 * Sections in the order a reader should meet them.
 *
 * Platform sections first, most-recent-work first (the caller supplies the
 * stamp, because who reads it decides which moment counts - see
 * `deliverableStamp`). The not-a-platform pile sinks to the bottom whatever its
 * timestamps say: it is the section a reader looks in last, and floating it on
 * one fresh placeholder would push the platforms they came for below the fold.
 */
export function orderArchiveGroups<T extends { name: string; latestAt: number }>(
  groups: readonly T[],
): T[] {
  return [...groups].sort((a, b) => {
    const aOther = a.name === NO_PLATFORM_GROUP;
    const bOther = b.name === NO_PLATFORM_GROUP;
    if (aOther !== bOther) return aOther ? 1 : -1;
    return b.latestAt - a.latestAt;
  });
}
