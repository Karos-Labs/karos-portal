/**
 * Which of a reputation v2 run's artifacts are DURABLE STATE, and how the run's
 * client-facing files become the one string the reader is handed.
 *
 * The fifth instance of the ephemeral-workspace capture and the one with the
 * most files: setup emits seven, and both the runner and the manager write back
 * to them. Two carry the consequences.
 *
 * `response-ledger` is the NO-REPEAT memory. Lose it and the next pulse drafts a
 * second public reply to a review a human already answered, under the client's
 * own name, on a surface strangers read.
 *
 * `crisis-ledger` is the record of what was escalated and to whom. Losing it
 * loses the audit trail on the only class of event here with a same-day cost.
 *
 * Pure and dependency-free, so both halves are testable without a webhook.
 */

import type { ReputationAgentState } from "@/lib/types";

/** The state files, by the base name the contract writes them under. */
const STATE_BY_BASENAME: Record<string, ReputationAgentState["kind"]> = {
  "01-facts.md": "facts",
  "02-config.json": "config",
  "03-autonomy.json": "autonomy",
  "roster.json": "roster",
  "response-voice.md": "response-voice",
  "response-ledger.json": "response-ledger",
  "crisis-ledger.jsonl": "crisis-ledger",
};

/**
 * The state kind an artifact path carries, or null if it is not state.
 *
 * ── TWO REFUSALS, and the second is specific to this agent ────────────────
 *
 * A RUN'S PINNED COPY, as everywhere: anything under `internal/inputs/` is a
 * frozen copy of what the run READ, and capturing one writes pre-run state over
 * post-run state.
 *
 * AND THE RUN'S OWN NUMBERED TRAIL, which matters here more than for its
 * siblings because THREE OF THE SEVEN STATE FILES ARE NUMBER-PREFIXED —
 * `01-facts.md`, `02-config.json`, `03-autonomy.json` — and the runner's
 * internal trail is also numbered (`01-run.md` … `11-payload.json`, with
 * `03-envelope.json` and `04-flagged.json` among them). `03-envelope.json` is
 * not `03-autonomy.json`, so a base-name match is safe on today's names, but the
 * two namespaces are one typo apart. Refusing `internal/` outright means a
 * future run file called `02-config.json` cannot overwrite the client's real
 * config, which is the kind of collision nobody would find by reading a diff.
 */
export function reputationStateKindFor(
  artifactPath: string,
): ReputationAgentState["kind"] | null {
  const path = artifactPath.split("\\").join("/").toLowerCase();
  if (path.includes("/internal/")) return null;
  const base = path.split("/").pop() ?? "";
  return STATE_BY_BASENAME[base] ?? null;
}

/** The content type to re-attach a captured file with. */
export function reputationStateContentType(path: string): string {
  const lower = path.toLowerCase();
  // `.jsonl` is not `application/json` — it is a stream of objects, one per
  // line, and a parser told otherwise fails on the second line.
  if (lower.endsWith(".jsonl")) return "application/x-ndjson";
  if (lower.endsWith(".json")) return "application/json";
  return "text/markdown";
}

/** YYYY-MM-DD from the path when it carries one, else the delivery clock. */
export function reputationStateDateFor(artifactPath: string, fallbackMs: number): string {
  const match = artifactPath.match(/(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : new Date(fallbackMs).toISOString().slice(0, 10);
}

/**
 * Is this captured body worth storing?
 *
 * THE ONE GUARD THAT MAKES WHOLE-FILE REPLACE SAFE for the two ledgers. Both are
 * append-only in the workspace and are stored here as one blob, so a run that
 * delivered an empty or whitespace body would REPLACE a full ledger with
 * nothing — losing every review already answered, which is exactly the state
 * that produces a duplicate public reply.
 *
 * It cannot catch a partial truncation, and that residual is stated rather than
 * implied: a run delivering half a ledger overwrites the whole one. Catching
 * that needs a size or row comparison against the stored version, which is a
 * policy decision (is a shrinking ledger ever legitimate?) rather than a helper.
 */
export function reputationStateHasContent(content: string): boolean {
  return content.trim().length > 0;
}

/** How many bytes of one state file we keep. Past any real one. */
export const REPUTATION_STATE_MAX_CHARS = 600_000;

/* ─────────────────── the deliverable envelope the reader reads ───────────── */

export const REPUTATION_ENVELOPE_KIND = "reputation-pulse-v2" as const;

/**
 * What the delivery handler stores as `asset.content` for one pulse.
 *
 * WHY AN ENVELOPE. The manifest's client contract is a FOLDER, not a file:
 * `client/01-response-drafts/`, `client/02-flags/` and `about.txt`. The reader is
 * handed a single string, and the largest-text-file heuristic would pick one
 * draft out of the folder and call it the deliverable — losing every other reply
 * and, worse, losing the FLAGS, which are the half of the run a person has to
 * act on rather than read.
 *
 * `flags` therefore travels as its own field rather than as more prose. A flagged
 * item is the only thing this draft-only product produces that has a deadline.
 */
export interface ReputationV2Envelope {
  kind: typeof REPUTATION_ENVELOPE_KIND;
  /** The pulse number as the run named it, e.g. "004". */
  pulseNumber?: string;
  /** One entry per drafted reply, in the run's own order. */
  drafts?: Array<{ name: string; text: string }>;
  /** One entry per flagged item — the part with a deadline. */
  flags?: Array<{ name: string; text: string }>;
  /** The two lines the portal shows, leading with anything urgent. */
  about?: string;
}

/** Is this asset content a reputation envelope? Cheap enough to run before parsing. */
export function isReputationEnvelope(content: string): boolean {
  const head = content.trimStart().slice(0, 200);
  return head.startsWith("{") && head.includes(REPUTATION_ENVELOPE_KIND);
}

/** One client-facing text file from the run, as the delivery handler has it. */
export interface ReputationClientFile {
  path: string;
  text: string;
}

/**
 * Assemble the client-facing folder into the envelope.
 *
 * Sorted into two buckets by the FOLDER a file sits in, not by its own name:
 * `01-response-drafts/` and `02-flags/` are the contract, and the files inside
 * them are named per review with no shared shape to match on. A file in neither
 * folder is ignored rather than guessed at — except `about.txt`, which sits at
 * the top level of `client/`.
 */
export function buildReputationEnvelope(
  files: readonly ReputationClientFile[],
): ReputationV2Envelope {
  const env: ReputationV2Envelope = { kind: REPUTATION_ENVELOPE_KIND };
  const drafts: Array<{ name: string; text: string }> = [];
  const flags: Array<{ name: string; text: string }> = [];
  for (const file of files) {
    if (!file.text.trim()) continue;
    const path = file.path.split("\\").join("/").toLowerCase();
    const name = file.path.split("/").pop() ?? file.path;
    if (name.toLowerCase() === "about.txt") {
      env.about = file.text;
    } else if (path.includes("/01-response-drafts/")) {
      drafts.push({ name, text: file.text });
    } else if (path.includes("/02-flags/")) {
      flags.push({ name, text: file.text });
    }
    const num = path.match(/-pulse-(\d+)/)?.[1];
    if (num && !env.pulseNumber) env.pulseNumber = num;
  }
  if (drafts.length > 0) env.drafts = drafts;
  if (flags.length > 0) env.flags = flags;
  return env;
}

/**
 * Does this envelope carry anything worth storing as a deliverable?
 *
 * FLAGS ALONE COUNT, and that is the case worth naming: a pulse that found
 * nothing safe to answer but did find something urgent has zero drafts and is
 * the single most important run this product can produce. Requiring a draft
 * would drop it.
 */
export function reputationEnvelopeHasContent(env: ReputationV2Envelope): boolean {
  return Boolean(env.drafts?.length || env.flags?.length || env.about);
}
