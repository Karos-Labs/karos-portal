import "server-only";

import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Stateless, HMAC-signed job tokens — the credential a running agent-service
 * job presents to the MCP server (`/api/mcp`) to pull its client's data or
 * upload artifacts mid-run. Minted in the submit path
 * (`src/lib/jobs/submit-custom.ts`) and handed to the runner via the job's
 * `metadata.karos_job_token`; verified here on every MCP request.
 *
 * Design: self-contained (no DB lookup), auto-expiring, and scoped to exactly
 * one client + job — so a leaked token can only touch the client it was issued
 * for, and only until it expires. Fits a Cloud Run / cross-repo boundary where
 * we don't want shared mutable session state.
 *
 *   token   = `karos_job_<base64url(claims)>.<base64url(hmac_sha256(secret, payload))>`
 *   claims  = { clientId, jobId, exp }   (exp = epoch millis)
 */

const PREFIX = "karos_job_";
const DEFAULT_TTL_MS = 2 * 60 * 60 * 1000; // 2h — comfortably longer than the slowest managed run

export interface JobTokenClaims {
  clientId: string;
  jobId: string;
  /** Epoch millis after which the token is rejected. */
  exp: number;
}

/**
 * Signing secret. Prefer a dedicated var; fall back to the first webhook secret
 * so the feature works with no extra env in setups that already sign webhooks.
 * Absent ⇒ minting/verification are disabled (jobs still run, just without the
 * mid-run callback capability).
 */
function secret(): string | null {
  const dedicated = process.env.MCP_JOB_TOKEN_SECRET?.trim();
  if (dedicated) return dedicated;
  const webhook = process.env.AGENT_WEBHOOK_SECRET?.split(",")[0]?.trim();
  return webhook && webhook.length > 0 ? webhook : null;
}

export function isJobTokenConfigured(): boolean {
  return secret() !== null;
}

function sign(payload: string, key: string): string {
  return createHmac("sha256", key).update(payload).digest("base64url");
}

/** Mint a job token, or null if signing isn't configured. */
export function mintJobToken(input: {
  clientId: string;
  jobId: string;
  ttlMs?: number;
  nowMs?: number;
}): string | null {
  const key = secret();
  if (!key) return null;
  const now = input.nowMs ?? Date.now();
  const claims: JobTokenClaims = {
    clientId: input.clientId,
    jobId: input.jobId,
    exp: now + (input.ttlMs ?? DEFAULT_TTL_MS),
  };
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `${PREFIX}${payload}.${sign(payload, key)}`;
}

/** Verify a job token; returns its claims, or null if invalid/expired/unconfigured. */
export function verifyJobToken(token: string | undefined, nowMs = Date.now()): JobTokenClaims | null {
  const key = secret();
  if (!key || !token || !token.startsWith(PREFIX)) return null;

  const body = token.slice(PREFIX.length);
  const dot = body.lastIndexOf(".");
  if (dot <= 0) return null;
  const payload = body.slice(0, dot);
  const providedSig = body.slice(dot + 1);

  const expected = Buffer.from(sign(payload, key));
  const provided = Buffer.from(providedSig);
  if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) return null;

  let claims: JobTokenClaims;
  try {
    claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (
    !claims ||
    typeof claims.clientId !== "string" ||
    typeof claims.jobId !== "string" ||
    typeof claims.exp !== "number" ||
    claims.exp < nowMs
  ) {
    return null;
  }
  return claims;
}
