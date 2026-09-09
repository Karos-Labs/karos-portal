import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { canViewClient } from "@/lib/client-visibility";
import { getClient } from "@/lib/data";
import { createUploadSignedUrl } from "@/lib/gcs-media";

/**
 * Signed upload URLs for media a person attaches to one agent run.
 *
 * ## Why signed URLs rather than posting the file here
 *
 * The same reason `bulk-upload-clips` uses them: the file goes browser →
 * GCS directly, so a 10 MB photo never traverses this server and no route has
 * to hold it in memory. `createUploadSignedUrl` already existed for exactly
 * this; this route only decides *where* a run attachment is allowed to land and
 * *who* may put one there.
 *
 * ## Why it returns a gs:// URI and not a signed read URL
 *
 * The engine reads the object with its own service account through
 * `media.ingestAssets`. A signed read URL would work today and expire later,
 * which is the wrong failure mode for something a run record points at: a
 * resumed or replayed run days afterwards would find a dead link. A `gs://`
 * URI stays valid for as long as the object does.
 */

/** Images and short video only. A run attachment is a slide asset, not an arbitrary file drop. */
const ALLOWED_CONTENT_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "video/mp4",
  "video/quicktime",
]);

function sanitize(filename: string): string {
  const cleaned = filename.trim().replace(/[^a-zA-Z0-9._-]+/g, "-");
  return cleaned.length > 0 ? cleaned.slice(0, 120) : "attachment";
}

export async function POST(request: Request): Promise<Response> {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Not signed in." }, { status: 401 });

  let body: { clientId?: unknown; filename?: unknown; contentType?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Expected a JSON body." }, { status: 400 });
  }

  const clientId = typeof body.clientId === "string" ? body.clientId.trim() : "";
  const filename = typeof body.filename === "string" ? body.filename.trim() : "";
  const contentType = typeof body.contentType === "string" ? body.contentType.trim() : "";

  if (!clientId || !filename || !contentType) {
    return NextResponse.json({ error: "clientId, filename and contentType are all required." }, { status: 400 });
  }
  if (!ALLOWED_CONTENT_TYPES.has(contentType)) {
    return NextResponse.json(
      { error: `Unsupported type "${contentType}". Attach a JPEG, PNG, WebP, MP4 or MOV.` },
      { status: 415 },
    );
  }

  // Tenancy: the same check every other client-scoped route makes. Without it
  // a signed URL would be a write handle into any client's media prefix for
  // anyone who could guess an id.
  const client = await getClient(clientId);
  if (!client || !(await canViewClient(user, client))) {
    return NextResponse.json({ error: "No such client, or you cannot access it." }, { status: 404 });
  }

  // A prefix of its own, so a run attachment is never confused with a
  // deliverable the engine wrote or a clip staff bulk-uploaded.
  const objectPath = `clients/${clientId}/run-attachments/${Date.now()}-${sanitize(filename)}`;

  try {
    const uploadUrl = await createUploadSignedUrl({ gcsPath: objectPath, contentType });
    const bucket = process.env.GCS_MEDIA_BUCKET;
    return NextResponse.json({ uploadUrl, uri: `gs://${bucket}/${objectPath}`, contentType });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not create an upload URL." },
      { status: 500 },
    );
  }
}
