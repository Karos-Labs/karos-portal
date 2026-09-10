import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ClientAgent, CustomAgent, Job } from "@/lib/types";

/**
 * #130 — THE ROSTER RAN THE WHOLE CARD PROJECTION FOR ONE BOOLEAN.
 *
 * The client branch of the agents roster awaited `toClientAgentRows` and read
 * exactly one thing off the result: whether any row had an `activeRun`, to
 * decide whether to mount `<AutoRefresh />`. Everything else the projection
 * builds — the week strip, the template gates, today's option texts, the
 * feedback list — is rendered by the DETAIL page, not by the roster, and per
 * live umbrella it costs a `listAgentSlots` query, a `listClientAgentFeedback`
 * query and (in options mode) a `getAsset`.
 *
 * `hasActiveTemplateRun` answers that one question from the umbrellas and jobs
 * the page already holds. This file pins it two ways, because either alone is
 * weak:
 *
 *  - ABSOLUTELY, over a table of worlds. The equivalence below shares a
 *    predicate with the projection, so loosening that predicate would move both
 *    sides together and the equivalence would stay green. These do not.
 *  - AGAINST THE PROJECTION, so the cheap answer and the row it stands in for
 *    cannot drift apart later.
 *
 * The projection is REAL here. Substituting a stub for the thing the boolean is
 * supposed to agree with would test the stub.
 */

vi.mock("server-only", () => ({}));

const { getAssetMock, upcomingSlotsMock, listFeedbackMock } = vi.hoisted(() => ({
  getAssetMock: vi.fn(),
  upcomingSlotsMock: vi.fn(async () => []),
  listFeedbackMock: vi.fn(async () => []),
}));

vi.mock("@/lib/data", () => ({ getAsset: getAssetMock, listPlannedScheduledRuns: vi.fn() }));
vi.mock("@/lib/data-client-agents", () => ({ listClientAgentFeedback: listFeedbackMock }));
vi.mock("@/lib/client-agent-slots", () => ({ upcomingSlots: upcomingSlotsMock }));
vi.mock("@/lib/agent-service/x-agent-context", () => ({ hasXAgentIntake: vi.fn() }));
vi.mock("@/lib/agent-service/linkedin-agent-context", () => ({ hasLinkedInAgentIntake: vi.fn() }));
vi.mock("@/lib/agent-service/reddit-agent-context", () => ({ hasRedditAgentIntake: vi.fn() }));

const { hasActiveTemplateRun, toClientAgentRows } = await import("@/lib/client-agent-rows");

const NOW = Date.UTC(2026, 7, 1, 12);
const CLIENT_VIEWER = "u-client";
const STAFF_VIEWER = "u-staff";

const AGENT: CustomAgent = {
  id: "ca-ig",
  key: "karos-instagram-agent",
  name: "Instagram Agent",
  description: "internal",
  clientBlurb: "Posts for you.",
  icon: "Camera",
  color: "#00ff88",
  entrySkillDir: "products/live/instagram-agent",
  skillRoots: [],
  includeClientSkills: true,
  instructions: "internal",
  enabled: true,
} as unknown as CustomAgent;

const umbrella = (over: Partial<ClientAgent> = {}): ClientAgent =>
  ({
    id: "ua-1",
    clientId: "c1",
    agentKey: AGENT.key,
    customAgentId: AGENT.id,
    displayName: "Instagram Agent",
    platform: "instagram",
    slotMode: "single",
    launchState: "live",
    templates: [],
    rotation: [],
    createdBy: "u-staff",
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  }) as unknown as ClientAgent;

const job = (over: Partial<Job> = {}): Job =>
  ({
    id: "job-1",
    clientId: "c1",
    clientAgentId: "ua-1",
    agentId: "agent-service",
    agentName: AGENT.name,
    customAgentId: AGENT.id,
    runType: "manual_template",
    status: "running",
    external: { taskType: "custom", serviceJobId: "svc-1" },
    input: {},
    assetIds: [],
    createdBy: CLIENT_VIEWER,
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  }) as unknown as Job;

interface World {
  what: string;
  umbrellas: ClientAgent[];
  jobs: Job[];
  agents?: CustomAgent[];
  viewerIsClient?: boolean;
  viewerUid?: string;
  expected: boolean;
}

/**
 * Every case the AutoRefresh bit has to get right. Each one is a way the old
 * projection could have answered `activeRun !== null`, so each one is a way a
 * cheaper answer could be wrong.
 */
const WORLDS: World[] = [
  {
    what: "the viewer's own manual template run, still running",
    umbrellas: [umbrella()],
    jobs: [job()],
    expected: true,
  },
  {
    what: "…and while it is only queued",
    umbrellas: [umbrella()],
    jobs: [job({ status: "queued" })],
    expected: true,
  },
  {
    what: "nothing in flight at all",
    umbrellas: [umbrella()],
    jobs: [],
    expected: false,
  },
  {
    what: "the same run, already delivered",
    umbrellas: [umbrella()],
    jobs: [job({ status: "delivered" })],
    expected: false,
  },
  {
    what: "a SCHEDULED fire — deliberately invisible to the client (§4.1)",
    umbrellas: [umbrella()],
    jobs: [job({ runType: "scheduled" })],
    expected: false,
  },
  {
    what: "a staff 'Run now', read by the CLIENT — work they did not ask for",
    umbrellas: [umbrella()],
    jobs: [job({ createdBy: STAFF_VIEWER })],
    viewerIsClient: true,
    viewerUid: CLIENT_VIEWER,
    expected: false,
  },
  {
    what: "the same staff 'Run now', read by STAFF",
    umbrellas: [umbrella()],
    jobs: [job({ createdBy: STAFF_VIEWER })],
    viewerIsClient: false,
    viewerUid: STAFF_VIEWER,
    expected: true,
  },
  {
    what: "a run on an umbrella that is not live yet",
    umbrellas: [umbrella({ launchState: "not_launched" })],
    jobs: [job()],
    expected: false,
  },
  {
    what: "a run on an umbrella whose bound agent was disabled",
    umbrellas: [umbrella()],
    jobs: [job()],
    agents: [{ ...AGENT, enabled: false }],
    expected: false,
  },
  {
    what: "a run belonging to a DIFFERENT umbrella of the same client",
    umbrellas: [umbrella()],
    jobs: [job({ clientAgentId: "ua-other" })],
    expected: false,
  },
  {
    what: "one quiet umbrella beside one that is running",
    umbrellas: [umbrella({ id: "ua-quiet" }), umbrella()],
    jobs: [job()],
    expected: true,
  },
];

const cheap = (w: World) =>
  hasActiveTemplateRun({
    umbrellas: w.umbrellas,
    agentsById: new Map((w.agents ?? [AGENT]).map((a) => [a.id, a])),
    jobs: w.jobs,
    viewerIsClient: w.viewerIsClient ?? true,
    viewerUid: w.viewerUid ?? CLIENT_VIEWER,
  });

const projection = async (w: World) => {
  const rows = await toClientAgentRows({
    umbrellas: w.umbrellas,
    agentsById: new Map((w.agents ?? [AGENT]).map((a) => [a.id, a])),
    viewerIsClient: w.viewerIsClient ?? true,
    grantedAgentIds: null,
    clientSlug: "acme",
    agentSetup: {},
    creditBlockReasons: {},
    scheduleRows: [],
    scheduleZones: new Map(),
    jobs: w.jobs,
    viewerUid: w.viewerUid ?? CLIENT_VIEWER,
    viewerIsStaff: !(w.viewerIsClient ?? true),
    now: NOW,
  });
  return rows.some((row) => row.activeRun !== null);
};

beforeEach(() => {
  vi.clearAllMocks();
  upcomingSlotsMock.mockResolvedValue([]);
  listFeedbackMock.mockResolvedValue([]);
});

describe("hasActiveTemplateRun — the AutoRefresh bit, without the projection", () => {
  it.each(WORLDS.map((w) => [w.what, w] as const))("%s", (_what, w) => {
    expect(cheap(w)).toBe(w.expected);
  });

  it("covers both answers", () => {
    // Non-vacuity: a table that only ever expected `false` would be satisfied
    // by a function that returns `false`.
    expect(WORLDS.some((w) => w.expected)).toBe(true);
    expect(WORLDS.some((w) => !w.expected)).toBe(true);
  });

  it("reads no data layer to answer it", async () => {
    // The whole point of #130: the umbrellas and the jobs are already in the
    // caller's hand, so this costs no query. A reintroduced read fails here.
    cheap(WORLDS[0]!);
    expect(upcomingSlotsMock).not.toHaveBeenCalled();
    expect(listFeedbackMock).not.toHaveBeenCalled();
    expect(getAssetMock).not.toHaveBeenCalled();
  });
});

describe("it answers exactly what the card projection would have", () => {
  it.each(WORLDS.map((w) => [w.what, w] as const))("%s", async (_what, w) => {
    // The equivalence that lets the roster stop building rows it never renders.
    expect(await projection(w)).toBe(cheap(w));
  });

  it("and the projection was really doing the expensive work", async () => {
    // Non-vacuity for the equivalence: if `toClientAgentRows` had stopped
    // reading slots and feedback, "the cheap path is cheaper" would be empty.
    await projection(WORLDS[0]!);
    expect(upcomingSlotsMock).toHaveBeenCalled();
    expect(listFeedbackMock).toHaveBeenCalled();
  });
});
