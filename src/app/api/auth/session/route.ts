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

    await createSession(idToken);

    // Signup: provision the user doc with the validated invitation key.
    // Login: fetch the existing doc for role-based routing.
    const user = intent?.requestedRole
      ? await provisionFromSignup(idToken, intent)
      : await getUserFromToken(idToken);

    // Fire-and-forget login audit log — non-blocking, never delays the response.
    if (user && !user.disabled) {
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
