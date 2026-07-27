import { describe, expect, it } from "vitest";
import {
  PUBLISHABLE_PLATFORMS,
  READ_ONLY_PLATFORM_IDS,
} from "@/lib/integrations/platforms";
import { guessAssetType } from "@/lib/lab-outputs-shared";

/**
 * Reddit is draft-only by hard contract — a human always posts, from their own
 * account. That was previously enforced by nothing: no test covered
 * PUBLISHABLE_PLATFORMS at all, so adding "reddit" to it, or typing a Reddit
 * asset as a publishable type, would have shipped silently.
 *
 * Two distinct failures are pinned here, because the second is the one that
 * nearly happened: Reddit does not appear as a publish TARGET, and a Reddit
 * deliverable does not land on an asset type that can be pushed to some OTHER
 * platform. social_post publishes to twitter/linkedin/facebook/tiktok, so a
 * Reddit reply typed social_post would have been offered for cross-posting to
 * a platform it was never written for.
 */
describe("Reddit stays unpublishable", () => {
  it("is never a publish target for any asset type", () => {
    for (const [assetType, targets] of Object.entries(PUBLISHABLE_PLATFORMS)) {
      expect(targets, `${assetType} must not publish to reddit`).not.toContain("reddit");
    }
  });

  it("is registered as a read-only integration", () => {
    // The Reddit connector exists for account health and own-history reads
    // (karma, age, removal rate). There is deliberately no publisher.
    expect(READ_ONLY_PLATFORM_IDS.has("reddit")).toBe(true);
  });

  it("maps a Reddit lab folder to an asset type with no publish targets", () => {
    const type = guessAssetType("reddit-agent");
    expect(PUBLISHABLE_PLATFORMS[type] ?? []).toEqual([]);
  });
});
