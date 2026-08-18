import { NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/auth";
import { getClient, updateClient } from "@/lib/data";
import { canViewClient } from "@/lib/client-visibility";
import { uploadBytes, deleteObject } from "@/lib/storage";

export const maxDuration = 60;

const ALLOWED_TYPES = new Set(["image/png", "image/jpeg", "image/jpg", "image/svg+xml"]);
const MAX_BYTES = 4 * 1024 * 1024;

/**
 * SCOPED TO WHOEVER MAY VIEW THE CLIENT, on BOTH handlers. `requireStaff`-
 * equivalent role tests only ever asked "not a client user", so an employee
 * 404'd on /clients/[id] could replace or delete any client's logo — and
 * DELETE also unlinks the previous file from Storage, so the damage outlived
 * the request. Both now ask the predicate the pages ask, unconditionally, and
 * refuse with the "Client not found" shape both already return for a missing
 * client. Repeated per handler rather than lifted into a local helper — see
 * the note in ../context/route.ts for why the tripwire needs it that way.
 *
 * CLIENT_USER is admitted too (portal revamp, Account Center Profile tab —
 * "company picture"): `canViewClient`'s CLIENT_USER branch only ever returns
 * true for `user.clientId === client.id`, so this is a client managing their
 * own logo, not the cross-client escalation the comment above describes — that
 * incident was staff reaching an unassigned client, which this fence still
 * refuses exactly as before.
 */

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user || user.disabled) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id: clientId } = await params;
  const client = await getClient(clientId);
  if (!client || !canViewClient(user, client)) {
    return NextResponse.json({ error: "Client not found" }, { status: 404 });
  }

  const form = await req.formData();
  const file = form.get("file");

  if (!(file instanceof File)) return NextResponse.json({ error: "No file provided" }, { status: 400 });
  if (file.size === 0) return NextResponse.json({ error: "Empty file" }, { status: 400 });
  if (file.size > MAX_BYTES) return NextResponse.json({ error: "File exceeds 4 MB" }, { status: 413 });

  const rawMime = file.type || "image/png";
  const mimeType = rawMime === "image/jpg" ? "image/jpeg" : rawMime;
  if (!ALLOWED_TYPES.has(mimeType)) {
    return NextResponse.json({ error: "Only PNG, JPEG, and SVG files are accepted" }, { status: 415 });
  }

  const bytes = Buffer.from(await file.arrayBuffer());
  const safeName = file.name.replace(/[^\w.\-]+/g, "_").slice(0, 80) || "logo";
  const path = `clients/${clientId}/logos/${crypto.randomUUID()}-${safeName}`;

  // Delete previous logo from storage (soft-fail)
  if (client.logoStoragePath) await deleteObject(client.logoStoragePath).catch(() => {});

  const { url } = await uploadBytes({ bytes, path, contentType: mimeType });

  await updateClient(clientId, { logoUrl: url, logoStoragePath: path });

  return NextResponse.json({ url, path });
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user || user.disabled) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id: clientId } = await params;
  const client = await getClient(clientId);
  if (!client || !canViewClient(user, client)) {
    return NextResponse.json({ error: "Client not found" }, { status: 404 });
  }

  if (!client.logoUrl) return NextResponse.json({ ok: true });

  if (client.logoStoragePath) await deleteObject(client.logoStoragePath).catch(() => {});

  await updateClient(clientId, { logoUrl: undefined, logoStoragePath: undefined });

  return NextResponse.json({ ok: true });
}
