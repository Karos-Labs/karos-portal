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
