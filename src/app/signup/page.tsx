"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  createUserWithEmailAndPassword,
  signInWithPopup,
  sendEmailVerification,
  updateProfile,
} from "firebase/auth";
import { auth, googleProvider } from "@/lib/firebase/client";
import { validateInvitationKeyAction } from "@/lib/actions";
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

/* ── Types ───────────────────────────────────────────────────────── */

type ValidatedKey =
  | { role: "KAROS_EMPLOYEE"; label: string; invitationKey: string }
  | { role: "CLIENT_USER"; clientId: string; label: string; invitationKey: string };

type Step = "key" | "auth";
type LoadingState = "validate" | "email" | "google" | null;

/* ── Helper ──────────────────────────────────────────────────────── */

function routeAfterAuth(role: string | null, clientId: string | null): string {
  if (role === "CLIENT_USER") return clientId ? `/clients/${clientId}` : "/assets";
  return "/dashboard";
}

function friendly(err: unknown): string {
  const code = (err as { code?: string })?.code ?? "";
  const map: Record<string, string> = {
    "auth/email-already-in-use": "That email is already registered. Try signing in instead.",
    "auth/weak-password": "Password must be at least 6 characters.",
    "auth/popup-closed-by-user": "Sign-in cancelled.",
    "auth/popup-blocked": "Popup blocked. Allow popups for this site and try again.",
    "auth/cancelled-popup-request": "",
    "auth/invalid-api-key": "Firebase isn't configured. Add your keys to .env.local.",
  };
  return map[code] ?? (err instanceof Error ? err.message : "Something went wrong.");
}

/* ── Page ────────────────────────────────────────────────────────── */

export default function SignupPage() {
  const router = useRouter();
  const [step, setStep] = useState<Step>("key");
  const [invKey, setInvKey] = useState("");
  const [validated, setValidated] = useState<ValidatedKey | null>(null);

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  const [loading, setLoading] = useState<LoadingState>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  // Set once a native email/password signup has been created and its
  // verification email dispatched - flips the card to the "check your inbox" view.
  const [verificationSent, setVerificationSent] = useState(false);
  const [resent, setResent] = useState(false);

  /* ── Step 1: validate the invitation key ─────────────────────── */

  function handleValidateKey() {
    setError(null);
    startTransition(async () => {
      const result = await validateInvitationKeyAction(invKey);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setValidated({ ...result, invitationKey: invKey.trim() });
      setStep("auth");
    });
  }

  /* ── Step 2: create Firebase credential + establish session ───── */

  // Provisions the Firestore user doc server-side and returns the session
  // decision. For native email/password signups the server withholds the
  // session until the email is verified (needsEmailVerification: true); the
  // provisioned doc still persists so a post-verification login resolves.
  type SessionResult =
    | { needsEmailVerification: true }
    | { needsEmailVerification: false; role: string; clientId: string | null; disabled?: boolean };

  async function establishSession(): Promise<SessionResult> {
    if (!validated) throw new Error("Missing invitation context.");
    const idToken = await auth.currentUser!.getIdToken(true);
    const res = await fetch("/api/auth/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        idToken,
        intent: {
          requestedRole: validated.role,
          invitationKey: validated.invitationKey,
        },
      }),
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
    setLoading("email");
    try {
      const cred = await createUserWithEmailAndPassword(auth, email, password);
      if (name.trim()) await updateProfile(cred.user, { displayName: name.trim() });
      // Fire the verification email immediately, then provision the account.
      await sendEmailVerification(cred.user);
      await establishSession();
      // The server withholds a session cookie until the email is verified, so the
      // workspace stays locked. We keep the client credential (no signOut) only so
      // the "resend" button below can reach auth.currentUser.
      setVerificationSent(true);
      setLoading(null);
    } catch (err) {
      const msg = friendly(err);
      if (msg) setError(msg);
      setLoading(null);
    }
  }

  async function handleGoogle() {
    setError(null);
    setLoading("google");
    try {
      await signInWithPopup(auth, googleProvider);
      const result = await establishSession();
      if (result.needsEmailVerification) {
        // Extremely unlikely for Google (pre-verified), but handle it safely.
        setVerificationSent(true);
        setLoading(null);
        return;
      }
      // A freshly-provisioned account that landed disabled (pending approval)
      // must go to /pending, not into the workspace - mirroring the login page.
      // Otherwise the server guard bounces it back, causing a confusing flash.
      router.push(result.disabled ? "/pending" : routeAfterAuth(result.role, result.clientId));
      router.refresh();
    } catch (err) {
      const msg = friendly(err);
      if (msg) setError(msg);
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

  const busy = loading !== null || isPending;

  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-sm animate-fade-up">

        {/* Wordmark lockup - head disc + Spectral (brand §2.2), matches /login */}
        <div className="mb-8 text-center">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/brand/kairos-head-disc-dark.svg"
            alt=""
            className="mx-auto mb-4 h-12 w-12 rounded-full shadow-[inset_0_0_0_1px_var(--border)]"
          />
          <p className="eyebrow mb-2">Your AI CMO</p>
          <h1 className="text-2xl">Karos Labs</h1>
          <p className="mt-1.5 text-sm text-muted">
            {verificationSent
              ? "Almost there. Verify your email."
              : step === "key"
                ? "Enter your invitation key to get started."
                : "Create your account."}
          </p>
        </div>

        <div className="card-grad rounded-[var(--radius)] border border-border p-6">

          {/* ── Step 1: Key entry ─────────────────────────────── */}
          {step === "key" && (
            <div className="space-y-4">
              <div>
                <Label>Invitation Key</Label>
                <Input
                  value={invKey}
                  onChange={(e) => setInvKey(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && !busy && handleValidateKey()}
                  placeholder="ck_••••••••••••••••"
                  autoComplete="off"
                  autoFocus
                  spellCheck={false}
                />
                <p className="mt-1.5 text-[11px] text-muted-2">
                  Your Karos account manager will have sent this to you.
                </p>
              </div>

              {error && <p className="text-xs text-danger">{error}</p>}

              <Button
                className="w-full"
                onClick={handleValidateKey}
                loading={isPending}
                disabled={busy || !invKey.trim()}
              >
                Verify Key
                <Icon name="ArrowRight" className="h-4 w-4" />
              </Button>

              <p className="text-center text-[11px] text-muted-2">
                Don&apos;t have a key?{" "}
                <Link href="/request-access" className="text-neon underline-offset-2 hover:underline">
                  Request a company account →
                </Link>
              </p>
            </div>
          )}

          {/* ── Step 2: Auth options ──────────────────────────── */}
          {!verificationSent && step === "auth" && validated && (
            <div className="space-y-4">
              {/* Validated key badge + back */}
              <div className="flex items-center justify-between">
                <button
                  type="button"
                  onClick={() => { setStep("key"); setError(null); }}
                  className="flex items-center gap-1 text-xs text-muted hover:text-foreground"
                >
                  <Icon name="ArrowLeft" className="h-3.5 w-3.5" />
                  Change key
                </button>
                <span className="flex items-center gap-1.5 rounded-full border border-neon/30 bg-neon-soft px-3 py-1 text-[11px] font-medium text-neon">
                  <Icon
                    name={validated.role === "KAROS_EMPLOYEE" ? "Shield" : "Building2"}
                    className="h-3 w-3"
                  />
                  {validated.label}
                </span>
              </div>

              {/* Email form */}
              <form onSubmit={handleEmail} className="space-y-3">
                <div>
                  <Label>Full name</Label>
                  <Input
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="Jane Doe"
                    autoFocus
                  />
                </div>
                <div>
                  <Label>Work email</Label>
                  <Input
                    type="email"
                    required
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
                    minLength={6}
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
                  Create account
                </Button>
              </form>

              {/* Divider */}
              <div className="flex items-center gap-3">
                <div className="h-px flex-1 bg-border" />
                <span className="text-[11px] text-muted-2">or</span>
                <div className="h-px flex-1 bg-border" />
              </div>

              {/* Social buttons */}
              <div className="space-y-2">
                <Button
                  variant="subtle"
                  className="w-full"
                  onClick={handleGoogle}
                  loading={loading === "google"}
                  disabled={busy}
                >
                  <GoogleLogo />
                  Continue with Google
                </Button>
              </div>
            </div>
          )}

          {/* ── Email verification sent ───────────────────────── */}
          {verificationSent && (
            <div className="space-y-4 text-center">
              <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-md bg-neon-soft">
                <Icon name="Mail" className="h-6 w-6 text-neon" />
              </div>
              <div className="space-y-1.5">
                <p className="text-sm font-medium text-foreground">Check your inbox</p>
                <p className="text-[13px] text-muted">
                  We sent a verification link to{" "}
                  <span className="text-foreground">{email}</span>. Click it to activate your
                  account, then sign in.
                </p>
              </div>

              {error && <p className="text-xs text-danger">{error}</p>}

              {resent ? (
                <p className="text-[11px] text-neon">Verification email sent again.</p>
              ) : (
                <button
                  type="button"
                  onClick={handleResend}
                  className="text-[11px] text-neon underline-offset-2 hover:underline"
                >
                  Didn&apos;t get it? Resend verification email
                </button>
              )}

              <Button className="w-full" onClick={() => router.push("/login")}>
                Go to sign in
                <Icon name="ArrowRight" className="h-4 w-4" />
              </Button>
            </div>
          )}
        </div>

        <p className="mt-5 text-center text-[11px] text-muted-2">
          Already have an account?{" "}
          <Link href="/login" className="text-neon underline-offset-2 hover:underline">
            Sign in →
          </Link>
        </p>
      </div>
    </div>
  );
}
