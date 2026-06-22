import { NextRequest, NextResponse } from "next/server";
import { fetchFirefliesTranscript } from "@/lib/transcripts/fireflies";
import { ingestTranscript } from "@/lib/transcripts/ingest";

export const maxDuration = 120;

/**
 * Fireflies webhook receiver.
 *
 * Fireflies POSTs { meetingId, eventType } when a meeting finishes processing.
 * We fetch the full transcript via the Fireflies API, summarise it, auto-route it
 * to the matching client by attendee email domain, and store it.
 *
 * Secure it by setting FIREFLIES_WEBHOOK_SECRET and configuring the webhook URL as
 *   /api/ingest/fireflies?secret=YOUR_SECRET
 */
export async function POST(req: NextRequest) {
  const secret = process.env.FIREFLIES_WEBHOOK_SECRET;
  if (secret) {
    const provided = req.nextUrl.searchParams.get("secret") || req.headers.get("x-webhook-secret");
    if (provided !== secret) {
      return NextResponse.json({ error: "Invalid secret" }, { status: 401 });
    }
  }

  let body: Record<string, unknown> = {};
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const meetingId = (body.meetingId || body.transcriptId || body.id) as string | undefined;
  if (!meetingId) {
    return NextResponse.json({ error: "Missing meetingId" }, { status: 400 });
  }

  try {
    const transcript = await fetchFirefliesTranscript(meetingId);
    if (!transcript) {
      return NextResponse.json({ error: "Transcript not found" }, { status: 404 });
    }
    const result = await ingestTranscript(transcript, "fireflies");
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Ingestion failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

// Lightweight health check / webhook verification.
export async function GET() {
  return NextResponse.json({ ok: true, service: "fireflies-ingest" });
}
