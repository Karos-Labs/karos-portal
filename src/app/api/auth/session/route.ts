import { NextRequest, NextResponse } from "next/server";
import {
  createSession,
  clearSession,
  provisionFromSignup,
  getUserFromToken,
  type SignupIntent,
} from "@/lib/auth";

export async function POST(req: NextRequest) {
  try {
    const { idToken, intent } = (await req.json()) as {
      idToken?: string;
      intent?: SignupIntent;
    };

    if (!idToken) {
      return NextResponse.json({ error: "Missing idToken" }, { status: 400 });
    }

    // Signup: provision user doc first, then create session.
    // Login: look up existing doc first — reject if not found (forces sign-up).
    const user = intent?.requestedRole
      ? await provisionFromSignup(idToken, intent)
      : await getUserFromToken(idToken);

    if (!user) {
      return NextResponse.json(
        { error: "No account found for this email. Please sign up with an invitation key first." },
        { status: 404 },
      );
    }

    await createSession(idToken);

    // Fire-and-forget login audit log — non-blocking, never delays the response.
    if (!user.disabled) {
      const ua = req.headers.get("user-agent")?.slice(0, 200) ?? null;
      void (async () => {
        try {
          const { adminDb } = await import("@/lib/firebase/admin");
          const ref = adminDb().collection("loginLogs").doc();
          await ref.set({ id: ref.id, uid: user.uid, email: user.email, timestamp: Date.now(), userAgent: ua });
        } catch {
          // silent — login log must never block auth
        }
      })();
    }

    return NextResponse.json({
      ok: true,
      role: user?.role ?? null,
      clientId: user?.clientId ?? null,
      disabled: user?.disabled ?? false,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Auth failed";
    return NextResponse.json({ error: message }, { status: 401 });
  }
}

export async function DELETE() {
  await clearSession();
  return NextResponse.json({ ok: true });
}
