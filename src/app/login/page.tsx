"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signInWithPopup,
  updateProfile,
} from "firebase/auth";
import { auth, googleProvider } from "@/lib/firebase/client";
import { Button, Input, Label } from "@/components/ui";
import { Icon } from "@/components/icon";

export default function LoginPage() {
  const router = useRouter();
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [joinAs, setJoinAs] = useState<"employee" | "client">("employee");
  const [companyName, setCompanyName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState<"email" | "google" | null>(null);

  /** Signup-only: the role/company the new user is requesting (an admin confirms it). */
  function signupIntent() {
    if (mode !== "signup") return undefined;
    return { requestedRole: joinAs, clientName: joinAs === "client" ? companyName.trim() : undefined };
  }

  async function establishSession() {
    const idToken = await auth.currentUser!.getIdToken(true);
    const res = await fetch("/api/auth/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ idToken, intent: signupIntent() }),
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      throw new Error(j.error || "Could not establish session");
    }
    router.push("/dashboard");
    router.refresh();
  }

  async function handleEmail(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (mode === "signup" && joinAs === "client" && !companyName.trim()) {
      return setError("Tell us your company or brand name.");
    }
    setLoading("email");
    try {
      if (mode === "signup") {
        const cred = await createUserWithEmailAndPassword(auth, email, password);
        if (name) await updateProfile(cred.user, { displayName: name });
      } else {
        await signInWithEmailAndPassword(auth, email, password);
      }
      await establishSession();
    } catch (err) {
      setError(friendly(err));
      setLoading(null);
    }
  }

  async function handleGoogle() {
    setError(null);
    if (mode === "signup" && joinAs === "client" && !companyName.trim()) {
      return setError("Tell us your company or brand name.");
    }
    setLoading("google");
    try {
      await signInWithPopup(auth, googleProvider);
      await establishSession();
    } catch (err) {
      setError(friendly(err));
      setLoading(null);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-sm animate-fade-up">
        <div className="mb-8 text-center">
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-[14px] bg-neon-soft neon-glow">
            <Icon name="Sparkles" className="h-6 w-6 text-neon" />
          </div>
          <h1 className="text-2xl font-semibold tracking-tight">
            Karos<span className="neon-text">CMO</span>
          </h1>
          <p className="mt-1 text-sm text-muted">Your AI marketing agency, on autopilot.</p>
        </div>

        <div className="card-grad rounded-[var(--radius)] border border-border p-6">
          <div className="mb-5 grid grid-cols-2 gap-1 rounded-[10px] bg-surface-2 p-1">
            {(["signin", "signup"] as const).map((m) => (
              <button
                key={m}
                onClick={() => setMode(m)}
                className={`h-8 rounded-[8px] text-xs font-medium transition-colors ${
                  mode === m ? "bg-neon text-[#03110b]" : "text-muted hover:text-foreground"
                }`}
              >
                {m === "signin" ? "Sign in" : "Create account"}
              </button>
            ))}
          </div>

          <form onSubmit={handleEmail} className="space-y-3">
            {mode === "signup" && (
              <>
                <div>
                  <Label>I'm joining as</Label>
                  <div className="grid grid-cols-2 gap-1 rounded-[10px] bg-surface-2 p-1">
                    {([
                      { value: "employee", label: "Agency staff" },
                      { value: "client", label: "Client" },
                    ] as const).map((opt) => (
                      <button
                        key={opt.value}
                        type="button"
                        onClick={() => setJoinAs(opt.value)}
                        className={`h-8 rounded-[8px] text-xs font-medium transition-colors ${
                          joinAs === opt.value ? "bg-neon text-[#03110b]" : "text-muted hover:text-foreground"
                        }`}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                </div>
                <div>
                  <Label>Full name</Label>
                  <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Jane Doe" />
                </div>
                {joinAs === "client" && (
                  <div>
                    <Label>Company / brand name</Label>
                    <Input
                      value={companyName}
                      onChange={(e) => setCompanyName(e.target.value)}
                      placeholder="Acme Co"
                    />
                  </div>
                )}
              </>
            )}
            <div>
              <Label>Work email</Label>
              <Input
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@agency.com"
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

            <Button type="submit" loading={loading === "email"} disabled={loading !== null} className="w-full">
              {mode === "signin" ? "Sign in" : "Create account"}
            </Button>
          </form>

          <div className="my-4 flex items-center gap-3">
            <div className="h-px flex-1 bg-border" />
            <span className="text-[11px] text-muted-2">or</span>
            <div className="h-px flex-1 bg-border" />
          </div>

          <Button variant="subtle" className="w-full" onClick={handleGoogle} loading={loading === "google"} disabled={loading !== null}>
            <Icon name="Globe" className="h-4 w-4" />
            Continue with Google
          </Button>
        </div>

        <p className="mt-5 text-center text-[11px] text-muted-2">
          {mode === "signup"
            ? "New accounts are reviewed by your agency admin before access is granted."
            : "Staff & client accounts are provisioned by your agency admin."}
        </p>
      </div>
    </div>
  );
}

function friendly(err: unknown): string {
  const code = (err as { code?: string })?.code ?? "";
  const map: Record<string, string> = {
    "auth/invalid-credential": "Incorrect email or password.",
    "auth/user-not-found": "No account with that email.",
    "auth/wrong-password": "Incorrect password.",
    "auth/email-already-in-use": "That email is already registered — try signing in.",
    "auth/weak-password": "Password must be at least 6 characters.",
    "auth/popup-closed-by-user": "Sign-in cancelled.",
    "auth/invalid-api-key": "Firebase isn't configured yet. Add your keys to .env.local.",
  };
  return map[code] || (err instanceof Error ? err.message : "Something went wrong.");
}
