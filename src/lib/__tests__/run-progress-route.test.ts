import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `GET /api/runs/[id]/progress`, as the reader of a run sees it: what the bar
 * says while the agent works, when it stops, and what never crosses. Behaviour,
 * not source: the job and the engine run doc are the inputs, the JSON is the
 * output.
 */

const job = vi.fn();
const run = vi.fn();
vi.mock("server-only", () => ({}));
vi.mock("@/lib/data", () => ({ getJob: (id: string) => job(id) }));
vi.mock("@/lib/actions/_shared", () => ({ requireClientAccess: async () => undefined }));
vi.mock("@/lib/agent-engine/read-run", () => ({ readAgentEngineRunRecord: (id: string) => run(id) }));

import { GET } from "@/app/api/runs/[id]/progress/route";

async function progress(): Promise<Record<string, unknown>> {
  const res = await GET(new Request("http://x"), { params: Promise.resolve({ id: "j1" }) });
  return (await res.json()) as Record<string, unknown>;
}

const engineJob = { id: "j1", clientId: "c1", status: "running", agentEngineRunId: "r1", agentEngineProductId: "linkedin-agent" };

describe("the run progress endpoint", () => {
  beforeEach(() => {
    job.mockReset();
    run.mockReset();
  });

  it("says what the engine is doing, in client words, while it works", async () => {
    job.mockResolvedValue(engineJob);
    run.mockResolvedValue({ status: "running", currentStepId: "09-draft-post" });
    const body = await progress();
    expect(body.headline).toBe("Writing the copy");
    expect(body.agentDone).toBeUndefined();
    // No engine step id reaches the browser.
    expect(JSON.stringify(body)).not.toContain("09-draft-post");
  });

  it("stops the bar at a gate, and names no review", async () => {
    // The job still reads `running` here: agent-engine does not treat a gate as
    // terminal. Without `agentDone` the bar would pulse through a human wait.
    job.mockResolvedValue(engineJob);
    run.mockResolvedValue({ status: "awaiting_gate", currentStepId: "15-batch-review-r0" });
    const body = await progress();
    expect(body.agentDone).toBe(true);
    expect(body.headline).toBeUndefined();
    expect(JSON.stringify(body)).not.toMatch(/review/i);
  });

  it("gives a run with no engine behind it a true line once it is running", async () => {
    job.mockResolvedValue({ id: "j1", clientId: "c1", status: "running" });
    expect((await progress()).headline).toBe("Working on it");
    job.mockResolvedValue({ id: "j1", clientId: "c1", status: "queued" });
    expect((await progress()).headline).toBe("Starting the run");
  });

  it("sends no headline once the run has landed", async () => {
    job.mockResolvedValue({ id: "j1", clientId: "c1", status: "review" });
    const body = await progress();
    expect(body.headline).toBeUndefined();
    expect(body.inProgress).toBe(false);
  });
});
