"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  signInWithEmailAndPassword,
  signInWithPopup,
  getRedirectResult,
  GoogleAuthProvider,
} from "firebase/auth";
import { auth, googleProvider, appleProvider } from "@/lib/firebase/client";
import { saveGoogleOAuthTokenAction } from "@/lib/actions";
import { Button, Input, Label } from "@/components/ui";
import { Icon } from "@/components/icon";

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

function AppleLogo() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" className="shrink-0">
      <path d="M12.152 6.896c-.948 0-2.415-1.078-3.96-1.04-2.04.027-3.91 1.183-4.961 3.014-2.117 3.675-.546 9.103 1.519 12.09 1.013 1.454 2.208 3.09 3.792 3.039 1.52-.065 2.09-.987 3.935-.987 1.831 0 2.35.987 3.96.948 1.637-.026 2.676-1.48 3.676-2.948 1.156-1.688 1.636-3.325 1.662-3.415-.039-.013-3.182-1.221-3.22-4.857-.026-3.04 2.48-4.494 2.597-4.559-1.429-2.09-3.623-2.324-4.39-2.376-2-.156-3.675 1.09-4.61 1.09zM15.53 3.83c.843-1.012 1.4-2.427 1.245-3.83-1.207.052-2.662.805-3.532 1.818-.78.896-1.454 2.338-1.273 3.714 1.338.104 2.715-.688 3.559-1.701z" />
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
    "auth/invalid-credential":      "Incorrect email or password.",
    "auth/user-not-found":          "No account with that email.",
    "auth/wrong-password":          "Incorrect password.",
    "auth/too-many-requests":       "Too many attempts — wait a moment and try again.",
    "auth/popup-closed-by-user":    "Sign-in cancelled.",
    "auth/popup-blocked":           "Popup blocked — allow popups for this site and try again.",
    "auth/cancelled-popup-request": "",
    "auth/invalid-api-key":         "Firebase isn't configured. Add your keys to .env.local.",
  };
  return map[code] ?? (err instanceof Error ? err.message : "Something went wrong.");
}

/* ── Page ────────────────────────────────────────────────────────── */

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState<"email" | "google" | "apple" | null>(null);

  // Catch redirect-based auth results (e.g. Apple on some browsers/platforms).
  useEffect(() => {
    getRedirectResult(auth)
      .then((result) => {
        if (result) establishSession();
      })
      .catch((err) => {
        const msg = friendly(err);
        if (msg) setError(msg);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Posts the Firebase ID token to the session endpoint and returns the
  // server-assigned role/clientId. Does NOT navigate — callers decide when.
  async function createSession(): Promise<{ role: string; clientId: string | null; disabled: boolean }> {
    const idToken = await auth.currentUser!.getIdToken(true);
    const res = await fetch("/api/auth/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ idToken }),
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      throw new Error(j.error || "Could not establish session.");
    }
    return res.json();
  }

  async function establishSession() {
    const { role, clientId, disabled } = await createSession();
    router.push(disabled ? "/pending" : routeAfterAuth(role, clientId));
    router.refresh();
  }

  async function handleEmail(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading("email");
    try {
      await signInWithEmailAndPassword(auth, email, password);
      await establishSession();
    } catch (err) {
      const msg = friendly(err);
      if (msg) setError(msg);
      setLoading(null);
    }
  }

  async function handleSocial(provider: "google" | "apple") {
    setError(null);
    setLoading(provider);
    try {
      const result = await signInWithPopup(
        auth,
        provider === "google" ? googleProvider : appleProvider,
      );

      // Extract the raw Google OAuth2 access token before any navigation.
      // credentialFromResult returns the Google-issued token (not a Firebase ID token).
      let googleAccessToken: string | null = null;
      if (provider === "google") {
        const cred = GoogleAuthProvider.credentialFromResult(result);
        googleAccessToken = cred?.accessToken ?? null;
      }

      // Create the session first — this sets the session cookie that
      // saveGoogleOAuthTokenAction needs to authenticate on the server.
      const { role, clientId, disabled } = await createSession();

      // Await the token save BEFORE calling router.push(). If we navigate
      // first, the browser can abort the in-flight server-action fetch,
      // leaving clientIntegrations empty and breaking Gmail scanning.
      if (googleAccessToken) {
        await saveGoogleOAuthTokenAction(googleAccessToken).catch(() => {});
      }

      router.push(disabled ? "/pending" : routeAfterAuth(role, clientId));
      router.refresh();
    } catch (err) {
      const msg = friendly(err);
      if (msg) setError(msg);
      setLoading(null);
    }
  }

  const busy = loading !== null;

  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-sm animate-fade-up">

        {/* Logo mark */}
        <div className="mb-8 text-center">
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-[14px] bg-neon-soft neon-glow">
            <Icon name="Sparkles" className="h-6 w-6 text-neon" />
          </div>
          <h1 className="text-2xl font-semibold tracking-tight">
            Karos<span className="neon-text">CMO</span>
          </h1>
          <p className="mt-1 text-sm text-muted">Welcome back.</p>
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
              onClick={() => handleSocial("google")}
              loading={loading === "google"}
              disabled={busy}
            >
              <GoogleLogo />
              Sign in with Google
            </Button>

            <div title="Apple Sign-In coming soon">
              <Button
                variant="subtle"
                className="w-full opacity-50 cursor-not-allowed"
                disabled
              >
                <AppleLogo />
                Sign in with Apple
                <span className="ml-auto text-[10px] font-normal tracking-wide text-muted-2">
                  Soon
                </span>
              </Button>
            </div>
          </div>
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
