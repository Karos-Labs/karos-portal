import { agentArchetype } from "@/lib/agent-archetype";
/**
 * D08: TikTok is three agents, and each must reach its OWN workflow.
 *
 * The failure this exists to catch is silent by construction. `launchProfileFor`
 * takes the FIRST matching profile, and the shared social profile matches
 * `/instagram|tiktok|content.?engine/` against "<key> <name>" — which every key
 * here contains. A profile added below that matcher, or a key renamed, hands the
 * client the Instagram carousel brief instead: they are asked for a carousel
 * format, the run dispatches with the wrong fields, and all three products still
 * return a vertical video, so nothing looks broken.
 *
 * So this asserts the whole path rather than any one table: key -> engine
 * product, key -> its own brief, and the brief's answers -> the run input the
 * engine actually receives.
 */
import { describe, expect, it } from "vitest";
import { launchProfileFor, attachmentModeForEngineProduct, clientOnlyMediaIsRequired, isSupersededAgentKey, isUnlistedAgent } from "@/lib/custom-agent-launch";
import { toEngineRunInput, resolveAgentEngineProductIdForCustomAgent, ENGINE_PRODUCTS_READING_MEDIA_ASSETS } from "@/lib/agent-engine/product-mapping";

const CASES = [
  // Names as renamed 2026-09-22 (Clipper, Editor, Producer); the old D08 names
  // are what a stored record may still carry until the roster sync runs, and
  // the profile resolves by key either way.
  { key: "karos-tiktok-clipping", name: "TikTok Clipper", product: "tiktok-clipping-agent", eyebrow: "TikTok Clipper" },
  { key: "karos-tiktok-editing", name: "TikTok editing", product: "tiktok-editing-agent", eyebrow: "TikTok Editor" },
  { key: "karos-tiktok-content-design", name: "TikTok content design (beta)", product: "tiktok-content-design-agent", eyebrow: "TikTok Producer" },
] as const;

describe("D08 dispatch trace", () => {
  for (const c of CASES) {
    it(`${c.key} -> ${c.product}, with its own brief`, () => {
      expect(resolveAgentEngineProductIdForCustomAgent(c.key)).toBe(c.product);
      const profile = launchProfileFor({ key: c.key, name: c.name } as never);
      expect(profile.eyebrow, `${c.key} fell through to another profile`).toBe(c.eyebrow);
      console.log(`${c.key}: fields = ${profile.fields.map((f) => f.key).join(", ")}`);
    });
  }

  it("editing carries all five of Albert's per-run fields", () => {
    const p = launchProfileFor({ key: "karos-tiktok-editing", name: "TikTok editing" } as never);
    const keys = p.fields.map((f) => f.key);
    for (const k of ["request", "platform", "duration", "cta", "editing_notes"]) expect(keys, k).toContain(k);
    const input = toEngineRunInput(
      { request: "the launch story", platform: "tiktok", duration: "30_seconds", cta: "book a demo", editing_notes: "keep the quote at 0:42", source_url: "https://example.com/v.mp4" },
      "tiktok-editing-agent",
      { requestSteersRun: false },
    );
    console.log("editing input:", JSON.stringify(input, null, 1));
    expect(input.platform).toBe("tiktok");
    expect(input.duration).toBe("30_seconds");
    expect(input.cta).toBe("book a demo");
    expect(input.requestedTopic).toBe("the launch story");
    expect(String(input.customPrompt)).toContain("keep the quote at 0:42");
    expect(input.mediaAssets, "the source link must be footage, not prose").toBeDefined();
  });

  it("content design takes one optional box and no attach control", () => {
    const p = launchProfileFor({ key: "karos-tiktok-content-design", name: "TikTok content design (beta)" } as never);
    expect(p.fields.map((f) => f.key)).toEqual(["request"]);
    expect(p.attachments).toBeUndefined();
    expect(attachmentModeForEngineProduct("tiktok-content-design-agent")).toBeUndefined();
    expect(ENGINE_PRODUCTS_READING_MEDIA_ASSETS.has("tiktok-content-design-agent")).toBe(false);
  });

  it("clipping may run with an empty link (the 'find podcasts in my niche' half of D08)", () => {
    const p = launchProfileFor({ key: "karos-tiktok-clipping", name: "TikTok clipping" } as never);
    expect(p.fields.find((f) => f.key === "source_url")?.required).toBeFalsy();
    expect(p.attachments?.required).toBeFalsy();
    expect(clientOnlyMediaIsRequired("tiktok-clipping-agent")).toBe(true);
  });

  it("the original monolithic agent is superseded by the three-way split, WITHOUT calling it a step", () => {
    // Same shape as the e10 LinkedIn / v1 Reddit precedent: no parentKey (nothing
    // runs it as a step of another agent), so it stays out of `isSupersededAgentKey`'s
    // sibling `isSubAgent` and is hidden purely because a newer generation replaced
    // it. The doc itself is untouched — every existing grant and in-flight schedule
    // still names `karos-tiktok-agent` — only its roster card disappears.
    expect(isSupersededAgentKey("karos-tiktok-agent")).toBe(true);
    expect(isUnlistedAgent({ key: "karos-tiktok-agent" })).toBe(true);
    for (const c of CASES) {
      expect(isSupersededAgentKey(c.key), c.key).toBe(false);
      expect(isUnlistedAgent({ key: c.key }), c.key).toBe(false);
    }
  });
});

/**
 * The client-facing page shape, for the one product that takes no footage.
 *
 * `agentArchetype` calls content design a `clip_maker` — correctly: its
 * deliverable is a video file, and the archetype is about what an agent MAKES.
 * The source-material card is about what an agent CONSUMES, and those are not
 * the same question. Gating the card on the archetype put "What it cuts from ·
 * Source material · Needed" on the one product defined by being handed
 * nothing, above an empty hint, because the launch profile declares no
 * attachments to describe.
 */
describe("content design asks for no source material", () => {
  const CONTENT_DESIGN = { key: "karos-tiktok-content-design", name: "TikTok content design (beta)" };
  const CLIPPING = { key: "karos-tiktok-clipping", name: "TikTok clipping" };
  const EDITING = { key: "karos-tiktok-editing", name: "TikTok editing" };

  it("is still a clip maker, because its deliverable is a video", () => {
    expect(agentArchetype(CONTENT_DESIGN)).toBe("clip_maker");
  });

  it("declares no attachments, which is what the page gates the card on", () => {
    // undefined -> no "What it cuts from" card. The other two declare one and
    // keep theirs; that is the whole difference between the products.
    expect(launchProfileFor(CONTENT_DESIGN).attachments).toBeUndefined();
    expect(launchProfileFor(CLIPPING).attachments?.hint).toBeTruthy();
    expect(launchProfileFor(EDITING).attachments?.hint).toBeTruthy();
  });
});
