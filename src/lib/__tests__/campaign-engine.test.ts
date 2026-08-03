import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  generateObjectMock,
  logUsageMock,
  getClientMock,
  listAssetsMock,
  createCampaignMock,
  createClientTaskMock,
  updateCampaignMock,
  getTaskBoardCapacityMock,
} = vi.hoisted(() => ({
  generateObjectMock: vi.fn(),
  logUsageMock: vi.fn(),
  getClientMock: vi.fn(),
  listAssetsMock: vi.fn(),
  createCampaignMock: vi.fn(),
  createClientTaskMock: vi.fn(),
  updateCampaignMock: vi.fn(),
  getTaskBoardCapacityMock: vi.fn(),
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
  getTaskBoardCapacity: getTaskBoardCapacityMock,
}));

import {
  buildCampaignTaskDrafts,
  generateCampaignBundle,
  unmetCampaignDependencyTitles,
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
    getTaskBoardCapacityMock.mockResolvedValue({ activeCount: 0, tasks: [] });
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

  /* QA F92 — this path used to write straight past the ceiling and the dedup. */

  it("respects the active-task ceiling: only the free slots are written", async () => {
    // 13 of 15 active ⇒ 2 slots: the anchor and the newsletter land, both
    // socials are deferred.
    getTaskBoardCapacityMock.mockResolvedValue({ activeCount: 13, tasks: [] });

    const result = await generateCampaignBundle(input);

    expect(createClientTaskMock).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ taskIds: ["t1", "t2"], capSkipped: 2, duplicatesSkipped: 0 });
  });

  it("writes nothing at all — not even the campaign shell — when the board is full", async () => {
    getTaskBoardCapacityMock.mockResolvedValue({ activeCount: 15, tasks: [] });

    const result = await generateCampaignBundle(input);

    expect(result).toBeNull();
    expect(createCampaignMock).not.toHaveBeenCalled();
    expect(createClientTaskMock).not.toHaveBeenCalled();
  });

  it("drops a piece the board already carries", async () => {
    getTaskBoardCapacityMock.mockResolvedValue({
      activeCount: 1,
      tasks: [
        {
          id: "existing",
          clientId: "c1",
          title: "Black Friday issue",
          status: "pending",
          priority: "medium",
          source: "copilot",
          owner: "karos_managed",
          createdBy: "u1",
          createdAt: input.now,
          updatedAt: input.now,
        },
      ],
    });

    const result = await generateCampaignBundle(input);

    expect(createClientTaskMock).toHaveBeenCalledTimes(3);
    expect(result).toMatchObject({ duplicatesSkipped: 1, capSkipped: 0 });
    // The anchor still landed, so the dependents still resolve against it.
    expect(createClientTaskMock.mock.calls[1][0]).toMatchObject({ dependsOnTaskIds: ["t1"] });
  });
});

describe("unmetCampaignDependencyTitles (pure)", () => {
  it("is empty when the task has no dependencies", () => {
    expect(unmetCampaignDependencyTitles({ dependsOnTaskIds: [] }, new Map())).toEqual([]);
    expect(unmetCampaignDependencyTitles({}, new Map())).toEqual([]);
  });

  it("blocks on a dependency that hasn't produced a deliverable yet", () => {
    const tasksById = new Map([["anchor1", { title: "The Buyer's Guide", status: "pending" as const }]]);
    expect(unmetCampaignDependencyTitles({ dependsOnTaskIds: ["anchor1"] }, tasksById)).toEqual([
      "The Buyer's Guide",
    ]);
  });

  it("is unblocked once the dependency reaches review_pending (drafted, not yet approved)", () => {
    const tasksById = new Map([["anchor1", { title: "The Buyer's Guide", status: "review_pending" as const }]]);
    expect(unmetCampaignDependencyTitles({ dependsOnTaskIds: ["anchor1"] }, tasksById)).toEqual([]);
  });

  it("is unblocked once the dependency is completed", () => {
    const tasksById = new Map([["anchor1", { title: "The Buyer's Guide", status: "completed" as const }]]);
    expect(unmetCampaignDependencyTitles({ dependsOnTaskIds: ["anchor1"] }, tasksById)).toEqual([]);
  });

  it("does not block on a dependency id that no longer resolves (deleted task)", () => {
    expect(unmetCampaignDependencyTitles({ dependsOnTaskIds: ["gone"] }, new Map())).toEqual([]);
  });

  it("reports every unmet dependency, in order", () => {
    const tasksById = new Map([
      ["a", { title: "Anchor", status: "completed" as const }],
      ["b", { title: "Second piece", status: "in_progress" as const }],
    ]);
    expect(unmetCampaignDependencyTitles({ dependsOnTaskIds: ["a", "b"] }, tasksById)).toEqual([
      "Second piece",
    ]);
  });
});
