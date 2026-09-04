import { NextResponse } from "next/server";
import { authorizeAssetMedia } from "@/lib/asset-media";
import { getClientLibraryAssets } from "@/lib/asset-visibility";

export const runtime = "nodejs";

/**
 * One asset, for a surface that holds an asset ID but not the asset.
 *
 * WHY THIS EXISTS AT ALL (flow audit 2026-09, R12). `AssetDetailModal` is the
 * product's one deliverable viewer and it has eight openers — every one of them
 * a page that already fetched the asset server-side and handed the object down.
 * The copilot dock is the exception: it is mounted in the (app) layout with a
 * `clientId` and nothing else, and its tools name an asset by id in the chat
 * stream. Without this the chip that the audit asks for could only be a link
 * back out to the archive LIST, which is the dead end being fixed.
 *
 * IT ADDS NO REACH. `authorizeAssetMedia` is the same gate the download and
 * media routes use — staff see the clients they are assigned, a client sees
 * only its own client's assets, and a future-dated post is withheld from a
 * client entirely — and the body is then put through `getClientLibraryAssets`'s
 * client redaction, exactly as the calendar and the archive do before rendering
 * one. What comes back is what that reader could already open two clicks away.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const access = await authorizeAssetMedia(id);
  if (!access.ok) return access.response;

  // The user comes back FROM the gate rather than being resolved a second time:
  // `authorizeAssetMedia` already read the session cookie to refuse an
  // unauthenticated caller, so a second `getCurrentUser()` here was a redundant
  // auth round-trip on every open — and it came back optional, which forced a
  // `user ? …` on a value the gate has already proved is present. This is only
  // asking WHICH register the body is written in.
  const { user } = access;
  const isClient = user.role === "CLIENT_USER";
  const [asset] = getClientLibraryAssets([access.asset], {
    forClient: isClient,
    viewer: { role: user.role, seatId: user.seatId, isGroupAdmin: user.isGroupAdmin },
  });

  // The redaction layer can DROP an asset outright (a personal-content post
  // belonging to another seat), which is a "you cannot see this", not an empty
  // success — and the same 404 the gate above uses, so the two refusals are
  // indistinguishable from outside.
  if (!asset) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // `viewerIsClient` rides along because the one consumer — the copilot dock —
  // is mounted by both shells from a layout that hands it a clientId and
  // nothing else, and `AssetDetailModal` needs to know whose vocabulary to
  // speak. Answered by the server, which already had to decide it to redact the
  // body, rather than by a component prop that could be defaulted wrong: a
  // defaulted viewer flag is the cheapest way to lose a disclosure rule
  // (archive-view.tsx makes the same argument about its own).
  return NextResponse.json({ asset, viewerIsClient: isClient });
}
