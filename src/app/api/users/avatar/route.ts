import { NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/auth";
import { upsertUser, clearUserAvatar } from "@/lib/data";
import { adminAuth } from "@/lib/firebase/admin";
import { uploadBytes } from "@/lib/storage";

export const maxDuration = 60;

const ALLOWED_TYPES = new Set(["image/png", "image/jpeg", "image/jpg", "image/svg+xml", "image/webp"]);
const MAX_BYTES = 4 * 1024 * 1024;

/** Upload/replace the current user's own avatar. Scoped to self — no clientId or role check needed. */
export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user || user.disabled) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

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
  const user = await getCurrentUser();
  if (!user || user.disabled) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!user.photoURL) return NextResponse.json({ ok: true });

  await clearUserAvatar(user.uid);
  // Admin SDK: `undefined` means "leave unchanged"; `null` is what actually clears it.
  await adminAuth().updateUser(user.uid, { photoURL: null }).catch(() => {});

  return NextResponse.json({ ok: true });
}
