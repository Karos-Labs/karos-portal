import { describe, expect, it, vi, afterEach } from "vitest";

const { dispatchEnabledMock, transportConfiguredMock } = vi.hoisted(() => ({
  dispatchEnabledMock: vi.fn(() => false),
  transportConfiguredMock: vi.fn(() => false),
}));

vi.mock("server-only", () => ({}));
// Real error class stays real elsewhere; here we only need the two booleans
// health.ts reads off dispatch.ts, stubbed so each test controls them
// independently of any real transport/env wiring.
vi.mock("../dispatch", () => ({
  isAgentEngineDispatchEnabled: dispatchEnabledMock,
  isAgentEngineTransportConfigured: transportConfiguredMock,
}));

import {
  clientHasEngineRoutedCustomAgent,
  resolveDispatchedAgentEngineProductId,
  shouldShowEngineHealthBanner,
} from "../health";

afterEach(() => {
  vi.unstubAllEnvs();
  dispatchEnabledMock.mockReset().mockReturnValue(false);
  transportConfiguredMock.mockReset().mockReturnValue(false);
});

describe("clientHasEngineRoutedCustomAgent", () => {
  it("is false when the global dispatch flag is off, even for a client with an engine-mapped agent", () => {
    dispatchEnabledMock.mockReturnValue(false);
    expect(clientHasEngineRoutedCustomAgent("karoslabs", ["karos-x-agent-v2"])).toBe(false);
  });

  it("is false when the client has no lab slug — there is no tenant for the engine to run as", () => {
    dispatchEnabledMock.mockReturnValue(true);
    expect(clientHasEngineRoutedCustomAgent(undefined, ["karos-x-agent-v2"])).toBe(false);
    expect(clientHasEngineRoutedCustomAgent("", ["karos-x-agent-v2"])).toBe(false);
  });

  it("is false when none of the client's enabled agent keys map to an engine product", () => {
    dispatchEnabledMock.mockReturnValue(true);
    expect(clientHasEngineRoutedCustomAgent("karoslabs", ["some-unmapped-agent-key"])).toBe(false);
  });

  it("is true for ANY client with a slug once one of their agent keys maps to an engine product — no allowlist", () => {
    dispatchEnabledMock.mockReturnValue(true);
    // "karos-x-agent-v2" is one of the real ENGINE_PRODUCT_BY_CUSTOM_AGENT_KEY
    // entries in product-mapping.ts, exercised for real (not stubbed) here.
    expect(clientHasEngineRoutedCustomAgent("karoslabs", ["some-unmapped-agent-key", "karos-x-agent-v2"])).toBe(true);
    // The six clients that used to fall through to the deleted agent-service
    // (2026-09-06: every run from Pitch by Deel's client view was a 404).
    expect(clientHasEngineRoutedCustomAgent("thepitchbydeel", ["karos-instagram-agent"])).toBe(true);
  });

  it("ignores AGENT_ENGINE_CUSTOM_AGENT_CLIENTS entirely — a stale deploy value cannot re-gate anyone", () => {
    dispatchEnabledMock.mockReturnValue(true);
    vi.stubEnv("AGENT_ENGINE_CUSTOM_AGENT_CLIENTS", "someone-else");
    expect(clientHasEngineRoutedCustomAgent("karoslabs", ["karos-x-agent-v2"])).toBe(true);
    expect(resolveDispatchedAgentEngineProductId("karos-x-agent-v2", "karoslabs")).toBe("x-agent");
  });
});

describe("shouldShowEngineHealthBanner", () => {
  it("is false for a client not routed to agent-engine, no matter how broken the transport is", () => {
    dispatchEnabledMock.mockReturnValue(false);
    transportConfiguredMock.mockReturnValue(false);
    expect(shouldShowEngineHealthBanner("karoslabs", ["karos-x-agent-v2"])).toBe(false);
  });

  it("is false for a routed client once the transport IS configured", () => {
    dispatchEnabledMock.mockReturnValue(true);
    transportConfiguredMock.mockReturnValue(true);
    expect(shouldShowEngineHealthBanner("karoslabs", ["karos-x-agent-v2"])).toBe(false);
  });

  it("is true (the actual failure this ticket is about) once a client is routed to agent-engine and its transport is not configured", () => {
    dispatchEnabledMock.mockReturnValue(true);
    transportConfiguredMock.mockReturnValue(false);
    expect(shouldShowEngineHealthBanner("karoslabs", ["karos-x-agent-v2"])).toBe(true);
  });
});

/**
 * SCRUM-249 (T-B5): this is the exact per-run gate `submit-custom.ts`
 * applies before it ever creates a job doc, and the fix for a review finding
 * against a prior version of the chat route, which asked
 * `resolveAgentEngineProductIdForCustomAgent(agent.key)` ALONE - true the
 * moment agent-engine has ANY workflow for that agent key, completely
 * independent of whether dispatch is enabled globally or the client has a
 * lab slug to run as.
 */
describe("resolveDispatchedAgentEngineProductId", () => {
  it("is undefined when the global dispatch flag is off, even for an engine-mapped agent", () => {
    dispatchEnabledMock.mockReturnValue(false);
    expect(resolveDispatchedAgentEngineProductId("karos-x-agent-v2", "karoslabs")).toBeUndefined();
  });

  it("is undefined for an agent key with no engine workflow", () => {
    dispatchEnabledMock.mockReturnValue(true);
    expect(resolveDispatchedAgentEngineProductId("some-unmapped-agent-key", "karoslabs")).toBeUndefined();
  });

  it("is undefined when clientSlug itself is undefined (client.agentsRepoSlug unset)", () => {
    dispatchEnabledMock.mockReturnValue(true);
    expect(resolveDispatchedAgentEngineProductId("karos-x-agent-v2", undefined)).toBeUndefined();
  });

  it("resolves the real productId once both conditions hold - dispatch enabled and agent key mapped - for every client with a slug", () => {
    dispatchEnabledMock.mockReturnValue(true);
    expect(resolveDispatchedAgentEngineProductId("karos-x-agent-v2", "karoslabs")).toBe("x-agent");
    expect(resolveDispatchedAgentEngineProductId("karos-x-agent-v2", "thepitchbydeel")).toBe("x-agent");
    expect(resolveDispatchedAgentEngineProductId("karos-instagram-agent", "geektime")).toBe("instagram-agent");
  });
});
