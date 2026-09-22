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

/**
 * The engine's own `code` on a `POST /runs/:runId/resume` 409 — its
 * `GateConflictBody` (apps/agent-server/src/routes/runs.ts), mirrored here as
 * a string union rather than imported (separate repos, same rule as
 * `read-run.ts`). `TIMEOUT` is this client's own: the fetch was severed by
 * `AbortSignal.timeout` and no status ever arrived.
 */
export type AgentEngineErrorCode = "RUN_NOT_AWAITING_GATE" | "GATE_NOT_PENDING" | "GATE_ALREADY_RESOLVED" | "RUN_BUSY" | "TIMEOUT";

/**
 * A non-2xx answer from agent-engine, WITH what the engine actually said.
 *
 * Until 2026-09-22 `request()` logged the body server-side and threw
 * `Agent engine request failed (409). Please try again or contact support.` —
 * so a reviewer whose "Request changes" met a 409 saw a sentence that was
 * wrong on both counts (trying again could not help, and support had nothing
 * to go on either). The body is now parsed and kept: `detail` is the engine's
 * own `error` sentence, `code` its machine-readable reason when it sent one,
 * and `body` the rest (e.g. who resolved a gate, and when).
 *
 * `message` stays a sentence a screen can show unchanged, and the NAME is
 * load-bearing for the same reason `AgentEngineCredentialError`'s is: callers
 * match on it rather than on the class, so it survives module mocking.
 */
export class AgentEngineRequestError extends Error {
  readonly name = "AgentEngineRequestError";
  constructor(
    readonly status: number,
    readonly path: string,
    /** The engine's own `error` sentence, when the body was JSON with one. */
    readonly detail: string | undefined,
    readonly code: AgentEngineErrorCode | undefined,
    readonly body: Record<string, unknown>,
  ) {
    super(detail ? `Agent engine request failed (${status}): ${detail}` : `Agent engine request failed (${status}). Please try again or contact support.`);
  }
}

const KNOWN_CODES: ReadonlySet<string> = new Set<AgentEngineErrorCode>(["RUN_NOT_AWAITING_GATE", "GATE_NOT_PENDING", "GATE_ALREADY_RESOLVED", "RUN_BUSY", "TIMEOUT"]);

function parseErrorBody(text: string): { detail?: string; code?: AgentEngineErrorCode; body: Record<string, unknown> } {
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return { body: {} };
    const body = parsed as Record<string, unknown>;
    const detail = typeof body.error === "string" ? body.error : undefined;
    const code = typeof body.code === "string" && KNOWN_CODES.has(body.code) ? (body.code as AgentEngineErrorCode) : undefined;
    return { ...(detail !== undefined ? { detail } : {}), ...(code !== undefined ? { code } : {}), body };
  } catch {
    return { body: {} };
  }
}

/**
 * How long one engine request may take before this client gives up on it.
 *
 * Every call here is now a control-plane exchange: `/resume` records the
 * decision and hands the rest of the run to the engine's worker (agent-engine,
 * 2026-09-22), so nothing behind this timeout does minutes of work any more.
 * It used to: a "Request changes" on the Instagram agent ran the whole redraft
 * inside the request, this 30s abort severed it, and the reviewer saw an error
 * for a decision the engine had in fact recorded — then a 409 on every retry.
 */
const REQUEST_TIMEOUT_MS = 30_000;

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const { baseUrl } = config();
  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...(init?.headers as Record<string, string> | undefined),
  };
  const idToken = await iamIdToken();
  if (idToken) headers.authorization = `Bearer ${idToken}`;
  let res: Response;
  try {
    res = await fetch(`${baseUrl}${path}`, { ...init, headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch (e) {
    // `AbortSignal.timeout` rejects with a DOMException named "TimeoutError".
    // Said as what it is — the engine did not answer in time, and may still be
    // working — rather than surfacing "The operation was aborted due to timeout"
    // to a reviewer as if their decision had been refused.
    if (e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError")) {
      console.error(`[agent-engine] ${path} did not answer within ${REQUEST_TIMEOUT_MS / 1000}s`);
      throw new AgentEngineRequestError(0, path, `the agent engine did not answer within ${REQUEST_TIMEOUT_MS / 1000} seconds`, "TIMEOUT", {});
    }
    throw e;
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    console.error(`[agent-engine] ${path} failed (${res.status}): ${text.slice(0, 500)}`);
    const { detail, code, body } = parseErrorBody(text);
    throw new AgentEngineRequestError(res.status, path, detail, code, body);
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
