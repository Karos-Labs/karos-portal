import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * [SCRUM-260/T-B15, D2/SCRUM-278] Coverage for the run-dispatch half of "the
 * split": `dispatchSeoGeoRecommendationRun` classifies a `RoutableRecommendation`
 * by `owner`/`actionKind` alone (never `recId`) and only ever calls the real
 * `dispatchAgentEngineRun` for `owner: "karos_agent"`, behind
 * `SEO_GEO_RECOMMENDATION_RUN_DISPATCH_ENABLED` (default OFF).
 *
 * Mocking follows dispatch.test.ts's own pattern: only `@/lib/data` and
 * `../pubsub-client` are mocked, so the REAL `dispatchAgentEngineRun` (and
 * this module's own classification logic) runs end-to-end — "triggers a real
 * run" is checked against the actual create-job/publish sequence, not a stub
 * standing in for it.
 *
 * Fixtures: the same four real T-A4 rows T-B14's own
 * routable-recommendation-tasks.test.ts uses (SEO-02 one_click/karos_agent,
 * SEO-04 guided_manual/client_manual, SEO-09 connect/karos_tool, GEO-09
 * review_approve/karos_agent), for consistency across the chain — not
 * invented.
 */

const { createJobMock, updateJobMock, publishAgentEngineRunMock, pubsubConfiguredMock } = vi.hoisted(() => ({
  createJobMock: vi.fn(),
  updateJobMock: vi.fn(),
  publishAgentEngineRunMock: vi.fn(),
  pubsubConfiguredMock: vi.fn(() => true),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/data", () => ({ createJob: createJobMock, updateJob: updateJobMock }));
vi.mock("../pubsub-client", () => ({
  isAgentEnginePubSubConfigured: pubsubConfiguredMock,
  publishAgentEngineRun: publishAgentEngineRunMock,
  agentEngineRunIdFromMessageId: (messageId: string) => `pubsub-${messageId}`,
}));
// No middleware base URL configured in the test env, so dispatchAgentEngineRun
// always takes the direct-publish branch — the real, unmocked check in
// middleware-client.ts already returns false here; nothing to stub.

import { toRoutableRecommendation, type RoutableRecommendation } from "../routable-recommendation";
import {
  dispatchSeoGeoRecommendationRun,
  isSeoGeoRecommendationRunDispatchEnabled,
  seoGeoRecommendationRunMode,
} from "../dispatch-recommendation-run";

function baseRaw(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    recId: "ZZZ-000",
    recommendation: "placeholder",
    fireState: "fail",
    worstNorm: 0.4,
    scoreLift: 3.2,
    impact: "high",
    effort: "quick",
    delivery: "agent-direct",
    priorityScore: 512,
    hardOverride: false,
    ...overrides,
  };
}

const SEO_02 = toRoutableRecommendation(
  baseRaw({
    recId: "SEO-02",
    recommendation: "Title tags are being truncated in search results.",
    impact: "high",
    fixAction: "meta_title",
    actionKind: "one_click",
    owner: "karos_agent",
    engineProductId: "seo-geo-agent",
  }),
)!;

const SEO_04 = toRoutableRecommendation(
  baseRaw({
    recId: "SEO-04",
    recommendation: "Core Web Vitals need a manual performance pass.",
    impact: "medium",
    fixAction: "manual",
    actionKind: "guided_manual",
    owner: "client_manual",
  }),
)!;

const SEO_09 = toRoutableRecommendation(
  baseRaw({
    recId: "SEO-09",
    recommendation: "Connect Google Search Console to verify indexing.",
    impact: "low",
    fixAction: "manual",
    actionKind: "connect",
    owner: "karos_tool",
    targetPlatform: "search-console",
  }),
)!;

const GEO_09 = toRoutableRecommendation(
  baseRaw({
    recId: "GEO-09",
    recommendation: "Add a byline and original statistics to key pages.",
    impact: "critical",
    fixAction: "manual",
    actionKind: "review_approve",
    owner: "karos_agent",
    engineProductId: "seo-geo-agent",
  }),
)!;

const CLIENT = { id: "client_1", name: "Acme", agentsRepoSlug: "acme" };

const ORIGINAL_FLAG = process.env.SEO_GEO_RECOMMENDATION_RUN_DISPATCH_ENABLED;

function setFlag(value: "true" | undefined) {
  if (value === undefined) delete process.env.SEO_GEO_RECOMMENDATION_RUN_DISPATCH_ENABLED;
  else process.env.SEO_GEO_RECOMMENDATION_RUN_DISPATCH_ENABLED = value;
}

describe("isSeoGeoRecommendationRunDispatchEnabled", () => {
  afterEach(() => setFlag(ORIGINAL_FLAG as "true" | undefined));

  it("defaults OFF when unset", () => {
    setFlag(undefined);
    expect(isSeoGeoRecommendationRunDispatchEnabled()).toBe(false);
  });

  it("is OFF for anything other than the literal string 'true'", () => {
    process.env.SEO_GEO_RECOMMENDATION_RUN_DISPATCH_ENABLED = "1";
    expect(isSeoGeoRecommendationRunDispatchEnabled()).toBe(false);
  });

  it("is ON only for the literal string 'true'", () => {
    process.env.SEO_GEO_RECOMMENDATION_RUN_DISPATCH_ENABLED = "true";
    expect(isSeoGeoRecommendationRunDispatchEnabled()).toBe(true);
  });
});

describe("seoGeoRecommendationRunMode — one_click vs review_approve, both karos_agent", () => {
  it("one_click -> apply (the click IS the ship)", () => {
    expect(seoGeoRecommendationRunMode("one_click")).toBe("apply");
  });
  it("review_approve -> draft (the click authorizes a draft, not a final ship)", () => {
    expect(seoGeoRecommendationRunMode("review_approve")).toBe("draft");
  });
  it("connect and guided_manual also fall to draft (never reached in practice — owner gates first)", () => {
    expect(seoGeoRecommendationRunMode("connect")).toBe("draft");
    expect(seoGeoRecommendationRunMode("guided_manual")).toBe("draft");
  });
});

describe("dispatchSeoGeoRecommendationRun — the three-way classification, real dispatch chain", () => {
  beforeEach(() => {
    createJobMock.mockReset().mockResolvedValue("job_1");
    updateJobMock.mockReset();
    publishAgentEngineRunMock.mockReset().mockResolvedValue({ messageId: "msg_1" });
    pubsubConfiguredMock.mockReset().mockReturnValue(true);
    setFlag("true");
  });
  afterEach(() => setFlag(ORIGINAL_FLAG as "true" | undefined));

  it("SEO-02 (one_click/karos_agent): dispatches a real run in apply mode", async () => {
    const outcome = await dispatchSeoGeoRecommendationRun(SEO_02, CLIENT, "staff-1");
    expect(outcome).toMatchObject({ dispatched: true, mode: "apply" });
    expect(createJobMock).toHaveBeenCalledTimes(1);
    expect(publishAgentEngineRunMock).toHaveBeenCalledTimes(1);
    const envelope = publishAgentEngineRunMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(envelope.productId).toBe("seo-geo-agent");
    expect(envelope.input).toEqual({ recId: "SEO-02", fixAction: "meta_title", mode: "apply" });
    if (outcome.dispatched) {
      expect(outcome.result).toEqual({ jobId: "job_1", agentEngineRunId: "pubsub-msg_1" });
    }
  });

  it("GEO-09 (review_approve/karos_agent): dispatches a real run in draft mode, not apply", async () => {
    const outcome = await dispatchSeoGeoRecommendationRun(GEO_09, CLIENT, "staff-1");
    expect(outcome).toMatchObject({ dispatched: true, mode: "draft" });
    expect(createJobMock).toHaveBeenCalledTimes(1);
    const envelope = publishAgentEngineRunMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(envelope.input).toEqual({ recId: "GEO-09", fixAction: "manual", mode: "draft" });
  });

  it("SEO-09 (connect/karos_tool): never dispatches — 'a tool runs it' is not a full agent-engine run here", async () => {
    const outcome = await dispatchSeoGeoRecommendationRun(SEO_09, CLIENT, "staff-1");
    expect(outcome.dispatched).toBe(false);
    expect(createJobMock).not.toHaveBeenCalled();
    expect(publishAgentEngineRunMock).not.toHaveBeenCalled();
  });

  it("SEO-04 (guided_manual/client_manual): never dispatches — always the client's own action", async () => {
    const outcome = await dispatchSeoGeoRecommendationRun(SEO_04, CLIENT, "staff-1");
    expect(outcome.dispatched).toBe(false);
    expect(createJobMock).not.toHaveBeenCalled();
  });

  it("a karos_agent record with no verified engineProductId never dispatches, even with the flag on", async () => {
    // Constructed directly, bypassing toRoutableRecommendation's own boundary
    // check, to prove THIS module's own defensive re-check independent of the
    // parser's (mirrors routable-recommendation-tasks.ts's own re-check).
    const suspect: RoutableRecommendation = { ...SEO_02, engineProductId: "not-a-real-product" };
    const outcome = await dispatchSeoGeoRecommendationRun(suspect, CLIENT, "staff-1");
    expect(outcome.dispatched).toBe(false);
    expect(createJobMock).not.toHaveBeenCalled();
  });

  it("a client with no agentsRepoSlug never dispatches, even for a karos_agent/one_click rec with the flag on", async () => {
    const outcome = await dispatchSeoGeoRecommendationRun(SEO_02, { id: "c2", name: "No Slug Co" }, "staff-1");
    expect(outcome.dispatched).toBe(false);
    expect(createJobMock).not.toHaveBeenCalled();
  });

  it("PRODUCTION SAFETY: the exact same karos_agent/one_click approval does NOT dispatch when the flag is OFF (its default)", async () => {
    setFlag(undefined);
    const outcome = await dispatchSeoGeoRecommendationRun(SEO_02, CLIENT, "staff-1");
    expect(outcome.dispatched).toBe(false);
    expect(createJobMock).not.toHaveBeenCalled();
    expect(publishAgentEngineRunMock).not.toHaveBeenCalled();
  });
});
