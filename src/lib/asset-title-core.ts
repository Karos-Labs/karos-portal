/**
 * The deliverable-titling contract, shared verbatim by the two callers that
 * name assets: the webhook's ingestion titler (asset-titles.ts, server-only)
 * and the archive backfill script (scripts/backfill-x-asset-titles.ts, plain
 * node). Pure — no server-only, no Firebase — so the script can import it
 * without dragging the Next runtime in, and the prompt cannot drift between
 * "titles going forward" and "titles for the archive".
 *
 * THE TITLE CONTRACT (the operator's spec, 2026-08-11):
 *   - the topic, front-loaded: the most identifying words come first, so a
 *     truncated render still identifies the output
 *   - natural plain English, 3-8 words, sentence case
 *   - no agent/platform/client name, no "draft"/"post"/"batch" nouns — the
 *     surfaces already label the type next to the title
 *   - no quotes, no emoji, no trailing punctuation, no em dashes
 */

import { normalizeDashes } from "./text-utils";

/** Enough of any deliverable to name it — envelopes are JSON, drafts markdown. */
export const TITLE_CONTENT_SAMPLE_CHARS = 6_000;
export const MAX_TITLE_WORDS = 10;

export const TITLE_PROMPT = `You name finished marketing deliverables in a client portal. Read the deliverable below and return ONLY its title, nothing else.

Rules for the title:
- 3 to 8 words, natural plain English, sentence case.
- Name the TOPIC, and put the most identifying words first: a client scanning a list must know what this is about from the first two or three words.
- Never include the platform, the agent, the client's company name, or words like "draft", "post", "batch", "deliverable", "content" — the portal already labels the type next to your title.
- No quotation marks, no emoji, no colon-led label, no trailing punctuation, no em dashes.
- If the deliverable holds several pieces, title the shared topic.
- If the deliverable is structured data (JSON), title what it is ABOUT, never its structure.

Deliverable:
`;

/**
 * A model completion reduced to a usable title, or null when nothing usable
 * came back (the caller then keeps its fallback). Tolerates the two classic
 * near-misses — a "Title: ..." prefix and wrapping quotes — because a model
 * that produced those has still answered.
 */
export function sanitizeGeneratedTitle(raw: string, agentName?: string | null): string | null {
  let title = raw.trim().split("\n")[0]?.trim() ?? "";
  title = title.replace(/^title\s*[:\-]\s*/i, "").replace(/^["'“‘]+|["'”’.]+$/g, "");
  title = normalizeDashes(title).replace(/\s+/g, " ").trim();
  if (!title || !/[\p{L}\p{N}]/u.test(title)) return null;
  const words = title.split(" ");
  if (words.length > MAX_TITLE_WORDS) title = words.slice(0, MAX_TITLE_WORDS).join(" ");
  // A title that is just the agent's name is the fallback wearing a hat.
  if (agentName && title.toLowerCase() === agentName.trim().toLowerCase()) return null;
  return title;
}
