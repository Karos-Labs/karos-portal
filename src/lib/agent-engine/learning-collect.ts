import "server-only";

import { middlewareBaseUrl, middlewareFetch, MiddlewareRequestError } from "./middleware-http";
import type { Job } from "@/lib/types";

/**
 * The half of the learning loop that closes it (C7 / SCRUM-461).
 *
 * A run on the loop writes its record to `state/runs/<runId>.json` and its
 * platform state to `state/<platform>/platform-state.json` in the workspace,
 * and then stops. Nothing reads those files until somebody asks the control
 * plane to fold them into the learning tables — and the next run reads the
 * TABLES, by way of the projection, not the files. So a reconcile that
 * materialises the asset and never calls `collect` produces an agent that
 * drafts, delivers, and learns precisely nothing, run after run, while looking
 * completely healthy from every surface a human checks.
 *
 * That was the state of this repo until now: the engine wrote the files, the
 * middleware could read them, and no caller existed. This module is the caller.
 *
 * ## Best-effort, always
 *
 * Collection is bookkeeping about a run that has already delivered. A control
 * plane that is down, unreachable or has no bucket configured must never turn a
 * delivered job into a failed one, so every failure here is logged and
 * swallowed. The cost of a missed collection is one run's worth of learning,
 * and the next sweep retries it.
 *
 * ## Which id we send
 *
 * `job.agentEngineRunId` — `pubsub-<messageId>`, agent-engine's own. The
 * middleware mints a different id for its run record and this repo does not
 * keep it (dispatch returns it and drops it). The middleware resolves either
 * spelling; see its `LearningService._resolve_run`.
 */

/**
 * The products whose runs have something to collect — the ones that write a
 * C7 run record at all.
 *
 * A LIST RATHER THAN A CALL, because the alternative is one HTTP round trip
 * per terminal job per sweep to be told "this agent has no platform". The
 * middleware is still the authority: it answers `collected: false` for
 * anything here that turns out not to be on the loop, which is a correct,
 * ordinary answer and not an error.
 *
 * Keep in step with `PRODUCT_PLATFORM_OVERRIDES` and the platform spelling rule
 * in agent-middleware's `learning_store.py`. `branded-shorts-agent` is on this
 * list because it is the editing TikTok agent under its old name — it mapped to
 * no platform for its whole life, which is exactly the silent failure this
 * list makes visible.
 */
export const LEARNING_LOOP_PRODUCT_IDS: ReadonlySet<string> = new Set([
  "x-agent",
  "linkedin-agent",
  "reddit-agent",
  "instagram-agent",
  "tiktok-agent",
  "tiktok-clipping-agent",
  "tiktok-editing-agent",
  "tiktok-content-design-agent",
  "branded-shorts-agent",
]);

export function isOnLearningLoop(productId: string | undefined): boolean {
  return typeof productId === "string" && LEARNING_LOOP_PRODUCT_IDS.has(productId);
}

/** What the middleware answers — the fields this repo acts on. */
export interface CollectOutcome {
  runId: string;
  collected: boolean;
  reason: string;
  platform?: string | null;
  subjectRowId?: string | null;
  recordChanged?: boolean;
}

/**
 * `POST /runs/{runId}/collect`. Returns the outcome, or `undefined` when the
 * call could not be made or failed — never throws.
 *
 * Idempotent on the run, by the middleware's own design: the record is upserted
 * by content hash and the subject row on its natural key, so calling it twice
 * costs one no-op round trip and changes nothing. That is what makes it safe to
 * call from a sweep.
 */
export async function collectRunLearning(job: Job): Promise<CollectOutcome | undefined> {
  const runId = job.agentEngineRunId;
  if (!runId) return undefined;
  if (!middlewareBaseUrl()) return undefined; // control plane not configured in this environment

  try {
    const body = (await middlewareFetch(`/runs/${encodeURIComponent(runId)}/collect`, {
      method: "POST",
    })) as CollectOutcome;
    return body;
  } catch (e) {
    // A 503 here is the middleware saying GCS_ARTIFACTS_BUCKET is not
    // configured, which is a deployment fact rather than a per-run problem —
    // logged like the rest, because a permanently-503 environment is an agent
    // that never learns and somebody should see it say so.
    const detail = e instanceof MiddlewareRequestError ? `${e.status ?? "no response"}: ${e.detail}` : String(e);
    console.error(`[agent-engine] learning collect failed for run ${runId} (job ${job.id}): ${detail}`);
    return undefined;
  }
}
