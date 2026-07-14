import { createHmac, timingSafeEqual } from "node:crypto";

export const SIGNATURE_HEADER = "x-karos-signature";
export const TIMESTAMP_HEADER = "x-karos-timestamp";
export const DEFAULT_TOLERANCE_MS = 5 * 60 * 1000;

export function signPayload(secret: string, timestampMs: number, rawBody: string): string {
  return createHmac("sha256", secret).update(`${timestampMs}.${rawBody}`).digest("hex");
}

export function buildSignatureHeaders(
  secret: string,
  rawBody: string,
  timestampMs: number = Date.now(),
): Record<string, string> {
  return {
    [TIMESTAMP_HEADER]: String(timestampMs),
    [SIGNATURE_HEADER]: `v1=${signPayload(secret, timestampMs, rawBody)}`,
  };
}

/**
 * Constant-time verification against one or more accepted secrets
 * (multiple secrets allow zero-downtime rotation).
 */
export function verifySignature(params: {
  secrets: string[];
  signatureHeader: string | undefined;
  timestampHeader: string | undefined;
  rawBody: string;
  toleranceMs?: number;
  nowMs?: number;
}): boolean {
  const { secrets, signatureHeader, timestampHeader, rawBody } = params;
  const toleranceMs = params.toleranceMs ?? DEFAULT_TOLERANCE_MS;
  const nowMs = params.nowMs ?? Date.now();
  if (!signatureHeader || !timestampHeader) return false;
  const timestampMs = Number(timestampHeader);
  if (!Number.isFinite(timestampMs)) return false;
  if (Math.abs(nowMs - timestampMs) > toleranceMs) return false;
  const match = /^v1=([0-9a-f]{64})$/.exec(signatureHeader.trim());
  if (!match) return false;
  const provided = Buffer.from(match[1]!, "hex");
  let valid = false;
  for (const secret of secrets) {
    const expected = Buffer.from(signPayload(secret, timestampMs, rawBody), "hex");
    if (expected.length === provided.length && timingSafeEqual(expected, provided)) valid = true;
  }
  return valid;
}

export function timingSafeStringEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    timingSafeEqual(bufA, bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}
