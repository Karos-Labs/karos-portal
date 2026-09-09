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
 *
 * T-B18 added the third: the `data-feedback` part `provide_feedback` writes
 * (stream-protocol.ts / chat/route.ts) is surfaced here as `feedback`, so
 * chatbot-widget.tsx can render a real confirmation chip — which agent, which
 * scope, a link into that agent's own feedback panel — instead of the model's
 * prose being the only place the client ever sees it recorded.
 */

// Type-only — erased at compile time, so this does not actually pull
// stream-protocol.ts's (server-safe, but still not a client concern) module
// into the client bundle; it only borrows the shape `data-feedback` chunks
// are written in, so the two sides of the wire cannot drift apart silently.
import type { ChatDataParts } from "./stream-protocol";

export type ChatStreamEvent =
  | { type: "text-delta"; delta: string }
  | { type: "agent-focus"; focusAgent: { id: string; name: string } | null }
  /**
   * A finished tool call: its real name, what it returned, and — added for the
   * flow audit's R12 (2026-09) — what it was CALLED WITH. The input is where
   * `edit_output` and `reschedule_output` name the asset they acted on
   * (`{ assetId }`); their result strings do not. Carrying it costs nothing (the
   * protocol already sends a `tool-input-available` chunk for every call, and
   * this module was throwing the payload away after reading the name off it)
   * and it is what lets the widget offer a way INTO the deliverable a turn just
   * touched instead of describing it and stopping.
   */
  | { type: "tool-result"; toolName: string; output: unknown; input?: unknown }
  | { type: "feedback"; feedback: ChatDataParts["feedback"] }
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
 * the `data-model`/`data-job` parts no current UI reads yet — T-B5's file
 * upload is the intended future reader of `data-job`; `data-feedback` is now
 * read, below, by T-B18).
 *
 * `toolNameByCallId` exists because `tool-output-available` carries no
 * `toolName` of its own (see stream-protocol.ts's own note on this) — only
 * `tool-input-available`, earlier in the same tool call, does.
 */
function mapChunk(
  chunk: Record<string, unknown>,
  toolNameByCallId: Map<string, string>,
  toolInputByCallId: Map<string, unknown>,
): ChatStreamEvent | null {
  switch (chunk.type) {
    case "text-delta":
      return typeof chunk.delta === "string" ? { type: "text-delta", delta: chunk.delta } : null;
    case "tool-input-available":
      if (typeof chunk.toolCallId === "string" && typeof chunk.toolName === "string") {
        toolNameByCallId.set(chunk.toolCallId, chunk.toolName);
        // Held for the matching output chunk below, which carries neither the
        // tool's name nor its arguments.
        if (chunk.input !== undefined) toolInputByCallId.set(chunk.toolCallId, chunk.input);
      }
      return null;
    case "tool-output-available": {
      const toolCallId = chunk.toolCallId;
      const toolName = typeof toolCallId === "string" ? toolNameByCallId.get(toolCallId) : undefined;
      if (!toolName) return null;
      const input = typeof toolCallId === "string" ? toolInputByCallId.get(toolCallId) : undefined;
      return {
        type: "tool-result",
        toolName,
        output: chunk.output,
        ...(input !== undefined ? { input } : {}),
      };
    }
    case "data-agentFocus":
      return {
        type: "agent-focus",
        focusAgent: (chunk.data as { id: string; name: string } | null | undefined) ?? null,
      };
    case "data-feedback": {
      // Defensive, not just a cast: this is untrusted-shape wire data as far
      // as this module is concerned (server and client can drift a version
      // apart in a rolling deploy), so a malformed/missing-agentName payload
      // is dropped rather than handed to the widget as a half-formed chip.
      const data = chunk.data as Partial<ChatDataParts["feedback"]> | null | undefined;
      if (!data || typeof data.agentName !== "string" || typeof data.agentId !== "string") return null;
      if (data.scope !== "agent" && data.scope !== "template") return null;
      return {
        type: "feedback",
        feedback: {
          agentName: data.agentName,
          agentId: data.agentId,
          scope: data.scope,
          ...(typeof data.templateKey === "string" ? { templateKey: data.templateKey } : {}),
          ...(typeof data.category === "string" ? { category: data.category } : {}),
        },
      };
    }
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
  const toolInputByCallId = new Map<string, unknown>();
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
        const event = mapChunk(chunk, toolNameByCallId, toolInputByCallId);
        if (event) yield event;
      }
    }
    // A final line with no trailing newline (unlikely from this server's own
    // writer, which always terminates with one, but not guaranteed of every
    // intermediary) would otherwise be silently dropped in `buffer`.
    const chunk = parseSseLine(buffer);
    if (chunk) {
      const event = mapChunk(chunk, toolNameByCallId, toolInputByCallId);
      if (event) yield event;
    }
  } finally {
    reader.releaseLock();
  }
}
