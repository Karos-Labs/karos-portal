"use client";

import { useState } from "react";
import Link from "next/link";
import {
  signInWithEmailAndPassword,
  signInWithPopup,
  sendEmailVerification,
  GoogleAuthProvider,
} from "firebase/auth";
import { auth, googleAuthProvider } from "@/lib/firebase/client";
import { saveGoogleOAuthTokenAction } from "@/lib/actions";
import { Button, Input, Label } from "@/components/ui";

/* ── SVG brand logos ─────────────────────────────────────────────── */

function GoogleLogo() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true" className="shrink-0">
      <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" />
      <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
      <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" />
      <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" />
    </svg>
  );
}

/* ── Helpers ─────────────────────────────────────────────────────── */

function routeAfterAuth(role: string | null, clientId: string | null): string {
  if (role === "CLIENT_USER") return clientId ? `/clients/${clientId}` : "/assets";
  return "/dashboard";
}

function friendly(err: unknown): string {
  const code = (err as { code?: string })?.code ?? "";
  const map: Record<string, string> = {
    "auth/invalid-credential":                   "Incorrect email or password.",
    "auth/user-not-found":                       "No account with that email.",
    "auth/wrong-password":                       "Incorrect password.",
    "auth/too-many-requests":                    "Too many attempts. Wait a moment and try again.",
    "auth/popup-closed-by-user":                 "Sign-in cancelled.",
    "auth/popup-blocked":                        "Popup blocked. Allow popups for this site and try again.",
    "auth/cancelled-popup-request":              "",
    "auth/invalid-api-key":                      "Firebase isn't configured. Add your keys to .env.local.",
    "auth/unauthorized-domain":                  "This domain isn't authorised for Google sign-in. Add it to Firebase Console → Authentication → Authorised Domains.",
    "auth/account-exists-with-different-credential": "An account with this email already exists. Try signing in with email and password.",
  };
  return map[code] ?? (err instanceof Error ? err.message : "Something went wrong.");
}

/* ── Page ────────────────────────────────────────────────────────── */

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState<"email" | "google" | null>(null);
  // Set when the account exists but its email is unverified. The account stays
  // signed in on the client (no server session cookie is minted) so we can offer
  // a "resend verification" action.
  const [needsVerify, setNeedsVerify] = useState(false);
  const [resent, setResent] = useState(false);

  type SessionResult =
    | { needsEmailVerification: true }
    | { needsEmailVerification: false; role: string; clientId: string | null; disabled: boolean };

  // Posts the Firebase ID token to the session endpoint. Returns the server's
  // decision: the account needs email verification, or the session was accepted
  // with a role/clientId. Does NOT navigate - callers decide when.
  async function establishSession(): Promise<SessionResult> {
    const idToken = await auth.currentUser!.getIdToken(true);
    const res = await fetch("/api/auth/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ idToken }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 403 && data.needsEmailVerification) {
      return { needsEmailVerification: true };
    }
    if (!res.ok) {
      throw new Error(data.error || "Could not establish session.");
    }
    return { needsEmailVerification: false, ...data };
  }

  async function handleEmail(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setNeedsVerify(false);
    setLoading("email");
    try {
      await signInWithEmailAndPassword(auth, email, password);
      const result = await establishSession();
      if (result.needsEmailVerification) {
        setNeedsVerify(true);
        setError("Please verify your email before logging in.");
        setLoading(null);
        return;
      }
      window.location.replace(
        result.disabled ? "/pending" : routeAfterAuth(result.role, result.clientId),
      );
    } catch (err) {
      const msg = friendly(err);
      if (msg) setError(msg);
      setLoading(null);
    }
  }

  async function handleGoogle() {
    setError(null);
    setNeedsVerify(false);
    setLoading("google");
    try {
      // googleAuthProvider uses the standard implicit-grant flow (no offline access,
      // no Gmail scope). This is intentional: access_type:"offline" forces a code-grant
      // response that Firebase's popup handler cannot process, causing a silent hang.
      const result = await signInWithPopup(auth, googleAuthProvider);
      const googleAccessToken =
        GoogleAuthProvider.credentialFromResult(result)?.accessToken ?? null;

      const session = await establishSession();
      if (session.needsEmailVerification) {
        setNeedsVerify(true);
        setError("Please verify your email before logging in.");
        return;
      }

      // Save the Google access token before navigating - if the browser navigates
      // first, the in-flight server-action fetch can be aborted.
      if (googleAccessToken) {
        // Non-blocking: a failed token save shouldn't block login, but it must
        // not vanish silently - otherwise Google-gated features appear "not
        // connected" with no clue why. Log it so it's diagnosable.
        const saved = await saveGoogleOAuthTokenAction(googleAccessToken).catch(
          (e) => ({ ok: false as const, error: e instanceof Error ? e.message : "save failed" }),
        );
        if (!saved.ok) {
          console.warn("[login] Google token save failed:", saved.error);
        }
      }

      window.location.replace(
        session.disabled ? "/pending" : routeAfterAuth(session.role, session.clientId),
      );
    } catch (err) {
      const msg = friendly(err);
      if (msg) setError(msg);
    } finally {
      setLoading(null);
    }
  }

  async function handleResend() {
    if (!auth.currentUser) return;
    try {
      await sendEmailVerification(auth.currentUser);
      setResent(true);
    } catch (err) {
      const msg = friendly(err);
      if (msg) setError(msg);
    }
  }

  const busy = loading !== null;

  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-sm animate-fade-up">

        {/* Wordmark lockup - head disc + Spectral (brand §2.2) */}
        <div className="mb-8 text-center">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/brand/kairos-head-disc-dark.svg"
            alt=""
            className="mx-auto mb-4 h-12 w-12 rounded-full shadow-[inset_0_0_0_1px_var(--border)]"
          />
          <p className="eyebrow mb-2">Your AI CMO</p>
          <h1 className="text-2xl">Karos Labs</h1>
          <p className="mt-1.5 text-sm text-muted">Welcome back.</p>
        </div>

        <div className="card-grad rounded-[var(--radius)] border border-border p-6 space-y-4">

          {/* Email / password */}
          <form onSubmit={handleEmail} className="space-y-3">
            <div>
              <Label>Work email</Label>
              <Input
                type="email"
                required
                autoFocus
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@company.com"
              />
            </div>
            <div>
              <Label>Password</Label>
              <Input
                type="password"
                required
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
              />
            </div>

            {error && <p className="text-xs text-danger">{error}</p>}

            <Button
              type="submit"
              className="w-full"
              loading={loading === "email"}
              disabled={busy}
            >
              Sign in
            </Button>
          </form>

          {/* Divider */}
          <div className="flex items-center gap-3">
            <div className="h-px flex-1 bg-border" />
            <span className="text-[11px] text-muted-2">or</span>
            <div className="h-px flex-1 bg-border" />
          </div>

          {/* Social sign-in */}
          <div className="space-y-2">
            <Button
              variant="subtle"
              className="w-full"
              onClick={handleGoogle}
              loading={loading === "google"}
              disabled={busy}
            >
              <GoogleLogo />
              Sign in with Google
            </Button>
          </div>

          {/* Unverified email - offer to resend the verification link */}
          {needsVerify && (
            <div className="rounded-md border border-warning/30 bg-warning/10 px-3 py-2.5 text-center">
              <p className="text-[11px] text-muted">
                We sent a verification link to your inbox. Verify your email, then sign in again.
              </p>
              {resent ? (
                <p className="mt-1.5 text-[11px] text-neon">Verification email sent.</p>
              ) : (
                <button
                  type="button"
                  onClick={handleResend}
                  className="mt-1.5 text-[11px] text-neon underline-offset-2 hover:underline"
                >
                  Resend verification email
                </button>
              )}
            </div>
          )}
        </div>

        <p className="mt-5 text-center text-[11px] text-muted-2">
          New to Karos?{" "}
          <Link href="/signup" className="text-neon underline-offset-2 hover:underline">
            Get your invitation key →
          </Link>
        </p>
      </div>
    </div>
  );
}
