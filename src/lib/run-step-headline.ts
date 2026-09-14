/**
 * What a running agent is doing right now, in a client's words — the one line
 * under the progress bar.
 *
 * A HEADLINE, NOT A POSITION (2026-09-10). This replaced a six-row checklist
 * that placed the bar by the current step's phase. Engine steps do not run in
 * a fixed phase order (Instagram lists past images before it writes the copy,
 * then reads templates after), so on the recorded runs that bar went backwards
 * four times, and `12-render-preview-check` matched "review" inside "preview".
 * A headline can change freely without claiming progress it has not made.
 *
 * Whole words only: the step id is split on hyphens, so "preview" is never
 * "review". There is deliberately no rule for review or approval steps — a
 * client is never told about review (SOW) — and a run parked at a gate is
 * shown as done by the caller, not narrated here. An unknown step reads
 * "Working on it" rather than nothing.
 */

const RULES: ReadonlyArray<readonly [headline: string, words: readonly string[]]> = [
  ["Making the visuals", ["image", "images", "carousel", "render", "visual", "media", "slide", "slides", "video", "clip", "thumbnail", "scrape"]],
  ["Checking its own work", ["verify", "check", "hygiene", "dedupe", "compliance", "qa", "leak", "placeholder", "vet"]],
  ["Writing the copy", ["write", "draft", "copy", "caption", "compose"]],
  ["Reading up on your brand", ["research", "fact", "facts", "topic", "candidate", "archetype", "intel", "history", "feedback", "templates", "claim", "reserve", "select", "read"]],
  ["Getting set up", ["setup", "intake", "open", "config", "load", "freeze", "auto", "channel", "context"]],
];

export function stepHeadline(stepId: string | null | undefined): string {
  if (!stepId) return "Starting the run";
  const words = stepId.toLowerCase().split("-");
  for (const [headline, match] of RULES) {
    if (words.some((w) => match.includes(w))) return headline;
  }
  return "Working on it";
}
