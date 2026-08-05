/**
 * Which of a Reddit v2 run's artifacts are DURABLE STATE, and how they map onto
 * `redditAgentState` rows.
 *
 * The same ephemeral-workspace problem `linkedin-state-capture.ts` solves, and a
 * more dangerous one. The v2 run appends to a ledger of every thread already
 * answered, a rejection blocklist, a per-account learning log and agent memory,
 * and a **dated** rules audit recording whether a product may be named in each
 * subreddit and whether AI-written comments are banned there. The runner clones
 * the lab repo fresh for every run and the container is destroyed, so all of it
 * is discarded.
 *
 * WHY THE RULES AUDIT IS THE ONE THAT MATTERS MOST. Losing a LinkedIn ledger
 * costs a repeated subject. Losing this audit means the next run holds no reading
 * at all, or worse re-reads a stale one, and names a product in a subreddit that
 * bans it — which gets the client's account banned, and Reddit bans rarely
 * reverse. The DATE is the load-bearing field: the run re-verifies a reading it
 * cannot trust, but only if it receives the date to judge.
 *
 * These are INTERNAL artifacts, so the delivery handler does not re-host them — a
 * client has no business reading a rules audit. It fetches the few named here for
 * their text alone; nothing here becomes an asset or reaches a client surface.
 *
 * Pure and dependency-free so the matching is testable without a webhook.
 */

import type { RedditAgentState } from "@/lib/types";

/** A state artifact's kind and the account it belongs to, or null if not state. */
export interface RedditStateMatch {
  kind: RedditAgentState["kind"];
  /** The account handle for a per-account file, null for a client-wide one. */
  account: string | null;
}

/**
 * The per-account files. v2 keeps one of each PER REDDIT ACCOUNT under
 * `skills/reddit-agent-v2/accounts/<handle>/`, and mixing them is a real failure
 * rather than an untidiness: one account's earned voice rules steering another
 * account's replies is exactly the "does not sound like me" the learning log
 * exists to prevent.
 */
const PER_ACCOUNT: Record<string, RedditAgentState["kind"]> = {
  "agent-memory.md": "agent-memory",
  "learning-log.md": "learning-log",
};

/** The client-wide files. */
const CLIENT_WIDE: Record<string, RedditAgentState["kind"]> = {
  "rules-audit.json": "rules-audit",
  "reddit-ledger.json": "ledger",
  "question-pools.json": "question-pools",
  "scan-config.json": "scan-config",
  "foundation.md": "foundation",
};

/**
 * The account a per-account path belongs to.
 *
 * Read from the path rather than from the run header, because the path is what
 * the file IS: `skills/reddit-agent-v2/accounts/acme_dev/learning-log.md` belongs
 * to `acme_dev` whatever the run thinks it was doing. Falls back to the segment
 * before the file name, which is the shape the contract uses.
 */
function accountFrom(path: string): string | null {
  const parts = path.split("/").filter(Boolean);
  const i = parts.lastIndexOf("accounts");
  if (i > -1 && parts.length > i + 1) return parts[i + 1] || null;
  // No `accounts/` segment: the directory holding the file, when it is not the
  // product folder itself. Better than guessing the run's account and attaching
  // one account's memory to another.
  const parent = parts[parts.length - 2];
  if (!parent || parent === "reddit-agent-v2" || parent === "_shared") return null;
  return parent;
}

/** The state kind an artifact path carries, or null if it is not state. */
export function redditStateKindFor(artifactPath: string): RedditStateMatch | null {
  const path = artifactPath.split("\\").join("/");
  const lower = path.toLowerCase();
  const base = lower.split("/").pop() ?? "";

  // A run's PINNED COPY of a state file is what the run READ, not what it wrote.
  // Capturing one would write the pre-run state back over the post-run state —
  // silently reverting the ledger append or, far worse, the re-verified rules row
  // this run just earned. Step 02 is where v2 photocopies its inputs.
  if (lower.includes("/02-inputs/") || lower.includes("/02-pinned/")) return null;

  if (PER_ACCOUNT[base]) return { kind: PER_ACCOUNT[base], account: accountFrom(path) };
  if (CLIENT_WIDE[base]) return { kind: CLIENT_WIDE[base], account: null };

  // The paced scan's durable results, under a dated cache directory.
  if (lower.includes("/reddit-research-cache/") && base.endsWith(".json")) {
    return { kind: "research-cache", account: null };
  }
  return null;
}

/**
 * The `YYYY-MM-DD` a state artifact belongs to, from its own path when it has one.
 *
 * Load-bearing for two kinds. `research-cache`: v2 reuses a scan only if it is
 * from TODAY, and a scan costs ten to fifteen minutes of paced requests, so a
 * wrong date either re-buys it or reuses yesterday's as today's. `rules-audit`:
 * the run decides whether a reading is too old to trust, and dating it by when
 * the webhook happened to fire is wrong exactly when a delivery is retried across
 * midnight.
 */
export function redditStateDateFor(artifactPath: string, fallbackMs: number): string {
  const match = artifactPath.match(/(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : new Date(fallbackMs).toISOString().slice(0, 10);
}

/** How many bytes of one state file we keep. Past any real one. */
export const REDDIT_STATE_MAX_CHARS = 200_000;

/** The content type to re-attach a captured file with. */
export function redditStateContentType(path: string): string {
  const lower = path.toLowerCase();
  if (lower.endsWith(".json")) return "application/json";
  if (lower.endsWith(".jsonl")) return "application/x-ndjson";
  return "text/markdown";
}
