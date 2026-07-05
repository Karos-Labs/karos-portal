import { buildSignatureHeaders } from "./sign.js";
import type { WebhookPayload } from "../types.js";

export type DeliveryResult = "delivered" | "rejected" | "unreachable";

/**
 * One signed delivery attempt. Retry policy lives in the webhooks queue
 * (BullMQ backoff over hours), not here: "rejected" (4xx — wrong secret or
 * bad receiver) is permanent, "unreachable" (network/5xx) is retryable.
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
