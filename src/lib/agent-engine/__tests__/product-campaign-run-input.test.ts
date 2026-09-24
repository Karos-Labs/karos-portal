import { describe, expect, it } from "vitest";
import {
  buildCustomAgentPrompt,
  isBriefFieldShown,
  launchProfileFor,
  withEngineRunFields,
} from "@/lib/custom-agent-launch";
import {
  INSTAGRAM_POST_TYPE_FIELD_KEY,
  PRODUCT_CAMPAIGN_POST_TYPE,
  PRODUCT_NAME_FIELD_KEY,
  PRODUCT_PHOTO_FIELD_KEY,
  instagramPostTypeInput,
  productCampaignAssets,
  toEngineRunInput,
} from "../product-mapping";

/**
 * The product campaign from the portal (agent-engine #223, stage 4).
 *
 * The engine's contract, read from its source rather than guessed:
 *
 * - `01-open-run` (create-instagram-agent-workflow.ts) turns
 *   `wf.input.requestedMode === "product_campaign"` into
 *   `runClaim.productCampaign`.
 * - Run attachments arrive ONLY as `wf.input.mediaAssets`, an array of
 *   `{ uri, role, contentType?, label? }` parsed by `readRichRunInput`
 *   (packages/core/src/types/run-input.ts); `05z-attach-user-media` ingests
 *   role `source`/`reference` as Tier 0, and `04q-plan-product-campaign`
 *   offers those uploads to the product-photo picker before any library
 *   frame, reading each one's `label` as the product's name.
 */

const PHOTO = JSON.stringify([{ uri: "gs://media/clients/c1/run-media/serum.png", role: "source", contentType: "image/png", label: "IMG_4412.png" }]);

describe("instagramPostTypeInput — product_campaign", () => {
  it("asks for the campaign under the key 01-open-run reads, as a carousel", () => {
    expect(PRODUCT_CAMPAIGN_POST_TYPE).toBe("product_campaign");
    expect(instagramPostTypeInput("product_campaign")).toEqual({ requestedMode: "product_campaign", requestedFormat: "carousel" });
  });

  it("wins over the format select, because the fallback is the normal carousel", () => {
    expect(toEngineRunInput({ requestedFormat: "single", instagram_post_type: "product_campaign" }, "instagram-agent")).toMatchObject({
      requestedMode: "product_campaign",
      requestedFormat: "carousel",
    });
  });
});

describe("toEngineRunInput — the product photo", () => {
  it("is sent as the FIRST mediaAssets entry, role reference, labelled with the typed product name", () => {
    const input = toEngineRunInput(
      {
        request: "Launch the new serum",
        instagram_post_type: "product_campaign",
        [PRODUCT_PHOTO_FIELD_KEY]: PHOTO,
        [PRODUCT_NAME_FIELD_KEY]: "  Daily Glow Serum ",
        mediaAssets: JSON.stringify([{ uri: "gs://media/clients/c1/run-media/team.jpg", role: "source", label: "team.jpg" }]),
      },
      "instagram-agent",
    );
    expect(input.mediaAssets).toEqual([
      { uri: "gs://media/clients/c1/run-media/serum.png", role: "reference", contentType: "image/png", label: "Daily Glow Serum" },
      // A file-name label on ANY attachment of a campaign run is dropped:
      // any of them may be picked as the product photo, and its label would
      // be lettered on the billboard.
      { uri: "gs://media/clients/c1/run-media/team.jpg", role: "source" },
    ]);
    expect(input.requestedMode).toBe("product_campaign");
  });

  it("never sends the file name as the product's name", () => {
    const input = toEngineRunInput({ instagram_post_type: "product_campaign", [PRODUCT_PHOTO_FIELD_KEY]: PHOTO }, "instagram-agent");
    expect(input.mediaAssets).toEqual([{ uri: "gs://media/clients/c1/run-media/serum.png", role: "reference", contentType: "image/png" }]);
    expect(JSON.stringify(input)).not.toContain("IMG_4412");
  });

  it("keeps a real product label someone typed on another attachment", () => {
    const { mediaAssets } = productCampaignAssets(undefined, undefined, [{ uri: "gs://b/a.png", role: "source", label: "Daily Glow Serum" }]);
    expect(mediaAssets).toEqual([{ uri: "gs://b/a.png", role: "source", label: "Daily Glow Serum" }]);
  });

  it("does not attach the same file twice when it is also in the run's attachments", () => {
    const input = toEngineRunInput({ instagram_post_type: "product_campaign", [PRODUCT_PHOTO_FIELD_KEY]: PHOTO, mediaAssets: PHOTO }, "instagram-agent");
    expect(input.mediaAssets).toHaveLength(1);
  });

  it("folds a product name with no photo into the run direction rather than dropping it", () => {
    const input = toEngineRunInput({ instagram_post_type: "product_campaign", [PRODUCT_NAME_FIELD_KEY]: "Daily Glow Serum" }, "instagram-agent");
    expect(input.mediaAssets).toBeUndefined();
    expect(input.customPrompt).toBe("Product to feature\nDaily Glow Serum");
  });

  it("ignores a video or a non-https/gs URI in the photo slot", () => {
    const junk = JSON.stringify([
      { uri: "gs://b/clip.mp4", role: "source", contentType: "video/mp4" },
      { uri: "file:///C:/serum.png", role: "source" },
    ]);
    expect(toEngineRunInput({ instagram_post_type: "product_campaign", [PRODUCT_PHOTO_FIELD_KEY]: junk }, "instagram-agent").mediaAssets).toBeUndefined();
  });

  it("sends neither box when the post type is not the campaign, even if they hold a stale answer", () => {
    for (const postType of ["", "news_flash", "the_list"]) {
      const input = toEngineRunInput(
        { instagram_post_type: postType, [PRODUCT_PHOTO_FIELD_KEY]: PHOTO, [PRODUCT_NAME_FIELD_KEY]: "Daily Glow Serum" },
        "instagram-agent",
      );
      expect(input.mediaAssets).toBeUndefined();
      expect(JSON.stringify(input)).not.toContain("Daily Glow Serum");
    }
  });

  it("leaves the run's own attachments exactly as they were outside a campaign", () => {
    const attachments = JSON.stringify([{ uri: "gs://b/slide.png", role: "source", label: "slide.png" }]);
    expect(toEngineRunInput({ instagram_post_type: "the_list", mediaAssets: attachments }, "instagram-agent").mediaAssets).toEqual([
      { uri: "gs://b/slide.png", role: "source", label: "slide.png" },
    ]);
  });
});

describe("the run dialog — product campaign fields", () => {
  const profile = withEngineRunFields(launchProfileFor({ key: "karos-instagram-agent", name: "Instagram Agent" }), "instagram-agent");
  const field = (key: string) => {
    const found = profile.fields.find((f) => f.key === key);
    if (!found) throw new Error(`${key} is not in the Instagram run dialog`);
    return found;
  };

  it("offers Product campaign in the post type select", () => {
    expect(field(INSTAGRAM_POST_TYPE_FIELD_KEY).options?.map((o) => o.value)).toContain("product_campaign");
  });

  it("shows the photo and name only while Product campaign is chosen", () => {
    for (const key of [PRODUCT_PHOTO_FIELD_KEY, PRODUCT_NAME_FIELD_KEY]) {
      expect(isBriefFieldShown(field(key), { [INSTAGRAM_POST_TYPE_FIELD_KEY]: "product_campaign" })).toBe(true);
      expect(isBriefFieldShown(field(key), { [INSTAGRAM_POST_TYPE_FIELD_KEY]: "" })).toBe(false);
      expect(isBriefFieldShown(field(key), {})).toBe(false);
      expect(field(key).required).toBeFalsy();
    }
  });

  it("uploads the photo as ONE picture and explains what the campaign makes", () => {
    const photo = field(PRODUCT_PHOTO_FIELD_KEY);
    expect(photo.type).toBe("media");
    expect(photo.media?.mode).toBe("picture");
    expect(photo.media?.hint).toMatch(/picture-only carousel of scenes built from this photo/);
  });

  it("keeps the photo's JSON and a hidden answer out of the legacy prompt prose", () => {
    const shown = buildCustomAgentPrompt(profile, { request: "Launch", instagram_post_type: "product_campaign", [PRODUCT_PHOTO_FIELD_KEY]: PHOTO, [PRODUCT_NAME_FIELD_KEY]: "Daily Glow Serum" });
    expect(shown).not.toContain("gs://");
    expect(shown).toContain("Daily Glow Serum");
    const hidden = buildCustomAgentPrompt(profile, { request: "Launch", instagram_post_type: "the_list", [PRODUCT_NAME_FIELD_KEY]: "Daily Glow Serum" });
    expect(hidden).not.toContain("Daily Glow Serum");
  });
});
