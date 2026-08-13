import path from "node:path";
import type { JobUsage, ModelTokenUsage } from "../../src/types.js";
import type { ServiceCallback } from "./callback.js";

const FLUSH_INTERVAL_MS = 3000;
const FLUSH_LINE_COUNT = 50;

/**
 * Streams the full SDK message log to the service in NDJSON batches so the
 * transcript survives timeouts, kills, and crashes mid-run.
 */
export class TranscriptStreamer {
  private buffer: string[] = [];
  private timer: NodeJS.Timeout | undefined;
  private flushing: Promise<void> = Promise.resolve();

  constructor(private readonly callback: ServiceCallback) {
    this.timer = setInterval(() => void this.flush(), FLUSH_INTERVAL_MS);
    this.timer.unref();
  }

  append(message: unknown): void {
    this.buffer.push(JSON.stringify(message));
    if (this.buffer.length >= FLUSH_LINE_COUNT) void this.flush();
  }

  async flush(): Promise<void> {
    this.flushing = this.flushing.then(async () => {
      if (this.buffer.length === 0) return;
      const chunk = this.buffer.join("\n");
      this.buffer = [];
      try {
        await this.callback.appendTranscript(chunk);
      } catch {
        // transcript loss is preferable to failing the job
      }
    });
    await this.flushing;
  }

  async close(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await this.flush();
  }
}

interface SdkResultLike {
  type: "result";
  subtype: string;
  total_cost_usd?: number;
  num_turns?: number;
  modelUsage?: Record<
    string,
    {
      inputTokens: number;
      outputTokens: number;
      cacheReadInputTokens: number;
      cacheCreationInputTokens: number;
      costUSD: number;
    }
  >;
  errors?: string[];
}

export function isResultMessage(message: unknown): message is SdkResultLike {
  return typeof message === "object" && message !== null && (message as { type?: string }).type === "result";
}

interface SdkAssistantLike {
  type: "assistant";
  message?: { content?: Array<{ type: string; name?: string; input?: unknown }> };
}

/**
 * Best-effort step-boundary signal for the HARDCODED path, which — unlike
 * Dynamic Agent Studio — has no explicit step API. Some skills (confirmed:
 * linkedin-agent-v2) checkpoint their own progress by writing one file per
 * phase under the client's `outputs/` tree (`01-run.json`, `02-inputs.json`,
 * ... `12-commit.json`); other skills don't follow this convention at all.
 * Where it exists, each `Write` tool call is a real, timestamped, code-
 * visible event — this just watches for it. Returns the repo-relative path
 * (matching how artifacts.ts already reports paths) when an assistant
 * message contains a `Write` call targeting the client's own output tree;
 * `null` for every other message, including a `Write` outside that tree
 * (skill scratch files, `.claude/` config, etc.) which is deliberately not a
 * step boundary.
 */
export function extractWriteCheckpoint(
  message: unknown,
  repoDir: string,
  clientSlug: string,
): string | null {
  if (typeof message !== "object" || message === null) return null;
  if ((message as { type?: string }).type !== "assistant") return null;
  const content = (message as SdkAssistantLike).message?.content;
  if (!Array.isArray(content)) return null;

  const outputsRoot = `clients/${clientSlug}/outputs/`;
  for (const block of content) {
    if (block.type !== "tool_use" || block.name !== "Write") continue;
    const filePath = (block.input as { file_path?: unknown } | undefined)?.file_path;
    if (typeof filePath !== "string") continue;
    const rel = path.relative(repoDir, filePath).split(path.sep).join("/");
    if (rel.startsWith(outputsRoot)) return rel;
  }
  return null;
}

export function extractUsage(result: SdkResultLike): JobUsage {
  const models: Record<string, ModelTokenUsage> = {};
  for (const [model, u] of Object.entries(result.modelUsage ?? {})) {
    models[model] = {
      inputTokens: u.inputTokens,
      outputTokens: u.outputTokens,
      cacheReadInputTokens: u.cacheReadInputTokens,
      cacheCreationInputTokens: u.cacheCreationInputTokens,
      costUsd: u.costUSD,
    };
  }
  const usage: JobUsage = { models };
  if (result.total_cost_usd !== undefined) usage.totalCostUsd = result.total_cost_usd;
  if (result.num_turns !== undefined) usage.numTurns = result.num_turns;
  return usage;
}
