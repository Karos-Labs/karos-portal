import "server-only";

import type { AgentServiceJobRequest, AgentServiceJobView } from "./types";

/**
 * Thin HTTP client for the external agent service. Auth is a bearer token
 * from env; the Anthropic key never lives in the platform — the service owns
 * agent execution end to end and reports back via signed webhooks.
 */

/** App token rides its own header so Authorization is free for the IAM ID token. */
const SERVICE_TOKEN_HEADER = "x-karos-service-token";
const METADATA_URL =
  "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity";

function config(): { baseUrl: string; token: string } {
  const baseUrl = process.env.AGENT_SERVICE_URL;
  const token = process.env.AGENT_SERVICE_TOKEN;
  if (!baseUrl || !token) {
    throw new Error("Agent service is not configured (AGENT_SERVICE_URL / AGENT_SERVICE_TOKEN).");
  }
  return { baseUrl: baseUrl.replace(/\/$/, ""), token };
}

let idTokenCache: { audience: string; token: string; expiresAt: number } | null = null;

/**
 * Google-signed ID token for the IAM-protected agent service, from the Cloud
 * Run metadata server. AGENT_SERVICE_AUDIENCE is the service URL; unset (local
 * dev) → no IAM in front → skip. The platform's runtime service account needs
 * roles/run.invoker on the agent-service api.
 */
async function iamIdToken(): Promise<string | undefined> {
  const audience = process.env.AGENT_SERVICE_AUDIENCE;
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
  const { baseUrl, token } = config();
  const headers: Record<string, string> = {
    "content-type": "application/json",
    [SERVICE_TOKEN_HEADER]: token,
    ...(init?.headers as Record<string, string> | undefined),
  };
  const idToken = await iamIdToken();
  if (idToken) headers.authorization = `Bearer ${idToken}`;
  const res = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers,
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Agent service ${path} failed (${res.status}): ${body.slice(0, 500)}`);
  }
  return (await res.json()) as T;
}

export async function submitAgentServiceJob(job: AgentServiceJobRequest): Promise<{ job_id: string }> {
  return request<{ job_id: string }>("/v1/jobs", { method: "POST", body: JSON.stringify(job) });
}

export async function getAgentServiceJob(serviceJobId: string): Promise<AgentServiceJobView> {
  return request<AgentServiceJobView>(`/v1/jobs/${serviceJobId}`);
}

export async function cancelAgentServiceJob(serviceJobId: string): Promise<{ status: string }> {
  return request<{ status: string }>(`/v1/jobs/${serviceJobId}/cancel`, { method: "POST" });
}

export function isAgentServiceConfigured(): boolean {
  return Boolean(process.env.AGENT_SERVICE_URL && process.env.AGENT_SERVICE_TOKEN);
}

/**
 * Auth headers for fetching an artifact/transcript URL back from the service.
 * The service's local-store routes are bearer-protected, so those fetches need
 * the token; production artifact URLs are GCS signed links on a different host
 * and must NOT carry an Authorization header (GCS rejects combined auth), so
 * the token is attached only when the URL belongs to the agent service.
 * Pure (env injected) so it can be unit-tested.
 */
export function agentServiceFetchHeaders(
  url: string,
  env: { base?: string; token?: string } = {
    ...(process.env.AGENT_SERVICE_URL ? { base: process.env.AGENT_SERVICE_URL } : {}),
    ...(process.env.AGENT_SERVICE_TOKEN ? { token: process.env.AGENT_SERVICE_TOKEN } : {}),
  },
): Record<string, string> | undefined {
  const base = env.base?.replace(/\/$/, "");
  if (base && env.token && url.startsWith(base)) {
    return { authorization: `Bearer ${env.token}` };
  }
  return undefined;
}
