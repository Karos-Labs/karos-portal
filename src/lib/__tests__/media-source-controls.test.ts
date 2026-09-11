import { describe, expect, it } from "vitest";
import {
  attachmentModeForEngineProduct,
  buildCustomAgentPrompt,
  clientOnlyMediaIsRequired,
  isMediaSource,
  mediaSourceHint,
  parseRunAttachmentsJson,
  withEngineRunFields,
  MEDIA_ASSETS_FIELD_KEY,
  MEDIA_SOURCE_DEFAULT,
  MEDIA_SOURCE_FIELD_KEY,
  type AgentLaunchProfile,
} from "@/lib/custom-agent-launch";
import { KNOWN_ENGINE_PRODUCT_IDS, toEngineRunInput } from "@/lib/agent-engine/product-mapping";

/**
 * 2026-09-06 — the media controls every media agent's run dialog now carries:
 * WHERE the visuals come from (`media_source`, wire `mediaSource`) and the
 * files themselves (`mediaAssets`, painted by `RunAttachments` rather than a
 * raw-JSON textarea). Both the client run dialog and the admin engine card
 * derive their behaviour from the helpers pinned here, so a product added to
 * one list and not the other fails this file instead of shipping a control
 * that quietly does nothing.
 */

const BASE_PROFILE: AgentLaunchProfile = {
  eyebrow: "Test",
  intro: "Test",
  fields: [{ key: "request", label: "What should the agent accomplish?", type: "textarea", required: true }],
  deliverables: [],
  attachments: { label: "Reference files", hint: "" },
};

const MEDIA_PRODUCTS = ["x-agent", "linkedin-agent", "instagram-agent", "tiktok-agent", "branded-shorts-agent"] as const;

describe("withEngineRunFields — the media block", () => {
  for (const product of MEDIA_PRODUCTS) {
    it(`appends the source selector and a media-typed upload field for ${product}`, () => {
      const profile = withEngineRunFields(BASE_PROFILE, product);
      const source = profile.fields.find((f) => f.key === MEDIA_SOURCE_FIELD_KEY);
      const assets = profile.fields.find((f) => f.key === MEDIA_ASSETS_FIELD_KEY);
      expect(source).toMatchObject({ type: "select", defaultValue: MEDIA_SOURCE_DEFAULT });
      expect(source!.options!.map((o) => o.value)).toEqual(["system", "client"]);
      // Typed `media`, never a textarea: a client pastes no gs:// JSON.
      expect(assets).toMatchObject({ type: "media" });
      // Order is the order the dialog paints them: the choice above the files.
      const keys = profile.fields.map((f) => f.key);
      expect(keys.indexOf(MEDIA_SOURCE_FIELD_KEY)).toBeLessThan(keys.indexOf(MEDIA_ASSETS_FIELD_KEY));
    });
  }

  it("appends neither to a product that never reads media", () => {
    for (const product of KNOWN_ENGINE_PRODUCT_IDS.filter((p) => !(MEDIA_PRODUCTS as readonly string[]).includes(p))) {
      const keys = withEngineRunFields(BASE_PROFILE, product).fields.map((f) => f.key);
      expect(keys, product).not.toContain(MEDIA_SOURCE_FIELD_KEY);
      expect(keys, product).not.toContain(MEDIA_ASSETS_FIELD_KEY);
    }
  });

  it("the default is system-managed, so an untouched dialog behaves exactly as before the control existed", () => {
    expect(MEDIA_SOURCE_DEFAULT).toBe("system");
    expect(isMediaSource("system")).toBe(true);
    expect(isMediaSource("client")).toBe(true);
    expect(isMediaSource("")).toBe(false);
    expect(isMediaSource(undefined)).toBe(false);
  });
});

describe("attachmentModeForEngineProduct — one answer for the dialog and the engine card", () => {
  it("maps every media product to the shape its workflow reads, and nothing else to anything", () => {
    expect(attachmentModeForEngineProduct("instagram-agent")).toBe("slides");
    expect(attachmentModeForEngineProduct("tiktok-agent")).toBe("source-video");
    expect(attachmentModeForEngineProduct("branded-shorts-agent")).toBe("source-video");
    expect(attachmentModeForEngineProduct("x-agent")).toBe("picture");
    expect(attachmentModeForEngineProduct("linkedin-agent")).toBe("picture");
    expect(attachmentModeForEngineProduct("blog-agent")).toBeUndefined();
    expect(attachmentModeForEngineProduct(undefined)).toBeUndefined();
  });

  it("agrees with withEngineRunFields about which products take media", () => {
    for (const product of KNOWN_ENGINE_PRODUCT_IDS) {
      const paints = withEngineRunFields(BASE_PROFILE, product).fields.some((f) => f.key === MEDIA_ASSETS_FIELD_KEY);
      expect(attachmentModeForEngineProduct(product) !== undefined, product).toBe(paints);
    }
  });
});

describe("clientOnlyMediaIsRequired — who has a text fallback", () => {
  it("requires an upload for the carousel and video agents, never for the text-first channels", () => {
    expect(clientOnlyMediaIsRequired("instagram-agent")).toBe(true);
    expect(clientOnlyMediaIsRequired("tiktok-agent")).toBe(true);
    expect(clientOnlyMediaIsRequired("branded-shorts-agent")).toBe(true);
    expect(clientOnlyMediaIsRequired("x-agent")).toBe(false);
    expect(clientOnlyMediaIsRequired("linkedin-agent")).toBe(false);
  });

  it("words the hint for the choice actually made", () => {
    expect(mediaSourceHint("x-agent", "client")).toMatch(/ships as text/);
    expect(mediaSourceHint("x-agent", "system")).toMatch(/sources one/);
    expect(mediaSourceHint("instagram-agent", "client")).toMatch(/Nothing is sourced or generated/);
    expect(mediaSourceHint("instagram-agent", "system")).toMatch(/sourced or generated as usual/);
    expect(mediaSourceHint("tiktok-agent", "client")).toMatch(/Nothing else is harvested or generated/);
  });
});

describe("the two media answers are data for the engine, not prose for the agent", () => {
  const profile = withEngineRunFields(BASE_PROFILE, "instagram-agent");
  const answers = {
    request: "Three slides on the launch",
    [MEDIA_SOURCE_FIELD_KEY]: "client",
    [MEDIA_ASSETS_FIELD_KEY]: JSON.stringify([{ uri: "gs://b/one.png", role: "source", label: "one.png" }]),
  };

  it("stay out of the legacy prompt", () => {
    const prompt = buildCustomAgentPrompt(profile, answers);
    expect(prompt).toContain("Three slides on the launch");
    expect(prompt).not.toContain("gs://");
    expect(prompt).not.toContain("client");
  });

  it("reach the engine under their wire keys", () => {
    expect(toEngineRunInput(answers, "instagram-agent")).toEqual({
      requestedTopic: "Three slides on the launch",
      mediaSource: "client",
      mediaAssets: [{ uri: "gs://b/one.png", role: "source", label: "one.png" }],
    });
  });

  it("parseRunAttachmentsJson is lenient: junk is no attachments, never a crash in a client's dialog", () => {
    expect(parseRunAttachmentsJson(undefined)).toEqual([]);
    expect(parseRunAttachmentsJson("")).toEqual([]);
    expect(parseRunAttachmentsJson("not json")).toEqual([]);
    expect(parseRunAttachmentsJson('{"uri":"gs://b/x.png"}')).toEqual([]);
    expect(parseRunAttachmentsJson('[{"uri":"gs://b/x.png","role":"logo"},{"role":"source"},{"uri":"gs://b/y.mp4","role":"reference","contentType":"video/mp4","label":"y"}]')).toEqual([
      { uri: "gs://b/x.png", role: "source" },
      { uri: "gs://b/y.mp4", role: "reference", contentType: "video/mp4", label: "y" },
    ]);
  });
});
