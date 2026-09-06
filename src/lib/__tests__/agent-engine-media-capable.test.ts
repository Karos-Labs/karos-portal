import { describe, expect, it } from "vitest";
import { agentEngineProductAcceptsMediaAssets, withEngineRunFields, type AgentLaunchProfile } from "@/lib/custom-agent-launch";

/**
 * T-B5: `agentEngineProductAcceptsMediaAssets` is the ONE predicate both the
 * run dialog (`withEngineRunFields`, deciding whether to paint the
 * `mediaAssets` textarea) and the copilot chat route (deciding whether to
 * fold a real upload into `briefValues.mediaAssets`) now share. This pins the
 * predicate itself and that `withEngineRunFields` actually calls through it
 * rather than a second, silently-divergent copy of the media-dependent-
 * product list.
 *
 * This predicate answers ONLY "does this engine product read mediaAssets" -
 * it says nothing about whether a given client's runs actually reach
 * agent-engine at all. That second, per-client question is
 * `resolveDispatchedAgentEngineProductId` (agent-engine/health.ts),
 * exercised separately in dispatch-gated-media-assets.test.ts.
 */

const BASE_PROFILE: AgentLaunchProfile = {
  eyebrow: "",
  intro: "",
  fields: [],
  quickStarts: [],
  deliverables: [],
  estimate: "",
  attachments: { label: "", hint: "" },
};

describe("agentEngineProductAcceptsMediaAssets", () => {
  it("is true for each known media-dependent engine product", () => {
    expect(agentEngineProductAcceptsMediaAssets("instagram-agent")).toBe(true);
    expect(agentEngineProductAcceptsMediaAssets("branded-shorts-agent")).toBe(true);
    expect(agentEngineProductAcceptsMediaAssets("tiktok-agent")).toBe(true);
    // agent-engine RFC-12 (2026-09): the text-first channels read an attached
    // image too — the post is written to it.
    expect(agentEngineProductAcceptsMediaAssets("x-agent")).toBe(true);
    expect(agentEngineProductAcceptsMediaAssets("linkedin-agent")).toBe(true);
  });

  it("is false for an engine product that does not consume media", () => {
    expect(agentEngineProductAcceptsMediaAssets("blog-agent")).toBe(false);
    expect(agentEngineProductAcceptsMediaAssets("landing-builder-agent")).toBe(false);
  });

  it("is false for undefined (no engine product resolved at all - the legacy agent-service path)", () => {
    expect(agentEngineProductAcceptsMediaAssets(undefined)).toBe(false);
  });
});

describe("withEngineRunFields defers to the same predicate", () => {
  it("paints the mediaAssets field for a media-dependent product", () => {
    const profile = withEngineRunFields(BASE_PROFILE, "instagram-agent");
    expect(profile.fields.some((f) => f.key === "mediaAssets")).toBe(true);
  });

  it("does not paint the mediaAssets field for a non-media-dependent product", () => {
    const profile = withEngineRunFields(BASE_PROFILE, "blog-agent");
    expect(profile.fields.some((f) => f.key === "mediaAssets")).toBe(false);
  });
});
