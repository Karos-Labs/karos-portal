import {
  createUIMessageStream,
  createUIMessageStreamResponse,
  streamText,
  toUIMessageStream,
  type LanguageModel,
  type LanguageModelUsage,
  type ModelMessage,
  type StopCondition,
  type ToolSet,
  type UIMessage,
  type UIMessageStreamWriterWithOutcome,
} from "ai";

/**
 * T-B4: the copilot chat's real stream protocol.
 *
 * Before this, `chat/route.ts` returned `streamText(...).toTextStreamResponse()`
 * — TEXT ONLY. There was no channel for anything but assistant prose, so the
 * one signal that needed to reach the client mid-turn (which agent the
 * conversation is now focused on, set by `set_agent_focus`) was smuggled inside
 * an `<!-- COPILOT_FOCUS:{...} --> ` HTML comment appended to the reply text,
 * sniffed out of the raw stream with a regex on the client
 * (chatbot-widget.tsx), and stripped before render by the same mechanism that
 * hides Markdown comments in general. That trick only carries a STRING; it
 * cannot carry a job id, a structured tool result, or which model actually
 * served the turn without inventing a new ad hoc marker syntax each time — and
 * a provider error mid-stream had NO channel at all, so a failed turn just
 * stopped producing text and completed as an empty success.
 *
 * This module switches the wire format to the AI SDK's UI MESSAGE STREAM
 * (newline-delimited SSE, `Content-Type: text/event-stream`) and adds typed
 * `data-*` parts alongside the text: `{ type: "data-<name>", data }`. Tool
 * calls and tool results are carried by the protocol's own `tool-*` parts
 * (tool-input-available / tool-output-available) with no extra work — the
 * client already gets "which tool ran, with what input, returning what" for
 * free once it reads this format instead of a flat text blob.
 *
 * See `ChatDataParts` below for the parts this route actually emits today,
 * and the two future consumers (T-B5 file upload, T-B18 feedback loop) the
 * shapes were chosen to serve without a protocol change.
 */

/**
 * The typed `data-*` parts this chat protocol can emit, keyed by the part
 * NAME (the chunk's `type` is `data-${name}`).
 *
 * Two are consumed by callers that exist today (chatbot-widget.tsx):
 *
 *  - `model`: which model and vendor actually served this turn. Before this,
 *    the client had no way to know whether a reply came from Anthropic direct
 *    or the Vertex binding T-B1 added — the provider layer's `aiFor` call
 *    resolves that per turn (`ResolvedAi.modelId` / `.vendor`,
 *    src/lib/ai/provider.ts) and it was computed and then thrown away.
 *    Emitted once, at the start of the turn.
 *  - `agentFocus`: replaces the COPILOT_FOCUS HTML-comment hack verbatim —
 *    same payload shape (`{ id, name } | null`), now a real typed part
 *    instead of text the client has to regex out of its own transcript.
 *
 * Two are written FORWARD of any consumer, on purpose, because this ticket
 * blocks both of the tickets that will need them and a shape invented after
 * the fact tends to only fit the caller that forced it:
 *
 *  - `job`: a job/run this turn started. `run_agent_now` emits it today
 *    (`status: "started"`) so a job id is a typed field instead of a number
 *    parsed out of the confirmation sentence's backtick-quoted id. T-B5 (file
 *    upload) is the obvious next writer of this SAME part — an upload that
 *    kicks off async processing is exactly "a job this turn started" — so
 *    `status` is left open rather than a boolean, and nothing about the shape
 *    assumes there is only ever one job per turn.
 *  - `feedback`: confirms standing feedback was recorded, with the structured
 *    fields (which agent, which scope/template/category) a future feedback
 *    surface (T-B18) needs to react to — not just the prose sentence the tool
 *    already returns for the model to read aloud.
 */
// `type`, not `interface`: an interface has no index signature, so it fails
// the `extends UIDataTypes` (`Record<string, unknown>`) constraint the SDK's
// generics require even though every property here IS a string key to an
// unknown-shaped value.
export type ChatDataParts = {
  model: { modelId: string; vendor: string };
  job: {
    jobId: string;
    agentName: string;
    status: "started";
    /** ISO 8601. Set only for a staff-scheduled run (T-B9's `publishAt`). */
    scheduledAt?: string;
  };
  agentFocus: { id: string; name: string } | null;
  feedback: {
    agentName: string;
    scope: "agent" | "template";
    templateKey?: string;
    category?: string;
  };
}

/** This route's UI message shape: default metadata, the typed data parts above. */
export type ChatUIMessage = UIMessage<unknown, ChatDataParts>;

/**
 * What a tool's `execute` gets handed so it can push a typed data part of its
 * own, outside of (and often before) the string it returns as its tool
 * result — e.g. `run_agent_now` writes a `data-job` part immediately, rather
 * than making the client parse a job id back out of the confirmation prose.
 */
export type ChatStreamWriter = UIMessageStreamWriterWithOutcome<ChatUIMessage>;

export interface CreateChatStreamResponseOptions {
  model: LanguageModel;
  /** Which model/vendor `model` actually is — emitted as the `data-model` part. */
  modelMeta: ChatDataParts["model"];
  system: string;
  messages: ModelMessage[];
  tools: ToolSet;
  stopWhen: StopCondition<ToolSet> | Array<StopCondition<ToolSet>>;
  /**
   * Called synchronously with the stream's writer before the model call
   * starts, so tool `execute` closures defined earlier in the caller can read
   * it (via a `let` they close over) by the time the model ever invokes them.
   */
  registerWriter?: (writer: ChatStreamWriter) => void;
  // Required, not `onFinish?`/`onError?`: this route always supplies both
  // (usage logging, failure alerting), and an optional callback nothing calls
  // is exactly what callback-prop-wiring.test.ts exists to catch repo-wide —
  // including outside React props, since it scans by naming pattern rather
  // than by file type. Required is the test's own documented way to opt a
  // genuinely-always-wired callback out of that scan.
  onFinish: (event: { usage: LanguageModelUsage }) => void;
  onError: (event: { error: unknown }) => void;
}

/**
 * Build the copilot chat's streaming HTTP response.
 *
 * Replaces `streamText(...).toTextStreamResponse()`. Emits, in order:
 *   1. a `data-model` part naming what actually ran this turn,
 *   2. the model's own text/tool-call/tool-result parts (verbatim — this is
 *      what `toUIMessageStream` already does for a `streamText` result), and
 *   3. any `data-job` / `data-agentFocus` / `data-feedback` parts a tool
 *      writes mid-execution via the writer handed to `registerWriter`.
 *
 * A provider error mid-stream, which used to vanish (no text-delta parts at
 * all, so the HTTP response completed as an empty success — see the old
 * comment this replaces, and chatbot-widget.tsx's "empty completion" special
 * case), now surfaces as a real `error` chunk in the protocol: `toUIMessageStream`
 * still routes it to `onError` (sanitized by default, so no server-internal
 * text reaches the client) but the client can now DETECT the failure from the
 * stream itself rather than inferring it from silence.
 */
export function createChatStreamResponse(opts: CreateChatStreamResponseOptions): Response {
  const stream = createUIMessageStream<ChatUIMessage>({
    execute: async ({ writer }) => {
      opts.registerWriter?.(writer);

      writer.write({ type: "data-model", data: opts.modelMeta });

      const result = streamText({
        model: opts.model,
        system: opts.system,
        messages: opts.messages,
        tools: opts.tools,
        stopWhen: opts.stopWhen,
        onFinish: ({ usage }) => opts.onFinish({ usage }),
        onError: opts.onError,
      });

      writer.merge(toUIMessageStream({ stream: result.stream, tools: opts.tools }));
    },
  });

  return createUIMessageStreamResponse({ stream });
}
