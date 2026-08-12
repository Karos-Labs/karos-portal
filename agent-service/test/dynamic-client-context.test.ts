import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DynamicAgentSpec } from "../src/dynamic-types.js";
import type { JobSpec } from "../src/types.js";

/**
 * Feature: per-AI-step "client data access" grant. `resolveClientContextText`
 * (run-dynamic-job.ts) is the piece that decides WHETHER to pay for the
 * download at all, and turns the downloaded file(s) into the one string
 * step-runner.ts threads into a granted step's prompt. `downloadContextFiles`
 * itself already has its own coverage (context-files.test.ts) — this file
 * only exercises the decision + read-back logic around it.
 */

const downloadContextFilesMock = vi.fn();
vi.mock("../runner/src/context-files.js", () => ({
  downloadContextFiles: (...args: unknown[]) => downloadContextFilesMock(...args),
}));

const readFileMock = vi.fn();
vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  return { ...actual, readFile: (...args: unknown[]) => readFileMock(...args) };
});

function aiStep(allowClientData: boolean): DynamicAgentSpec["steps"][number] {
  return { id: "a", type: "ai", label: "A", model: "sonnet", prompt: "go", order: 0, allowClientData };
}

function snapshot(steps: DynamicAgentSpec["steps"]): DynamicAgentSpec {
  return {
    id: "spec-1",
    name: "Test",
    description: "d",
    category: "c",
    icon: "Sparkles",
    creditsCost: 1,
    active: true,
    version: 1,
    inputSchema: [],
    steps,
    createdAt: 0,
    updatedAt: 0,
    createdBy: "u1",
  };
}

function jobSpec(contextFiles: JobSpec["contextFiles"]): JobSpec {
  return {
    jobId: "job-1",
    taskType: "custom",
    clientId: "c1",
    brief: {},
    contextFiles,
    timeoutMs: 60_000,
    callbackBaseUrl: "https://platform.test",
    runnerToken: "tok",
    attempt: 1,
    maxAttempts: 1,
  };
}

const workspace = { repoDir: "/work/repo", clientSlug: "acme" };

beforeEach(() => {
  vi.clearAllMocks();
});

describe("resolveClientContextText", () => {
  it("returns undefined and never downloads anything when no step requests client data", async () => {
    const { resolveClientContextText } = await import("../runner/src/dynamic/run-dynamic-job.js");
    const result = await resolveClientContextText(
      snapshot([aiStep(false)]),
      jobSpec([{ name: "client-context.md", url: "https://files.test/x" }]),
      workspace,
    );
    expect(result).toBeUndefined();
    expect(downloadContextFilesMock).not.toHaveBeenCalled();
  });

  it("returns undefined when a step requests client data but the brief carries no context files", async () => {
    const { resolveClientContextText } = await import("../runner/src/dynamic/run-dynamic-job.js");
    const result = await resolveClientContextText(snapshot([aiStep(true)]), jobSpec([]), workspace);
    expect(result).toBeUndefined();
    expect(downloadContextFilesMock).not.toHaveBeenCalled();
  });

  it("downloads and reads the file back into a string when a step requests client data and context files are present", async () => {
    downloadContextFilesMock.mockResolvedValue([{ name: "client-context.md", bytes: 42 }]);
    readFileMock.mockResolvedValue("This client's brand voice is playful.");
    const { resolveClientContextText } = await import("../runner/src/dynamic/run-dynamic-job.js");
    const result = await resolveClientContextText(
      snapshot([aiStep(true)]),
      jobSpec([{ name: "client-context.md", url: "https://files.test/x" }]),
      workspace,
    );
    expect(downloadContextFilesMock).toHaveBeenCalledWith(
      workspace.repoDir,
      workspace.clientSlug,
      [{ name: "client-context.md", url: "https://files.test/x" }],
    );
    expect(result).toBe("This client's brand voice is playful.");
  });

  it("returns undefined when the downloaded file is empty, rather than an empty string", async () => {
    downloadContextFilesMock.mockResolvedValue([{ name: "client-context.md", bytes: 0 }]);
    readFileMock.mockResolvedValue("   ");
    const { resolveClientContextText } = await import("../runner/src/dynamic/run-dynamic-job.js");
    const result = await resolveClientContextText(
      snapshot([aiStep(true)]),
      jobSpec([{ name: "client-context.md", url: "https://files.test/x" }]),
      workspace,
    );
    expect(result).toBeUndefined();
  });
});
