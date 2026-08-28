import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/data", () => ({ updateJob: vi.fn() }));
vi.mock("@/lib/credit-reconcile", () => ({ refundJobCharge: vi.fn() }));
vi.mock("../materialize", () => ({ materializeAgentEngineDeliverable: vi.fn() }));
vi.mock("next/server", () => ({ after: (fn: () => void) => fn() }));

import { isJobInProgress } from "../reconcile";
import type { AgentEngineRunView } from "../read-run";
import type { Job } from "@/lib/types";

/**
 * SCRUM-265 item 1 — `isJobInProgress` is the predicate the Job detail page
 * used to compute inline (as `inProgress` / `agentEngineTerminal`) and now
 * shares with the new narrow status route (`/api/jobs/[id]/status`). Pinned
 * here so the two can never quietly disagree about what "still running"
 * means — a route that says `inProgress: true` while the page has already
 * stopped polling (or vice versa) would either poll forever or never notice
 * the job finished.
 */
function job(overrides: Partial<Job> = {}): Job {
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
  } as Job;
}

function view(status: AgentEngineRunView["run"]["status"]): AgentEngineRunView {
  return {
    run: {
      runId: "r1",
      clientSlug: "acme",
      productId: "landing-builder-agent",
      runKind: "recurring",
      status,
      createdAt: 1000,
      updatedAt: 2000,
    },
    steps: [],
  };
}

describe("isJobInProgress", () => {
  it("a legacy (non-agent-engine) job is in progress iff status is running/queued", () => {
    expect(isJobInProgress(job({ status: "queued" }))).toBe(true);
    expect(isJobInProgress(job({ status: "running" }))).toBe(true);
    expect(isJobInProgress(job({ status: "review" }))).toBe(false);
    expect(isJobInProgress(job({ status: "failed" }))).toBe(false);
    expect(isJobInProgress(job({ status: "held" }))).toBe(false);
  });

  it("an agent-engine job with no view yet is still in progress — dispatched, not visible", () => {
    expect(isJobInProgress(job({ agentEngineRunId: "r1" }), undefined)).toBe(true);
  });

  it("an agent-engine job in progress while the run is running or awaiting_gate", () => {
    expect(isJobInProgress(job({ agentEngineRunId: "r1" }), view("running"))).toBe(true);
    expect(isJobInProgress(job({ agentEngineRunId: "r1" }), view("awaiting_gate"))).toBe(true);
  });

  it("an agent-engine job is NOT in progress once the run reaches any terminal status", () => {
    for (const status of ["completed", "failed", "degraded", "held", "blocked_intake"] as const) {
      expect(isJobInProgress(job({ agentEngineRunId: "r1" }), view(status)), status).toBe(false);
    }
  });
});
