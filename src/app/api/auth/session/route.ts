import { NextRequest, NextResponse } from "next/server";
import {
  createSession,
  clearSession,
  provisionFromSignup,
  getUserFromToken,
  verifyIdToken,
  isEmailUnverified,
  type SignupIntent,
} from "@/lib/auth";
import { trackUserAction } from "@/lib/telemetry/bi-tracker";

export async function POST(req: NextRequest) {
  try {
    const { idToken, intent } = (await req.json()) as {
      idToken?: string;
      intent?: SignupIntent;
    };

    if (!idToken) {
      return NextResponse.json({ error: "Missing idToken" }, { status: 400 });
    }

    const decoded = await verifyIdToken(idToken);
    const isSignup = !!intent?.requestedRole;

    // Signup: provision the user doc first (so a later post-verification login
    // finds it), then create the session. Login: look up the existing doc —
    // reject if not found (forces sign-up).
    const user = isSignup
      ? await provisionFromSignup(decoded, intent!)
      : await getUserFromToken(decoded);

    if (!user) {
      return NextResponse.json(
        { error: "No account found for this email. Please sign up with an invitation key first." },
        { status: 404 },
      );
    }

    // Mandatory email verification: a native email/password account that hasn't
    // verified its address gets NO session cookie and cannot reach the workspace.
    // Social logins and admin-created accounts (emailVerified: true) sail through.
    if (isEmailUnverified(decoded)) {
      return NextResponse.json(
        {
          needsEmailVerification: true,
          error: isSignup
            ? "Verify your email to finish setting up your account."
            : "Please verify your email before logging in.",
        },
        { status: 403 },
      );
    }

    // Derive whether the request arrived over HTTPS so we set the Secure
    // cookie flag only when the transport actually supports it. Checking the
    // forwarded proto handles deployments behind a TLS-terminating proxy.
    const proto = req.headers.get("x-forwarded-proto") ?? req.nextUrl.protocol.replace(":", "");
    const isSecure = proto === "https";
    await createSession(idToken, isSecure);

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
      trackUserAction({
        clientId: user.clientId ?? null,
        userId: user.uid,
        eventName: "login",
        surface: "auth",
      });
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
