import { NextResponse } from "next/server";
import { authorizeAssetMedia, resolveAssetVideo } from "@/lib/asset-media";

export const runtime = "nodejs";

/**
 * Playback source for an asset's clip: authorize the caller, re-sign the object
 * from `meta.gcsPath`, and redirect to a URL that is valid right now.
 *
 * A bulk-uploaded clip's stored `videoUrl` is a V4 signed URL with a 7-day TTL
 * that nothing ever refreshes, while `bulkScheduleClipsAction` spreads the
 * batch one clip per day across weeks — so by the day a client was shown a
 * clip, its URL had usually expired and the player simply never loaded. Every
 * `<video>` in the product points here instead, so the URL it follows is minted
 * for that request. The browser does still end up holding a signed bucket URL
 * (it is the redirect target), but it is one this request minted, not the
 * long-dead one sitting in Firestore.
 *
 * A redirect rather than a proxy: the bytes go browser↔GCS directly, which
 * keeps range requests, seeking and 2 GB clips off this server — and off Cloud
 * Run's request timeout (`--timeout=300` in cloudbuild.yaml).
 */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const access = await authorizeAssetMedia(id);
  if (!access.ok) return access.response;

  const asked = Number.parseInt(new URL(req.url).searchParams.get("i") ?? "0", 10);
  const index = Number.isInteger(asked) && asked > 0 ? asked : 0;
  const source = await resolveAssetVideo(access.asset, index);
  if (!source) {
    return NextResponse.json({ error: "This asset has no video" }, { status: 404 });
  }

  // Never cached: the URL behind this redirect is short-lived by design, and a
  // cached redirect would hand a client an expired link all over again.
  return new NextResponse(null, {
    status: 302,
    headers: { Location: source.url, "Cache-Control": "private, no-store" },
  });
}
