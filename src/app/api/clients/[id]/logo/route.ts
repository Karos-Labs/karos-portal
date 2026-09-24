import { NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/auth";
import { clearClientLogo, getClient, updateClient } from "@/lib/data";
import { canViewClient } from "@/lib/client-visibility";
import { uploadBytes, deleteObject } from "@/lib/storage";
import { checkBrandLogoFile } from "@/lib/brand-logo-file";
import { projectClientOnSaveInBackground } from "@/lib/agent-engine/project-on-save";

export const maxDuration = 60;

/*
 * The type and size rules live in `@/lib/brand-logo-file` (shared with the
 * upload controls) and are agent-engine's own: a 4,000,000-byte cap and
 * SVG/PNG/JPEG/WebP. See that module for why the old 4 MiB cap was a logo
 * that uploaded here and never appeared on a post.
 *
 * BOTH handlers re-project the client into the engine workspace afterwards,
 * because `client/brand.json`'s `logoUrl` is where every post reads the logo
 * from (see `engineBrandLogoUrl`). Background, like every other save: the
 * dispatch-time projection is the correctness guarantee, this makes the new
 * logo visible before the next run rather than only during it.
 */

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
  const check = checkBrandLogoFile(file);
  if (!check.ok) return NextResponse.json({ error: check.error }, { status: check.status });
  const mimeType = check.contentType;

  const bytes = Buffer.from(await file.arrayBuffer());
  const safeName = file.name.replace(/[^\w.\-]+/g, "_").slice(0, 80) || "logo";
  const path = `clients/${clientId}/logos/${crypto.randomUUID()}-${safeName}`;

  const { url } = await uploadBytes({ bytes, path, contentType: mimeType });

  await updateClient(clientId, { logoUrl: url, logoStoragePath: path });
  projectClientOnSaveInBackground(clientId, "logo-uploaded");

  // The previous file goes only AFTER the new one is stored and recorded (soft-
  // fail). It used to be deleted first, so an upload that then failed left the
  // record — and the engine's brand.json — pointing at a file that was gone.
  if (client.logoStoragePath && client.logoStoragePath !== path) {
    await deleteObject(client.logoStoragePath).catch(() => {});
  }

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

  await clearClientLogo(clientId);
  projectClientOnSaveInBackground(clientId, "logo-removed");

  return NextResponse.json({ ok: true });
}
