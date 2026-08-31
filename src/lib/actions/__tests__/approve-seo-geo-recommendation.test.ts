/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as data from "@/lib/data";
import * as auth from "@/lib/auth";

/**
 * [SCRUM-260/T-B15, D2/SCRUM-278] Action-level coverage for
 * `approveSeoGeoRecommendationAction` — the acceptance criterion is that
 * approval now triggers a real run for `owner: "karos_agent"` (behind the
 * flag), and that the three-way classification (`owner`/`actionKind`, never
 * `recId`) routes every category correctly. Reuses the same four real T-A4
 * rows the rest of this chain (T-B14, dispatch-recommendation-run.test.ts)
 * uses, for consistency.
 *
 * `@/lib/agent-engine/seo-geo-report-lookup` and
 * `@/lib/agent-engine/dispatch-recommendation-run` are mocked here — their
 * own real behavior is covered directly by dispatch-recommendation-run.test.ts
 * (which exercises the real `dispatchAgentEngineRun` chain). This file's job
 * is to prove the ACTION wires them together correctly: looks the rec up,
 * only calls dispatch for a rec it found, never lets a dispatch failure turn
 * a successful approval into an error response, and logs a second activity
 * entry only when a run actually started.
 */

vi.mock("server-only", () => ({}));
vi.mock("@/lib/data");
vi.mock("@/lib/auth");
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const logActivityMock = vi.fn().mockResolvedValue(undefined);
vi.mock("@/lib/actions/_shared", () => ({
  requireStaff: vi.fn(),
  requireAdmin: vi.fn(),
  logGenerationFailure: vi.fn(),
  logActivity: (...args: unknown[]) => logActivityMock(...args),
}));

const findRoutableRecommendationMock = vi.fn();
vi.mock("@/lib/agent-engine/seo-geo-report-lookup", () => ({
  findRoutableRecommendation: (...args: unknown[]) => findRoutableRecommendationMock(...args),
}));

const dispatchSeoGeoRecommendationRunMock = vi.fn();
vi.mock("@/lib/agent-engine/dispatch-recommendation-run", () => ({
  dispatchSeoGeoRecommendationRun: (...args: unknown[]) => dispatchSeoGeoRecommendationRunMock(...args),
}));

import { approveSeoGeoRecommendationAction } from "../intel-actions";
import { toRoutableRecommendation } from "@/lib/agent-engine/routable-recommendation";

const STAFF_USER = {
  uid: "u-staff",
  email: "staff@karoslabs.test",
  name: "Staff User",
  role: "KAROS_EMPLOYEE",
  disabled: false,
  createdAt: 0,
} as any;

const CLIENT_USER = {
  uid: "u-client",
  email: "client@acme.test",
  name: "Client User",
  role: "CLIENT_USER",
  disabled: false,
  clientId: "c1",
  createdAt: 0,
} as any;

const CLIENT_DOC = { id: "c1", name: "Acme", agentsRepoSlug: "acme" };

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
    fixAction: "meta_title",
    actionKind: "one_click",
    owner: "karos_agent",
    engineProductId: "seo-geo-agent",
  }),
)!;

const SEO_04 = toRoutableRecommendation(
  baseRaw({ recId: "SEO-04", fixAction: "manual", actionKind: "guided_manual", owner: "client_manual" }),
)!;

const SEO_09 = toRoutableRecommendation(
  baseRaw({
    recId: "SEO-09",
    fixAction: "manual",
    actionKind: "connect",
    owner: "karos_tool",
    targetPlatform: "search-console",
  }),
)!;

const GEO_09 = toRoutableRecommendation(
  baseRaw({
    recId: "GEO-09",
    fixAction: "manual",
    actionKind: "review_approve",
    owner: "karos_agent",
    engineProductId: "seo-geo-agent",
  }),
)!;

beforeEach(() => {
  (auth.getCurrentUser as any).mockReset().mockResolvedValue(STAFF_USER);
  (data.approveSeoGeoRecommendation as any).mockReset().mockResolvedValue(["SEO-02"]);
  (data.getClient as any).mockReset().mockResolvedValue(CLIENT_DOC);
  findRoutableRecommendationMock.mockReset();
  dispatchSeoGeoRecommendationRunMock.mockReset();
  logActivityMock.mockReset().mockResolvedValue(undefined);
});
afterEach(() => vi.clearAllMocks());

describe("approveSeoGeoRecommendationAction — authorization (unchanged by this ticket)", () => {
  it("rejects a client user approving on another client's behalf", async () => {
    (auth.getCurrentUser as any).mockResolvedValue(CLIENT_USER);
    const res = await approveSeoGeoRecommendationAction("some-other-client", "SEO-02", "Tighten your page titles");
    expect(res).toEqual({ error: "Forbidden" });
    expect(data.approveSeoGeoRecommendation).not.toHaveBeenCalled();
  });

  it("still persists the approval and logs activity exactly as before when there is no classified rec at all", async () => {
    findRoutableRecommendationMock.mockResolvedValue(undefined);
    const res = await approveSeoGeoRecommendationAction("c1", "SEO-02", "Tighten your page titles");
    expect(res).toMatchObject({ ok: true, approved: ["SEO-02"], runDispatched: false });
    expect(dispatchSeoGeoRecommendationRunMock).not.toHaveBeenCalled();
    // Exactly one activity entry (the approval) — no second "run started" entry.
    expect(logActivityMock).toHaveBeenCalledTimes(1);
    expect(logActivityMock).toHaveBeenCalledWith(expect.objectContaining({ title: "SEO/GEO fix approved" }));
  });
});

describe("approveSeoGeoRecommendationAction — the three-way classification drives dispatch", () => {
  it("SEO-02 (one_click/karos_agent): looks the rec up and dispatches, reporting apply mode", async () => {
    findRoutableRecommendationMock.mockResolvedValue(SEO_02);
    dispatchSeoGeoRecommendationRunMock.mockResolvedValue({
      dispatched: true,
      mode: "apply",
      result: { jobId: "job_1", agentEngineRunId: "run_1" },
    });

    const res = await approveSeoGeoRecommendationAction("c1", "SEO-02", "Tighten your page titles");

    expect(findRoutableRecommendationMock).toHaveBeenCalledWith("c1", "SEO-02");
    expect(dispatchSeoGeoRecommendationRunMock).toHaveBeenCalledWith(SEO_02, CLIENT_DOC, "u-staff");
    expect(res).toMatchObject({ ok: true, approved: ["SEO-02"], runDispatched: true, runMode: "apply" });
    expect(logActivityMock).toHaveBeenCalledTimes(2);
    expect(logActivityMock).toHaveBeenNthCalledWith(2, expect.objectContaining({ title: "SEO/GEO fix run started" }));
  });

  it("GEO-09 (review_approve/karos_agent): dispatches, reporting draft mode with its own activity title", async () => {
    findRoutableRecommendationMock.mockResolvedValue(GEO_09);
    dispatchSeoGeoRecommendationRunMock.mockResolvedValue({
      dispatched: true,
      mode: "draft",
      result: { jobId: "job_2", agentEngineRunId: "run_2" },
    });

    const res = await approveSeoGeoRecommendationAction("c1", "GEO-09", "Put a real author on your pages");

    expect(res).toMatchObject({ ok: true, runDispatched: true, runMode: "draft" });
    expect(logActivityMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ title: "SEO/GEO fix draft run started" }),
    );
  });

  it("SEO-09 (connect/karos_tool): approval succeeds, no dispatch, no second activity entry", async () => {
    findRoutableRecommendationMock.mockResolvedValue(SEO_09);
    dispatchSeoGeoRecommendationRunMock.mockResolvedValue({
      dispatched: false,
      reason: "owner \"karos_tool\" is not karos_agent",
    });

    const res = await approveSeoGeoRecommendationAction("c1", "SEO-09", "Connect Search Console");

    expect(res).toMatchObject({ ok: true, runDispatched: false });
    expect(logActivityMock).toHaveBeenCalledTimes(1);
  });

  it("SEO-04 (guided_manual/client_manual): approval succeeds, no dispatch", async () => {
    findRoutableRecommendationMock.mockResolvedValue(SEO_04);
    dispatchSeoGeoRecommendationRunMock.mockResolvedValue({
      dispatched: false,
      reason: "owner \"client_manual\" is not karos_agent",
    });

    const res = await approveSeoGeoRecommendationAction("c1", "SEO-04", "Core Web Vitals");

    expect(res).toMatchObject({ ok: true, runDispatched: false });
    expect(logActivityMock).toHaveBeenCalledTimes(1);
  });

  it("a dispatch error never turns a successful approval into an error response", async () => {
    findRoutableRecommendationMock.mockResolvedValue(SEO_02);
    dispatchSeoGeoRecommendationRunMock.mockResolvedValue({
      dispatched: true,
      mode: "apply",
      result: { jobId: "job_3", error: "AGENT_ENGINE_PUBSUB_TOPIC (or the Pub/Sub emulator) is not configured." },
    });

    const res = await approveSeoGeoRecommendationAction("c1", "SEO-02", "Tighten your page titles");

    expect(res).toMatchObject({ ok: true, approved: ["SEO-02"], runDispatched: true, runMode: "apply" });
    expect((res as any).runError).toContain("not configured");
    // No "run started" entry when the dispatch itself came back with an error.
    expect(logActivityMock).toHaveBeenCalledTimes(1);
  });

  it("a thrown lookup/dispatch error never fails the approval either", async () => {
    findRoutableRecommendationMock.mockRejectedValue(new Error("Firestore unavailable"));

    const res = await approveSeoGeoRecommendationAction("c1", "SEO-02", "Tighten your page titles");

    expect(res).toMatchObject({ ok: true, approved: ["SEO-02"], runDispatched: false });
    expect((res as any).runError).toBe("Firestore unavailable");
  });
});
