import { getCurrentUser } from "@/lib/auth";
import { trackUserAction } from "@/lib/telemetry/bi-tracker";

export const runtime = "nodejs";

const MAX_METADATA_KEYS = 20;

/**
 * Generic BI click/UI-event sink for client components. Server actions cover
 * approvals and other mutations already; this exists for events that don't
 * otherwise touch the server (nav clicks, tab switches, filter changes).
 * BigQuery writes need Admin credentials, so this is a thin authenticated
 * relay rather than a direct client insert.
 */
export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user || user.disabled) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: { eventName?: string; surface?: string; targetId?: string; metadata?: Record<string, unknown> };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!body.eventName || !body.surface) {
    return Response.json({ error: "eventName and surface are required" }, { status: 400 });
  }

  const metadata =
    body.metadata && typeof body.metadata === "object"
      ? Object.fromEntries(Object.entries(body.metadata).slice(0, MAX_METADATA_KEYS))
      : undefined;

  trackUserAction({
    clientId: user.clientId ?? null,
    userId: user.uid,
    eventName: body.eventName,
    surface: body.surface,
    targetId: body.targetId ?? null,
    metadata,
  });

  return Response.json({ ok: true });
}
