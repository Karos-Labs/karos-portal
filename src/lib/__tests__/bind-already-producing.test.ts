/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Asset, ClientAgent, Job, PlannedScheduledRun } from "@/lib/types";

/**
 * BINDING AN AGENT THAT IS ALREADY WORKING FOR THIS CLIENT (#60).
 *
 * `bindClientAgentAction` refuses to bind an already-producing agent silently:
 * it returns `alreadyProducing`, writes nothing, and the control offers staff
 * the two honest choices (W6). That safeguard exists because a `not_launched`
 * umbrella takes the client's card away — and, since `launchCreditCost` is
 * uncalibrated on every agent (#167 is open), what replaces it is a launch card
 * whose only CTA is disabled for that client. `clientAgentRunRefusal` refuses
 * the run server-side from the same moment, so the gesture goes with the button.
 *
 * The safeguard asked a JOB JOIN, and a job join cannot see a lab import:
 * imported assets are written with `jobId: null` and produce no job at all. So
 * for an agent whose whole history is imported posts and which has no schedule,
 * the bind said "not producing" and bound it silently, while the very same
 * client's agent detail page — reading `agentsWithDeliveredWork` — was drawing
 * the legacy panel and a working "Create a new post".
 *
 * `agentsWithDeliveredWork` is REAL here, not mocked. The defect was two answers
 * to one question, so a test that stubs the answer cannot see it.
 */

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/data");
vi.mock("@/lib/data-client-agents");
vi.mock("@/lib/auth");
vi.mock("@/lib/client-agent-slots", () => ({ ensureSlotHorizon: vi.fn() }));
vi.mock("@/lib/jobs/submit-custom", () => ({
  isCustomAgentGrantedToClient: vi.fn(async () => true),
  submitCustomAgentJob: vi.fn(async () => ({ jobId: "job-new" })),
}));
vi.mock("@/lib/agent-service/x-agent-context", () => ({ hasXAgentIntake: vi.fn(async () => true) }));
vi.mock("@/lib/agent-service/linkedin-agent-context", () => ({
  hasLinkedInAgentIntake: vi.fn(async () => true),
}));
vi.mock("@/lib/agent-service/reddit-agent-context", () => ({
  hasRedditAgentIntake: vi.fn(async () => true),
}));

import * as data from "@/lib/data";
import * as clientAgentData from "@/lib/data-client-agents";
import { getCurrentUser } from "@/lib/auth";

const NOW = Date.UTC(2026, 6, 28, 12);
const CLIENT_SLUG = "karoslabs";

const STAFF = {
  uid: "u-staff",
  email: "tomer@karoslabs.com",
  name: "Tomer",
  role: "KAROS_EMPLOYEE" as const,
  createdAt: 0,
};

/**
 * The agent in the report: a lab product with no per-client folder in its key,
 * so the binding rung above this predicate passes and the question under test is
 * the one that gets asked.
 */
const AGENT = {
  id: "ca-ig",
  key: "karos-instagram-agent",
  name: "Instagram Agent",
  enabled: true,
};

/** A lab import: no job, no agent id, attributed by its folder alone. */
const labAsset = (): Asset =>
  ({
    id: "lab-1",
    clientId: "c1",
    title: "A post we published",
    content: "Body",
    createdBy: "staff-1",
    createdAt: NOW,
    updatedAt: NOW,
    status: "approved",
    type: "social_post",
    jobId: null,
    agentId: null,
    meta: {
      source: "lab-import",
      labRun: "instagram-agent/run-1#post-1",
      agentFolder: "instagram-agent",
    },
  }) as unknown as Asset;

const deliveredJob = (): Job =>
  ({
    id: "job-1",
    clientId: "c1",
    agentId: "agent-service",
    agentName: AGENT.name,
    customAgentId: AGENT.id,
    status: "delivered",
    external: { taskType: "custom", serviceJobId: "svc-1" },
    input: {},
    assetIds: [],
    createdBy: "staff-1",
    createdAt: NOW,
    updatedAt: NOW,
  }) as unknown as Job;

const liveSchedule = (): PlannedScheduledRun =>
  ({
    id: "sched-1",
    clientId: "c1",
    customAgentId: AGENT.id,
    cadence: "weekly",
    status: "active",
  }) as unknown as PlannedScheduledRun;

function world(over: { assets?: Asset[]; jobs?: Job[]; schedules?: PlannedScheduledRun[]; umbrellas?: ClientAgent[] } = {}) {
  vi.mocked(data.listAssets).mockResolvedValue(over.assets ?? []);
  vi.mocked(data.listJobs).mockResolvedValue(over.jobs ?? []);
  vi.mocked(data.listPlannedScheduledRuns).mockResolvedValue(over.schedules ?? []);
  vi.mocked(clientAgentData.listClientAgents).mockResolvedValue(over.umbrellas ?? []);
}

const bind = async (input: Record<string, unknown> = {}) => {
  const { bindClientAgentAction } = await import("@/lib/actions/client-agent-actions");
  return bindClientAgentAction({ clientId: "c1", customAgentId: AGENT.id, ...input } as any);
};

/** What the bind actually wrote, if anything. */
const written = () => vi.mocked(clientAgentData.upsertClientAgent).mock.calls.map((c) => c[0]);

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getCurrentUser).mockResolvedValue(STAFF as any);
  vi.mocked(data.getClient).mockResolvedValue({
    id: "c1",
    name: "Karos Labs",
    agentsRepoSlug: CLIENT_SLUG,
  } as any);
  vi.mocked(data.getCustomAgent).mockResolvedValue(AGENT as any);
  vi.mocked(clientAgentData.upsertClientAgent).mockResolvedValue({ id: "c1__ig", created: true });
  world();
});

describe("bindClientAgentAction — is this agent already working here?", () => {
  it("asks before binding an agent whose only history is a lab import", async () => {
    world({ assets: [labAsset()] });

    const result = await bind();

    expect(result.alreadyProducing).toBe(true);
    expect(result.id).toBeUndefined();
    expect(written()).toEqual([]);
  });

  it("binds silently when the agent really has produced nothing", async () => {
    // Non-vacuity for the case above: same agent, same client, no history at
    // all. Without this, a predicate that returned `true` unconditionally — or a
    // fixture that confirmed for some unrelated reason — would read green.
    const result = await bind();

    expect(result.alreadyProducing).toBeUndefined();
    expect(written()).toHaveLength(1);
    expect(written()[0]).toMatchObject({ launchState: "not_launched" });
  });

  it("still asks on a delivered run — the job rung is kept, not replaced", async () => {
    world({ jobs: [deliveredJob()] });

    expect((await bind()).alreadyProducing).toBe(true);
    expect(written()).toEqual([]);
  });

  it("still asks on a schedule row that has not been retired", async () => {
    // The schedule rung lives outside `agentsWithDeliveredWork`, which knows
    // nothing about schedules. A rewrite that dropped it would let staff bind
    // over an agent that is about to fire.
    world({ schedules: [liveSchedule()] });

    expect((await bind()).alreadyProducing).toBe(true);
    expect(written()).toEqual([]);
  });

  it("does not credit this agent with ANOTHER agent's lab folder", async () => {
    // Keyed to the agent's own key: the folder rung matches a folder to an
    // identity, so an unrelated import must not make every agent look busy.
    const foreign = labAsset();
    (foreign as any).meta = {
      source: "lab-import",
      labRun: "newsletter-agent/run-1#post-1",
      agentFolder: "newsletter-agent",
    };
    world({ assets: [foreign] });

    expect((await bind()).alreadyProducing).toBeUndefined();
    expect(written()[0]).toMatchObject({ launchState: "not_launched" });
  });

  it("takes the grandfathered path when staff answer 'add as live'", async () => {
    world({ assets: [labAsset()] });

    const result = await bind({ bindAsLive: true });

    expect(result.alreadyProducing).toBeUndefined();
    expect(written()[0]).toMatchObject({ launchState: "live" });
    expect(written()[0]).toHaveProperty("launchCompletedAt");
  });

  it("takes the client offline only when staff answer 'add as new'", async () => {
    world({ assets: [labAsset()] });

    const result = await bind({ bindAsNew: true });

    expect(result.alreadyProducing).toBeUndefined();
    expect(written()[0]).toMatchObject({ launchState: "not_launched" });
  });
});
