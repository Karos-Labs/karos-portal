import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  generateObjectMock,
  logUsageMock,
  getClientMock,
  listAssetsMock,
  createCampaignMock,
  createClientTaskMock,
  updateCampaignMock,
} = vi.hoisted(() => ({
  generateObjectMock: vi.fn(),
  logUsageMock: vi.fn(),
  getClientMock: vi.fn(),
  listAssetsMock: vi.fn(),
  createCampaignMock: vi.fn(),
  createClientTaskMock: vi.fn(),
  updateCampaignMock: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("ai", () => ({ generateObject: generateObjectMock }));
vi.mock("@ai-sdk/anthropic", () => ({ anthropic: vi.fn(() => "mock-model") }));
vi.mock("next/server", () => ({ after: (fn: () => void) => fn() }));
vi.mock("@/services/logger", () => ({ logger: { logUsage: logUsageMock } }));
vi.mock("@/lib/data", () => ({
  getClient: getClientMock,
  listAssets: listAssetsMock,
  createCampaign: createCampaignMock,
  createClientTask: createClientTaskMock,
  updateCampaign: updateCampaignMock,
}));

import {
  buildCampaignTaskDrafts,
  generateCampaignBundle,
  type CampaignBlueprint,
} from "@/lib/campaign-engine";

const blueprint: CampaignBlueprint = {
  title: "Black Friday Blitz",
  themeScope: "Black Friday 2026 SaaS deals",
  anchor: { title: "The 2026 Black Friday SaaS Buyer's Guide", description: "Cornerstone article", weight: 90 },
  newsletter: { title: "Black Friday issue", description: "Summarize + drive traffic", weight: 70 },
  socials: [
    { title: "LinkedIn teaser", description: "Pro angle", platform: "linkedin", weight: 60 },
    { title: "TikTok clip", description: "Fast hook", platform: "tiktok", weight: 55 },
  ],
};

describe("buildCampaignTaskDrafts (pure)", () => {
  it("orders anchor → newsletter → socials with the right productTypes", () => {
    const drafts = buildCampaignTaskDrafts(blueprint);
    expect(drafts.map((d) => d.role)).toEqual(["anchor", "distribution", "social", "social"]);
    expect(drafts.map((d) => d.productType)).toEqual([
      "blog_article",
      "newsletter_issue",
      "social_post",
      "social_post",
    ]);
  });

  it("wires dependencies: anchor has none, newsletter + socials depend on the anchor", () => {
    const drafts = buildCampaignTaskDrafts(blueprint);
    expect(drafts[0].dependsOnRoles).toEqual([]);
    expect(drafts[1].dependsOnRoles).toEqual(["anchor"]);
    expect(drafts.filter((d) => d.role === "social").every((d) => d.dependsOnRoles[0] === "anchor")).toBe(true);
  });

  it("carries the social platforms through", () => {
    const socials = buildCampaignTaskDrafts(blueprint).filter((d) => d.role === "social");
    expect(socials.map((d) => d.platform)).toEqual(["linkedin", "tiktok"]);
  });
});

describe("generateCampaignBundle", () => {
  beforeEach(() => {
    getClientMock.mockResolvedValue({ id: "c1", name: "Acme", industry: "saas" });
    listAssetsMock.mockResolvedValue([]);
    generateObjectMock.mockResolvedValue({ object: blueprint, usage: { inputTokens: 100, outputTokens: 50 } });
    createCampaignMock.mockResolvedValue("camp1");
    let n = 0;
    createClientTaskMock.mockImplementation(() => Promise.resolve(`t${++n}`));
    updateCampaignMock.mockResolvedValue(undefined);
  });

  afterEach(() => vi.clearAllMocks());

  const input = {
    clientId: "c1",
    createdBy: "u1",
    trend: { theme: "Black Friday SaaS deals", weight: 92 },
    now: Date.UTC(2026, 6, 8, 12), // 2026-W28
  };

  it("creates the campaign shell, then all dependency-wired tasks, then backfills taskIds", async () => {
    const result = await generateCampaignBundle(input);

    expect(createCampaignMock).toHaveBeenCalledTimes(1);
    expect(createCampaignMock).toHaveBeenCalledWith(
      expect.objectContaining({ clientId: "c1", title: "Black Friday Blitz", targetWeek: "2026-W28", taskIds: [] }),
    );

    expect(createClientTaskMock).toHaveBeenCalledTimes(4);
    // Anchor first, no deps, tagged with the campaign.
    expect(createClientTaskMock.mock.calls[0][0]).toMatchObject({
      campaignId: "camp1",
      dependsOnTaskIds: [],
      metadata: expect.objectContaining({ productType: "blog_article", campaignRole: "anchor" }),
    });
    // Newsletter + socials depend on the anchor's real id (t1).
    expect(createClientTaskMock.mock.calls[1][0]).toMatchObject({
      dependsOnTaskIds: ["t1"],
      metadata: expect.objectContaining({ productType: "newsletter_issue" }),
    });
    expect(createClientTaskMock.mock.calls[2][0]).toMatchObject({
      dependsOnTaskIds: ["t1"],
      metadata: expect.objectContaining({ productType: "social_post", platform: "linkedin" }),
    });

    expect(updateCampaignMock).toHaveBeenCalledWith(
      "camp1",
      expect.objectContaining({ taskIds: ["t1", "t2", "t3", "t4"] }),
    );
    expect(result).toMatchObject({ campaignId: "camp1", taskIds: ["t1", "t2", "t3", "t4"], targetWeek: "2026-W28" });
    expect(logUsageMock).toHaveBeenCalledWith(expect.objectContaining({ operation: "campaign_generation" }));
  });

  it("keeps generation fresh: repetitive recent output injects entropy-guard constraints", async () => {
    listAssetsMock.mockResolvedValue([
      { id: "a1", title: "Black Friday SaaS deals", content: "Black Friday SaaS deals roundup", createdAt: input.now },
    ]);
    await generateCampaignBundle(input);
    const systemArg = (generateObjectMock.mock.calls[0][0] as { system: string }).system;
    expect(systemArg).toContain("CREATIVE ENTROPY GUARD");
  });

  it("does not inject constraints when recent output is unrelated", async () => {
    listAssetsMock.mockResolvedValue([
      { id: "a1", title: "Cooking recipes", content: "How to bake sourdough bread", createdAt: input.now },
    ]);
    await generateCampaignBundle(input);
    const systemArg = (generateObjectMock.mock.calls[0][0] as { system: string }).system;
    expect(systemArg).not.toContain("CREATIVE ENTROPY GUARD");
  });
});
