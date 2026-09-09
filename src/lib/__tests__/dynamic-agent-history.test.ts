import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * buildDynamicAgentHistory (docs/dynamic-agent-guardrails.md §3.1) — which
 * prior runs count as "already produced", and in what order.
 *
 * The filter is the substance here. Feeding a de-duplicating agent the wrong
 * set is worse than feeding it nothing: a queued job has no output to avoid
 * repeating, and a failed one produced nothing at all, so either would spend
 * tokens teaching the model to avoid text that does not exist.
 */

vi.mock("server-only", () => ({}));
vi.mock("@/lib/data");

import * as data from "@/lib/data";
import {
  DYNAMIC_AGENT_HISTORY_EXCERPT_CHARS,
  DYNAMIC_AGENT_HISTORY_RUNS,
  buildDynamicAgentHistory,
} from "@/lib/agent-service/dynamic-agent-history";

/* eslint-disable @typescript-eslint/no-explicit-any */

function job(patch: Record<string, unknown> = {}) {
  return {
    id: "job-1",
    clientId: "c1",
    dynamicAgentSpecId: "spec-1",
    status: "delivered",
    assetIds: ["asset-1"],
    createdAt: 1_000,
    ...patch,
  } as any;
}

beforeEach(() => {
  vi.clearAllMocks();
  (data.getAsset as any).mockImplementation(async (id: string) => ({ id, content: `content of ${id}` }));
});

describe("buildDynamicAgentHistory", () => {
  it("returns the agent's own prior deliverables for this client", async () => {
    (data.listJobs as any).mockResolvedValue([job()]);
    const items = await buildDynamicAgentHistory("spec-1", "c1");
    expect(items).toEqual([{ jobId: "job-1", createdAt: 1_000, excerpt: "content of asset-1" }]);
  });

  it("scopes the read to this client", async () => {
    (data.listJobs as any).mockResolvedValue([]);
    await buildDynamicAgentHistory("spec-1", "c1");
    expect(data.listJobs).toHaveBeenCalledWith({ clientId: "c1" });
  });

  it("keys off the SPEC id, so another agent's runs never leak in", async () => {
    (data.listJobs as any).mockResolvedValue([job({ id: "mine" }), job({ id: "theirs", dynamicAgentSpecId: "spec-2" })]);
    const items = await buildDynamicAgentHistory("spec-1", "c1");
    expect(items.map((i) => i.jobId)).toEqual(["mine"]);
  });

  it("ignores a hardcoded agent's job, which carries no spec id at all", async () => {
    (data.listJobs as any).mockResolvedValue([job({ id: "hardcoded", dynamicAgentSpecId: undefined })]);
    expect(await buildDynamicAgentHistory("spec-1", "c1")).toEqual([]);
  });

  it("ignores runs that never produced anything", async () => {
    (data.listJobs as any).mockResolvedValue([
      job({ id: "queued", status: "queued" }),
      job({ id: "running", status: "running" }),
      job({ id: "failed", status: "failed" }),
      job({ id: "cancelled", status: "cancelled" }),
      job({ id: "delivered", status: "delivered" }),
    ]);
    const items = await buildDynamicAgentHistory("spec-1", "c1");
    expect(items.map((i) => i.jobId)).toEqual(["delivered"]);
  });

  it("counts review and approved as produced, alongside delivered", async () => {
    (data.listJobs as any).mockResolvedValue([
      job({ id: "a", status: "review", createdAt: 3 }),
      job({ id: "b", status: "approved", createdAt: 2 }),
      job({ id: "c", status: "delivered", createdAt: 1 }),
    ]);
    const items = await buildDynamicAgentHistory("spec-1", "c1");
    expect(items.map((i) => i.jobId)).toEqual(["a", "b", "c"]);
  });

  it("ignores a job with no assets", async () => {
    (data.listJobs as any).mockResolvedValue([job({ id: "empty", assetIds: [] })]);
    expect(await buildDynamicAgentHistory("spec-1", "c1")).toEqual([]);
  });

  it("skips a job whose asset has since been deleted, without failing the whole build", async () => {
    (data.listJobs as any).mockResolvedValue([job({ id: "gone" }), job({ id: "ok", assetIds: ["asset-2"] })]);
    (data.getAsset as any).mockImplementation(async (id: string) =>
      id === "asset-1" ? null : { id, content: "still here" },
    );
    const items = await buildDynamicAgentHistory("spec-1", "c1");
    expect(items.map((i) => i.jobId)).toEqual(["ok"]);
  });

  it("skips an asset with blank content", async () => {
    (data.listJobs as any).mockResolvedValue([job()]);
    (data.getAsset as any).mockResolvedValue({ id: "asset-1", content: "   " });
    expect(await buildDynamicAgentHistory("spec-1", "c1")).toEqual([]);
  });

  it("returns newest first", async () => {
    (data.listJobs as any).mockResolvedValue([
      job({ id: "old", createdAt: 1 }),
      job({ id: "new", createdAt: 3 }),
      job({ id: "mid", createdAt: 2 }),
    ]);
    const items = await buildDynamicAgentHistory("spec-1", "c1");
    expect(items.map((i) => i.jobId)).toEqual(["new", "mid", "old"]);
  });

  it("caps how many runs it returns", async () => {
    const many = Array.from({ length: DYNAMIC_AGENT_HISTORY_RUNS + 5 }, (_, i) =>
      job({ id: `job-${i}`, createdAt: i, assetIds: [`asset-${i}`] }),
    );
    (data.listJobs as any).mockResolvedValue(many);
    const items = await buildDynamicAgentHistory("spec-1", "c1");
    expect(items).toHaveLength(DYNAMIC_AGENT_HISTORY_RUNS);
  });

  it("truncates each excerpt, so the payload stays bounded", async () => {
    (data.listJobs as any).mockResolvedValue([job()]);
    (data.getAsset as any).mockResolvedValue({
      id: "asset-1",
      content: "y".repeat(DYNAMIC_AGENT_HISTORY_EXCERPT_CHARS + 5_000),
    });
    const items = await buildDynamicAgentHistory("spec-1", "c1");
    expect(items[0]!.excerpt).toHaveLength(DYNAMIC_AGENT_HISTORY_EXCERPT_CHARS);
  });

  it("returns an empty list rather than throwing when there is no history", async () => {
    (data.listJobs as any).mockResolvedValue([]);
    expect(await buildDynamicAgentHistory("spec-1", "c1")).toEqual([]);
  });
});
