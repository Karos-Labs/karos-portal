import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * SCRUM-265 item 1 — GET /api/jobs/[id]/status, the narrow endpoint
 * `AutoRefresh` polls from the Job detail page instead of a full
 * `router.refresh()` on every tick.
 *
 * Covers the two things a caller of this route actually depends on: it
 * reports `inProgress` using the SAME predicate the page gates its own
 * `AutoRefresh` mount on (so the two can't drift), and it 404s cleanly for a
 * job id that doesn't exist rather than throwing.
 */
const { getJobMock, readAgentEngineRunMock, requireUserMock } = vi.hoisted(() => ({
  getJobMock: vi.fn(),
  readAgentEngineRunMock: vi.fn(),
  requireUserMock: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/data", () => ({ getJob: getJobMock }));
vi.mock("@/lib/agent-engine/read-run", () => ({ readAgentEngineRun: readAgentEngineRunMock }));
vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return { ...actual, requireUser: requireUserMock };
});

const STAFF_USER = { uid: "u1", role: "KAROS_ADMIN", disabled: false, clientId: null, createdAt: 0 };

function job(overrides: Record<string, unknown> = {}) {
  return {
    id: "job_1",
    clientId: "client_1",
    agentId: "agent-service",
    agentName: "Some agent",
    title: "Test job",
    status: "queued",
    input: {},
    assetIds: [],
    events: [],
    createdBy: "user_1",
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides,
  };
}

async function callStatusRoute(id: string) {
  const { GET } = await import("@/app/api/jobs/[id]/status/route");
  return GET(new Request(`https://portal.test/api/jobs/${id}/status`), {
    params: Promise.resolve({ id }),
  });
}

describe("GET /api/jobs/[id]/status", () => {
  beforeEach(() => {
    getJobMock.mockReset();
    readAgentEngineRunMock.mockReset();
    requireUserMock.mockReset();
    requireUserMock.mockResolvedValue(STAFF_USER);
  });

  it("reports inProgress: true for a running legacy job", async () => {
    getJobMock.mockResolvedValue(job({ status: "running" }));
    const res = await callStatusRoute("job_1");
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ inProgress: true });
  });

  it("reports inProgress: false once the legacy job is terminal", async () => {
    getJobMock.mockResolvedValue(job({ status: "review" }));
    const res = await callStatusRoute("job_1");
    await expect(res.json()).resolves.toEqual({ inProgress: false });
  });

  it("reads the agent-engine run view for an agent-engine job and reports the SAME predicate the page uses", async () => {
    getJobMock.mockResolvedValue(job({ agentEngineRunId: "r1", status: "running" }));
    readAgentEngineRunMock.mockResolvedValue({
      run: { runId: "r1", clientSlug: "acme", productId: "x", runKind: "recurring", status: "completed", createdAt: 0, updatedAt: 0 },
      steps: [],
    });
    const res = await callStatusRoute("job_1");
    await expect(res.json()).resolves.toEqual({ inProgress: false });
    expect(readAgentEngineRunMock).toHaveBeenCalledWith("r1");
  });

  it("404s for a job id that doesn't exist, rather than throwing", async () => {
    getJobMock.mockResolvedValue(null);
    const res = await callStatusRoute("no-such-job");
    expect(res.status).toBe(404);
  });
});
