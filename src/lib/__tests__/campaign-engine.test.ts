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
  listCustomAgentsMock,
} = vi.hoisted(() => ({
  generateObjectMock: vi.fn(),
  logUsageMock: vi.fn(),
  getClientMock: vi.fn(),
  listAssetsMock: vi.fn(),
  createCampaignMock: vi.fn(),
  createClientTaskMock: vi.fn(),
  updateCampaignMock: vi.fn(),
  getTaskBoardCapacityMock: vi.fn(),
  listCustomAgentsMock: vi.fn(),
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
  listCustomAgents: listCustomAgentsMock,
}));

import { BLOG_WRITER_V2_KEY, NEWSLETTER_WRITER_V2_KEY } from "@/lib/custom-agent-launch";
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
  it("orders anchor → newsletter → socials with the right executors", () => {
    const drafts = buildCampaignTaskDrafts(blueprint);
    expect(drafts.map((d) => d.role)).toEqual(["anchor", "distribution", "social", "social"]);
    // BOTH the anchor and the distribution vehicle are v2 custom agents now.
    // They route by KEY because a document id is per-environment and per-grant.
    expect(drafts.map((d) => d.productType)).toEqual([
      "custom",
      "custom",
      "social_post",
      "social_post",
    ]);
    expect(drafts[0].customAgentKey).toBe(BLOG_WRITER_V2_KEY);
    expect(drafts[1].customAgentKey).toBe(NEWSLETTER_WRITER_V2_KEY);
    // TWO DIFFERENT KEYS, asserted rather than assumed: both pieces carry
    // productType "custom", so the only thing distinguishing them is the key —
    // and `findDuplicateReason` reads the resolved executor to decide whether the
    // second piece is a duplicate of the first. One key on both would silently
    // drop the newsletter from every campaign.
    expect(new Set(drafts.map((d) => d.customAgentKey).filter(Boolean)).size).toBe(2);
    // The socials stay managed and carry no key — two executors on one task.
    expect(drafts.slice(2).every((d) => !d.customAgentKey)).toBe(true);
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
    // Stored under the LEGACY name on purpose: `clientCategoryValue` is what the
    // prompt builder reads now, so a client who predates the rename still gets a
    // category into their campaign brief rather than a bare company name.
    getClientMock.mockResolvedValue({ id: "c1", name: "Acme", industry: "saas" });
    listAssetsMock.mockResolvedValue([]);
    generateObjectMock.mockResolvedValue({ object: blueprint, usage: { inputTokens: 100, outputTokens: 50 } });
    createCampaignMock.mockResolvedValue("camp1");
    let n = 0;
    createClientTaskMock.mockImplementation(() => Promise.resolve(`t${++n}`));
    updateCampaignMock.mockResolvedValue(undefined);
    getTaskBoardCapacityMock.mockResolvedValue({ activeCount: 0, tasks: [] });
    listCustomAgentsMock.mockResolvedValue([
      { id: "nl-agent-id", key: NEWSLETTER_WRITER_V2_KEY, name: "Newsletter agent", enabled: true },
      { id: "blog-agent-id", key: BLOG_WRITER_V2_KEY, name: "Blog agent", enabled: true },
    ]);
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
      metadata: expect.objectContaining({
        customAgentId: "blog-agent-id",
        customAgentName: "Blog agent",
        campaignRole: "anchor",
      }),
    });
    // The anchor is a custom run too, so it gets no product_run trigger either.
    expect(createClientTaskMock.mock.calls[0][0].metadata.completionTrigger).toBeUndefined();
    // AND the two custom pieces resolved to DIFFERENT agents — the dedup pass
    // reads this, and one id on both would have dropped the newsletter.
    expect(createClientTaskMock.mock.calls[1][0].metadata.customAgentId).toBe("nl-agent-id");
    // Newsletter + socials depend on the anchor's real id (t1). The newsletter
    // resolves its KEY to this environment's agent document.
    expect(createClientTaskMock.mock.calls[1][0]).toMatchObject({
      dependsOnTaskIds: ["t1"],
      metadata: expect.objectContaining({
        customAgentId: "nl-agent-id",
        customAgentName: "Newsletter agent",
      }),
    });
    // AND NO product_run TRIGGER, which is the whole reason this migration
    // exists. A custom run delivers `task_type: "custom"`, so the webhook mints
    // `product_run:custom`; a trigger naming anything else could never match and
    // the task would sit pending for ever — exactly how the v1 newsletter tasks
    // became stranded.
    const newsletterMeta = createClientTaskMock.mock.calls[1][0].metadata;
    expect(newsletterMeta.completionTrigger).toBeUndefined();
    expect(newsletterMeta.productType).toBeUndefined();
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

  it("still writes the newsletter piece when its agent is missing or disabled", async () => {
    // A campaign whose distribution agent is not registered in this environment,
    // or is registered and turned off. The piece is real editorial work and the
    // bundle is a dependency graph — dropping it silently would leave a hole
    // nobody can see, with the anchor pointing at nothing downstream.
    //
    // It lands UNASSIGNED, which is a state the board already renders and a
    // staff member can fix, rather than carrying a customAgentId that resolves
    // to nothing on every read.
    for (const roster of [
      [],
      [
        { id: "nl", key: NEWSLETTER_WRITER_V2_KEY, name: "NL", enabled: false },
        { id: "bl", key: BLOG_WRITER_V2_KEY, name: "BL", enabled: false },
      ],
    ]) {
      vi.clearAllMocks();
      getClientMock.mockResolvedValue({ id: "c1", name: "Acme", industry: "saas" });
      listAssetsMock.mockResolvedValue([]);
      generateObjectMock.mockResolvedValue({ object: blueprint, usage: { inputTokens: 1, outputTokens: 1 } });
      createCampaignMock.mockResolvedValue("camp1");
      let n = 0;
      createClientTaskMock.mockImplementation(() => Promise.resolve(`t${++n}`));
      updateCampaignMock.mockResolvedValue(undefined);
      getTaskBoardCapacityMock.mockResolvedValue({ activeCount: 0, tasks: [] });
      listCustomAgentsMock.mockResolvedValue(roster);

      await generateCampaignBundle(input);
      // ALL FOUR still written. The anchor matters most: every other piece
      // depends on it, so dropping an unassignable anchor would stall the whole
      // bundle rather than leave one hole.
      expect(createClientTaskMock).toHaveBeenCalledTimes(4);
      for (const [index, role] of [[0, "anchor"], [1, "distribution"]] as const) {
        const meta = createClientTaskMock.mock.calls[index][0].metadata;
        expect(meta.campaignRole, role).toBe(role);
        expect(meta.customAgentId, role).toBeUndefined();
        // And never a managed productType as a consolation executor — those are
        // the dead products this migration removed.
        expect(meta.productType, role).toBeUndefined();
        expect(meta.completionTrigger, role).toBeUndefined();
      }
    }
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
