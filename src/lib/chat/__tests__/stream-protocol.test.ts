import { describe, expect, it } from "vitest";
import { tool } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { z } from "zod";
import {
  createChatStreamResponse,
  type ChatDataParts,
  type ChatStreamWriter,
} from "../stream-protocol";

/**
 * T-B4: real behavioral coverage for the new stream protocol, driven against
 * a mock model — not a type-check and not a source scan (the route itself
 * stays source-scanned in chat-route-*.test.ts, matching this repo's existing
 * precedent for that 1000+ line, Firestore-heavy file; this module is the
 * part of T-B4 that has NO such dependency and can be driven for real).
 *
 * Each test reads the actual HTTP `Response` this module returns end to end
 * (SSE body -> parsed JSON chunks), the same bytes a browser would receive,
 * so a green test here means the protocol genuinely emits what it claims to.
 */

/** Decode the SSE body into the ordered list of UI message chunks. */
async function readChunks(response: Response): Promise<Array<Record<string, unknown>>> {
  const text = await response.text();
  const chunks: Array<Record<string, unknown>> = [];
  for (const line of text.split("\n")) {
    if (!line.startsWith("data: ")) continue;
    const payload = line.slice("data: ".length).trim();
    if (payload === "[DONE]") continue;
    chunks.push(JSON.parse(payload));
  }
  return chunks;
}

/** A single-step model that just streams text then finishes. */
function makeTextModel(parts: string[]) {
  return new MockLanguageModelV3({
    doStream: async () => ({
      stream: streamOf([
        { type: "stream-start", warnings: [] },
        { type: "text-start", id: "0" },
        ...parts.map((delta) => ({ type: "text-delta" as const, id: "0", delta })),
        { type: "text-end", id: "0" },
        {
          type: "finish",
          finishReason: { unified: "stop", raw: "stop" },
          usage: {
            inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
            outputTokens: { total: parts.length, text: parts.length, reasoning: 0 },
          },
        },
      ]),
    }),
  });
}

/** A model that errors mid-stream after some partial text (provider overload, a 5xx). */
function makeErroringModel() {
  return new MockLanguageModelV3({
    doStream: async () => ({
      stream: streamOf([
        { type: "stream-start", warnings: [] },
        { type: "text-start", id: "0" },
        { type: "text-delta", id: "0", delta: "partial before the failure..." },
        { type: "error", error: new Error("overloaded_error: temporarily overloaded") },
      ]),
    }),
  });
}

/**
 * A two-step model: step 1 calls a tool, step 2 (fed the tool result) answers
 * with text. `MockLanguageModelV3` indexes an array of `doStream` results by
 * call count, so this drives the SAME multi-step loop `stopWhen: stepCountIs`
 * runs for the real copilot.
 */
function makeToolCallingModel() {
  return new MockLanguageModelV3({
    doStream: [
      {
        stream: streamOf([
          { type: "stream-start", warnings: [] },
          {
            type: "tool-call",
            toolCallId: "call-1",
            toolName: "start_job",
            input: "{}",
          },
          {
            type: "finish",
            finishReason: { unified: "tool-calls", raw: "tool_calls" },
            usage: {
              inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
              outputTokens: { total: 5, text: 0, reasoning: 0 },
            },
          },
        ]),
      },
      {
        stream: streamOf([
          { type: "stream-start", warnings: [] },
          { type: "text-start", id: "1" },
          { type: "text-delta", id: "1", delta: "Started it." },
          { type: "text-end", id: "1" },
          {
            type: "finish",
            finishReason: { unified: "stop", raw: "stop" },
            usage: {
              inputTokens: { total: 15, noCache: 15, cacheRead: 0, cacheWrite: 0 },
              outputTokens: { total: 3, text: 3, reasoning: 0 },
            },
          },
        ]),
      },
    ],
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function streamOf(chunks: any[]): ReadableStream<any> {
  let i = 0;
  return new ReadableStream({
    pull(controller) {
      if (i < chunks.length) {
        controller.enqueue(chunks[i++]);
      } else {
        controller.close();
      }
    },
  });
}

const MODEL_META: ChatDataParts["model"] = { modelId: "claude-haiku-4-5", vendor: "anthropic" };

/** `onFinish`/`onError` are required on `createChatStreamResponse` (the real
 *  route always wires both); tests that don't care about either still have
 *  to supply a no-op. */
const NOOP_CALLBACKS = { onFinish: () => {}, onError: () => {} };

describe("createChatStreamResponse", () => {
  it("is a real UI message stream, not the old plain-text protocol", async () => {
    const response = createChatStreamResponse({
      model: makeTextModel(["Hello"]),
      modelMeta: MODEL_META,
      system: "You are a helpful assistant.",
      messages: [{ role: "user", content: "hi" }],
      tools: {},
      stopWhen: () => true,
      ...NOOP_CALLBACKS,
    });

    // The old route returned `toTextStreamResponse()` — a bare text/plain
    // body with no structure at all. This asserts the actual wire format
    // changed, not just that SOME response came back.
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(response.headers.get("x-vercel-ai-ui-message-stream")).toBe("v1");

    const chunks = await readChunks(response);
    const types = chunks.map((c) => c.type);
    expect(types).toContain("text-delta");
    // Every chunk parsed as JSON (readChunks would have thrown on malformed
    // SSE otherwise) - non-vacuous: at least the start/finish framing plus
    // our text delta.
    expect(chunks.length).toBeGreaterThan(2);
  });

  it("emits a data-model part naming which model/vendor actually ran, before any text", async () => {
    const response = createChatStreamResponse({
      model: makeTextModel(["hi there"]),
      modelMeta: { modelId: "claude-sonnet-4-6", vendor: "vertex" },
      system: "sys",
      messages: [{ role: "user", content: "hi" }],
      tools: {},
      stopWhen: () => true,
      ...NOOP_CALLBACKS,
    });

    const chunks = await readChunks(response);
    const modelIdx = chunks.findIndex((c) => c.type === "data-model");
    const firstTextIdx = chunks.findIndex((c) => c.type === "text-delta");

    expect(modelIdx).toBeGreaterThanOrEqual(0);
    expect(chunks[modelIdx].data).toEqual({ modelId: "claude-sonnet-4-6", vendor: "vertex" });
    // Emitted up front - a client reading the stream knows which model/vendor
    // served the turn before the first word of the reply arrives.
    expect(modelIdx).toBeLessThan(firstTextIdx);
  });

  it("carries a tool call and its result as typed protocol parts, not text a client must parse", async () => {
    let writer: ChatStreamWriter | null = null;
    const startJobTool = tool({
      description: "start a job",
      inputSchema: z.object({}),
      execute: async () => {
        writer?.write({
          type: "data-job",
          data: { jobId: "job-42", agentName: "LinkedIn Agent", status: "started" },
        });
        return "Started job job-42.";
      },
    });

    const response = createChatStreamResponse({
      model: makeToolCallingModel(),
      modelMeta: MODEL_META,
      system: "sys",
      messages: [{ role: "user", content: "run it" }],
      tools: { start_job: startJobTool },
      stopWhen: () => false, // let the model's own tool-calls finish reason end the run
      registerWriter: (w) => {
        writer = w;
      },
      ...NOOP_CALLBACKS,
    });

    const chunks = await readChunks(response);
    const types = chunks.map((c) => c.type);

    // The tool call and its result are FIRST-CLASS protocol parts.
    expect(types).toContain("tool-input-available");
    expect(types).toContain("tool-output-available");
    const toolInput = chunks.find((c) => c.type === "tool-input-available");
    expect(toolInput).toMatchObject({ toolName: "start_job" });

    // The job id reaches the client as a TYPED data part the tool wrote mid-
    // execution, not as a string baked into the assistant's prose.
    const jobPart = chunks.find((c) => c.type === "data-job");
    expect(jobPart).toBeDefined();
    expect(jobPart!.data).toEqual({ jobId: "job-42", agentName: "LinkedIn Agent", status: "started" });

    // And the final answer still streams as ordinary text.
    const finalText = chunks
      .filter((c) => c.type === "text-delta")
      .map((c) => c.delta)
      .join("");
    expect(finalText).toContain("Started it.");
  });

  it("surfaces a mid-stream provider error as a real error part instead of vanishing silently", async () => {
    let observedError: unknown;
    const response = createChatStreamResponse({
      model: makeErroringModel(),
      modelMeta: MODEL_META,
      system: "sys",
      messages: [{ role: "user", content: "hi" }],
      tools: {},
      stopWhen: () => true,
      onFinish: NOOP_CALLBACKS.onFinish,
      onError: ({ error }) => {
        observedError = error;
      },
    });

    const chunks = await readChunks(response);
    const types = chunks.map((c) => c.type);

    // The partial text that streamed before the failure is not lost.
    const partial = chunks
      .filter((c) => c.type === "text-delta")
      .map((c) => c.delta)
      .join("");
    expect(partial).toContain("partial before the failure");

    // Unlike the old `toTextStreamResponse()` protocol - which had no error
    // channel at all, so a failed turn just stopped producing bytes and the
    // HTTP response completed as an empty success - this protocol carries a
    // real `error` chunk the client can detect and act on.
    expect(types).toContain("error");

    // The route's own onError (logging/alerting) still fires with the real,
    // unsanitized error - only the chunk sent to the CLIENT is sanitized.
    expect(String((observedError as Error)?.message ?? observedError)).toContain("overloaded");
  });

  it("never lets a client-facing error chunk leak the raw server error text", async () => {
    const response = createChatStreamResponse({
      model: makeErroringModel(),
      modelMeta: MODEL_META,
      system: "sys",
      messages: [{ role: "user", content: "hi" }],
      tools: {},
      stopWhen: () => true,
      ...NOOP_CALLBACKS,
    });

    const chunks = await readChunks(response);
    const errorChunk = chunks.find((c) => c.type === "error") as { errorText?: string } | undefined;
    expect(errorChunk).toBeDefined();
    // Default sanitization (ai/toUIMessageStream's default onError) - the
    // internal message text must not reach this chunk verbatim.
    expect(errorChunk!.errorText ?? "").not.toContain("overloaded_error");
  });
});
