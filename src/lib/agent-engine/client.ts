import "server-only";
import type { AgentEngineGateResolution } from "./types";

/**
 * Thin HTTP client for agent-engine's synchronous endpoints — gate
 * resolution and status polling. Dispatch itself goes over Pub/Sub
 * (`pubsub-client.ts`); these two are inherently request/response, not
 * fire-and-forget, so they stay plain HTTP, mirroring
 * `src/lib/agent-service/client.ts`'s own IAM-ID-token pattern exactly
 * (same Cloud-Run-to-Cloud-Run auth story, same metadata-server call).
 *
 * NOTE: as of this writing, `agent-engine`'s `/api/v1/runs/*` routes
 * (`apps/agent-server/src/app.ts`/`routes/runs.ts`) have no
 * application-level auth check at all — this ID token is sent anyway, for
 * when Cloud Run's own IAM invoker check (or an app-level check) is turned
 * on for that service, exactly like `agent-service` already has. That's a
 * gap in agent-engine itself, not something this repo can fix.
 */

const METADATA_URL = "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity";

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

let idTokenCache: { audience: string; token: string; expiresAt: number } | null = null;

/** Google-signed ID token for an IAM-protected agent-engine Cloud Run service. `AGENT_ENGINE_AUDIENCE` unset (local dev) → no IAM in front → skip. */
async function iamIdToken(): Promise<string | undefined> {
  const audience = process.env.AGENT_ENGINE_AUDIENCE;
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
    idTokenCache = { audience, token, expiresAt: now + 55 * 60 * 1000 };
    return token;
  } catch {
    return undefined;
  }
}

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
