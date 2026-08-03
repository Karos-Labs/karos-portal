import { NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/auth";
import { createContextItem, getClient, listContextItems } from "@/lib/data";
import { canViewClient } from "@/lib/client-visibility";
import { uploadBytes } from "@/lib/storage";
import { contextKind } from "@/lib/context";

export const maxDuration = 60;

const MAX_BYTES = 4 * 1024 * 1024; // 4 MB self-imposed cap on a context item

/**
 * STAFF SCOPE, on BOTH handlers — a read fence that leaves the write open is not
 * a fence, and this file exports two handlers.
 *
 * Each one's only role test was a CLIENT_USER branch, so an employee 404'd on
 * /clients/[id] could list any client's context items through GET and attach a
 * file to any client through POST. Both now ask the predicate the pages ask,
 * UNCONDITIONALLY rather than under `role === "KAROS_EMPLOYEE"`: admins and (on
 * GET) a client on their own account already pass it, and an unknown role must
 * not. The refusal reuses the "Client not found" shape both handlers already
 * return for a missing client, so it does not confirm the client exists.
 *
 * Written out at each handler rather than lifted into a local helper on purpose:
 * the tripwire in `client-api-access-guard.test.ts` counts `canViewClient(` calls
 * against the exported handlers it finds on disk, so a file that hides the call
 * behind a helper can add a third unfenced handler and still pass. The RULE has
 * one home (`canViewClient`); the two lines repeated here are the refusal shape,
 * which is per-route by design.
 */

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user || user.disabled) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id: clientId } = await params;
  if (user.role === "CLIENT_USER" && user.clientId !== clientId) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const client = await getClient(clientId);
  if (!client || !canViewClient(user, client)) {
    return NextResponse.json({ error: "Client not found" }, { status: 404 });
  }

  const items = await listContextItems({ clientId });
  return NextResponse.json({
    items: items.map((item) => ({
      id: item.id,
      clientId: item.clientId,
      kind: item.kind,
      name: item.name,
      mimeType: item.mimeType,
      sizeBytes: item.sizeBytes,
      url: item.url,
      ...(item.note ? { note: item.note } : {}),
      ...(item.purpose ? { purpose: item.purpose } : {}),
      createdAt: item.createdAt,
      // Preserve the ContextItem client shape without exposing internal object
      // paths or uploader identities through this picker endpoint.
      storagePath: "",
      createdBy: "",
    })),
  });
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user || user.disabled) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (user.role === "CLIENT_USER") return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { id: clientId } = await params;
  const client = await getClient(clientId);
  if (!client || !canViewClient(user, client)) {
    return NextResponse.json({ error: "Client not found" }, { status: 404 });
  }

  const form = await req.formData();
  const file = form.get("file");
  const note = (form.get("note") as string | null)?.trim() || undefined;
  const rawPurpose = (form.get("purpose") as string | null)?.trim();
  const purpose =
    rawPurpose === "newsletter_reference" || rawPurpose === "image_pool" ? rawPurpose : undefined;

  if (!(file instanceof File)) return NextResponse.json({ error: "No file provided" }, { status: 400 });
  if (file.size === 0) return NextResponse.json({ error: "Empty file" }, { status: 400 });
  if (file.size > MAX_BYTES) {
    return NextResponse.json({ error: "File is larger than 4 MB" }, { status: 413 });
  }

  const mimeType = file.type || "application/octet-stream";
  const bytes = Buffer.from(await file.arrayBuffer());
  const safeName = file.name.replace(/[^\w.\-]+/g, "_").slice(0, 80) || "file";
  const path = `clients/${clientId}/context/${crypto.randomUUID()}-${safeName}`;

  const { url, path: storagePath } = await uploadBytes({ bytes, path, contentType: mimeType });

  const itemId = await createContextItem({
    clientId,
    kind: contextKind(mimeType),
    name: file.name,
    mimeType,
    sizeBytes: file.size,
    storagePath,
    url,
    note,
    ...(purpose ? { purpose } : {}),
    createdBy: user.uid,
    createdAt: Date.now(),
  });

  return NextResponse.json({ id: itemId, url, name: file.name });
}
