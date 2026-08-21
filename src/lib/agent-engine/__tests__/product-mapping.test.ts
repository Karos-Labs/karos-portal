import { describe, expect, it } from "vitest";
import { resolveAgentEngineProductId } from "../product-mapping";

describe("resolveAgentEngineProductId", () => {
  it("maps landing_page directly onto landing-builder-agent, brief-independent", () => {
    expect(resolveAgentEngineProductId("landing_page", { page_goal: "leads" })).toBe("landing-builder-agent");
    expect(resolveAgentEngineProductId("landing_page", {})).toBe("landing-builder-agent");
  });

  it("maps social_post + platform:instagram onto instagram-agent", () => {
    expect(resolveAgentEngineProductId("social_post", { platform: "instagram" })).toBe("instagram-agent");
  });

  it("maps social_post + platform:tiktok onto branded-shorts-agent", () => {
    expect(resolveAgentEngineProductId("social_post", { platform: "tiktok" })).toBe("branded-shorts-agent");
  });

  it("is case-insensitive on platform", () => {
    expect(resolveAgentEngineProductId("social_post", { platform: "Instagram" })).toBe("instagram-agent");
    expect(resolveAgentEngineProductId("social_post", { platform: "TIKTOK" })).toBe("branded-shorts-agent");
  });

  it("returns undefined for social_post with no recognized platform — never a guess", () => {
    expect(resolveAgentEngineProductId("social_post", {})).toBeUndefined();
    expect(resolveAgentEngineProductId("social_post", { platform: "facebook" })).toBeUndefined();
    expect(resolveAgentEngineProductId("social_post", { platform: 42 })).toBeUndefined();
  });

  it("returns undefined for custom agent jobs — agent-engine has no mechanism to run a user-authored spec", () => {
    expect(resolveAgentEngineProductId("custom", { agent_key: "x-agent" })).toBeUndefined();
  });
});
