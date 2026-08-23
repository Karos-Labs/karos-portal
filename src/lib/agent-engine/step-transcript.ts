import type { TranscriptBlock, TranscriptTurn } from "@/lib/agent-service/transcript";
import type { AgentEngineStepRecord } from "./read-run";

/**
 * The agent-engine run transcript — read straight off a `step.agent`
 * checkpoint's own recorded output, with no second fetch.
 *
 * WHY THIS EXISTS AT ALL. The Job page's "Agent transcript" card is gated on
 * `job.external?.transcriptUrl`, which only the LEGACY agent-service webhook
 * ever writes (`src/app/api/agent-service/webhook/route.ts`). A job dispatched
 * through agent-engine has no `job.external` at all, so that card could never
 * render for one — and staff reading an engine run saw a step table with a
 * cost and a duration against `10-draft-post` and nothing about what the agent
 * actually did. The transcript was never missing: agent-engine checkpoints the
 * whole `AgentExecutionResult` as that step's `output` (every turn's thought,
 * tool call, tool result, model, tokens and cost — RFC-01 §4's "Layer 1
 * records what ran"), and this portal simply never read it.
 *
 * SO THERE IS NO NEW STORAGE AND NO NEW ENDPOINT HERE, only a projection of a
 * record `readAgentEngineRun` already fetches. It deliberately produces the
 * SAME `TranscriptTurn`/`TranscriptBlock` shape the agent-service transcript
 * parser produces, so `<JobTranscript>` renders both and there is one transcript
 * component in the tree rather than two that drift. Those types are imported
 * `import type` — the module they live in is `server-only`, and a type-only
 * import erases, which is the same thing `job-transcript.tsx` (a client
 * component) already relies on.
 *
 * PURE AND CLIENT-SAFE: no `server-only`, no Firebase, no fetch. The caller
 * hands it a step record it already has.
 */

/** Guards against one enormous tool result (a research pull's raw payload, say) blowing up the RSC payload for the whole page. */
const MAX_BLOCK_CHARS = 12_000;
/** A bounded agent loop is a handful of turns; this is a runaway backstop, not an expected limit. */
const MAX_TURNS = 200;

export interface AgentStepTranscript {
  turns: TranscriptTurn[];
  truncated: boolean;
  /**
   * The step's own terminal status (`AgentExecutionStatus`) — `"completed"`,
   * `"content_fail"`, `"tooling_error"` or `"budget_exceeded"`. Distinct from
   * the step CHECKPOINT's status, which only says whether the step ran: an
   * agent step can be a checkpointed `"completed"` while its own execution
   * resolved to `content_fail`, and conflating the two is how a run reads as
   * clean when its draft turn never produced anything.
   */
  executionStatus?: string;
  /** The structured object the agent returned, pretty-printed. Absent when the agent produced none (a `content_fail`/`tooling_error` outcome). */
  finalOutput?: string;
  totalCostUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function clip(text: string): { text: string; clipped: boolean } {
  return text.length > MAX_BLOCK_CHARS
    ? { text: `${text.slice(0, MAX_BLOCK_CHARS)}\n… (truncated)`, clipped: true }
    : { text, clipped: false };
}

function stringify(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    // A cyclic or otherwise unserializable payload must not blank the whole
    // transcript — the turn it belongs to is still worth showing.
    return String(value);
  }
}

/**
 * Whether a recorded tool result is an error, asked of the RESULT rather than
 * of the turn: `AgentToolOutcome` carries its own `status`
 * (`"success"`/`"content_fail"`/`"tooling_error"` — see agent-engine's
 * `tool-common`), and a turn whose telemetry `status` is `"success"` can still
 * hold a `content_fail` outcome from the tool it called. Both are asked, so
 * neither alone can hide a failure.
 */
function isErrorResult(result: unknown, turnStatus: unknown): boolean {
  const resultStatus = isRecord(result) ? result["status"] : undefined;
  if (typeof resultStatus === "string" && resultStatus !== "success") return true;
  return typeof turnStatus === "string" && turnStatus !== "success";
}

/**
 * One `AgentStepTelemetry` → the blocks a reader wants from it, in the order
 * they happened: the model's reasoning, the tool it decided to call, then what
 * came back.
 */
function blocksForTurn(turn: Record<string, unknown>): { blocks: TranscriptBlock[]; clipped: boolean } {
  const blocks: TranscriptBlock[] = [];
  let clipped = false;

  const thought = turn["thought"];
  if (typeof thought === "string" && thought.trim()) {
    const { text, clipped: cut } = clip(thought);
    blocks.push({ kind: "thinking", text });
    clipped = clipped || cut;
  }

  const toolCall = isRecord(turn["toolCall"]) ? turn["toolCall"] : undefined;
  if (toolCall) {
    const name = typeof toolCall["name"] === "string" ? toolCall["name"] : "tool";
    const version = typeof toolCall["toolVersion"] === "string" ? toolCall["toolVersion"] : undefined;
    blocks.push({ kind: "tool_use", name: version ? `${name} (v${version})` : name, input: toolCall["args"] });
    if (toolCall["result"] !== undefined) {
      const { text, clipped: cut } = clip(stringify(toolCall["result"]));
      blocks.push({ kind: "tool_result", text, isError: isErrorResult(toolCall["result"], turn["status"]) });
      clipped = clipped || cut;
    }
  }

  // A turn's own `error` is separate from a tool result that came back bad —
  // it is the provider error, the schema violation, the missing prompt (see
  // `AgentStepTelemetrySchema.error`'s own note). Without this a failed turn
  // reports only a status, which is exactly what that field exists to fix.
  const error = turn["error"];
  if (typeof error === "string" && error.trim()) {
    blocks.push({ kind: "tool_result", text: error, isError: true });
  }

  return { blocks, clipped };
}

/**
 * Projects one `step.agent` checkpoint into a renderable transcript, or
 * `undefined` when the record is not an agent execution result at all — a
 * `code`/`gate` step, a step still `"running"` (no `output` yet), or an
 * output offloaded to GCS (`{archived:true}`), all of which are ordinary
 * states rather than errors.
 */
export function agentStepTranscript(step: AgentEngineStepRecord): AgentStepTranscript | undefined {
  const output = step.output;
  if (!isRecord(output) || !Array.isArray(output["steps"])) return undefined;

  const rawTurns = output["steps"].filter(isRecord);
  const kept = rawTurns.slice(0, MAX_TURNS);
  let clipped = kept.length < rawTurns.length;

  const turns: TranscriptTurn[] = [];
  for (const rawTurn of kept) {
    const { blocks, clipped: cut } = blocksForTurn(rawTurn);
    clipped = clipped || cut;
    // A turn that recorded neither a thought nor a tool call has nothing to
    // show; an empty turn card is worse than no card.
    if (blocks.length > 0) turns.push({ role: "assistant", blocks });
  }

  const totals = isRecord(output["totalTokens"]) ? output["totalTokens"] : {};
  const finalOutput = output["finalOutput"];

  return {
    turns,
    truncated: clipped,
    ...(typeof output["status"] === "string" ? { executionStatus: output["status"] } : {}),
    ...(finalOutput !== undefined && finalOutput !== null ? { finalOutput: clip(stringify(finalOutput)).text } : {}),
    ...(typeof output["totalCostUsd"] === "number" ? { totalCostUsd: output["totalCostUsd"] } : {}),
    ...(typeof totals["input"] === "number" ? { inputTokens: totals["input"] } : {}),
    ...(typeof totals["output"] === "number" ? { outputTokens: totals["output"] } : {}),
  };
}

/**
 * Every agent step of a run that carries a readable transcript, in the order
 * `readAgentEngineRun` already sorted them (by `startedAt`, execution order).
 *
 * Keyed by `stepId` rather than returned as a bare list because a run can have
 * more than one agent step — `instagram-agent` alone has a research-extract
 * turn and a caption-draft turn, and a reader needs to know which transcript
 * belongs to which step.
 */
export function runAgentTranscripts(
  steps: readonly AgentEngineStepRecord[],
): Array<{ stepId: string; transcript: AgentStepTranscript }> {
  const found: Array<{ stepId: string; transcript: AgentStepTranscript }> = [];
  for (const step of steps) {
    const transcript = agentStepTranscript(step);
    if (transcript && (transcript.turns.length > 0 || transcript.finalOutput)) {
      found.push({ stepId: step.stepId, transcript });
    }
  }
  return found;
}

/** One non-agent step's recorded output, ready to render — see `stepOutputPreviews`. */
export interface StepOutputPreview {
  stepId: string;
  kind: AgentEngineStepRecord["kind"];
  /** Pretty-printed and length-capped. */
  json: string;
  /** True when the cap actually bit, so the reader is told rather than left with a silently short payload. */
  truncated: boolean;
}

/**
 * The recorded output of every step whose payload is worth showing raw — which
 * is every step EXCEPT the agent ones (those render as a transcript instead,
 * via `runAgentTranscripts`; showing both would print the same 40k of turns
 * twice) and except an output archived to GCS (`{archived:true}`, whose size is
 * already reported by the panel's own footnote).
 *
 * PROJECTED ON THE SERVER, deliberately. The panel is a server component and
 * the renderer is a client one, so everything here crosses the RSC boundary —
 * and a `research.pull` result or an intel report's full structure is large
 * enough that handing over the untruncated records would make the page payload
 * the new problem. The cap is applied before the boundary, not at render.
 *
 * Includes a resolved `gate` step, which is the point: that record's output is
 * the decision, the actor and the notes, and it is the only place the portal
 * can show who approved what.
 */
export function stepOutputPreviews(steps: readonly AgentEngineStepRecord[]): StepOutputPreview[] {
  const previews: StepOutputPreview[] = [];
  for (const step of steps) {
    if (step.kind === "agent") continue;
    if (step.output === undefined || step.output === null) continue;
    if (isRecord(step.output) && step.output["archived"] === true) continue;
    const { text, clipped } = clip(stringify(step.output));
    previews.push({ stepId: step.stepId, kind: step.kind, json: text, truncated: clipped });
  }
  return previews;
}
