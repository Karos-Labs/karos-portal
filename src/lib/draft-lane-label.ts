/**
 * Client-facing label for an agent draft's lane heading.
 *
 * The agent writes its own production vocabulary into the deliverable —
 * "Avenue 3 · News-reaction (live)", "Post 2 · POV thread" — and the readers
 * printed it verbatim as the first thing a client reads on every draft
 * (QA F70). Nobody outside the lab knows what an Avenue is.
 *
 * Humanize at the RENDER boundary only: the raw heading is also the draftRef
 * sent to the feedback actions, so the parsers must keep it untouched.
 */

const LANE_COPY: Record<string, string> = {
  "build-in-public": "Building in public",
  "build in public": "Building in public",
  "knowledge/explainer": "Explainer",
  knowledge: "Explainer",
  explainer: "Explainer",
  "news-reaction": "Reacting to the news",
  "news reaction": "Reacting to the news",
  "quote-comment": "Quote reply",
  "quote comment": "Quote reply",
  reply: "Reply",
  "pov single": "Your point of view",
  "pov-single": "Your point of view",
  pov: "Your point of view",
  "pov thread": "Your point of view (thread)",
  "pov-thread": "Your point of view (thread)",
};

/** "Avenue 3 · News-reaction (live)" → "Reacting to the news · live" */
export function laneLabel(heading: string): string {
  const raw = (heading ?? "").trim();
  if (!raw) return "Draft";

  // Drop the lab's slot prefix ("Avenue 2 · ", "Post 1 · ", "Draft 3 · ").
  const withoutPrefix = raw.replace(/^\s*(avenue|post|draft)\s*\d+\s*[·:\-–—]\s*/i, "").trim();
  if (!withoutPrefix) return "Draft";

  // "(live)" and friends are freshness flags, not part of the lane name.
  const flagMatch = withoutPrefix.match(/\(([^)]+)\)\s*$/);
  const flag = flagMatch?.[1]?.trim();
  const base = withoutPrefix.replace(/\s*\([^)]*\)\s*$/, "").trim();

  const mapped = LANE_COPY[base.toLowerCase()];
  const label = mapped ?? sentenceCase(base);
  return flag ? `${label} · ${flag.toLowerCase()}` : label;
}

function sentenceCase(value: string): string {
  const spaced = value.replace(/[_/-]+/g, " ").replace(/\s+/g, " ").trim();
  if (!spaced) return "Draft";
  return spaced.charAt(0).toUpperCase() + spaced.slice(1).toLowerCase();
}
