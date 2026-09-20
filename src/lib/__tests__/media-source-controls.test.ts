import { describe, expect, it } from "vitest";
import {
  attachmentModeForEngineProduct,
  buildCustomAgentPrompt,
  clientOnlyMediaIsRequired,
  engineProductSourcesItsOwnMedia,
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

// D08: clipping is handed a recording and editing is handed the client's own
// video, so both read media. Content design is deliberately NOT here, and the
// "appends neither" case below is what proves it: the product is defined by
// being given no footage, and an attach control would contradict it.
const MEDIA_PRODUCTS = [
  // `x-agent` is deliberately NOT here: it reads media (the attach box is
  // painted for it) but it has no SOURCE CHOICE, because D24 makes it text
  // only. Its own case is below.
  "linkedin-agent",
  "instagram-agent",
  "tiktok-agent",
  "branded-shorts-agent",
  "tiktok-clipping-agent",
  "tiktok-editing-agent",
] as const;

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

  /**
   * D24: X is text only — it does not create or source pictures, and a
   * client's own picture is attached if given. agent-engine enforces that by
   * passing `clientMediaOnly: true` unconditionally, so "Karos sources or
   * generates the visuals" was an option the engine could not honour and a
   * sentence under it that promised a picture nobody would ever source. The
   * attach box stays, because the client's own picture is the permitted half.
   */
  it("paints the upload field but NO source selector for x-agent, because one of its two answers was not real", () => {
    const keys = withEngineRunFields(BASE_PROFILE, "x-agent").fields.map((f) => f.key);
    expect(keys).toContain(MEDIA_ASSETS_FIELD_KEY);
    expect(keys).not.toContain(MEDIA_SOURCE_FIELD_KEY);
    expect(engineProductSourcesItsOwnMedia("x-agent")).toBe(false);
    for (const product of MEDIA_PRODUCTS) expect(engineProductSourcesItsOwnMedia(product), product).toBe(true);
  });

  it("appends neither to a product that never reads media", () => {
    const takesMedia = new Set<string>([...MEDIA_PRODUCTS, "x-agent"]);
    for (const product of KNOWN_ENGINE_PRODUCT_IDS.filter((p) => !takesMedia.has(p))) {
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
    // Both settings, one sentence, because X has one behaviour: the wire
    // value cannot change what the engine does, so the hint must not suggest
    // it can. This is the line that used to promise "the agent sources one
    // when the post wants a visual" about an agent that never does.
    for (const source of ["client", "system"] as const) {
      expect(mediaSourceHint("x-agent", source)).toMatch(/ships as text/);
      expect(mediaSourceHint("x-agent", source)).not.toMatch(/sources one/);
    }
    expect(mediaSourceHint("linkedin-agent", "system")).toMatch(/sources one/);
    expect(mediaSourceHint("instagram-agent", "client")).toMatch(/Nothing is sourced or generated/);
    expect(mediaSourceHint("instagram-agent", "system")).toMatch(/sourced or generated as usual/);
    expect(mediaSourceHint("tiktok-agent", "client")).toMatch(/Nothing else is harvested or generated/);
  });

  /**
   * D08's split made the shared "source-video" sentence wrong for two of the
   * three products that use it. The old line promised "leave it empty and the
   * agent finds or generates its own" to an editing agent that refuses the run
   * without a recording, and to a clipping agent that searches a source list
   * but never generates a frame.
   */
  it("tells each video product the truth about leaving the box empty", () => {
    // Editing: nothing to cut without the client's own recording.
    expect(mediaSourceHint("tiktok-editing-agent", "system")).toMatch(/^Required\./);
    expect(mediaSourceHint("tiktok-editing-agent", "system")).not.toMatch(/generates its own/);

    // Clipping: the empty box IS a supported path, and since agent-engine
    // RFC-25 (2026-09-20) it has TWO shapes. A client with a `sourcePool`
    // still gets a search of their own shows; a client without one used to
    // get a refused run and now gets an open web search for a podcast on the
    // run's topic. Both halves have to be said, because which one a given
    // client gets is a fact about their own configuration and they are the
    // ones who can change it. What stays true either way: it never generates
    // footage, and pasting a link is now a way in beside uploading.
    const clipping = mediaSourceHint("tiktok-clipping-agent", "system");
    expect(clipping).toMatch(/shows on your source list/);
    expect(clipping).toMatch(/open web if you have not set one/);
    expect(clipping).toMatch(/paste a link/);
    expect(clipping).toMatch(/never generates footage/);

    // The products the old sentence was true of keep it, byte for byte.
    expect(mediaSourceHint("tiktok-agent", "system")).toMatch(/finds or generates its own/);
    expect(mediaSourceHint("branded-shorts-agent", "system")).toMatch(/finds or generates its own/);
  });

  it("offers no attach control at all for content design, so it needs no hint", () => {
    // Defined by being handed nothing: `attachmentModeForEngineProduct`
    // returns undefined and the run dialog paints no attachment box.
    expect(attachmentModeForEngineProduct("tiktok-content-design-agent")).toBeUndefined();
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
