import { buildSignatureHeaders } from "./sign.js";
import type { WebhookPayload } from "../types.js";

const RETRY_DELAYS_MS = [1000, 5000, 25000];

export async function deliverWebhook(
  secret: string,
  callbackUrl: string,
  payload: WebhookPayload,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  const rawBody = JSON.stringify(payload);
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
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
      if (response.ok) return true;
      if (response.status >= 400 && response.status < 500) return false;
    } catch {
      // network error → retry
    }
    const delay = RETRY_DELAYS_MS[attempt];
    if (delay !== undefined) await new Promise((r) => setTimeout(r, delay));
  }
  return false;
}
