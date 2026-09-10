import "server-only";

import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Webhook signature verification (platform side of the agent-service HMAC
 * contract — see agent-service/src/webhooks/sign.ts for the signing side):
 *   signature = hex(hmac_sha256(secret, `${timestampMs}.${rawBody}`))
 *   headers:   x-karos-timestamp: <ms>   x-karos-signature: v1=<signature>
 * Requests older than 5 minutes are rejected (replay window). Multiple
 * accepted secrets allow zero-downtime rotation.
 */

export const SIGNATURE_HEADER = "x-karos-signature";
export const TIMESTAMP_HEADER = "x-karos-timestamp";
const TOLERANCE_MS = 5 * 60 * 1000;

export function verifyAgentServiceSignature(params: {
  secrets: string[];
  signatureHeader: string | null;
  timestampHeader: string | null;
  rawBody: string;
  nowMs?: number;
}): boolean {
  const { secrets, signatureHeader, timestampHeader, rawBody } = params;
  const nowMs = params.nowMs ?? Date.now();
  if (!signatureHeader || !timestampHeader) return false;
  const timestampMs = Number(timestampHeader);
  if (!Number.isFinite(timestampMs) || Math.abs(nowMs - timestampMs) > TOLERANCE_MS) return false;
  const match = /^v1=([0-9a-f]{64})$/.exec(signatureHeader.trim());
  if (!match) return false;
  const provided = Buffer.from(match[1], "hex");
  let valid = false;
  for (const secret of secrets) {
    const expected = createHmac("sha256", secret).update(`${timestampMs}.${rawBody}`).digest();
    if (expected.length === provided.length && timingSafeEqual(expected, provided)) valid = true;
  }
  return valid;
}
