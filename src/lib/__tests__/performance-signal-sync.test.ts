import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The half with the side effect: does the document land where the engine reads,
 * in the shape it unwraps?
 *
 * Both halves of that question have bitten this repo before. A projection that
 * writes to the wrong path is indistinguishable from one that was never run —
 * the engine logs the absent kind and falls back, exactly as it does today. And
 * a file with no object `data` is treated as ABSENT on purpose, because a
 * malformed projection is the projector's bug and must not become the run's
 * held status. So the path and the envelope are the contract, and asserting
 * them is asserting the feature works at all.
 */

const writes: Array<{ path: string; value: unknown }> = [];
const { listAssetsMock, listAnalyticsMock, configuredMock } = vi.hoisted(() => ({
  listAssetsMock: vi.fn(),
  listAnalyticsMock: vi.fn(),
  configuredMock: vi.fn(() => true),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/data", () => ({
  listAssets: listAssetsMock,
  listClientMarketingAnalytics: listAnalyticsMock,
}));
vi.mock("@/lib/agent-engine/workspace-writer", () => ({
  isWorkspaceWriterConfigured: configuredMock,
  writeWorkspaceJson: async (path: string, value: unknown) => {
    writes.push({ path, value });
  },
}));

import { syncPerformanceSignalToWorkspace } from "@/lib/agent-engine/performance-signal-sync";

const NOW = new Date("2026-09-24T00:00:00.000Z");
const CLIENT = { id: "c1", agentsRepoSlug: "karoslabs" } as never;

function row(over: Partial<Record<string, unknown>> & { assetId: string; engagementScore: number }) {
  return { clientId: "c1", platform: "instagram", source: "live", ...over } as never;
}
function asset(id: string, templateKey?: string, type = "social_post") {
  return { id, templateKey, type } as never;
}

beforeEach(() => {
  writes.length = 0;
  configuredMock.mockReturnValue(true);
});

describe("where the document lands", () => {
  it("writes the exact path client.getLearningContext reads", async () => {
    listAnalyticsMock.mockResolvedValue(
      Array.from({ length: 12 }, (_, i) => row({ assetId: `a${i}`, engagementScore: 50 })),
    );
    listAssetsMock.mockResolvedValue(Array.from({ length: 12 }, (_, i) => asset(`a${i}`, "carousel-edu")));

    await syncPerformanceSignalToWorkspace(CLIENT, NOW);

    expect(writes.map((w) => w.path)).toEqual([
      "clients/karoslabs/context/learning/instagram/what-works.json",
    ]);
  });

  it("writes one document per platform, not one for the client", async () => {
    listAnalyticsMock.mockResolvedValue([
      ...Array.from({ length: 10 }, (_, i) => row({ assetId: `i${i}`, engagementScore: 40 })),
      ...Array.from({ length: 10 }, (_, i) => row({ assetId: `l${i}`, engagementScore: 40, platform: "linkedin" })),
    ]);
    listAssetsMock.mockResolvedValue([
      ...Array.from({ length: 10 }, (_, i) => asset(`i${i}`, "carousel-edu")),
      ...Array.from({ length: 10 }, (_, i) => asset(`l${i}`, "doc-post")),
    ]);

    await syncPerformanceSignalToWorkspace(CLIENT, NOW);

    expect(writes.map((w) => w.path).sort()).toEqual([
      "clients/karoslabs/context/learning/instagram/what-works.json",
      "clients/karoslabs/context/learning/linkedin/what-works.json",
    ]);
  });
});

describe("the envelope the engine unwraps", () => {
  it("puts the outliers under an object `data`, or the engine reads the file as absent", async () => {
    listAnalyticsMock.mockResolvedValue([
      ...Array.from({ length: 8 }, (_, i) => row({ assetId: `a${i}`, engagementScore: 40 })),
      ...Array.from({ length: 4 }, (_, i) => row({ assetId: `b${i}`, engagementScore: 80 })),
    ]);
    listAssetsMock.mockResolvedValue([
      ...Array.from({ length: 8 }, (_, i) => asset(`a${i}`, "carousel-edu")),
      ...Array.from({ length: 4 }, (_, i) => asset(`b${i}`, "reel-hook")),
    ]);

    await syncPerformanceSignalToWorkspace(CLIENT, NOW);

    const value = writes[0]!.value as { kind: string; platform: string; data: Record<string, unknown>; source: Record<string, unknown> };
    expect(value.kind).toBe("what-works");
    expect(value.platform).toBe("instagram");
    expect(Array.isArray(value.data["outliers"])).toBe(true);
    expect((value.data["outliers"] as unknown[]).length).toBeGreaterThan(0);
    expect(value.source["projectedBy"]).toBe("karos-portal/performance-signal");
    expect(value.source["rows"]).toBe(12);
  });

  it("writes a document even when nothing is conclusive, carrying the reason", async () => {
    // "Absent" and "measured, nothing conclusive" are different states, and
    // only one of them means somebody should go and look.
    listAnalyticsMock.mockResolvedValue([row({ assetId: "a1", engagementScore: 50 })]);
    listAssetsMock.mockResolvedValue([asset("a1", "carousel-edu")]);

    await syncPerformanceSignalToWorkspace(CLIENT, NOW);

    const data = (writes[0]!.value as { data: Record<string, unknown> }).data;
    expect(data["outliers"]).toEqual([]);
    expect(String(data["refusal"])).toMatch(/needed before this account/);
  });
});

describe("what it will not do", () => {
  it("writes nothing when the client has no engine workspace", async () => {
    await syncPerformanceSignalToWorkspace({ id: "c1" } as never, NOW);
    expect(writes).toEqual([]);
  });

  it("writes nothing when the bucket is not configured", async () => {
    configuredMock.mockReturnValue(false);
    await syncPerformanceSignalToWorkspace(CLIENT, NOW);
    expect(writes).toEqual([]);
  });

  it("writes nothing at all when there are no measured rows", async () => {
    // Rather than an empty document per platform for a client who has never
    // published — there is no platform to name, and a file saying nothing is
    // still a file a reader has to open.
    listAnalyticsMock.mockResolvedValue([]);
    listAssetsMock.mockResolvedValue([]);
    expect((await syncPerformanceSignalToWorkspace(CLIENT, NOW)).synced).toBe(false);
    expect(writes).toEqual([]);
  });
});

describe("what a post WAS", () => {
  it("prefers the template key, which is what the engine matches on", async () => {
    listAnalyticsMock.mockResolvedValue([
      ...Array.from({ length: 8 }, (_, i) => row({ assetId: `a${i}`, engagementScore: 40 })),
      ...Array.from({ length: 4 }, (_, i) => row({ assetId: `b${i}`, engagementScore: 90 })),
    ]);
    listAssetsMock.mockResolvedValue([
      ...Array.from({ length: 8 }, (_, i) => asset(`a${i}`, "carousel-edu")),
      ...Array.from({ length: 4 }, (_, i) => asset(`b${i}`, "reel-hook")),
    ]);

    await syncPerformanceSignalToWorkspace(CLIENT, NOW);

    const outliers = (writes[0]!.value as { data: { outliers: Array<{ trait: string }> } }).data.outliers;
    expect(outliers.map((o) => o.trait)).toContain("reel-hook");
  });

  it("falls back to the asset type, which still separates a carousel from a reel", async () => {
    listAnalyticsMock.mockResolvedValue([
      ...Array.from({ length: 8 }, (_, i) => row({ assetId: `a${i}`, engagementScore: 40 })),
      ...Array.from({ length: 4 }, (_, i) => row({ assetId: `b${i}`, engagementScore: 90 })),
    ]);
    listAssetsMock.mockResolvedValue([
      ...Array.from({ length: 8 }, (_, i) => asset(`a${i}`, undefined, "social_post")),
      ...Array.from({ length: 4 }, (_, i) => asset(`b${i}`, undefined, "video_short")),
    ]);

    await syncPerformanceSignalToWorkspace(CLIENT, NOW);

    const outliers = (writes[0]!.value as { data: { outliers: Array<{ trait: string }> } }).data.outliers;
    expect(outliers.map((o) => o.trait)).toContain("video_short");
  });

  it("lets a row whose asset is gone sit out rather than inventing a trait", async () => {
    listAnalyticsMock.mockResolvedValue(
      Array.from({ length: 12 }, (_, i) => row({ assetId: `missing${i}`, engagementScore: 50 })),
    );
    listAssetsMock.mockResolvedValue([]);

    await syncPerformanceSignalToWorkspace(CLIENT, NOW);

    const data = (writes[0]!.value as { data: Record<string, unknown> }).data;
    expect(data["outliers"]).toEqual([]);
  });
});
