import { NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/auth";
import { upsertUser, updateEmployeeSeat, clearUserResume } from "@/lib/data";
import { uploadBytes } from "@/lib/storage";

export const maxDuration = 60;

const ALLOWED_TYPES = new Set([
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "text/plain",
]);
const MAX_BYTES = 8 * 1024 * 1024;

/**
 * Upload/replace the current user's own resume/CV. Scoped to self. Mirrors the URL
 * onto the user's primary employee seat (best-effort) so the advocacy LLM voice
 * picks up the new resume immediately, without requiring a separate settings visit.
 */
export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user || user.disabled) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const form = await req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) return NextResponse.json({ error: "No file provided" }, { status: 400 });
  if (file.size === 0) return NextResponse.json({ error: "Empty file" }, { status: 400 });
  if (file.size > MAX_BYTES) return NextResponse.json({ error: "File exceeds 8 MB" }, { status: 413 });

  const mimeType = file.type || "application/octet-stream";
  if (!ALLOWED_TYPES.has(mimeType)) {
    return NextResponse.json({ error: "Only PDF, DOC, DOCX, or TXT files are accepted" }, { status: 415 });
  }

  const bytes = Buffer.from(await file.arrayBuffer());
  const safeName = file.name.replace(/[^\w.\-]+/g, "_").slice(0, 80) || "resume";
  const path = `users/${user.uid}/resume/${crypto.randomUUID()}-${safeName}`;
  const { url } = await uploadBytes({ bytes, path, contentType: mimeType });

  await upsertUser({ ...user, resumeUrl: url });
  if (user.clientId && user.primarySeatId) {
    await updateEmployeeSeat(user.clientId, user.primarySeatId, { resumeUrl: url }).catch(() => {});
  }

  return NextResponse.json({ url });
}

export async function DELETE() {
  const user = await getCurrentUser();
  if (!user || user.disabled) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!user.resumeUrl) return NextResponse.json({ ok: true });

  await clearUserResume(user.uid);
  if (user.clientId && user.primarySeatId) {
    await updateEmployeeSeat(user.clientId, user.primarySeatId, { resumeUrl: null }).catch(() => {});
  }

  return NextResponse.json({ ok: true });
}
