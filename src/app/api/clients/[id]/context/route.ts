import { NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/auth";
import { getClient, createContextItem } from "@/lib/data";
import { uploadBytes } from "@/lib/storage";
import { contextKind } from "@/lib/context";

export const maxDuration = 60;

const MAX_BYTES = 4 * 1024 * 1024; // 4 MB (Vercel request-body limit)

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user || user.disabled) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (user.role === "client") return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { id: clientId } = await params;
  const client = await getClient(clientId);
  if (!client) return NextResponse.json({ error: "Client not found" }, { status: 404 });

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
