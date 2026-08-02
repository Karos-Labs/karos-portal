import { NextResponse } from "next/server";

import { ownAccountSession } from "@/lib/actions/_shared";
import { upsertUser, clearUserAvatar } from "@/lib/data";
import { adminAuth } from "@/lib/firebase/admin";
import { uploadBytes } from "@/lib/storage";

export const maxDuration = 60;

const ALLOWED_TYPES = new Set(["image/png", "image/jpeg", "image/jpg", "image/svg+xml", "image/webp"]);
const MAX_BYTES = 4 * 1024 * 1024;

/**
 * Upload/replace the current user's own avatar.
 *
 * Scoped to self, which is why no clientId or role check appears here — and why
 * the session has to actually BE its own subject. This comment used to end at
 * "no clientId or role check needed", and under "View as Client" the subject is
 * the client: an admin could replace their photo in Firestore AND on their
 * Firebase Auth record, leaving no trace of who did it. `ownAccountSession` is
 * the whole of that check; see IMPERSONATED_SELF_WRITE_MESSAGE for the rule.
 */
export async function POST(req: Request) {
  const session = await ownAccountSession();
  if (!session.ok) {
    return NextResponse.json({ error: session.error }, { status: session.status });
  }
  const { user } = session;

  const form = await req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) return NextResponse.json({ error: "No file provided" }, { status: 400 });
  if (file.size === 0) return NextResponse.json({ error: "Empty file" }, { status: 400 });
  if (file.size > MAX_BYTES) return NextResponse.json({ error: "File exceeds 4 MB" }, { status: 413 });

  const rawMime = file.type || "image/png";
  const mimeType = rawMime === "image/jpg" ? "image/jpeg" : rawMime;
  if (!ALLOWED_TYPES.has(mimeType)) {
    return NextResponse.json({ error: "Only PNG, JPEG, WEBP, and SVG files are accepted" }, { status: 415 });
  }

  const bytes = Buffer.from(await file.arrayBuffer());
  const path = `users/${user.uid}/avatar/${crypto.randomUUID()}`;
  const { url } = await uploadBytes({ bytes, path, contentType: mimeType });

  await upsertUser({ ...user, photoURL: url });
  await adminAuth().updateUser(user.uid, { photoURL: url }).catch(() => {});

  return NextResponse.json({ url });
}

export async function DELETE() {
  // Both handlers, for the reason the sibling `/api/clients/[id]/context` note
  // gives: a guard on the upload that leaves the delete open is not a guard,
  // and clearing the photo is the half that destroys something.
  const session = await ownAccountSession();
  if (!session.ok) {
    return NextResponse.json({ error: session.error }, { status: session.status });
  }
  const { user } = session;
  if (!user.photoURL) return NextResponse.json({ ok: true });

  await clearUserAvatar(user.uid);
  // Admin SDK: `undefined` means "leave unchanged"; `null` is what actually clears it.
  await adminAuth().updateUser(user.uid, { photoURL: null }).catch(() => {});

  return NextResponse.json({ ok: true });
}
