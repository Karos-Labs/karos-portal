import { NextRequest, NextResponse } from "next/server";
import { createSession, clearSession, provisionFromSignup, type SignupIntent } from "@/lib/auth";

export async function POST(req: NextRequest) {
  try {
    const { idToken, intent } = (await req.json()) as { idToken?: string; intent?: SignupIntent };
    if (!idToken) {
      return NextResponse.json({ error: "Missing idToken" }, { status: 400 });
    }
    await createSession(idToken);
    // On signup the client passes the chosen role / company so we can record it before the
    // first page load. Ignored for an already-provisioned user (e.g. signing back in).
    if (intent?.requestedRole) {
      await provisionFromSignup(idToken, {
        requestedRole: intent.requestedRole === "client" ? "client" : "employee",
        clientName: intent.clientName,
      });
    }
    return NextResponse.json({ ok: true });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Auth failed";
    return NextResponse.json({ error: message }, { status: 401 });
  }
}

export async function DELETE() {
  await clearSession();
  return NextResponse.json({ ok: true });
}
