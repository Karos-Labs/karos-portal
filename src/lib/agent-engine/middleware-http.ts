import "server-only";

/**
 * The one HTTP/auth layer for `agent-middleware`, shared by the dispatch path
 * (`middleware-client.ts`) and the admin path (`middleware-admin.ts`).
 *
 * Extracted because both need the same Google-signed ID token against the same
 * audience, and two copies of that would drift — the caching in particular:
 * the metadata server is not free, and an admin page that lists agents,
 * prompts and templates makes several calls per render.
 */

const METADATA_URL =
  "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity";

/** Admin calls are plain Firestore reads/writes behind the API — much quicker than a dispatch. */
const DEFAULT_TIMEOUT_MS = 15_000;

export function middlewareBaseUrl(env: Record<string, string | undefined> = process.env): string | undefined {
  const url = env.AGENT_MIDDLEWARE_URL;
  return url && url.length > 0 ? url.replace(/\/$/, "") : undefined;
}

let idTokenCache: { audience: string; token: string; expiresAt: number } | null = null;

/** Exposed for tests; production code has no reason to call this. */
export function __resetMiddlewareTokenCache(): void {
  idTokenCache = null;
}

/**
 * Google-signed ID token for the IAM-protected middleware, from the Cloud Run
 * metadata server.
 *
 * `AGENT_MIDDLEWARE_AUDIENCE` unset means local development with no IAM in
 * front, so no token is sent; the middleware's `AUTH_ENABLED=false` or its dev
 * bearer token covers that case.
 *
 * The audience must equal the middleware's own `AUTH_AUDIENCE` exactly. Google
 * issues a valid signed token to every account for every audience, so that
 * claim is the only thing binding a token to this service — a mismatch is a
 * 403, not a warning.
 */
export async function middlewareIdToken(): Promise<string | undefined> {
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

/**
 * A non-2xx from the control plane, or an unreachable one.
 *
 * `status` is undefined when the request never got a response. `detail` is the
 * body, truncated — FastAPI puts the useful part in `detail` and an admin
 * fixing a rejected prompt needs to read it, so it is not swallowed.
 */
export class MiddlewareRequestError extends Error {
  readonly status: number | undefined;
  readonly detail: string;

  constructor(message: string, options: { status?: number; detail?: string; cause?: unknown }) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "MiddlewareRequestError";
    this.status = options.status;
    this.detail = options.detail ?? "";
  }
}

export interface MiddlewareFetchOptions {
  method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  body?: unknown;
  timeoutMs?: number;
}

/** Pulls FastAPI's `{"detail": ...}` out of an error body, falling back to the raw text. */
function readDetail(text: string): string {
  try {
    const parsed = JSON.parse(text) as { detail?: unknown };
    if (typeof parsed.detail === "string") return parsed.detail;
    if (parsed.detail !== undefined) return JSON.stringify(parsed.detail);
  } catch {
    // Not JSON — an HTML error page from the proxy, most likely.
  }
  return text;
}

/**
 * One authenticated request to the control plane. Returns the parsed JSON body,
 * or `undefined` for a 204.
 *
 * Throws `MiddlewareRequestError` on anything non-2xx. Unlike dispatch, there
 * is no recoverable/non-recoverable split: an admin action either happened or
 * it did not, and retrying it elsewhere is not a thing that exists.
 */
export async function middlewareFetch(path: string, options: MiddlewareFetchOptions = {}): Promise<unknown> {
  const base = middlewareBaseUrl();
  if (!base) {
    throw new MiddlewareRequestError(
      "AGENT_MIDDLEWARE_URL is not set — the control plane is not configured in this environment.",
      {},
    );
  }

  const headers: Record<string, string> = { accept: "application/json" };
  if (options.body !== undefined) headers["content-type"] = "application/json";
  const token = await middlewareIdToken();
  if (token) headers.authorization = `Bearer ${token}`;

  let res: Response;
  try {
    res = await fetch(`${base}${path}`, {
      method: options.method ?? "GET",
      headers,
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
      signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      // Admin data is live and edited in place; a cached list would show an
      // admin their own edit failing to appear.
      cache: "no-store",
    });
  } catch (cause) {
    throw new MiddlewareRequestError(
      `Agent middleware is unreachable: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
  }

  if (!res.ok) {
    const detail = readDetail((await res.text().catch(() => "")).slice(0, 1000));
    throw new MiddlewareRequestError(`Agent middleware returned ${res.status}${detail ? `: ${detail}` : ""}`, {
      status: res.status,
      detail,
    });
  }

  if (res.status === 204) return undefined;

  try {
    return await res.json();
  } catch (cause) {
    throw new MiddlewareRequestError("Agent middleware returned a body that is not JSON.", {
      status: res.status,
      cause,
    });
  }
}
