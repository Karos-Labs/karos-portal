/**
 * T-B4: the client-side half of the real stream protocol.
 *
 * Decodes the `Response` `createChatStreamResponse` (stream-protocol.ts)
 * returns — a UI-message SSE stream (`data: <json>\n\n` per chunk, `ai`'s
 * `JsonToSseTransformStream` framing) — into the small, typed set of events
 * `chatbot-widget.tsx` actually reacts to. No React, no server-only imports:
 * this is a pure function of a `Response`, so it is unit-testable with a
 * fake stream instead of driving the whole widget.
 *
 * This replaces two things the old plain-text protocol forced onto the
 * client:
 *  - regexing `<!-- COPILOT_FOCUS:{...} -->` out of the raw text (now the
 *    typed `data-agentFocus` part, surfaced here as `agent-focus`), and
 *  - sniffing the model's own PROSE for magic substrings ("Branding
 *    guidelines updated", "Created ... task") to guess which tool ran (now
 *    the protocol's own `tool-input-available` / `tool-output-available`
 *    parts, surfaced here as `tool-result` with the tool's REAL name).
 */

export type ChatStreamEvent =
  | { type: "text-delta"; delta: string }
  | { type: "agent-focus"; focusAgent: { id: string; name: string } | null }
  | { type: "tool-result"; toolName: string; output: unknown }
  | { type: "error"; errorText?: string };

/** One line of the SSE body, parsed to its JSON payload — or null for framing/noise. */
function parseSseLine(line: string): Record<string, unknown> | null {
  if (!line.startsWith("data: ")) return null;
  const payload = line.slice("data: ".length).trim();
  if (!payload || payload === "[DONE]") return null;
  try {
    return JSON.parse(payload) as Record<string, unknown>;
  } catch {
    // A line split across two reader chunks mid-JSON is buffered by the
    // caller before it ever reaches here (see readChatStream) — a parse
    // failure at this point is a genuinely malformed line, so it's dropped
    // rather than crashing the whole turn over one bad chunk.
    return null;
  }
}

/**
 * One raw UI-message chunk -> the event this module exposes, or null for a
 * chunk type this widget doesn't act on (text-start/end, step boundaries,
 * the `data-model`/`data-job`/`data-feedback` parts no current UI reads yet).
 *
 * `toolNameByCallId` exists because `tool-output-available` carries no
 * `toolName` of its own (see stream-protocol.ts's own note on this) — only
 * `tool-input-available`, earlier in the same tool call, does.
 */
function mapChunk(
  chunk: Record<string, unknown>,
  toolNameByCallId: Map<string, string>,
): ChatStreamEvent | null {
  switch (chunk.type) {
    case "text-delta":
      return typeof chunk.delta === "string" ? { type: "text-delta", delta: chunk.delta } : null;
    case "tool-input-available":
      if (typeof chunk.toolCallId === "string" && typeof chunk.toolName === "string") {
        toolNameByCallId.set(chunk.toolCallId, chunk.toolName);
      }
      return null;
    case "tool-output-available": {
      const toolCallId = chunk.toolCallId;
      const toolName = typeof toolCallId === "string" ? toolNameByCallId.get(toolCallId) : undefined;
      return toolName ? { type: "tool-result", toolName, output: chunk.output } : null;
    }
    case "data-agentFocus":
      return {
        type: "agent-focus",
        focusAgent: (chunk.data as { id: string; name: string } | null | undefined) ?? null,
      };
    case "error":
      return { type: "error", errorText: typeof chunk.errorText === "string" ? chunk.errorText : undefined };
    default:
      return null;
  }
}

/**
 * Read a chat route `Response` and yield its events in order.
 *
 * Buffers across reader chunks on newline boundaries so a chunk split
 * mid-line (a real possibility over HTTP) never truncates a JSON payload —
 * only complete lines are handed to `parseSseLine`.
 */
export async function* readChatStream(response: Response): AsyncGenerator<ChatStreamEvent> {
  const body = response.body;
  if (!body) return;
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const toolNameByCallId = new Map<string, string>();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const chunk = parseSseLine(line);
        if (!chunk) continue;
        const event = mapChunk(chunk, toolNameByCallId);
        if (event) yield event;
      }
    }
    // A final line with no trailing newline (unlikely from this server's own
    // writer, which always terminates with one, but not guaranteed of every
    // intermediary) would otherwise be silently dropped in `buffer`.
    const chunk = parseSseLine(buffer);
    if (chunk) {
      const event = mapChunk(chunk, toolNameByCallId);
      if (event) yield event;
    }
  } finally {
    reader.releaseLock();
  }
}
