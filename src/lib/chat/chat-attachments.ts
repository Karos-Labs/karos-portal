import "server-only";

/**
 * T-B5: turns a chat turn's uploaded files into validated MediaAsset-shaped
 * objects, and nothing else.
 *
 * Before this ticket there was no file input in the copilot chat at all — the
 * only way to get a `gs://` URI into an agent-engine run was the run dialog's
 * own `mediaAssets` field (custom-agent-launch.ts's `withEngineRunFields`), a
 * raw-JSON textarea a human had to hand-author
 * (`'[{"uri": "gs://bucket/episode.mp4", "role": "source"}]'`), and that
 * dialog is staff/admin-only. This module is the server-side half of a REAL
 * upload surface for chat: chatbot-widget.tsx's `RunAttachments` control
 * (mode `"chat"`) uploads browser → GCS directly through the existing
 * signed-URL route (`/api/agent-engine/run-media`, already used by the
 * admin-facing engine-agent-card.tsx) and sends the resulting
 * `{ uri, role, contentType?, label? }` objects on the chat request's
 * `attachments` field. `parseChatAttachments` is what the route calls to turn
 * that untrusted JSON back into the objects `run_agent_now` folds into
 * `briefValues.mediaAssets` (chat/route.ts).
 *
 * ## Tenancy, not just shape
 *
 * A prior version of this module validated only URI SCHEME (`gs://` or
 * `https://`), role, and length — nothing tied a `gs://` URI back to the
 * client making the request, or the object the upload route actually just
 * wrote for them. That was fine as long as this capability was staff-only
 * (the run dialog's textarea): a staff member can already see and choose any
 * client's media. It stopped being fine the moment this field became reachable
 * by a plain `CLIENT_USER` (this ticket) — a scheme check alone lets a client
 * hand back `gs://<our-bucket>/clients/<some-other-client>/...` (an object
 * they never uploaded and have no right to reference) or an arbitrary
 * external `https://` URL, and have it injected as "source media for this
 * run" with zero LLM cooperation required, since `run_agent_now`'s executor
 * builds `briefValues.mediaAssets` straight from this parsed array.
 *
 * The fix is to validate that too, not just the scheme: `requireClientId` is
 * mandatory, and every accepted `gs://` URI MUST fall under
 * `gs://<GCS_MEDIA_BUCKET>/clients/<requireClientId>/run-attachments/` — the
 * EXACT prefix `/api/agent-engine/run-media` mints signed upload URLs under
 * for this same client (see that route's own tenancy check,
 * `canViewClient`). An object outside that prefix cannot have come from this
 * client's own upload flow for this run, so it is dropped, not forwarded.
 *
 * `https://` is no longer accepted here at all. Nothing in the real upload
 * flow this ticket builds ever produces one (the signed-URL route always
 * returns a `gs://` URI — see its own "why it returns a gs:// URI" note) and
 * there is no scoped way to prove a client-supplied `https://` URL is
 * something they own or should be allowed to fetch into a run — allowing it
 * was carrying over the run dialog's own broad, staff-only allowance into a
 * surface serving a much less trusted actor. The run dialog's textarea (still
 * staff-only, unaffected by this change) keeps accepting `https://` — see
 * `parseMediaAssets`, agent-engine/product-mapping.ts.
 */
import { MEDIA_ROLES } from "@/lib/agent-engine/product-mapping";

export type ChatAttachmentRole = "source" | "reference" | "logo" | "overlay";

export interface ChatAttachment {
  uri: string;
  role: ChatAttachmentRole;
  contentType?: string;
  label?: string;
}

/**
 * A chat turn carries at most this many attachments. Matches the upload
 * control's own cap (`run-attachments.tsx`'s `"chat"` mode) — this is the
 * server-side backstop for a client that ignores it, not the primary limit
 * (that one is UX: refusing more uploads before they cost anything).
 */
export const MAX_CHAT_ATTACHMENTS = 4;

/** Same ceiling `parseMediaAssets` implicitly gets from a JSON body size limit — no single field should carry an unbounded string. */
const MAX_STRING_FIELD_CHARS = 2048;

/**
 * The exact object-key prefix `/api/agent-engine/run-media` mints a signed
 * upload URL under for one client (see that route's `objectPath`). Building
 * the allowed URI prefix from the SAME literal (`clients/<id>/run-attachments/`)
 * rather than a copy of it means a future rename of that prefix fails loudly
 * here too, instead of quietly reopening the tenancy hole this function
 * exists to close.
 */
function allowedGcsPrefix(clientId: string, bucket: string): string {
  return `gs://${bucket}/clients/${clientId}/run-attachments/`;
}

/**
 * Validates and normalizes an `attachments` request-body field into the
 * `MediaAsset`-shaped objects `run_agent_now` can safely forward, SCOPED TO
 * `clientId` — the client the chat request is already authorized for
 * (chat/route.ts's own `canViewClient` gate runs before this is ever called,
 * so `clientId` here is trustworthy even though `raw` is not).
 *
 * Not `Array.isArray` alone: every element is checked independently, so one
 * malformed or out-of-tenant entry in an otherwise-valid array drops just
 * that entry rather than the whole turn's attachments — the same "drop at
 * the boundary, not an engine-side surprise" rule `parseMediaAssets` states
 * for its own JSON-string variant of the identical check.
 *
 * Returns an empty array (accepting nothing) when `GCS_MEDIA_BUCKET` is
 * unset, rather than falling back to a laxer check — an unconfigured bucket
 * name means there is no prefix this function can verify against, and
 * accepting-by-default in that state is exactly the failure mode this
 * function exists to avoid.
 */
export function parseChatAttachments(raw: unknown, clientId: string): ChatAttachment[] {
  if (!clientId || !Array.isArray(raw)) return [];

  const bucket = process.env.GCS_MEDIA_BUCKET;
  if (!bucket) return [];
  const prefix = allowedGcsPrefix(clientId, bucket);

  const out: ChatAttachment[] = [];
  for (const candidate of raw) {
    if (out.length >= MAX_CHAT_ATTACHMENTS) break;
    if (typeof candidate !== "object" || candidate === null) continue;

    const entry = candidate as Record<string, unknown>;
    const uri = typeof entry.uri === "string" ? entry.uri.trim() : "";
    if (!uri || uri.length > MAX_STRING_FIELD_CHARS) continue;
    // Tenancy, not just scheme: this must be an object this client's OWN
    // upload just wrote, not any `gs://` path in the bucket and not an
    // arbitrary `https://` URL (see the module header for why `https://` is
    // rejected outright here rather than allowlisted by host).
    if (!uri.startsWith(prefix)) continue;

    const role: ChatAttachmentRole =
      typeof entry.role === "string" && MEDIA_ROLES.has(entry.role) ? (entry.role as ChatAttachmentRole) : "source";

    const contentType =
      typeof entry.contentType === "string" && entry.contentType.trim()
        ? entry.contentType.trim().slice(0, 200)
        : undefined;
    const label =
      typeof entry.label === "string" && entry.label.trim() ? entry.label.trim().slice(0, 200) : undefined;

    out.push({
      uri,
      role,
      ...(contentType ? { contentType } : {}),
      ...(label ? { label } : {}),
    });
  }
  return out;
}
