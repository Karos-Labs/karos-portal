import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  generateObjectMock,
  logUsageMock,
  logGenerationFailureMock,
  getTaskBoardCapacityMock,
  createClientTaskMock,
  generateCampaignBundleMock,
} = vi.hoisted(() => ({
  generateObjectMock: vi.fn(),
  logUsageMock: vi.fn(),
  logGenerationFailureMock: vi.fn(),
  getTaskBoardCapacityMock: vi.fn(),
  createClientTaskMock: vi.fn(),
  generateCampaignBundleMock: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("ai", () => ({ generateObject: generateObjectMock }));
vi.mock("@ai-sdk/anthropic", () => ({ anthropic: vi.fn(() => "mock-model") }));
vi.mock("next/server", () => ({ after: (fn: () => void) => fn() }));
vi.mock("@/services/logger", () => ({
  logger: { logUsage: logUsageMock, logGenerationFailure: logGenerationFailureMock },
}));
// Campaign generation is exercised in its own test file; mock it here.
vi.mock("@/lib/campaign-engine", () => ({ generateCampaignBundle: generateCampaignBundleMock }));
// Real task-dedup (pure) is used; only the Firestore I/O is mocked.
vi.mock("@/lib/data", () => ({
  getTaskBoardCapacity: getTaskBoardCapacityMock,
  createClientTask: createClientTaskMock,
  getClient: vi.fn(),
  listAssets: vi.fn(),
  listClientIntegrations: vi.fn(),
  getClientPerformanceBenchmarks: vi.fn(),
}));

import {
  runSwarm,
  finalizeConsensus,
  persistSwarmTasks,
  MAX_CONSENSUS_TASKS,
  type SwarmEvent,
  type SwarmInput,
  type SwarmTaskDraft,
} from "@/lib/agent-swarm";
import type { ClientTask } from "@/lib/types";

const SAMPLE_TASKS: SwarmTaskDraft[] = [
  { title: "Publish LinkedIn thought-leadership article on Trend X", description: "d1", priority: "high", productType: "landing_page", platform: "linkedin", weight: 80 },
  { title: "Produce TikTok short on customer win", description: "d2", priority: "medium", productType: "social_post", platform: "tiktok", weight: 60 },
  { title: "Draft monthly newsletter issue", description: "d3", priority: "low", productType: "landing_page", weight: 40 },
];

function turn(tasks: SwarmTaskDraft[], message = "my move") {
  return { object: { message, tasks }, usage: { inputTokens: 10, outputTokens: 5 } };
}

const input: SwarmInput = {
  clientId: "c1",
  createdBy: "u1",
  rounds: 2,
  context: {
    clientName: "Acme",
    category: "saas",
    gapSummary: "- linkedin: GAP",
    brandingSummary: "Tone: bold",
    benchmarkSummary: "No data",
    customAgents: [],
  },
};

async function collect(gen: AsyncGenerator<SwarmEvent>): Promise<SwarmEvent[]> {
  const out: SwarmEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

beforeEach(() => {
  generateObjectMock.mockResolvedValue(turn(SAMPLE_TASKS));
  getTaskBoardCapacityMock.mockResolvedValue({ activeCount: 0, tasks: [] as ClientTask[] });
  createClientTaskMock.mockResolvedValue("new-id");
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("finalizeConsensus (pure)", () => {
  it("drops exact-title duplicates (normalized)", () => {
    const drafts: SwarmTaskDraft[] = [
      { title: "Write a Blog Post", description: "d", priority: "high", weight: 50 },
      { title: "write a blog post!", description: "d", priority: "high", weight: 90 },
    ];
    expect(finalizeConsensus(drafts)).toHaveLength(1);
  });

  it("sorts by weight descending", () => {
    const drafts: SwarmTaskDraft[] = [
      { title: "low", description: "d", priority: "low", weight: 10 },
      { title: "high", description: "d", priority: "high", weight: 95 },
      { title: "mid", description: "d", priority: "medium", weight: 50 },
    ];
    expect(finalizeConsensus(drafts).map((t) => t.title)).toEqual(["high", "mid", "low"]);
  });

  it("caps at the consensus limit", () => {
    const drafts: SwarmTaskDraft[] = Array.from({ length: 25 }, (_, i) => ({
      title: `task ${i}`,
      description: "d",
      priority: "medium" as const,
      weight: i,
    }));
    expect(finalizeConsensus(drafts)).toHaveLength(MAX_CONSENSUS_TASKS);
  });
});

describe("runSwarm — multi-round state machine", () => {
  it("runs the debate in fixed agent order across every round", async () => {
    const events = await collect(runSwarm(input));

    const rounds = events.filter((e) => e.type === "round_start");
    expect(rounds).toHaveLength(2);
    expect(rounds.map((e) => (e.type === "round_start" ? e.round : 0))).toEqual([1, 2]);

    const agents = events
      .filter((e) => e.type === "agent_message")
      .map((e) => (e.type === "agent_message" ? e.agent : ""));
    expect(agents).toEqual(["seo", "creative", "data", "seo", "creative", "data"]);
  });

  it("dispatches one model call per agent turn and logs usage each time", async () => {
    await collect(runSwarm(input));
    expect(generateObjectMock).toHaveBeenCalledTimes(6); // 3 agents × 2 rounds
    expect(logUsageMock).toHaveBeenCalledTimes(6);
    expect(logUsageMock).toHaveBeenCalledWith(
      expect.objectContaining({ operation: "task_swarm", clientId: "c1" }),
    );
  });

  it("locks consensus and persists it, ending with done", async () => {
    const events = await collect(runSwarm(input));

    const consensus = events.find((e) => e.type === "consensus");
    expect(consensus).toMatchObject({ type: "consensus", taskCount: 3 });

    const persisted = events.find((e) => e.type === "persisted");
    expect(persisted).toMatchObject({ type: "persisted", created: 3 });

    const done = events.at(-1);
    expect(done).toMatchObject({ type: "done", created: 3 });

    expect(createClientTaskMock).toHaveBeenCalledTimes(3);
    expect(createClientTaskMock).toHaveBeenCalledWith(
      expect.objectContaining({ owner: "karos_managed", source: "copilot", clientId: "c1" }),
    );
  });

  it("carries the evolving array forward and keeps the prior draft on an empty turn", async () => {
    generateObjectMock
      .mockResolvedValueOnce(turn(SAMPLE_TASKS.slice(0, 2), "seo proposes 2")) // seo r1 → 2
      .mockResolvedValueOnce(turn([], "creative defers")) // creative r1 → empty, keep 2
      .mockResolvedValue(turn(SAMPLE_TASKS, "revised to 3")); // everyone else → 3

    const events = await collect(runSwarm(input));
    const counts = events
      .filter((e) => e.type === "agent_message")
      .map((e) => (e.type === "agent_message" ? e.taskCount : -1));

    expect(counts[0]).toBe(2); // seo proposed 2
    expect(counts[1]).toBe(2); // creative returned empty → prior 2 kept
    expect(counts[2]).toBe(3); // data revised to 3
  });

  it("is resilient: one failed turn becomes a soft message and the run still completes", async () => {
    generateObjectMock.mockReset();
    generateObjectMock.mockRejectedValueOnce(new Error("boom")); // seo r1 fails
    generateObjectMock.mockResolvedValue(turn(SAMPLE_TASKS));

    const events = await collect(runSwarm(input));

    const seoR1 = events.find((e) => e.type === "agent_message" && e.agent === "seo");
    expect(seoR1?.type === "agent_message" && seoR1.message).toMatch(/error/i);
    expect(seoR1?.type === "agent_message" && seoR1.taskCount).toBe(0); // no draft yet

    // Despite the failure, the debate reaches consensus + done.
    expect(events.some((e) => e.type === "consensus")).toBe(true);
    expect(events.at(-1)?.type).toBe("done");
  });

  it("emits an error event when persistence fails", async () => {
    createClientTaskMock.mockRejectedValue(new Error("firestore down"));
    const events = await collect(runSwarm(input));
    expect(events.at(-1)).toMatchObject({ type: "error" });
  });
});

// A client disconnecting (tab closed, fetch aborted) must stop the debate
// instead of burning LLM spend + Firestore writes for nobody — a QA review
// found the route had no way to propagate that signal into the generator.
describe("runSwarm — abort signal (client disconnect)", () => {
  it("does nothing when already aborted before the first turn", async () => {
    const ac = new AbortController();
    ac.abort();

    const events = await collect(runSwarm({ ...input, signal: ac.signal }));

    expect(events).toEqual([]);
    expect(generateObjectMock).not.toHaveBeenCalled();
    expect(createClientTaskMock).not.toHaveBeenCalled();
  });

  it("forwards the signal into each model call", async () => {
    const ac = new AbortController();
    await collect(runSwarm({ ...input, signal: ac.signal }));

    expect(generateObjectMock).toHaveBeenCalledWith(
      expect.objectContaining({ abortSignal: ac.signal }),
    );
  });

  it("stops after the in-flight turn and never persists once aborted mid-debate", async () => {
    const ac = new AbortController();
    // Abort as a side effect of the very first model call — simulates the
    // client disconnecting while the first agent turn is in flight.
    generateObjectMock.mockImplementationOnce(async () => {
      ac.abort();
      return turn(SAMPLE_TASKS);
    });

    const events = await collect(runSwarm({ ...input, signal: ac.signal }));

    // Only the first turn ran; the abort check at the top of the next
    // iteration stops the loop before a second call.
    expect(generateObjectMock).toHaveBeenCalledTimes(1);
    expect(events.some((e) => e.type === "consensus")).toBe(false);
    expect(events.some((e) => e.type === "persisted")).toBe(false);
    expect(createClientTaskMock).not.toHaveBeenCalled();
  });
});

describe("runSwarm — campaign shift on a high-weight trend", () => {
  const withTrend = (weight: number): SwarmInput => ({
    ...input,
    context: { ...input.context, campaignTrend: { theme: "Black Friday", weight } },
  });

  it("generates a campaign bundle and emits a campaign event above the threshold", async () => {
    generateCampaignBundleMock.mockResolvedValue({
      campaignId: "camp1",
      title: "Black Friday Blitz",
      themeScope: "Black Friday 2026",
      taskIds: ["a", "b", "c", "d"],
    });

    const events = await collect(runSwarm(withTrend(92)));

    expect(generateCampaignBundleMock).toHaveBeenCalledTimes(1);
    expect(generateCampaignBundleMock).toHaveBeenCalledWith(
      expect.objectContaining({ clientId: "c1", createdBy: "u1", trend: { theme: "Black Friday", weight: 92 } }),
    );
    const campaign = events.find((e) => e.type === "campaign");
    expect(campaign).toMatchObject({ type: "campaign", campaignId: "camp1", taskCount: 4 });
    // Campaign lands after persistence, before done; done stays last.
    const last = events.at(-1);
    expect(last?.type).toBe("done");
    // The closing count includes the campaign's tasks — it used to report the
    // debate's total only, so the client was told fewer cards than landed
    // (QA F92).
    const persisted = events.find((e) => e.type === "persisted");
    expect(last).toMatchObject({
      created: (persisted as { created: number }).created + 4,
    });
  });

  it("reports a skipped campaign in the console instead of dropping it silently", async () => {
    // null ⇒ the board was full or the anchor already existed; nothing written.
    generateCampaignBundleMock.mockResolvedValue(null);

    const events = await collect(runSwarm(withTrend(92)));

    expect(events.some((e) => e.type === "campaign")).toBe(false);
    const note = events.find((e) => e.type === "agent_message" && e.agentName === "Campaign Director");
    expect(note).toBeTruthy();
    const persisted = events.find((e) => e.type === "persisted");
    expect(events.at(-1)).toMatchObject({
      type: "done",
      created: (persisted as { created: number }).created,
    });
  });

  it("stays with standalone tasks when the trend weight is below the threshold", async () => {
    const events = await collect(runSwarm(withTrend(79)));
    expect(generateCampaignBundleMock).not.toHaveBeenCalled();
    expect(events.some((e) => e.type === "campaign")).toBe(false);
  });

  it("survives a campaign-generation failure without failing the run", async () => {
    generateCampaignBundleMock.mockRejectedValue(new Error("blueprint boom"));
    const events = await collect(runSwarm(withTrend(90)));
    expect(events.some((e) => e.type === "campaign")).toBe(false);
    expect(events.at(-1)?.type).toBe("done");
    const note = events.find((e) => e.type === "agent_message" && e.agentName === "Campaign Director");
    expect(note).toBeTruthy();
  });
});

describe("persistSwarmTasks — dedup + capacity", () => {
  it("skips tasks that duplicate the live board", async () => {
    const existing: ClientTask = {
      id: "t1",
      clientId: "c1",
      title: "Draft monthly newsletter issue",
      status: "pending",
      priority: "low",
      source: "copilot",
      owner: "karos_managed",
      createdBy: "u1",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    getTaskBoardCapacityMock.mockResolvedValue({ activeCount: 1, tasks: [existing] });

    const result = await persistSwarmTasks("c1", "u1", SAMPLE_TASKS);
    expect(result.duplicatesSkipped).toBe(1);
    expect(result.created).toBe(2);
    expect(createClientTaskMock).toHaveBeenCalledTimes(2);
  });

  it("defers tasks beyond the active-task capacity", async () => {
    // Board already at the cap → no free slots.
    getTaskBoardCapacityMock.mockResolvedValue({ activeCount: MAX_CONSENSUS_TASKS, tasks: [] });
    const result = await persistSwarmTasks("c1", "u1", SAMPLE_TASKS);
    expect(result.created).toBe(0);
    expect(result.capSkipped).toBe(3);
    expect(createClientTaskMock).not.toHaveBeenCalled();
  });

  it("no-ops cleanly on an empty consensus", async () => {
    const result = await persistSwarmTasks("c1", "u1", []);
    expect(result.created).toBe(0);
    expect(getTaskBoardCapacityMock).not.toHaveBeenCalled();
  });

  it("records a custom-agent linkage when a draft assigns a granted custom agent", async () => {
    const drafts: SwarmTaskDraft[] = [
      { title: "Run bespoke brand video", description: "d", priority: "high", customAgentId: "ca_1", weight: 90 },
    ];
    await persistSwarmTasks("c1", "u1", drafts, [
      { id: "ca_1", key: "brand-video-agent", name: "Brand Video Agent", description: "Makes videos" },
    ]);
    expect(createClientTaskMock).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: "karos_managed",
        metadata: expect.objectContaining({ customAgentId: "ca_1", customAgentName: "Brand Video Agent" }),
      }),
    );
    // Custom-agent tasks don't carry a managed product_run trigger.
    const arg = createClientTaskMock.mock.calls[0][0] as { metadata?: Record<string, unknown> };
    expect(arg.metadata?.productType).toBeUndefined();
    expect(arg.metadata?.completionTrigger).toBeUndefined();
  });

  it("ignores a hallucinated customAgentId not granted to the client", async () => {
    const drafts: SwarmTaskDraft[] = [
      { title: "Ghost agent task", description: "d", priority: "medium", customAgentId: "nope", productType: "landing_page", weight: 50 },
    ];
    await persistSwarmTasks("c1", "u1", drafts, [{ id: "ca_1", key: "real", name: "Real", description: "d" }]);
    const arg = createClientTaskMock.mock.calls[0][0] as { metadata?: Record<string, unknown> };
    // Falls back to the managed productType path; no bogus customAgentId persisted.
    expect(arg.metadata?.customAgentId).toBeUndefined();
    expect(arg.metadata?.productType).toBe("landing_page");
  });
});
