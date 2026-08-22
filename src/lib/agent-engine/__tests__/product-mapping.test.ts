import { describe, expect, it } from "vitest";
import {
  isClientEnabledForEngineCustomAgents,
  resolveAgentEngineProductId,
  resolveAgentEngineProductIdForCustomAgent,
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

  it("leaves setup and manager variants on agent-service", () => {
    // These are different products — onboarding interviews and account
    // management — with no engine workflow behind them. A prefix match would
    // route an onboarding interview into a post-drafting workflow.
    for (const key of [
      "karos-linkedin-setup-v2",
      "karos-linkedin-manager-v2",
      "karos-reddit-setup",
      "karos-newsletter-writer-v2",
      "karos-blog-writer-v2",
    ]) {
      expect(resolveAgentEngineProductIdForCustomAgent(key)).toBeUndefined();
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
