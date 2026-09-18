import "server-only";

import { middlewareBaseUrl, middlewareFetch, MiddlewareRequestError } from "./middleware-http";
import type { LearningPlatform } from "./learning-feedback";
import type { Client } from "@/lib/types";

/**
 * THE STRATEGY MAP, READ (C1, SCRUM-486) — the portal half.
 *
 * The map exists and is built: `ensureStrategyMap` in the engine composes it in
 * one checkpointed model call, the middleware keeps it in `config.strategy_maps`
 * + `strategy_map_rows`, and the projection puts it in front of every draft. The
 * portal has never read it, so the topic pool that decides what a client is
 * going to be told about — problem, funnel stage, idea, and whether it has been
 * used — was visible to the agents and to nobody else.
 *
 * ## It is built on FIRST USE, not at setup, and that is the better behaviour
 *
 * 04 asks for the map to be built "at setup". The engine builds it lazily, on
 * the first drafting run that finds none. Keeping it that way is the
 * recommendation on SCRUM-486: a client who never runs an agent never pays for a
 * map, and a map built at the first run is built from a profile that has had
 * time to be corrected. What that means HERE is that an absent map is an
 * ordinary state for a new client — not an error, and not something to hide
 * behind a spinner.
 *
 * ## Why this reads the context endpoint
 *
 * There is no `GET .../strategy-map`; the middleware exposes a `PUT` for the
 * engine and serves the map inside `GET /clients/{slug}/learning/{platform}`,
 * which is the whole of what the next run will see. So this asks for the context
 * and takes one slice of it. That costs one round trip per platform and carries
 * more than it needs; it is still cheaper than a new endpoint on both sides, and
 * the rest of the payload is what A1b will want when it surfaces the other
 * sources.
 */

/** One row of the topic pool. `id` is the map's own `row_id`, which the subject table references as `strategyRowId`. */
export interface StrategyRow {
  id: string;
  problem?: string;
  /** The same three-value funnel vocabulary the subject table uses. */
  stage: "attention" | "expertise" | "decide";
  idea?: string;
  type?: string;
  evidence?: string;
  status?: string;
  /** Set once a run has drafted from this row — what makes the pool a pool rather than a list. */
  usedByRunId?: string;
}

export interface StrategyMap {
  platform: string;
  builtAt?: string;
  /** Which side built it — the engine's own run, or a human overwriting it. */
  source?: string;
  audience: string[];
  /** D32's stage mix for this client, if the run set one. */
  defaultMix: Record<string, unknown>;
  rows: StrategyRow[];
}

const STAGES = new Set(["attention", "expertise", "decide"]);

function toStrategyRow(value: unknown): StrategyRow | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const r = value as Record<string, unknown>;
  const str = (key: string): string | undefined => (typeof r[key] === "string" ? (r[key] as string) : undefined);
  const id = str("id");
  const stage = str("stage");
  // Same rule as the subject table's reader: `stage` is a CHECK constraint, so a
  // value outside it means the contract moved rather than that this row is
  // unusual, and a row with no id cannot be matched to the subject that used it.
  if (!id || !stage || !STAGES.has(stage)) return undefined;
  return {
    id,
    stage: stage as StrategyRow["stage"],
    ...(str("problem") ? { problem: str("problem")! } : {}),
    ...(str("idea") ? { idea: str("idea")! } : {}),
    ...(str("type") ? { type: str("type")! } : {}),
    ...(str("evidence") ? { evidence: str("evidence")! } : {}),
    ...(str("status") ? { status: str("status")! } : {}),
    ...(str("usedByRunId") ? { usedByRunId: str("usedByRunId")! } : {}),
  };
}

/**
 * `GET /clients/{slug}/learning/{platform}` → its `strategy-map` slice.
 *
 * THREE ANSWERS, AND THEY ARE ALL DIFFERENT. `undefined` means the question
 * could not be asked (not an engine client, no control plane, the call failed).
 * `null` means it was asked and this client has no map yet — the ordinary state
 * before the first run. A map means there is one.
 */
export async function readStrategyMap(
  client: Pick<Client, "agentsRepoSlug">,
  platform: LearningPlatform,
): Promise<StrategyMap | null | undefined> {
  const slug = client.agentsRepoSlug;
  if (!slug) return undefined;
  if (!middlewareBaseUrl()) return undefined;

  try {
    const body = (await middlewareFetch(`/clients/${encodeURIComponent(slug)}/learning/${platform}`)) as {
      ["strategy-map"]?: unknown;
      strategyMap?: unknown;
    };
    // The endpoint serialises by ALIAS (`strategy-map`); the camelCase name is
    // read too so a future `response_model_by_alias=False` on that route does
    // not silently empty this pane.
    const raw = body?.["strategy-map"] ?? body?.strategyMap;
    if (raw === null || raw === undefined) return null;
    if (typeof raw !== "object") return null;

    const map = raw as Record<string, unknown>;
    const rows = Array.isArray(map["rows"])
      ? (map["rows"] as unknown[]).map(toStrategyRow).filter((r): r is StrategyRow => r !== undefined)
      : [];
    return {
      platform,
      ...(typeof map["builtAt"] === "string" ? { builtAt: map["builtAt"] } : {}),
      ...(typeof map["source"] === "string" ? { source: map["source"] } : {}),
      audience: Array.isArray(map["audience"]) ? (map["audience"] as unknown[]).filter((a): a is string => typeof a === "string") : [],
      defaultMix: typeof map["defaultMix"] === "object" && map["defaultMix"] !== null ? (map["defaultMix"] as Record<string, unknown>) : {},
      rows,
    };
  } catch (e) {
    const detail = e instanceof MiddlewareRequestError ? `${e.status ?? "no response"}: ${e.detail}` : String(e);
    console.error(`[agent-engine] reading the strategy map failed for ${slug}/${platform}: ${detail}`);
    return undefined;
  }
}

/** Every platform's map in one pass, asked in parallel; one platform's failure is its own. */
export async function readStrategyMapsByPlatform(
  client: Pick<Client, "agentsRepoSlug">,
  platforms: readonly LearningPlatform[],
): Promise<Record<string, StrategyMap | null | undefined>> {
  const entries = await Promise.all(
    platforms.map(async (platform) => [platform, await readStrategyMap(client, platform)] as const),
  );
  return Object.fromEntries(entries);
}

/**
 * How much of the pool is left, which is the one number a person scanning this
 * actually acts on: a map whose rows are all used is a client about to repeat
 * itself, and the map is rebuilt from nothing rather than topped up.
 *
 * "Used" is `usedByRunId`, not `status`: the status vocabulary is the engine's
 * and has changed once already, while the run id is set exactly when a draft
 * came out of the row.
 */
export function summariseStrategyMap(map: StrategyMap): {
  total: number;
  used: number;
  remaining: number;
  stages: Record<StrategyRow["stage"], number>;
} {
  const stages: Record<StrategyRow["stage"], number> = { attention: 0, expertise: 0, decide: 0 };
  let used = 0;
  for (const row of map.rows) {
    stages[row.stage] += 1;
    if (row.usedByRunId) used += 1;
  }
  return { total: map.rows.length, used, remaining: map.rows.length - used, stages };
}
