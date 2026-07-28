import "server-only";

import { getClientAgent, updateClientAgent } from "@/lib/data-client-agents";
import type { ClientAgent, ClientAgentTemplate } from "@/lib/types";

/**
 * What the webhook does when a LAUNCH run lands (Phase 3 §8.2).
 *
 * Lives beside the route rather than in it: the route is a long shared file
 * that several clusters touch, and the launch branch is a self-contained
 * decision — flip the umbrella, seed the templates the setup run proposed, and
 * keep the deliverables staff-only until a human confirms them.
 */

const MAX_TEMPLATES = 12;
const MAX_NAME = 80;
const MAX_RATIONALE = 400;
const TEMPLATE_KEY_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** The artifact a setup run emits so the registry seeds itself (Tomer seam T1). */
export const LAUNCH_TEMPLATES_ARTIFACT = "templates.json";

export function isLaunchTemplatesArtifact(name: string): boolean {
  return name.split("/").pop()?.toLowerCase() === LAUNCH_TEMPLATES_ARTIFACT;
}

/**
 * Parse the setup run's `templates.json` into registry rows.
 *
 * Deliberately forgiving about SHAPE and strict about CONTENT: a lab skill that
 * emits `{ templates: [...] }` instead of a bare array should still seed, but a
 * key that isn't kebab-case must not enter the registry — `key` is the join
 * with Asset.templateKey, so a malformed one silently breaks every future
 * asset↔slot match rather than failing loudly here.
 *
 * Returns [] for anything unparseable: the curation pane works without the
 * file, which is exactly why this can afford to be strict.
 */
export function parseLaunchTemplates(raw: string, now: number): ClientAgentTemplate[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  const rows = Array.isArray(parsed)
    ? parsed
    : Array.isArray((parsed as { templates?: unknown })?.templates)
      ? (parsed as { templates: unknown[] }).templates
      : [];

  const templates: ClientAgentTemplate[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const entry = row as Record<string, unknown>;
    const key = typeof entry.key === "string" ? entry.key.trim().toLowerCase() : "";
    if (!TEMPLATE_KEY_RE.test(key) || seen.has(key)) continue;
    const name = typeof entry.name === "string" ? entry.name.trim().slice(0, MAX_NAME) : "";
    if (!name) continue;
    const rationale =
      typeof entry.rationale === "string" ? entry.rationale.trim().slice(0, MAX_RATIONALE) : "";
    seen.add(key);
    templates.push({
      key,
      name,
      ...(rationale ? { rationale } : {}),
      status: "active",
      position: templates.length,
      source: "launch",
      addedAt: now,
    });
    if (templates.length >= MAX_TEMPLATES) break;
  }
  return templates;
}

export interface LaunchOutcome {
  /** The umbrella this run belongs to (job.clientAgentId, metadata fallback). */
  clientAgentId: string;
  /** Terminal webhook status. */
  status: "done" | "failed" | "cancelled" | "dead_letter";
  /** Raw service error — stored for STAFF; client surfaces redact it. */
  error?: string | null;
  /** Contents of templates.json when the run emitted one. */
  templatesJson?: string | null;
  /** Whether the client's launch charge was handed back. */
  refunded?: boolean;
  now: number;
}

/**
 * Advance the umbrella's launch state from a finished setup run.
 *
 * done      → `curating` (staff confirm the templates before the client sees
 *              them — the Q3 default; deliverables stay staff-only meanwhile)
 * anything  → `launch_failed`, keeping the raw error for staff. A cancelled
 * else       run is terminal and NEUTRAL: a deliberate stop is not a breakage
 *             (F30), and the card must not paint it red.
 *
 * Best-effort by contract: the caller has already claimed the job, so a write
 * failure here must not fail the delivery. It returns what happened instead of
 * throwing.
 */
export async function applyLaunchOutcome(
  outcome: LaunchOutcome,
): Promise<{ applied: boolean; seededTemplates: number }> {
  const umbrella = await getClientAgent(outcome.clientAgentId);
  if (!umbrella) return { applied: false, seededTemplates: 0 };
  // Only an in-flight launch may be advanced — a redelivery arriving after
  // staff already pressed "Go live" must not drag a live agent back.
  if (umbrella.launchState !== "launching") return { applied: false, seededTemplates: 0 };

  if (outcome.status !== "done") {
    await updateClientAgent(umbrella.id, {
      launchState: "launch_failed",
      launchError: outcome.error ?? `Setup run ${outcome.status.replace("_", " ")}`,
      launchRefunded: outcome.refunded ?? false,
    });
    return { applied: true, seededTemplates: 0 };
  }

  const seeded = outcome.templatesJson
    ? parseLaunchTemplates(outcome.templatesJson, outcome.now)
    : [];
  const patch: Partial<ClientAgent> = {
    launchState: "curating",
    launchError: null,
    launchRefunded: null,
  };
  // Never overwrite a registry that already has entries — a re-launch of an
  // agent staff already curated must add to the pane's suggestions, not
  // silently replace the names a human chose.
  if (seeded.length > 0 && umbrella.templates.length === 0) {
    patch.templates = seeded;
    patch.rotation = seeded.map((t) => t.key);
  }
  await updateClientAgent(umbrella.id, patch);
  return { applied: true, seededTemplates: patch.templates?.length ?? 0 };
}
