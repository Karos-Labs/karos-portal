import "server-only";

/**
 * Dispatch through `agent-middleware` (the control plane) instead of
 * publishing to agent-engine's Pub/Sub topic directly.
 *
 * The difference that matters: publishing ourselves sends only
 * `{clientSlug, productId, runKind}`, so the engine runs whatever prompt and
 * template happen to be baked into its own image. Going through the control
 * plane means the middleware resolves the agent's *active* system prompt,
 * template version and GCS assets, records a run those versions are attached
 * to, and publishes that. Feedback then has an exact prompt version to point
 * at, which is the whole reason the control plane exists.
 *
 * ## The run id
 *
 * Everything downstream in this repo — `reconcile.ts`, `materialize.ts`, the
 * job detail page — reads `agentEngineRuns/{runId}` where `runId` is
 * `pubsub-${messageId}`, because that is how agent-engine's queue consumer
 * derives it from the message it receives. That does not change here: the
 * middleware returns the Pub/Sub message id it published under, and we derive
 * the same id from it. The middleware's own `run.id` is a *different*
 * identifier, internal to the control plane's run/feedback store, and is
 * deliberately not what this repo keys on.
 *
 * ## Timeout
 *
 * 30s, against the middleware's own 10s publish timeout. It has to resolve a
 * context (several Firestore reads) and then publish, so its worst case is
 * meaningfully longer than a bare publish; a client timeout below its server
 * timeout would abandon requests that were about to succeed and, worse, that
 * had already written a run record.
 */

const METADATA_URL =
  "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity";

/** Comfortably above the middleware's own 10s publish timeout — see the header note. */
const REQUEST_TIMEOUT_MS = 30_000;

export interface MiddlewareDispatchInput {
  /** The middleware agent to run. Its slug equals agent-engine's product id. */
  productId: string;
  clientSlug: string;
  runKind: "setup" | "recurring";
  /** Job-specific variables merged into the resolved payload. */
  inputs?: Record<string, unknown>;
  /** karosCMO's job id, for cross-system tracing. */
  correlationId: string;
  requestedBy?: string;
}

export interface MiddlewareDispatchResult {
  /** Pub/Sub's id for the published message — `pubsub-${this}` is the agentEngineRuns doc id. */
  pubsubMessageId: string;
  /** The control plane's own run id. Feedback attaches to this, not to the engine run. */
  middlewareRunId: string;
}

function baseUrl(env: Record<string, string | undefined> = process.env): string | undefined {
  const url = env.AGENT_MIDDLEWARE_URL;
  return url && url.length > 0 ? url.replace(/\/$/, "") : undefined;
}

/**
 * Whether dispatch should go through the control plane at all.
 *
 * Separate from `AGENT_ENGINE_DISPATCH_ENABLED`, deliberately: that flag
 * decides *whether* a product uses agent-engine, this one decides *how* the
 * job gets there. Off (the default) keeps the direct-publish path exactly as
 * it is, so turning the control plane on is one variable and reverting it is
 * one variable.
 */
export function isMiddlewareDispatchEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env.AGENT_MIDDLEWARE_DISPATCH_ENABLED === "true" && baseUrl(env) !== undefined;
}

let idTokenCache: { audience: string; token: string; expiresAt: number } | null = null;

/**
 * Google-signed ID token for the IAM-protected middleware, from the Cloud Run
 * metadata server. Same pattern as `client.ts`'s own `iamIdToken`.
 *
 * `AGENT_MIDDLEWARE_AUDIENCE` unset means local development with no IAM in
 * front, so no token is sent; the middleware's `AUTH_ENABLED=false` or its dev
 * bearer token covers that case.
 */
async function iamIdToken(): Promise<string | undefined> {
  const audience = process.env.AGENT_MIDDLEWARE_AUDIENCE;
  if (!audience) return undefined;

  const now = Date.now();
  if (idTokenCache && idTokenCache.audience === audience && idTokenCache.expiresAt > now + 60_000) {
    return idTokenCache.token;
  }
  try {
    const res = await fetch(`${METADATA_URL}?audience=${encodeURIComponent(audience)}`, {
      headers: { "Metadata-Flavor": "Google" },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return undefined;
    const token = (await res.text()).trim();
    if (!token) return undefined;
    // Google mints these with a 1h life; refresh a little early.
    idTokenCache = { audience, token, expiresAt: now + 55 * 60 * 1000 };
    return token;
  } catch {
    return undefined;
  }
}

interface DispatchResponseBody {
  run: { id: string };
  topic: string;
  pubsub_message_id: string;
}

/**
 * `POST /agents/{productId}/jobs`.
 *
 * Throws on any non-2xx. The caller (`dispatch.ts`) already turns a throw into
 * a failed job with the message attached, so there is no partial-success
 * shape to interpret here.
 */
export async function dispatchViaMiddleware(
  input: MiddlewareDispatchInput,
): Promise<MiddlewareDispatchResult> {
  const url = baseUrl();
  if (!url) {
    throw new Error(
      "dispatchViaMiddleware: AGENT_MIDDLEWARE_URL is not set — call " +
        "isMiddlewareDispatchEnabled() first and fall back to direct publishing.",
    );
  }

  const headers: Record<string, string> = { "content-type": "application/json" };
  const idToken = await iamIdToken();
  if (idToken) headers.authorization = `Bearer ${idToken}`;

  const body = {
    client_slug: input.clientSlug,
    run_kind: input.runKind,
    ...(input.inputs && Object.keys(input.inputs).length > 0 ? { input: input.inputs } : {}),
    ...(input.requestedBy ? { requested_by: input.requestedBy } : {}),
    // Rides along as a Pub/Sub message attribute so a job is traceable from
    // the portal to the broker without opening either datastore.
    attributes: { correlationId: input.correlationId },
  };

  const res = await fetch(`${url}/agents/${encodeURIComponent(input.productId)}/jobs`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    console.error(
      `[agent-middleware] dispatch failed (${res.status}) for ${input.productId}: ${detail.slice(0, 500)}`,
    );
    throw new Error(`Agent middleware dispatch failed (${res.status}).`);
  }

  const payload = (await res.json()) as DispatchResponseBody;
  if (!payload?.pubsub_message_id) {
    // Without this we cannot derive the agentEngineRuns doc id, so the job
    // would run but never be reconcilable. Better to fail the dispatch.
    throw new Error("Agent middleware returned no pubsub_message_id; cannot track this run.");
  }

  return {
    pubsubMessageId: payload.pubsub_message_id,
    middlewareRunId: payload.run?.id ?? "",
  };
}
