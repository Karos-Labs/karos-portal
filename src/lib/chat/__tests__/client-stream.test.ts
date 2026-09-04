import { describe, expect, it } from "vitest";
import { readChatStream, type ChatStreamEvent } from "../client-stream";

/**
 * T-B4: real behavioral coverage for the client-side half of the stream
 * protocol, driven against fake `Response` bodies (byte-level SSE, exactly
 * what `fetch()` would hand chatbot-widget.tsx) — not a mock of `fetch`
 * itself, so this proves the actual parsing/buffering logic.
 */

function sse(...events: Array<Record<string, unknown> | "[DONE]">): string {
  return events.map((e) => `data: ${e === "[DONE]" ? "[DONE]" : JSON.stringify(e)}\n\n`).join("");
}

/** A `Response` whose body streams the given raw text in arbitrary byte chunks. */
function responseFromChunks(rawChunks: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of rawChunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(stream);
}

async function collect(response: Response): Promise<ChatStreamEvent[]> {
  const out: ChatStreamEvent[] = [];
  for await (const evt of readChatStream(response)) out.push(evt);
  return out;
}

describe("readChatStream", () => {
  it("reconstructs text-delta chunks into the full reply, ignoring framing chunks", async () => {
    const body = sse(
      { type: "start" },
      { type: "start-step" },
      { type: "text-start", id: "0" },
      { type: "text-delta", id: "0", delta: "Hel" },
      { type: "text-delta", id: "0", delta: "lo" },
      { type: "text-end", id: "0" },
      { type: "finish-step" },
      { type: "finish" },
      "[DONE]",
    );
    const events = await collect(responseFromChunks([body]));
    const text = events
      .filter((e): e is Extract<ChatStreamEvent, { type: "text-delta" }> => e.type === "text-delta")
      .map((e) => e.delta)
      .join("");
    expect(text).toBe("Hello");
    // Framing chunks (start/start-step/finish-step/finish/[DONE]) produce no events.
    expect(events).toEqual([
      { type: "text-delta", delta: "Hel" },
      { type: "text-delta", delta: "lo" },
    ]);
  });

  it("resolves a tool-output-available chunk's tool name from the matching tool-input-available", async () => {
    const body = sse(
      { type: "tool-input-available", toolCallId: "call-1", toolName: "create_tasks", input: {} },
      { type: "tool-output-available", toolCallId: "call-1", output: "Created 2 tasks in your task board." },
    );
    const events = await collect(responseFromChunks([body]));
    // The INPUT rides along with the result now (flow audit 2026-09, R12): it
    // is the only place `edit_output`/`reschedule_output` name the asset they
    // acted on, and it was being read for the tool's name and then dropped.
    expect(events).toEqual([
      {
        type: "tool-result",
        toolName: "create_tasks",
        output: "Created 2 tasks in your task board.",
        input: {},
      },
    ]);
  });

  it("carries the arguments a tool was called with through to its result", async () => {
    const body = sse(
      {
        type: "tool-input-available",
        toolCallId: "call-9",
        toolName: "edit_output",
        input: { assetId: "asset-77", newContent: "…" },
      },
      { type: "tool-output-available", toolCallId: "call-9", output: "Saved." },
    );
    const [event] = await collect(responseFromChunks([body]));
    expect(event).toMatchObject({
      type: "tool-result",
      toolName: "edit_output",
      input: { assetId: "asset-77" },
    });
  });

  it("drops a tool-output-available chunk whose call id was never seen (no name to attach)", async () => {
    const body = sse({ type: "tool-output-available", toolCallId: "orphan", output: "whatever" });
    const events = await collect(responseFromChunks([body]));
    expect(events).toEqual([]);
  });

  it("surfaces a data-agentFocus part as a typed agent-focus event, both set and clear", async () => {
    const body = sse(
      { type: "data-agentFocus", data: { id: "agent-1", name: "LinkedIn Agent" } },
      { type: "data-agentFocus", data: null },
    );
    const events = await collect(responseFromChunks([body]));
    expect(events).toEqual([
      { type: "agent-focus", focusAgent: { id: "agent-1", name: "LinkedIn Agent" } },
      { type: "agent-focus", focusAgent: null },
    ]);
  });

  it("surfaces an error chunk as a typed error event", async () => {
    const body = sse({ type: "error", errorText: "An error occurred." });
    const events = await collect(responseFromChunks([body]));
    expect(events).toEqual([{ type: "error", errorText: "An error occurred." }]);
  });

  it("ignores data parts this widget doesn't act on yet (data-model, data-job)", async () => {
    const body = sse(
      { type: "data-model", data: { modelId: "claude-haiku-4-5", vendor: "anthropic" } },
      { type: "data-job", data: { jobId: "job-1", agentName: "X", status: "started" } },
    );
    const events = await collect(responseFromChunks([body]));
    expect(events).toEqual([]);
  });

  it("surfaces a data-feedback part as a typed feedback event (T-B18)", async () => {
    const body = sse({
      type: "data-feedback",
      data: { agentName: "X Agent", agentId: "custom-agent-1", scope: "agent" },
    });
    const events = await collect(responseFromChunks([body]));
    expect(events).toEqual([
      {
        type: "feedback",
        feedback: { agentName: "X Agent", agentId: "custom-agent-1", scope: "agent" },
      },
    ]);
  });

  it("carries templateKey and category through a data-feedback part when present", async () => {
    const body = sse({
      type: "data-feedback",
      data: {
        agentName: "X Agent",
        agentId: "custom-agent-1",
        scope: "template",
        templateKey: "numbers",
        category: "tone",
      },
    });
    const events = await collect(responseFromChunks([body]));
    expect(events).toEqual([
      {
        type: "feedback",
        feedback: {
          agentName: "X Agent",
          agentId: "custom-agent-1",
          scope: "template",
          templateKey: "numbers",
          category: "tone",
        },
      },
    ]);
  });

  it("drops a data-feedback part missing agentId (a stale server build predating T-B18's field)", async () => {
    const body = sse({ type: "data-feedback", data: { agentName: "X Agent", scope: "agent" } });
    const events = await collect(responseFromChunks([body]));
    expect(events).toEqual([]);
  });

  it("drops a data-feedback part with an unrecognized scope", async () => {
    const body = sse({
      type: "data-feedback",
      data: { agentName: "X Agent", agentId: "custom-agent-1", scope: "bogus" },
    });
    const events = await collect(responseFromChunks([body]));
    expect(events).toEqual([]);
  });

  it("buffers a JSON payload split across two reader chunks instead of dropping it", async () => {
    const whole = sse({ type: "text-delta", id: "0", delta: "split across chunks" });
    const splitPoint = Math.floor(whole.length / 2);
    const events = await collect(
      responseFromChunks([whole.slice(0, splitPoint), whole.slice(splitPoint)]),
    );
    expect(events).toEqual([{ type: "text-delta", delta: "split across chunks" }]);
  });

  it("does not crash on a malformed line and keeps yielding the well-formed ones around it", async () => {
    const raw = `data: not json at all\n\n${sse({ type: "text-delta", id: "0", delta: "ok" })}`;
    const events = await collect(responseFromChunks([raw]));
    expect(events).toEqual([{ type: "text-delta", delta: "ok" }]);
  });

  it("yields nothing for a response with no body", async () => {
    const response = new Response(null);
    const events = await collect(response);
    expect(events).toEqual([]);
  });
});
