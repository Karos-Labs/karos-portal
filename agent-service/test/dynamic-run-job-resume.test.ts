import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DynamicAgentJobPayload } from "../src/dynamic-types.js";
import type { JobSpec } from "../src/types.js";

/**
 * run-dynamic-job.ts's OWN control flow — the deterministic runFolder, and
 * when it restores/saves a checkpoint — with everything it talks to mocked:
 * the workspace/filesystem, the artifact machinery, checkpoint save/restore,
 * and runDynamicSteps itself. What ran ALREADY has its own coverage
 * (dynamic-step-runner.test.ts, dynamic-end-to-end.test.ts); this file is
 * about the NEW wiring around it.
 */

const mkdirMock = vi.fn().mockResolvedValue(undefined);
const writeFileMock = vi.fn().mockResolvedValue(undefined);
const readFileMock = vi.fn();
vi.mock("node:fs/promises", () => ({
  mkdir: (...a: unknown[]) => mkdirMock(...a),
  writeFile: (...a: unknown[]) => writeFileMock(...a),
  readFile: (...a: unknown[]) => readFileMock(...a),
}));

const prepareWorkspaceMock = vi.fn().mockResolvedValue({
  repoDir: "/work/repo",
  clientSlug: "acme",
  agentsRepoSha: "sha1",
});
vi.mock("../runner/src/workspace.js", () => ({
  prepareWorkspace: (...a: unknown[]) => prepareWorkspaceMock(...a),
}));

const snapshotOutputsMock = vi.fn().mockResolvedValue({ files: new Map() });
const collectArtifactsMock = vi.fn().mockResolvedValue({ artifacts: [], skipped: [] });
vi.mock("../runner/src/artifacts.js", () => ({
  snapshotOutputs: (...a: unknown[]) => snapshotOutputsMock(...a),
  collectArtifacts: (...a: unknown[]) => collectArtifactsMock(...a),
  guessContentType: () => undefined,
}));

const restoreCheckpointMock = vi.fn().mockResolvedValue(0);
const saveCheckpointMock = vi.fn().mockResolvedValue(undefined);
vi.mock("../runner/src/checkpoint.js", () => ({
  restoreCheckpoint: (...a: unknown[]) => restoreCheckpointMock(...a),
  saveCheckpoint: (...a: unknown[]) => saveCheckpointMock(...a),
}));

const runDynamicStepsMock = vi.fn();
vi.mock("../runner/src/dynamic/step-runner.js", () => ({
  runDynamicSteps: (...a: unknown[]) => runDynamicStepsMock(...a),
}));

vi.mock("../runner/src/transcript.js", () => ({
  TranscriptStreamer: class {
    append() {}
    async close() {}
  },
}));

function fakeCallback() {
  return { reportStepProgress: vi.fn().mockResolvedValue(undefined) } as never;
}

function baseSpec(overrides: Partial<JobSpec> = {}): JobSpec {
  return {
    jobId: "job-12345678-abcd",
    taskType: "custom",
    clientId: "client-1",
    brief: {},
    contextFiles: [],
    timeoutMs: 60_000,
    callbackBaseUrl: "https://agent-service.internal",
    runnerToken: "tok",
    attempt: 1,
    maxAttempts: 3,
    ...overrides,
  };
}

function basePayload(): DynamicAgentJobPayload {
  return {
    specId: "spec-1",
    specVersion: 1,
    specSnapshot: {
      id: "spec-1",
      name: "Test agent",
      description: "d",
      category: "c",
      icon: "Sparkles",
      creditsCost: 1,
      active: true,
      version: 1,
      inputSchema: [],
      steps: [{ id: "a", type: "ai", label: "Step A", model: "sonnet", prompt: "p", order: 0 }],
      createdAt: 0,
      updatedAt: 0,
      createdBy: "u1",
    },
    clientId: "client-1",
    inputs: {},
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mkdirMock.mockResolvedValue(undefined);
  writeFileMock.mockResolvedValue(undefined);
  prepareWorkspaceMock.mockResolvedValue({ repoDir: "/work/repo", clientSlug: "acme", agentsRepoSha: "sha1" });
  snapshotOutputsMock.mockResolvedValue({ files: new Map() });
  collectArtifactsMock.mockResolvedValue({ artifacts: [], skipped: [] });
  restoreCheckpointMock.mockResolvedValue(0);
  saveCheckpointMock.mockResolvedValue(undefined);
});

describe("runFolder is deterministic across attempts", () => {
  it("never includes a date component, so a restored checkpoint's files land at the same path on attempt 2", async () => {
    runDynamicStepsMock.mockResolvedValue({ ok: true, outputs: {}, trace: [] });
    const { runDynamicJob } = await import("../runner/src/dynamic/run-dynamic-job.js");
    await runDynamicJob(baseSpec({ attempt: 1 }), basePayload(), fakeCallback());
    const dirsAttempt1 = mkdirMock.mock.calls.map((c) => c[0] as string);

    vi.clearAllMocks();
    mkdirMock.mockResolvedValue(undefined);
    writeFileMock.mockResolvedValue(undefined);
    prepareWorkspaceMock.mockResolvedValue({ repoDir: "/work/repo", clientSlug: "acme", agentsRepoSha: "sha1" });
    snapshotOutputsMock.mockResolvedValue({ files: new Map() });
    collectArtifactsMock.mockResolvedValue({ artifacts: [], skipped: [] });
    readFileMock.mockRejectedValue(new Error("nothing checkpointed"));
    runDynamicStepsMock.mockResolvedValue({ ok: true, outputs: {}, trace: [] });

    const { runDynamicJob: runAgain } = await import("../runner/src/dynamic/run-dynamic-job.js");
    await runAgain(baseSpec({ attempt: 2 }), basePayload(), fakeCallback());
    const dirsAttempt2 = mkdirMock.mock.calls.map((c) => c[0] as string);

    expect(dirsAttempt1).toEqual(dirsAttempt2);
    expect(dirsAttempt1.some((d) => /\d{4}-\d{2}-\d{2}/.test(d))).toBe(false);
    // runFolder = `job-${spec.jobId.slice(0, 8)}` — jobId "job-12345678-abcd" sliced to "job-1234"
    expect(dirsAttempt1.some((d) => d.includes("job-job-1234"))).toBe(true);
  });
});

describe("checkpoint save on failure", () => {
  it("saves a checkpoint (keyed by this attempt) after a failed run, so a resume has something to restore", async () => {
    runDynamicStepsMock.mockResolvedValue({
      ok: false,
      error: "step a blew up",
      trace: [],
      failedStepId: "a",
      failedStepIndex: 0,
      partialOutputs: {},
    });
    const { runDynamicJob } = await import("../runner/src/dynamic/run-dynamic-job.js");
    const result = await runDynamicJob(baseSpec({ attempt: 1 }), basePayload(), fakeCallback());
    expect(result.outcome).toBe("failed");
    expect(saveCheckpointMock).toHaveBeenCalledWith(expect.anything(), "/work/repo", "acme", 1);
  });

  it("never saves a checkpoint after a successful run — nothing to resume from", async () => {
    runDynamicStepsMock.mockResolvedValue({ ok: true, outputs: { a: "out" }, trace: [], finalOutput: "out" });
    const { runDynamicJob } = await import("../runner/src/dynamic/run-dynamic-job.js");
    await runDynamicJob(baseSpec({ attempt: 1 }), basePayload(), fakeCallback());
    expect(saveCheckpointMock).not.toHaveBeenCalled();
  });
});

describe("checkpoint restore on a retried attempt", () => {
  it("attempt 1 never calls restoreCheckpoint", async () => {
    runDynamicStepsMock.mockResolvedValue({ ok: true, outputs: {}, trace: [] });
    const { runDynamicJob } = await import("../runner/src/dynamic/run-dynamic-job.js");
    await runDynamicJob(baseSpec({ attempt: 1 }), basePayload(), fakeCallback());
    expect(restoreCheckpointMock).not.toHaveBeenCalled();
    expect(runDynamicStepsMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.not.objectContaining({ resumeFrom: expect.anything() }),
    );
  });

  it("attempt > 1 restores the checkpoint and passes a resumeFrom built from the prior attempt's trace/partial-outputs", async () => {
    restoreCheckpointMock.mockResolvedValue(1);
    readFileMock.mockImplementation((filePath: string) => {
      if (filePath.endsWith("trace.json")) {
        return Promise.resolve(
          JSON.stringify([{ stepId: "a", type: "ai", label: "Step A", status: "done", durationMs: 50 }]),
        );
      }
      if (filePath.endsWith("partial-outputs.json")) {
        return Promise.resolve(JSON.stringify({ a: "a-out" }));
      }
      return Promise.reject(new Error(`unexpected read: ${filePath}`));
    });
    runDynamicStepsMock.mockResolvedValue({ ok: true, outputs: { a: "a-out", b: "b-out" }, trace: [] });

    const { runDynamicJob } = await import("../runner/src/dynamic/run-dynamic-job.js");
    await runDynamicJob(baseSpec({ attempt: 2 }), basePayload(), fakeCallback());

    expect(restoreCheckpointMock).toHaveBeenCalledWith(expect.anything(), "/work/repo");
    expect(runDynamicStepsMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        resumeFrom: {
          completedStepIds: new Set(["a"]),
          outputs: { a: "a-out" },
          priorTrace: [{ stepId: "a", type: "ai", label: "Step A", status: "done", durationMs: 50 }],
        },
      }),
    );
  });

  it("a missing/corrupt checkpoint on attempt > 1 just means starting fresh, never a hard failure", async () => {
    restoreCheckpointMock.mockResolvedValue(0);
    readFileMock.mockRejectedValue(new Error("ENOENT"));
    runDynamicStepsMock.mockResolvedValue({ ok: true, outputs: {}, trace: [] });

    const { runDynamicJob } = await import("../runner/src/dynamic/run-dynamic-job.js");
    const result = await runDynamicJob(baseSpec({ attempt: 2 }), basePayload(), fakeCallback());

    expect(result.outcome).toBe("done");
    expect(runDynamicStepsMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.not.objectContaining({ resumeFrom: expect.anything() }),
    );
  });
});
