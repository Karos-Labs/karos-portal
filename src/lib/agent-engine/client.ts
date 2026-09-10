import "server-only";
import { mintIdToken, resetIdTokenCacheForTests } from "@/lib/gcp-id-token";
import type { AgentEngineGateResolution } from "./types";

/**
 * Thin HTTP client for agent-engine's synchronous endpoints — gate
 * resolution and status polling. Dispatch itself goes over Pub/Sub
 * (`pubsub-client.ts`); these two are inherently request/response, not
 * fire-and-forget, so they stay plain HTTP, mirroring
 * `src/lib/agent-service/client.ts`'s own IAM-ID-token pattern exactly
 * (same Cloud-Run-to-Cloud-Run auth story, same metadata-server call).
 *
 * NOTE: this ID token is sent whether or not agent-engine currently enforces
 * anything, so that turning enforcement on there is a config flip rather than
 * a code change here. `iamIdToken` below fails CLOSED for exactly that reason
 * (SCRUM-330): a portal that answers "no token" instead of failing is a portal
 * that discovers the problem in production, at call time.
 */


function config(): { baseUrl: string } {
  const baseUrl = process.env.AGENT_ENGINE_URL;
  if (!baseUrl) {
    throw new Error("Agent engine is not configured (AGENT_ENGINE_URL).");
  }
  return { baseUrl: baseUrl.replace(/\/$/, "") };
}

export function isAgentEngineHttpConfigured(): boolean {
  return Boolean(process.env.AGENT_ENGINE_URL);
}

/**
 * Thrown when agent-engine is IAM-protected (`AGENT_ENGINE_AUDIENCE` is set)
 * but this process could not mint an ID token for it.
 *
 * Exists so that a MISSING credential is a different thing from a credential
 * that is legitimately not required. Callers that want to degrade gracefully
 * can still catch it — but they have to name it, which is the point.
 *
 * The NAME is load-bearing: `intel/agent-onboarding.ts` matches on
 * `e.name === "AgentEngineCredentialError"` rather than on the class, so it
 * survives module mocking.
 */
export class AgentEngineCredentialError extends Error {
  constructor(reason: string) {
    super(`agent-engine is IAM-protected but no ID token could be minted: ${reason}`);
    this.name = "AgentEngineCredentialError";
  }
}

/**
 * Google-signed ID token for an IAM-protected agent-engine Cloud Run service.
 *
 * THE MINTING MOVED (SCRUM-330, second pass). This function used to hold the
 * metadata-server call, the cache and the fail-closed logic itself — and it was
 * one of THREE copies of all three, of which only this one had been fixed. The
 * logic now lives in `lib/gcp-id-token.ts`; what stays here is this service's
 * own error type and its own audience variable, which is all that ever differed.
 *
 * `AGENT_ENGINE_AUDIENCE` unset means local development with no IAM in front,
 * so no token is sent and an unauthenticated request is the intended behaviour.
 * Every other outcome throws `AgentEngineCredentialError`.
 */
async function iamIdToken(env: Record<string, string | undefined> = process.env): Promise<string | undefined> {
  return mintIdToken({
    audience: env.AGENT_ENGINE_AUDIENCE,
    service: "agent-engine",
    credentialError: (reason) => new AgentEngineCredentialError(reason),
  });
}

/** Test seam: the shared token cache would otherwise leak between cases. */
export function __resetIdTokenCacheForTests(): void {
  resetIdTokenCacheForTests();
}

/** Exported for tests only — the failure modes above must be exercisable. */
export const __iamIdTokenForTests = iamIdToken;

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const { baseUrl } = config();
  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...(init?.headers as Record<string, string> | undefined),
  };
  const idToken = await iamIdToken();
  if (idToken) headers.authorization = `Bearer ${idToken}`;
  const res = await fetch(`${baseUrl}${path}`, { ...init, headers, signal: AbortSignal.timeout(30_000) });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    console.error(`[agent-engine] ${path} failed (${res.status}): ${body.slice(0, 500)}`);
    throw new Error(`Agent engine request failed (${res.status}). Please try again or contact support.`);
  }
  return (await res.json()) as T;
}

export interface AgentEngineRunStatus {
  runId: string;
  status: string;
  pendingGateId?: string;
  report?: unknown;
}

export async function getAgentEngineRunStatus(runId: string): Promise<AgentEngineRunStatus> {
  return request<AgentEngineRunStatus>(`/api/v1/runs/${runId}/status`);
}

/** Resolves a paused run's gate — matches `apps/agent-server/src/routes/runs.ts`'s `ResumeRunRequestSchema` body exactly. */
export async function resolveAgentEngineGate(
  runId: string,
  gateId: string,
  resolution: AgentEngineGateResolution,
): Promise<AgentEngineRunStatus> {
  return request<AgentEngineRunStatus>(`/api/v1/runs/${runId}/resume`, {
    method: "POST",
    body: JSON.stringify({ gateId, resolution }),
  });
}

/**
 * Fetches one run's deliverable content — the retrieval half of
 * `ledger.writeDeliverable` (Task 1's plumbing; see agent-engine's own
 * `routes/deliverables.ts`). `kind` must match what the workflow actually
 * called `ledger.writeDeliverable` with (e.g. `"seo-geo-report"`,
 * `"intel-report"`) — an unwritten or not-yet-run deliverable 404s, which
 * this returns as `undefined` rather than throwing, since "not ready yet"
 * is an expected, common state for a caller polling a just-dispatched run.
 */
export async function getAgentEngineDeliverable<T = unknown>(runId: string, kind: string): Promise<T | undefined> {
  const { baseUrl } = config();
  const idToken = await iamIdToken();
  const headers: Record<string, string> = {};
  if (idToken) headers.authorization = `Bearer ${idToken}`;
  const res = await fetch(`${baseUrl}/api/v1/runs/${runId}/deliverables/${kind}`, { headers, signal: AbortSignal.timeout(30_000) });
  if (res.status === 404) return undefined;
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    console.error(`[agent-engine] deliverable fetch failed (${res.status}): ${body.slice(0, 500)}`);
    throw new Error(`Agent engine deliverable request failed (${res.status}).`);
  }
  const record = (await res.json()) as { deliverable: T };
  return record.deliverable;
}
