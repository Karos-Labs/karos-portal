import { streamText, stepCountIs, type LanguageModel } from "ai";

/**
 * Resilient streaming boundary for the Intel Report agent.
 *
 * This module has no server-only dependencies (it takes the model as a parameter),
 * so it is unit-testable with a mock language model. `report.ts` composes it.
 */

/**
 * IDLE timeout: abort only if NO chunk arrives for this long. A deep report does many
 * web searches + fetches across pause-turn steps and legitimately runs for several
 * minutes, so a fixed wall-clock cap would abort a healthy-but-slow stream (it did).
 * An idle timer — reset on every streamed chunk — aborts only a genuinely STALLED
 * stream, never one that is still producing. Sized above the slowest single tool call.
 */
export const REPORT_IDLE_TIMEOUT_MS = 120_000;

/** Absolute backstop so a pathological stream can't run forever even while trickling. */
export const REPORT_TIMEOUT_MS = 720_000;

type ReportStream = ReturnType<typeof streamText>;

export interface GuardedPass {
  /** Text streamed before completion/error (may be partial on a failed pass). */
  text: string;
  /** Provider stream error captured via onError — the SDK resolves `.text` with
   *  partial text instead of rejecting, so we capture it here rather than let it vanish. */
  streamError: unknown;
  /** True if a timeout (idle or hard-cap) aborted the stream. */
  timedOut: boolean;
  /** The stream handle (for usage tracking / diagnostics); null only if construction threw. */
  stream: ReportStream | null;
}

/**
 * Run ONE report generation pass with hard resilience guarantees:
 *
 *  - **Idle-bounded**: aborts only after `idleTimeoutMs` with no streamed activity, so a
 *    slow-but-progressing deep-research stream completes while a truly stalled one is cut.
 *    A generous hard-cap backstop prevents an infinite trickle.
 *  - **Error-captured**: the AI SDK routes provider stream errors (overload, 429, web-tool
 *    failures, pause_turn, exhausted quota) to `onError` and resolves `.text` with the
 *    partial text rather than rejecting. We capture that error.
 *  - **Never throws / never leaks an unhandled rejection**: any thrown value (abort,
 *    network) is caught and normalized. The caller decides retry/fail from
 *    `{ streamError, timedOut }`.
 *
 * The system prompt is passed via the top-level `system` option (SDK-recommended; avoids
 * the "system message in messages" prompt-injection warning).
 */
export async function runGuardedReportPass(
  model: LanguageModel,
  opts: {
    system: string;
    messages: Array<{ role: "user" | "assistant"; content: string }>;
    tools?: Parameters<typeof streamText>[0]["tools"];
    maxOutputTokens: number;
    maxSteps: number;
    /** Abort after this long with no streamed chunk. Default REPORT_IDLE_TIMEOUT_MS. */
    idleTimeoutMs?: number;
    /** Absolute wall-clock backstop. Default REPORT_TIMEOUT_MS. */
    timeoutMs?: number;
  },
): Promise<GuardedPass> {
  const ac = new AbortController();
  const idleMs = opts.idleTimeoutMs ?? REPORT_IDLE_TIMEOUT_MS;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  const resetIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => ac.abort(), idleMs);
  };
  resetIdle();
  const hardTimer = setTimeout(() => ac.abort(), opts.timeoutMs ?? REPORT_TIMEOUT_MS);

  let streamError: unknown;
  let stream: ReportStream | null = null;
  try {
    stream = streamText({
      model,
      system: opts.system,
      messages: opts.messages,
      tools: opts.tools,
      stopWhen: stepCountIs(opts.maxSteps),
      maxOutputTokens: opts.maxOutputTokens,
      abortSignal: ac.signal,
      // Every streamed chunk (text or tool activity) proves the stream is alive → keep it.
      onChunk: () => resetIdle(),
      onError: ({ error }) => {
        streamError = error;
      },
    });
    const text = await stream.text;
    return { text, streamError, timedOut: ac.signal.aborted, stream };
  } catch (err) {
    // Abort/timeout or a hard throw surfaces here — normalize so the caller never
    // sees an unhandled rejection.
    return { text: "", streamError: streamError ?? err, timedOut: ac.signal.aborted, stream };
  } finally {
    if (idleTimer) clearTimeout(idleTimer);
    clearTimeout(hardTimer);
  }
}
