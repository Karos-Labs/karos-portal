import { afterEach, describe, expect, it, vi } from "vitest";
import { ServiceCallback } from "../runner/src/callback.js";
import type { JobSpec } from "../src/types.js";

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
  vi.useRealTimers();
});

function fakeSpec(): JobSpec {
  return {
    jobId: "job-1",
    taskType: "custom",
    clientId: "client-1",
    brief: {},
    contextFiles: [],
    timeoutMs: 60_000,
    callbackBaseUrl: "https://agent-service.example",
    runnerToken: "runner-token",
    attempt: 1,
    maxAttempts: 1,
  };
}

/** Advances past every scheduled backoff (1s, 2s, 4s) regardless of how many retries a case takes. */
async function runOutBackoffs(): Promise<void> {
  await vi.advanceTimersByTimeAsync(1_000);
  await vi.advanceTimersByTimeAsync(2_000);
  await vi.advanceTimersByTimeAsync(4_000);
}

describe("ServiceCallback.complete", () => {
  it("reports success on the first try without retrying", async () => {
    let calls = 0;
    global.fetch = vi.fn(async () => {
      calls += 1;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    await new ServiceCallback(fakeSpec()).complete({ outcome: "done" });
    expect(calls).toBe(1);
  });

  it("retries a network failure and succeeds on the next attempt", async () => {
    vi.useFakeTimers();
    let calls = 0;
    global.fetch = vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw new Error("fetch failed: network blip");
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    const promise = new ServiceCallback(fakeSpec()).complete({ outcome: "done" });
    await runOutBackoffs();
    await promise;
    expect(calls).toBe(2);
  });

  it("retries a 503 and succeeds on the next attempt", async () => {
    vi.useFakeTimers();
    let calls = 0;
    global.fetch = vi.fn(async () => {
      calls += 1;
      if (calls === 1) return new Response("unavailable", { status: 503 });
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    const promise = new ServiceCallback(fakeSpec()).complete({ outcome: "failed", error: "boom" });
    await runOutBackoffs();
    await promise;
    expect(calls).toBe(2);
  });

  it("gives up and throws after exhausting every retry", async () => {
    vi.useFakeTimers();
    global.fetch = vi.fn(async () => {
      throw new Error("service unreachable");
    }) as unknown as typeof fetch;

    const promise = new ServiceCallback(fakeSpec()).complete({ outcome: "done" });
    const assertion = expect(promise).rejects.toThrow("service unreachable");
    await runOutBackoffs();
    await assertion;
    expect(global.fetch).toHaveBeenCalledTimes(4);
  });

  it("does not retry a 4xx — a bad request won't be fixed by trying again", async () => {
    let calls = 0;
    global.fetch = vi.fn(async () => {
      calls += 1;
      return new Response("unauthorized", { status: 401 });
    }) as unknown as typeof fetch;

    await expect(new ServiceCallback(fakeSpec()).complete({ outcome: "done" })).rejects.toThrow("401");
    expect(calls).toBe(1);
  });

  it("does retry a 429 (rate limit), unlike other 4xx statuses", async () => {
    vi.useFakeTimers();
    let calls = 0;
    global.fetch = vi.fn(async () => {
      calls += 1;
      if (calls === 1) return new Response("slow down", { status: 429 });
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    const promise = new ServiceCallback(fakeSpec()).complete({ outcome: "done" });
    await runOutBackoffs();
    await promise;
    expect(calls).toBe(2);
  });
});
