import "server-only";

import { generateText } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { MODELS } from "@/lib/constants";
import { logger } from "@/services/logger";
import { normalizeDashes } from "@/lib/text-utils";

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
 * shows the stored title (archive rows, the modal, the assets library) agrees
 * on one name. Display-time composition stays as the fallback for legacy
 * assets and for any run where this call fails.
 *
 * THE TITLE CONTRACT (mirrors the operator's spec, 2026-08-11):
 *   - the topic, front-loaded: the most identifying words come first, so a
 *     truncated render still identifies the output
 *   - natural plain English, 3–8 words, sentence case
 *   - no agent/platform/client name, no "draft"/"post"/"batch" nouns — the
 *     surfaces already label the type next to the title
 *   - no quotes, no emoji, no trailing punctuation, no em dashes
 *
 * FAILURE IS FREE: any error, timeout, or unusable completion returns null.
 * The webhook must never lose a delivery to its own naming, so the caller
 * falls back to the agent-name title exactly as before this existed.
 *
 * COST: one Haiku call of ~1–2k input tokens per delivered asset, platform-
 * absorbed (the webhook is a system path — `isBillableClientActor` sessions
 * are the only ones charged credits, and this is not a session at all).
 * Logged as `asset_titling` so §6 reporting can see the spend.
 */

const TITLE_TIMEOUT_MS = 8_000;
/** Enough of any deliverable to name it — envelopes are JSON, drafts markdown. */
const CONTENT_SAMPLE_CHARS = 6_000;
const MAX_TITLE_WORDS = 10;

const PROMPT = `You name finished marketing deliverables in a client portal. Read the deliverable below and return ONLY its title, nothing else.

Rules for the title:
- 3 to 8 words, natural plain English, sentence case.
- Name the TOPIC, and put the most identifying words first: a client scanning a list must know what this is about from the first two or three words.
- Never include the platform, the agent, the client's company name, or words like "draft", "post", "batch", "deliverable", "content" — the portal already labels the type next to your title.
- No quotation marks, no emoji, no colon-led label, no trailing punctuation, no em dashes.
- If the deliverable holds several pieces, title the shared topic.
- If the deliverable is structured data (JSON), title what it is ABOUT, never its structure.

Deliverable:
`;

function usable(raw: string, agentName?: string | null): string | null {
  let title = raw.trim().split("\n")[0]?.trim() ?? "";
  // A model that answers "Title: ..." or wraps in quotes has still answered.
  title = title.replace(/^title\s*[:\-]\s*/i, "").replace(/^["'“‘]+|["'”’.]+$/g, "");
  title = normalizeDashes(title).replace(/\s+/g, " ").trim();
  if (!title || !/[\p{L}\p{N}]/u.test(title)) return null;
  const words = title.split(" ");
  if (words.length > MAX_TITLE_WORDS) title = words.slice(0, MAX_TITLE_WORDS).join(" ");
  // A title that is just the agent's name is the fallback wearing a hat.
  if (agentName && title.toLowerCase() === agentName.trim().toLowerCase()) return null;
  return title;
}

export async function generateAssetTitle(args: {
  content: string;
  clientId: string;
  agentName?: string | null;
}): Promise<string | null> {
  const sample = args.content.trim().slice(0, CONTENT_SAMPLE_CHARS);
  if (!sample) return null;
  try {
    const result = await Promise.race([
      generateText({
        model: anthropic(MODELS.HAIKU),
        prompt: PROMPT + sample,
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
    return usable(result.text ?? "", args.agentName);
  } catch {
    return null;
  }
}
