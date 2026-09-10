/**
 * Gmail API client — server-side only.
 * Uses a stored OAuth2 access_token to fetch messages via REST.
 * Handles expired tokens by throwing a GmailTokenExpiredError so the
 * caller can mark the integration as expired and prompt the user to
 * reconnect their Google account.
 */

import "server-only";
import type { RawEmail } from "@/lib/ai/prompts/proactive-assistant";

export class GmailTokenExpiredError extends Error {
  /** "expired" = 401 (token revoked/expired); "insufficient_scope" = 403 (scope not granted or Gmail API disabled). */
  readonly reason: "expired" | "insufficient_scope";
  constructor(reason: "expired" | "insufficient_scope" = "expired") {
    super("gmail_token_expired");
    this.name = "GmailTokenExpiredError";
    this.reason = reason;
  }
}

interface GmailListItem {
  id: string;
  threadId: string;
}

interface GmailMessagePayloadHeader {
  name: string;
  value: string;
}

interface GmailMessagePayload {
  headers?: GmailMessagePayloadHeader[];
}

interface GmailMessage {
  id: string;
  snippet?: string;
  payload?: GmailMessagePayload;
  internalDate?: string;
}

function header(payload: GmailMessagePayload | undefined, name: string): string {
  return (
    payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? ""
  );
}

function formatDate(internalDate?: string): string {
  if (!internalDate) return "";
  const ms = parseInt(internalDate, 10);
  if (isNaN(ms)) return "";
  return new Date(ms).toISOString().slice(0, 10);
}

async function gmailFetch(path: string, accessToken: string): Promise<unknown> {
  const res = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me${path}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    cache: "no-store",
  });
  if (res.status === 401) throw new GmailTokenExpiredError("expired");
  // 403 means the token is valid but lacks gmail.readonly, or the Gmail API
  // isn't enabled in the Google Cloud project — different from an expired token.
  if (res.status === 403) throw new GmailTokenExpiredError("insufficient_scope");
  if (!res.ok) throw new Error(`Gmail API error ${res.status}`);
  return res.json();
}

/**
 * Fetch the last `maxResults` unread business emails.
 * Returns structured RawEmail objects for AI processing.
 */
export async function fetchGmailMessages(
  accessToken: string,
  maxResults = 15,
): Promise<RawEmail[]> {
  // Query: unread, not promotional/social tabs — focus on primary inbox
  const query = encodeURIComponent(
    "is:unread category:primary -from:noreply -from:no-reply",
  );
  const listData = (await gmailFetch(
    `/messages?q=${query}&maxResults=${maxResults}`,
    accessToken,
  )) as { messages?: GmailListItem[] };

  const items = listData.messages ?? [];
  if (items.length === 0) return [];

  // Fetch full message headers in parallel (metadata only to keep payloads small)
  const messages = await Promise.allSettled(
    items.map((item) =>
      gmailFetch(`/messages/${item.id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date`, accessToken),
    ),
  );

  const result: RawEmail[] = [];
  for (const settled of messages) {
    if (settled.status !== "fulfilled") continue;
    const msg = settled.value as GmailMessage;
    const subject = header(msg.payload, "Subject") || "(no subject)";
    const from = header(msg.payload, "From") || "Unknown";
    const date = header(msg.payload, "Date") || formatDate(msg.internalDate);
    const snippet = msg.snippet?.replace(/\n/g, " ").slice(0, 300) ?? "";
    result.push({ subject, from, date, snippet });
  }
  return result;
}
