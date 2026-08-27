import "server-only";

import { generateText } from "ai";
import { MODELS } from "@/lib/constants";
import { logger } from "@/services/logger";
import { aiFor } from "@/lib/ai/provider";
import {
  sanitizeGeneratedTitle,
  TITLE_CONTENT_SAMPLE_CHARS,
  TITLE_PROMPT,
} from "@/lib/asset-title-core";

/**
 * A natural, topic-first title for a delivered asset, written by Haiku at
 * ingestion time — or null, in which case the caller keeps its fallback.
 *
 * WHY AT INGESTION AND NOT AT DISPLAY: every stored title used to be the bare
 * agent name ("X Agent"), so `deliverable-titles.ts` grew a display-time
 * composer that titles a row with the post's own first six words. That is a
 * hook fragment, not a topic — a post opening "The actor who stopped renting
 * out his face" gets that as its name, and nothing says Ryan Reynolds. A model
 * reads the whole deliverable once, names the topic, and every surface that
 * shows the stored title (archive rows, the modal, the assets library, the
 * calendar) agrees on one name. Display-time composition stays as the
 * fallback for legacy assets and for any run where this call fails.
 *
 * The prompt and sanitizer live in asset-title-core.ts, shared with the
 * archive backfill script so old and new titles obey one contract.
 *
 * FAILURE IS FREE: any error, timeout, or unusable completion returns null.
 * The webhook must never lose a delivery to its own naming, so the caller
 * falls back to the agent-name title exactly as before this existed.
 *
 * COST: one Haiku call of ~1-2k input tokens per delivered asset, platform-
 * absorbed (the webhook is a system path — `isBillableClientActor` sessions
 * are the only ones charged credits, and this is not a session at all).
 * Logged as `asset_titling` so §6 reporting can see the spend.
 */

const TITLE_TIMEOUT_MS = 8_000;

export async function generateAssetTitle(args: {
  content: string;
  clientId: string;
  agentName?: string | null;
}): Promise<string | null> {
  const sample = args.content.trim().slice(0, TITLE_CONTENT_SAMPLE_CHARS);
  if (!sample) return null;
  try {
    const result = await Promise.race([
      generateText({
        model: aiFor("asset.title").model,
        prompt: TITLE_PROMPT + sample,
        maxOutputTokens: 50,
        temperature: 0.2,
      }),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), TITLE_TIMEOUT_MS)),
    ]);
    if (!result) return null;
    logger.logUsage({
      clientId: args.clientId,
      agentId: null,
      agentName: "Deliverable titling",
      modelName: MODELS.HAIKU,
      operation: "asset_titling",
      inputTokens: result.usage.inputTokens ?? 0,
      outputTokens: result.usage.outputTokens ?? 0,
    });
    return sanitizeGeneratedTitle(result.text ?? "", args.agentName);
  } catch {
    return null;
  }
}
