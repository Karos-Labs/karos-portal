/**
 * Which of a LinkedIn v2 run's artifacts are DURABLE STATE, and how they map
 * onto `liAgentState` rows.
 *
 * The problem this solves. The v2 skills are written against files that persist
 * between runs — the ledger the writer appends a row to, the topic catalog it
 * flips `used_by` on, the manager's `AGENT-MEMORY.md` and its `05-plan.json`,
 * the research cache that makes a same-day pull free the second time. The runner
 * clones the lab repo fresh for every run and destroys the container after, so
 * every one of those writes is discarded. Without capture the manager steers
 * nothing and the ledger stays permanently empty, which is precisely the v1 failure v2 exists
 * to fix (the lab's `references/run-protocol.md` §12).
 *
 * These files are INTERNAL artifacts, not client-facing ones, so the delivery
 * handler does not re-host them — a client has no business reading a ledger. It
 * fetches the few named here for their text alone and stores that; nothing here
 * ever becomes an asset or reaches a client surface.
 *
 * Pure and dependency-free so the matching can be tested without a webhook.
 */

import type { LiAgentState } from "@/lib/types";

/** The state kind an artifact path carries, or null if it is not state. */
export function liStateKindFor(artifactPath: string): LiAgentState["kind"] | null {
  const path = artifactPath.split("\\").join("/").toLowerCase();
  const base = path.split("/").pop() ?? "";

  // The contract paths first, because a file name alone is ambiguous: a run
  // folder's pinned COPY of the ledger sits at
  // internal/02-inputs/linkedin-ledger.json and must never be captured as the
  // new state — it is what the run read, not what it wrote. Anything under a
  // run folder's 02-inputs/ is a pinned input by construction.
  if (path.includes("/02-inputs/")) return null;

  if (base === "linkedin-ledger.json") return "ledger";
  if (base === "topic-catalog.yaml" || base === "topic-catalog.yml") return "topic-catalog";
  if (base === "agent-memory.md") return "agent-memory";
  if (base === "linkedin-foundation.md") return "foundation";
  // The manager's standing plan. Named by its step number inside the manager's
  // own run folder, so both facts are required — a writer run has no 05-plan.
  if (base === "05-plan.json" && path.includes("-manager-run-")) return "manager-plan";
  // The research cache's parsed candidates. The raw payloads beside it are the
  // manager's audit trail and stay in the run record; what the next run needs to
  // decide "same-day, reuse it" is this file and its date.
  if (path.includes("/linkedin-research-cache/") && base === "candidates.json") {
    return "research-cache";
  }
  // The company voice card. A seat's goes through seatVoiceProfiles instead
  // (voice-profile--<slug>.md), which the delivery handler already captures for
  // every agent family.
  if (base === "linkedin-voice-card-company.json") return "voice-card-company";
  return null;
}

/**
 * The `YYYY-MM-DD` a state artifact belongs to, read from its own path when the
 * path carries one.
 *
 * This is load-bearing for exactly one kind. The manager reuses a research pull
 * if and only if the cache is from TODAY, and the cache's date is in its
 * directory name (`linkedin-research-cache/2026-08-04/candidates.json`). Taking
 * the delivery's wall clock instead would date a cache by when the webhook ran,
 * which is close enough on the happy path and wrong exactly when a delivery is
 * retried across midnight — and being wrong here means re-buying a pull, or
 * worse, reusing yesterday's as today's.
 */
export function liStateDateFor(artifactPath: string, fallbackMs: number): string {
  const match = artifactPath.match(/(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : new Date(fallbackMs).toISOString().slice(0, 10);
}

/** How many bytes of one state file we keep. Comfortably past any real one. */
export const LI_STATE_MAX_CHARS = 200_000;

/**
 * The writer's memory step receipt (`12-commit.json`). Read for one field only —
 * which direction requests the run says it covered — so those rows can be closed.
 */
export function isLiCommitArtifact(artifactPath: string): boolean {
  const path = artifactPath.split("\\").join("/").toLowerCase();
  if (path.includes("/02-inputs/")) return false;
  return (path.split("/").pop() ?? "") === "12-commit.json";
}

/**
 * The direction requests a run reported covering, as exact request strings.
 *
 * REPORTED, never inferred. The alternative — closing every open row whenever a
 * run delivers — silently loses a standing steer the moment any post ships, and a
 * client whose "talk more about pricing transparency" vanished after one
 * unrelated post has no way to tell that from us ignoring them. So a row closes
 * only when the run names it, and the instructions say so.
 *
 * Tolerant of the two shapes a model actually produces for a list of strings: a
 * bare array, or objects carrying the text under a `request`/`text` key. Anything
 * else yields nothing, which leaves the row open — the safe direction.
 */
export function coveredDirectionRequests(commitJson: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(commitJson);
  } catch {
    return [];
  }
  if (typeof parsed !== "object" || parsed === null) return [];
  const raw = (parsed as Record<string, unknown>).direction_requests_covered;
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item === "string" && item.trim()) {
      out.push(item.trim());
      continue;
    }
    if (typeof item === "object" && item !== null) {
      const record = item as Record<string, unknown>;
      const text = record.request ?? record.text;
      if (typeof text === "string" && text.trim()) out.push(text.trim());
    }
  }
  return out;
}
