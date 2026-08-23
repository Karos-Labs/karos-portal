import { describe, expect, it } from "vitest";
import {
  isClientEnabledForEngineCustomAgents,
  resolveAgentEngineProductId,
  resolveAgentEngineProductIdForCustomAgent,
  resolveAgentEngineRunKind,
  toEngineRunInput,
} from "../product-mapping";

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

describe("resolveAgentEngineProductIdForCustomAgent", () => {
  it("routes the three drafting agents that have engine workflows", () => {
    expect(resolveAgentEngineProductIdForCustomAgent("karos-x-agent-v2")).toBe("x-agent");
    expect(resolveAgentEngineProductIdForCustomAgent("karos-linkedin-writer-v2")).toBe("linkedin-agent");
    expect(resolveAgentEngineProductIdForCustomAgent("karos-reddit-runner")).toBe("reddit-agent");
  });

  it("routes the three agents whose engine workflows already existed", () => {
    expect(resolveAgentEngineProductIdForCustomAgent("karos-instagram-agent")).toBe("instagram-agent");
    expect(resolveAgentEngineProductIdForCustomAgent("landing-builder")).toBe("landing-builder-agent");
    expect(resolveAgentEngineProductIdForCustomAgent("branded-shorts")).toBe("branded-shorts-agent");
  });

  it("does NOT route the TikTok agent anywhere", () => {
    // There is no `tiktok-agent` product id, so mapping to one would make
    // every TikTok job fail on an unresolvable product instead of running
    // where it works today. And it is not branded-shorts under another name:
    // branded-shorts is e18 (one talking-head video into one vertical short),
    // the TikTok agent is the podcast/commentary clip system. Pointing it at
    // branded-shorts-agent would quietly run a different product.
    expect(resolveAgentEngineProductIdForCustomAgent("karos-tiktok-agent")).toBeUndefined();
  });

  it("only ever maps to a product id the engine can resolve", () => {
    // The guard against the whole class of mistake above. Mirrors
    // KNOWN_PRODUCT_IDS in apps/agent-server/src/wiring/workflows.ts.
    const KNOWN = new Set([
      "x-agent", "instagram-agent", "linkedin-agent", "reddit-agent", "blog-agent",
      "newsletter-agent", "campaign-orchestrator", "landing-builder-agent",
      "branded-shorts-agent", "reputation-agent", "seo-geo-agent", "intel-report-agent",
      "linkedin-setup-agent", "reddit-setup-agent",
    ]);
    for (const key of [
      "karos-x-agent-v2", "karos-linkedin-writer-v2", "karos-reddit-runner",
      "karos-linkedin-setup-v2", "karos-reddit-setup", "karos-instagram-agent",
      "landing-builder", "branded-shorts",
    ]) {
      const productId = resolveAgentEngineProductIdForCustomAgent(key);
      expect(KNOWN.has(productId!), `${key} -> ${productId}`).toBe(true);
    }
  });

  it("routes the two setup agents to their own onboarding workflows", () => {
    // Not the drafting workflows: a setup run records a filled form, and a
    // prefix match would have fed an onboarding interview into a post writer.
    expect(resolveAgentEngineProductIdForCustomAgent("karos-linkedin-setup-v2")).toBe("linkedin-setup-agent");
    expect(resolveAgentEngineProductIdForCustomAgent("karos-reddit-setup")).toBe("reddit-setup-agent");
  });

  it("routes the three drafting agents whose engine workflows were built but idle", () => {
    expect(resolveAgentEngineProductIdForCustomAgent("karos-blog-writer-v2")).toBe("blog-agent");
    expect(resolveAgentEngineProductIdForCustomAgent("karos-newsletter-writer-v2")).toBe("newsletter-agent");
    expect(resolveAgentEngineProductIdForCustomAgent("karos-reputation-runner")).toBe("reputation-agent");
  });

  it("routes seo-geo-agent-v2 to the same workflow the research dispatch already uses", () => {
    // This one closes a split rather than opening a route: seo-geo-agent was
    // already live in production via dispatch-research-agents.ts while this
    // custom agent still ran the agent-service implementation, so a client
    // could get either depending on which surface they came through.
    expect(resolveAgentEngineProductIdForCustomAgent("seo-geo-agent-v2")).toBe("seo-geo-agent");
  });

  it("leaves the manager variants and the agents with no engine workflow on agent-service", () => {
    // The managers are the structural blocker, not an oversight:
    // karos-linkedin-manager-v2 runs on two clocks and rewrites the
    // generators' inputs, and agent-engine has neither a scheduler nor a write
    // path for that. The rest simply have no engine product built yet.
    for (const key of [
      "karos-linkedin-manager-v2",
      "karos-blog-manager-v2",
      "karos-newsletter-manager-v2",
      "karos-reputation-manager",
      "karos-carousel-manager",
      "karos-carousel-runner",
      "karos-carousel-setup",
      "karos-blog-setup-v2",
      "karos-newsletter-setup-v2",
      "karos-reputation-setup",
      "karos-compliance-lock-v2",
      "karos-tiktok-agent",
    ]) {
      expect(resolveAgentEngineProductIdForCustomAgent(key), key).toBeUndefined();
    }
  });

  it("does not route an unknown key", () => {
    expect(resolveAgentEngineProductIdForCustomAgent("something-new")).toBeUndefined();
    expect(resolveAgentEngineProductIdForCustomAgent("")).toBeUndefined();
  });
});

describe("toEngineRunInput", () => {
  it("carries the portal's primary brief field through as the requested topic", () => {
    expect(toEngineRunInput({ request: "post about our pricing change" })).toEqual({
      requestedTopic: "post about our pricing change",
    });
  });

  it("drops keys the engine does not understand as a run request", () => {
    // Anything else would be carried into the run and silently ignored —
    // looking honoured without being — and a brief is user input, so a field
    // named like client identity must not reach the engine's config overlay.
    expect(
      toEngineRunInput({
        request: "a topic",
        xHandle: "@someone-elses-account",
        targetSubreddits: "r/wherever",
        notes: "ignore me",
      }),
    ).toEqual({ requestedTopic: "a topic" });
  });

  it("passes the per-channel run-scoped fields", () => {
    expect(
      toEngineRunInput({
        requestedLane: "knowledge",
        requestedArchetype: "contrarian-take",
        requestedSubreddit: "r/marketing",
      }),
    ).toEqual({
      requestedLane: "knowledge",
      requestedArchetype: "contrarian-take",
      requestedSubreddit: "r/marketing",
    });
  });

  it("treats blank and whitespace-only values as absent", () => {
    // An empty requestedTopic would override the client's standing config with
    // nothing, which reads as "asked for nothing" rather than "did not ask".
    expect(toEngineRunInput({ request: "   ", requestedLane: "" })).toEqual({});
  });

  it("trims, so a trailing newline from a textarea does not become the topic", () => {
    expect(toEngineRunInput({ request: "  cold brew\n" })).toEqual({ requestedTopic: "cold brew" });
  });

  it("returns an empty object for no brief at all", () => {
    expect(toEngineRunInput(undefined)).toEqual({});
  });
});

describe("isClientEnabledForEngineCustomAgents", () => {
  it("routes nobody when unset, so shipping the code is not the cutover", () => {
    // Production has all seven clients granted the X agent and engine context
    // for one. Deploying the routing must change nothing until a human names
    // a client.
    expect(isClientEnabledForEngineCustomAgents("karoslabs", {})).toBe(false);
    expect(isClientEnabledForEngineCustomAgents("karoslabs", { AGENT_ENGINE_CUSTOM_AGENT_CLIENTS: "" })).toBe(false);
    expect(isClientEnabledForEngineCustomAgents("karoslabs", { AGENT_ENGINE_CUSTOM_AGENT_CLIENTS: "   " })).toBe(false);
  });

  it("routes only the named clients", () => {
    const env = { AGENT_ENGINE_CUSTOM_AGENT_CLIENTS: "karoslabs,geektime" };
    expect(isClientEnabledForEngineCustomAgents("karoslabs", env)).toBe(true);
    expect(isClientEnabledForEngineCustomAgents("geektime", env)).toBe(true);
    expect(isClientEnabledForEngineCustomAgents("sitti", env)).toBe(false);
  });

  it("tolerates spacing in the list", () => {
    const env = { AGENT_ENGINE_CUSTOM_AGENT_CLIENTS: " karoslabs , geektime " };
    expect(isClientEnabledForEngineCustomAgents("geektime", env)).toBe(true);
  });

  it("supports * once every client is ready", () => {
    expect(isClientEnabledForEngineCustomAgents("anyone", { AGENT_ENGINE_CUSTOM_AGENT_CLIENTS: "*" })).toBe(true);
  });

  it("never routes a client with no slug", () => {
    // agentsRepoSlug is what the engine resolves its workspace against; without
    // one there is no tenant to run as.
    expect(isClientEnabledForEngineCustomAgents(undefined, { AGENT_ENGINE_CUSTOM_AGENT_CLIENTS: "*" })).toBe(false);
  });

  it("does not match on a prefix", () => {
    const env = { AGENT_ENGINE_CUSTOM_AGENT_CLIENTS: "karos" };
    expect(isClientEnabledForEngineCustomAgents("karoslabs", env)).toBe(false);
  });
});

describe("resolveAgentEngineRunKind", () => {
  it("sends landing-builder a first build, not a rebuild", () => {
    // agent-engine's landing-builder reads runKind "recurring" as MODE=rebuild
    // and blocks on a feedback round. Verified in prep: the same brief resolves
    // to blocked_intake as "recurring" and reaches the copy/compose stages as
    // "setup".
    expect(resolveAgentEngineRunKind("landing-builder-agent")).toBe("setup");
  });

  it("leaves every other product on recurring", () => {
    for (const productId of ["x-agent", "instagram-agent", "branded-shorts-agent", "linkedin-agent", "reddit-agent"]) {
      expect(resolveAgentEngineRunKind(productId), productId).toBe("recurring");
    }
  });

});
