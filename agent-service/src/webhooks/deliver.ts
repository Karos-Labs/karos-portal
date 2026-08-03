import { buildSignatureHeaders } from "./sign.js";
import type { WebhookPayload } from "../types.js";

export type DeliveryResult = "delivered" | "rejected" | "unreachable";

/**
 * One signed delivery attempt. Retry policy lives in the webhooks queue
 * (BullMQ backoff over hours), not here: "rejected" (4xx — wrong secret or
 * bad receiver) is permanent, "unreachable" (network/5xx) is retryable.
 *
 * THAT SPLIT IS THE CONTRACT THE RECEIVER IS WRITTEN AGAINST, so it is one rule
 * and not a list. Everything the portal wants retried it answers 5xx —
 * including the unmatched-job case, which answered 404 with a comment promising
 * a retry while this classifier was dropping it after a single attempt, and a
 * dropped delivery there costs the client their deliverable and their credits
 * (karosCMO src/app/api/agent-service/webhook/route.ts). If a receiver ever
 * needs another condition retried, make it answer 5xx; do not add an excepted
 * 4xx code here, because the exception is the line that goes stale.
 */
export async function deliverWebhook(
  secret: string,
  callbackUrl: string,
  payload: WebhookPayload,
  fetchImpl: typeof fetch = fetch,
): Promise<DeliveryResult> {
  const rawBody = JSON.stringify(payload);
  try {
    const response = await fetchImpl(callbackUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...buildSignatureHeaders(secret, rawBody),
      },
      body: rawBody,
      signal: AbortSignal.timeout(30_000),
    });
    if (response.ok) return "delivered";
    if (response.status >= 400 && response.status < 500) return "rejected";
    return "unreachable";
  } catch {
    return "unreachable";
  }
}
