/**
 * Which of a newsletter v2 run's artifacts are DURABLE STATE, and how the four
 * client-facing files become the one string the reader is handed.
 *
 * The third instance of the ephemeral-workspace capture, and the one where a lost
 * write is most visible to a stranger: the issue index is the numbering
 * authority, so losing it means the next run claims a number that already went
 * out and real subscribers receive a second copy of "Issue 004". That is the
 * precise v1 defect the framework opens with.
 *
 * Pure and dependency-free, so both halves are testable without a webhook.
 */

import type { NewsletterAgentState } from "@/lib/types";

/** The state files, by the base name the contract writes them under. */
const STATE_BY_BASENAME: Record<string, NewsletterAgentState["kind"]> = {
  "issue-index.json": "issue-index",
  "topic-pool.json": "topic-pool",
  "voice-card.md": "voice-card",
  "scan-topics.json": "scan-topics",
  "content-foundation.md": "content-foundation",
};

/**
 * The state kind an artifact path carries, or null if it is not state.
 *
 * REFUSES A RUN'S PINNED COPY. Writer step 02 freezes every standing document it
 * reads into `internal/inputs/`, and the framework is explicit that those copies
 * are what the run READ. Capturing one writes the pre-run state back over the
 * post-run state — which for the issue index means un-shipping a claim the run
 * just made, silently, with nothing to show it happened.
 */
export function newsletterStateKindFor(artifactPath: string): NewsletterAgentState["kind"] | null {
  const path = artifactPath.split("\\").join("/").toLowerCase();
  if (path.includes("/inputs/") || path.includes("/02-inputs/")) return null;
  const base = path.split("/").pop() ?? "";
  return STATE_BY_BASENAME[base] ?? null;
}

/** The content type to re-attach a captured file with. */
export function newsletterStateContentType(path: string): string {
  return path.toLowerCase().endsWith(".json") ? "application/json" : "text/markdown";
}

/** YYYY-MM-DD from the path when it carries one, else the delivery clock. */
export function newsletterStateDateFor(artifactPath: string, fallbackMs: number): string {
  const match = artifactPath.match(/(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : new Date(fallbackMs).toISOString().slice(0, 10);
}

/** How many bytes of one state file we keep. Past any real one. */
export const NEWSLETTER_STATE_MAX_CHARS = 400_000;

/* ─────────────────── the deliverable envelope the reader reads ───────────── */

export const NEWSLETTER_ENVELOPE_KIND = "newsletter-issue-v2" as const;

/**
 * What the delivery handler stores as `asset.content` for a newsletter v2 issue.
 *
 * WHY AN ENVELOPE. The framework's D7 contract is FOUR files per issue — the
 * email in dark, the same email in light, a plain-text version, and a two-line
 * description — and the reader is handed a single string. The largest-text-file
 * heuristic would pick one of the two HTML renders and call it the deliverable,
 * losing the other three; and the two themes are built by one command precisely
 * so they can never disagree, which only holds if they travel together.
 *
 * `about.txt` LEADS WITH REVIEW FLAGS by contract — anything needing confirmation
 * before the client sends. In v1 the only surface that showed those flags was a
 * console nobody was supposed to open, which is the defect this field closes, so
 * it is a first-class part of the envelope rather than an afterthought.
 */
export interface NewsletterV2Envelope {
  kind: typeof NEWSLETTER_ENVELOPE_KIND;
  /** The issue number as the run named it, e.g. "004". */
  issueNumber?: string;
  /** The email, dark theme. The client pastes this into their own tool. */
  html?: string;
  /** The same email, light theme. Built by the same command; never diverges. */
  htmlLight?: string;
  /** The plain-text part every email needs, and the readable archive. */
  text?: string;
  /** The two lines the portal shows, leading with anything to confirm first. */
  about?: string;
}

/** Is this asset content a newsletter envelope? Cheap enough to run before parsing. */
export function isNewsletterEnvelope(content: string): boolean {
  const head = content.trimStart().slice(0, 200);
  return head.startsWith("{") && head.includes(NEWSLETTER_ENVELOPE_KIND);
}

/** One client-facing text file from the run, as the delivery handler has it. */
export interface NewsletterClientFile {
  path: string;
  text: string;
}

/**
 * Assemble the four client-facing files into the envelope.
 *
 * Matched on SHAPE rather than on an exact issue number, because the number is in
 * every one of these file names (`issue-004.html`) and hard-coding a pattern that
 * assumed three digits or a particular folder would silently drop a real
 * deliverable. The light variant is checked first: `issue-004-light.html` also
 * ends in `.html`, so testing for the dark one first would claim both.
 */
export function buildNewsletterEnvelope(
  files: readonly NewsletterClientFile[],
): NewsletterV2Envelope {
  const env: NewsletterV2Envelope = { kind: NEWSLETTER_ENVELOPE_KIND };
  for (const file of files) {
    const base = (file.path.split("\\").join("/").split("/").pop() ?? "").toLowerCase();
    if (!file.text.trim()) continue;
    if (base === "about.txt") env.about = file.text;
    else if (base.endsWith("-light.html")) env.htmlLight = file.text;
    else if (base.endsWith(".html")) env.html = file.text;
    else if (base.endsWith(".md")) env.text = file.text;
    const num = base.match(/issue-(\d+)/)?.[1];
    if (num && !env.issueNumber) env.issueNumber = num;
  }
  return env;
}

/** Does this envelope carry anything worth storing as a deliverable? */
export function newsletterEnvelopeHasContent(env: NewsletterV2Envelope): boolean {
  return Boolean(env.html || env.htmlLight || env.text || env.about);
}
