import { describe, it, expect } from "vitest";
import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";
import { MockLanguageModelV3, simulateReadableStream } from "ai/test";
import { runGuardedReportPass } from "../intel/report-stream";

/* ── Mock stream builders ─────────────────────────────────────────── */

/** A well-formed text stream that finishes cleanly. */
function textStream(parts: string[]): LanguageModelV3StreamPart[] {
  return [
    { type: "stream-start", warnings: [] },
    { type: "text-start", id: "0" },
    ...parts.map((delta): LanguageModelV3StreamPart => ({ type: "text-delta", id: "0", delta })),
    { type: "text-end", id: "0" },
    {
      type: "finish",
      finishReason: { unified: "stop", raw: "stop" },
      usage: {
        inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: parts.length, text: parts.length, reasoning: 0 },
      },
    },
  ];
}

/** A stream that emits some text and then a provider error mid-flight (overload/quota). */
function erroringStream(): LanguageModelV3StreamPart[] {
  return [
    { type: "stream-start", warnings: [] },
    { type: "text-start", id: "0" },
    { type: "text-delta", id: "0", delta: "partial answer before the failure..." },
    { type: "error", error: new Error("overloaded_error: the model is temporarily overloaded") },
  ];
}

function mockModel(
  chunks: LanguageModelV3StreamPart[],
  streamOpts: { initialDelayInMs?: number; chunkDelayInMs?: number } = {},
): MockLanguageModelV3 {
  return new MockLanguageModelV3({
    doStream: async () => ({ stream: simulateReadableStream({ chunks, ...streamOpts }) }),
  });
}

const baseOpts = {
  system: "You are the Intel Report agent. " + "x".repeat(2000),
  messages: [{ role: "user" as const, content: "Generate the report." }],
  maxOutputTokens: 1000,
  maxSteps: 4,
};

/* ── Tests ────────────────────────────────────────────────────────── */

describe("runGuardedReportPass — streaming resilience", () => {
  it("assembles a long, chunked stream to completion without error", async () => {
    const parts = Array.from({ length: 60 }, (_, i) => `sentence-${i} `);
    const pass = await runGuardedReportPass(mockModel(textStream(parts), { chunkDelayInMs: 1 }), baseOpts);

    expect(pass.streamError).toBeUndefined();
    expect(pass.timedOut).toBe(false);
    expect(pass.text).toContain("sentence-0");
    expect(pass.text).toContain("sentence-59");
    expect(pass.stream).not.toBeNull();
  });

  it("captures a mid-stream provider error and resolves gracefully (no throw)", async () => {
    // Awaiting without a try/catch: if it rejected, the test itself would fail.
    const pass = await runGuardedReportPass(mockModel(erroringStream(), { chunkDelayInMs: 1 }), baseOpts);

    expect(pass.streamError).toBeDefined();
    expect(String((pass.streamError as Error)?.message ?? pass.streamError)).toContain("overloaded");
    // The partial text that arrived before the error is preserved, not lost.
    expect(pass.text).toContain("partial answer");
  });

  it("aborts a STALLED stream on the idle timeout without an unhandled rejection", async () => {
    // No chunk arrives for 2s; the 25ms idle timeout fires long before the first one.
    const pass = await runGuardedReportPass(mockModel(textStream(["never arrives"]), { initialDelayInMs: 2000 }), {
      ...baseOpts,
      idleTimeoutMs: 25,
    });

    expect(pass.timedOut).toBe(true);
  }, 10_000);

  it("does NOT abort a slow-but-progressing stream (idle timer resets on each chunk)", async () => {
    // 20 chunks each 40ms apart = 800ms total, well past the 120ms idle window — but each
    // chunk resets the idle timer, so a healthy trickle completes instead of being cut.
    const parts = Array.from({ length: 20 }, (_, i) => `tok-${i} `);
    const pass = await runGuardedReportPass(mockModel(textStream(parts), { chunkDelayInMs: 40 }), {
      ...baseOpts,
      idleTimeoutMs: 120,
    });

    expect(pass.timedOut).toBe(false);
    expect(pass.text).toContain("tok-19");
  }, 10_000);

  it("never emits an unhandledRejection across the error and timeout paths", async () => {
    const rejections: unknown[] = [];
    const handler = (reason: unknown) => rejections.push(reason);
    process.on("unhandledRejection", handler);
    try {
      await Promise.all([
        runGuardedReportPass(mockModel(erroringStream(), { chunkDelayInMs: 1 }), baseOpts),
        runGuardedReportPass(mockModel(textStream(["x"]), { initialDelayInMs: 2000 }), { ...baseOpts, idleTimeoutMs: 25 }),
        runGuardedReportPass(mockModel(textStream(["ok done"]), { chunkDelayInMs: 1 }), baseOpts),
      ]);
      // Let any stray microtasks/timers settle so a late rejection would be caught.
      await new Promise((r) => setTimeout(r, 100));
    } finally {
      process.off("unhandledRejection", handler);
    }
    expect(rejections).toEqual([]);
  }, 10_000);
});
