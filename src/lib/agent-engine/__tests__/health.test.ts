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
  it("is false when the global dispatch flag is off, even for a named client with an engine-mapped agent", () => {
    dispatchEnabledMock.mockReturnValue(false);
    vi.stubEnv("AGENT_ENGINE_CUSTOM_AGENT_CLIENTS", "*");
    expect(clientHasEngineRoutedCustomAgent("karoslabs", ["karos-x-agent-v2"])).toBe(false);
  });

  it("is false when the client is not in AGENT_ENGINE_CUSTOM_AGENT_CLIENTS", () => {
    dispatchEnabledMock.mockReturnValue(true);
    vi.stubEnv("AGENT_ENGINE_CUSTOM_AGENT_CLIENTS", "geektime");
    expect(clientHasEngineRoutedCustomAgent("karoslabs", ["karos-x-agent-v2"])).toBe(false);
  });

  it("is false when the client is cut over but none of their enabled agent keys map to an engine product", () => {
    dispatchEnabledMock.mockReturnValue(true);
    vi.stubEnv("AGENT_ENGINE_CUSTOM_AGENT_CLIENTS", "karoslabs");
    expect(clientHasEngineRoutedCustomAgent("karoslabs", ["some-unmapped-agent-key"])).toBe(false);
  });

  it("is true once the client is cut over AND one of their agent keys maps to an engine product", () => {
    dispatchEnabledMock.mockReturnValue(true);
    vi.stubEnv("AGENT_ENGINE_CUSTOM_AGENT_CLIENTS", "karoslabs");
    // "karos-x-agent-v2" is one of the real ENGINE_PRODUCT_BY_CUSTOM_AGENT_KEY
    // entries in product-mapping.ts, exercised for real (not stubbed) here.
    expect(clientHasEngineRoutedCustomAgent("karoslabs", ["some-unmapped-agent-key", "karos-x-agent-v2"])).toBe(true);
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
    vi.stubEnv("AGENT_ENGINE_CUSTOM_AGENT_CLIENTS", "karoslabs");
    transportConfiguredMock.mockReturnValue(true);
    expect(shouldShowEngineHealthBanner("karoslabs", ["karos-x-agent-v2"])).toBe(false);
  });

  it("is true (the actual failure this ticket is about) once a client is routed to agent-engine and its transport is not configured", () => {
    dispatchEnabledMock.mockReturnValue(true);
    vi.stubEnv("AGENT_ENGINE_CUSTOM_AGENT_CLIENTS", "karoslabs");
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
 * independent of whether dispatch is enabled globally or this client has
 * been cut over. That let a client not yet cut over (the normal state for
 * most clients mid-migration) be told a file was "attached as source media
 * for this run" when the run actually fell through to the legacy
 * agent-service path, which never reads `mediaAssets` at all.
 */
describe("resolveDispatchedAgentEngineProductId", () => {
  it("is undefined when the global dispatch flag is off, even for a cut-over client with an engine-mapped agent", () => {
    dispatchEnabledMock.mockReturnValue(false);
    vi.stubEnv("AGENT_ENGINE_CUSTOM_AGENT_CLIENTS", "*");
    expect(resolveDispatchedAgentEngineProductId("karos-x-agent-v2", "karoslabs")).toBeUndefined();
  });

  it("is undefined when the client is not in AGENT_ENGINE_CUSTOM_AGENT_CLIENTS - the realistic mid-migration state this finding was about", () => {
    dispatchEnabledMock.mockReturnValue(true);
    vi.stubEnv("AGENT_ENGINE_CUSTOM_AGENT_CLIENTS", "geektime");
    expect(resolveDispatchedAgentEngineProductId("karos-x-agent-v2", "karoslabs")).toBeUndefined();
  });

  it("is undefined for a cut-over client whose agent key has no engine workflow", () => {
    dispatchEnabledMock.mockReturnValue(true);
    vi.stubEnv("AGENT_ENGINE_CUSTOM_AGENT_CLIENTS", "karoslabs");
    expect(resolveDispatchedAgentEngineProductId("some-unmapped-agent-key", "karoslabs")).toBeUndefined();
  });

  it("is undefined when clientSlug itself is undefined (client.agentsRepoSlug unset)", () => {
    dispatchEnabledMock.mockReturnValue(true);
    vi.stubEnv("AGENT_ENGINE_CUSTOM_AGENT_CLIENTS", "*");
    expect(resolveDispatchedAgentEngineProductId("karos-x-agent-v2", undefined)).toBeUndefined();
  });

  it("resolves the real productId once all three conditions hold - dispatch enabled, client cut over, agent key mapped", () => {
    dispatchEnabledMock.mockReturnValue(true);
    vi.stubEnv("AGENT_ENGINE_CUSTOM_AGENT_CLIENTS", "karoslabs");
    expect(resolveDispatchedAgentEngineProductId("karos-x-agent-v2", "karoslabs")).toBe("x-agent");
  });
});
