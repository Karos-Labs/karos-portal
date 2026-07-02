"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Card, CardTitle, Button, Input, Label, Badge } from "@/components/ui";
import { Icon } from "@/components/icon";
import { cn, initials } from "@/lib/utils";
import { updateUserProfileAction, updatePasswordAction } from "@/lib/actions";
import type { AppUser, Role } from "@/lib/types";

/* ── Inline brand SVGs (no external deps needed) ─────────────────────── */

function GoogleMark() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true" className="shrink-0">
      <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" />
      <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
      <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" />
      <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" />
    </svg>
  );
}

function AppleMark() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" className="shrink-0 text-foreground">
      <path d="M12.152 6.896c-.948 0-2.415-1.078-3.96-1.04-2.04.027-3.91 1.183-4.961 3.014-2.117 3.675-.546 9.103 1.519 12.09 1.013 1.454 2.208 3.09 3.792 3.039 1.52-.065 2.09-.987 3.935-.987 1.831 0 2.35.987 3.96.948 1.637-.026 2.676-1.48 3.676-2.948 1.156-1.688 1.636-3.325 1.662-3.415-.039-.013-3.182-1.221-3.22-4.857-.026-3.04 2.48-4.494 2.597-4.559-1.429-2.09-3.623-2.324-4.39-2.376-2-.156-3.675 1.09-4.61 1.09zM15.53 3.83c.843-1.012 1.4-2.427 1.245-3.83-1.207.052-2.662.805-3.532 1.818-.78.896-1.454 2.338-1.273 3.714 1.338.104 2.715-.688 3.559-1.701z" />
    </svg>
  );
}

/* ── Shared helpers ───────────────────────────────────────────────────── */

const ROLE_LABEL: Record<Role, string> = {
  KAROS_ADMIN: "Karos Admin",
  KAROS_EMPLOYEE: "Karos Employee",
  CLIENT_USER: "Client",
};

type Tab = "profile" | "security";

function Avatar({
  photoURL,
  name,
  size = "lg",
}: {
  photoURL?: string | null;
  name: string;
  size?: "sm" | "lg";
}) {
  const dim = size === "lg" ? "h-20 w-20 text-2xl" : "h-14 w-14 text-lg";
  if (photoURL) {
    return (
      <img
        src={photoURL}
        alt={name}
        className={cn("rounded-full object-cover ring-2 ring-border", dim)}
      />
    );
  }
  return (
    <div
      className={cn(
        "flex shrink-0 items-center justify-center rounded-full bg-surface-3 font-semibold text-neon ring-2 ring-border",
        dim,
      )}
    >
      {initials(name)}
    </div>
  );
}

/* ── Profile tab ──────────────────────────────────────────────────────── */

function ProfileTab({
  user,
  clientName,
}: {
  user: AppUser;
  clientName: string | null;
}) {
  const router = useRouter();
  const [name, setName] = useState(user.name);
  const [savedName, setSavedName] = useState(user.name);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [isPending, startTransition] = useTransition();

  const dirty = name.trim() !== savedName.trim() && name.trim().length > 0;

  function save(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSuccess(false);
    startTransition(async () => {
      try {
        await updateUserProfileAction(name);
        setSavedName(name.trim());
        setSuccess(true);
        router.refresh();
        setTimeout(() => setSuccess(false), 3500);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not update profile.");
      }
    });
  }

  return (
    <div className="space-y-5">
      {/* Avatar card */}
      <Card>
        <CardTitle className="mb-4">Profile Picture</CardTitle>
        <div className="flex items-center gap-5">
          <Avatar photoURL={user.photoURL} name={user.name} size="lg" />
          <div className="space-y-1">
            <p className="text-sm font-medium text-foreground">{savedName}</p>
            <p className="text-xs text-muted-2">{user.email}</p>
            {user.photoURL ? (
              <p className="mt-2 text-[11px] text-muted-2">
                Synced from your sign-in provider.
              </p>
            ) : (
              <p className="mt-2 text-[11px] text-muted-2">
                Avatar shows your initials.
              </p>
            )}
          </div>
        </div>
      </Card>

      {/* Editable fields */}
      <Card>
        <CardTitle className="mb-4">Personal Information</CardTitle>
        <form onSubmit={save} className="space-y-4">
          <div>
            <Label htmlFor="settings-name">Full name</Label>
            <Input
              id="settings-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Your name"
              autoComplete="name"
              required
            />
          </div>
          <div>
            <Label htmlFor="settings-email">Email address</Label>
            <Input
              id="settings-email"
              type="email"
              value={user.email}
              disabled
              className="cursor-not-allowed opacity-60"
            />
            <p className="mt-1.5 text-[11px] text-muted-2">
              Email is used as your login key and cannot be changed here.
            </p>
          </div>

          {error && <p className="text-xs text-danger">{error}</p>}
          {success && (
            <p className="flex items-center gap-1.5 text-xs text-neon">
              <Icon name="CheckCircle" className="h-3.5 w-3.5" />
              Profile updated.
            </p>
          )}

          <Button
            type="submit"
            loading={isPending}
            disabled={isPending || !dirty}
          >
            Save changes
          </Button>
        </form>
      </Card>

      {/* Account metadata — read-only */}
      <Card>
        <CardTitle className="mb-4">Account Details</CardTitle>
        <dl className="space-y-3">
          <div className="flex items-center justify-between">
            <dt className="text-sm text-muted">Role</dt>
            <dd>
              <Badge tone={user.role === "KAROS_ADMIN" ? "neon" : user.role === "KAROS_EMPLOYEE" ? "info" : "neutral"}>
                {ROLE_LABEL[user.role]}
              </Badge>
            </dd>
          </div>
          {clientName && (
            <div className="flex items-center justify-between">
              <dt className="text-sm text-muted">Company</dt>
              <dd className="text-sm font-medium text-foreground">{clientName}</dd>
            </div>
          )}
          <div className="flex items-center justify-between">
            <dt className="text-sm text-muted">Member since</dt>
            <dd className="text-sm text-foreground">
              {new Date(user.createdAt).toLocaleDateString("en-US", {
                month: "long",
                year: "numeric",
              })}
            </dd>
          </div>
        </dl>
      </Card>
    </div>
  );
}

/* ── Security tab ─────────────────────────────────────────────────────── */

const PROVIDER_META: Record<string, { label: string; sub: string; mark: React.ReactNode }> = {
  "google.com": {
    label: "Signed in via Google",
    sub: "Your credentials are managed by Google. Visit myaccount.google.com to change your password.",
    mark: <GoogleMark />,
  },
  "apple.com": {
    label: "Signed in via Apple",
    sub: "Your credentials are managed by Apple ID. Manage them in your Apple account settings.",
    mark: <AppleMark />,
  },
};

function SecurityTab({ providers }: { providers: string[] }) {
  const hasPassword = providers.includes("password");
  const socialProviders = providers.filter((p) => p !== "password");

  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [isPending, startTransition] = useTransition();

  function savePassword(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSuccess(false);
    if (next !== confirm) {
      setError("New passwords don't match.");
      return;
    }
    if (next.length < 6) {
      setError("New password must be at least 6 characters.");
      return;
    }
    startTransition(async () => {
      try {
        await updatePasswordAction(current, next);
        setCurrent("");
        setNext("");
        setConfirm("");
        setSuccess(true);
        setTimeout(() => setSuccess(false), 4000);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not update password.");
      }
    });
  }

  return (
    <div className="space-y-5">
      {/* Auth method overview */}
      <Card>
        <CardTitle className="mb-4">Authentication Method</CardTitle>
        <div className="space-y-3">
          {socialProviders.map((pid) => {
            const meta = PROVIDER_META[pid];
            if (!meta) return null;
            return (
              <div
                key={pid}
                className="flex items-center gap-4 rounded-md border border-border bg-surface-2 px-4 py-3"
              >
                {meta.mark}
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-foreground">{meta.label}</p>
                  <p className="text-xs text-muted-2">{meta.sub}</p>
                </div>
                <Icon name="ShieldCheck" className="h-5 w-5 shrink-0 text-neon" />
              </div>
            );
          })}

          {hasPassword && (
            <div className="flex items-center gap-4 rounded-md border border-border bg-surface-2 px-4 py-3">
              <Icon name="Mail" className="h-5 w-5 shrink-0 text-muted" />
              <div>
                <p className="text-sm font-medium text-foreground">Email &amp; password</p>
                <p className="text-xs text-muted-2">You can change your password below.</p>
              </div>
            </div>
          )}
        </div>
      </Card>

      {/* Password change — only for email/password accounts */}
      {hasPassword && (
        <Card>
          <CardTitle className="mb-4">Change Password</CardTitle>
          <form onSubmit={savePassword} className="space-y-4">
            <div>
              <Label htmlFor="pw-current">Current password</Label>
              <Input
                id="pw-current"
                type="password"
                value={current}
                onChange={(e) => setCurrent(e.target.value)}
                placeholder="••••••••"
                required
                autoComplete="current-password"
              />
            </div>
            <div>
              <Label htmlFor="pw-new">New password</Label>
              <Input
                id="pw-new"
                type="password"
                value={next}
                onChange={(e) => setNext(e.target.value)}
                placeholder="••••••••"
                required
                autoComplete="new-password"
                minLength={6}
              />
            </div>
            <div>
              <Label htmlFor="pw-confirm">Confirm new password</Label>
              <Input
                id="pw-confirm"
                type="password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                placeholder="••••••••"
                required
                autoComplete="new-password"
              />
            </div>

            {error && <p className="text-xs text-danger">{error}</p>}
            {success && (
              <p className="flex items-center gap-1.5 text-xs text-neon">
                <Icon name="CheckCircle" className="h-3.5 w-3.5" />
                Password updated successfully.
              </p>
            )}

            <Button type="submit" loading={isPending} disabled={isPending}>
              Update password
            </Button>
          </form>
        </Card>
      )}
    </div>
  );
}

/* ── Root export ──────────────────────────────────────────────────────── */

export function SettingsForm({
  user,
  providers,
  clientName,
}: {
  user: AppUser;
  providers: string[];
  clientName: string | null;
}) {
  const [tab, setTab] = useState<Tab>("profile");

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      {/* Page header */}
      <div className="flex items-center gap-4">
        <Avatar photoURL={user.photoURL} name={user.name} size="sm" />
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{user.name}</h1>
          <p className="text-sm text-muted">{user.email}</p>
        </div>
      </div>

      {/* Tab switcher */}
      <div className="flex gap-1 rounded-md border border-border bg-surface-2 p-1">
        {(
          [
            { id: "profile", label: "Profile Information", icon: "User" },
            { id: "security", label: "Account Security", icon: "Shield" },
          ] as { id: Tab; label: string; icon: string }[]
        ).map(({ id, label, icon }) => (
          <button
            key={id}
            type="button"
            onClick={() => setTab(id)}
            className={cn(
              "flex flex-1 items-center justify-center gap-2 rounded-md py-2.5 text-sm font-medium transition-colors",
              tab === id
                ? "bg-surface text-foreground shadow-sm"
                : "text-muted hover:text-foreground",
            )}
          >
            <Icon name={icon} className="h-4 w-4" />
            {label}
          </button>
        ))}
      </div>

      {tab === "profile" && <ProfileTab user={user} clientName={clientName} />}
      {tab === "security" && <SecurityTab providers={providers} />}
    </div>
  );
}
