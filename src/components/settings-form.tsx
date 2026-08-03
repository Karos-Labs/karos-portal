"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Card, CardTitle, Button, Input, Label, Badge } from "@/components/ui";
import { Icon } from "@/components/icon";
import { AvatarUploader } from "@/components/avatar-uploader";
import { ResumeUploader } from "@/components/resume-uploader";
import { updateUserProfileAction, updatePasswordAction } from "@/lib/actions";
import type { AppUser, Role } from "@/lib/types";

/**
 * THE TWO ACCOUNT PANELS (AF-2).
 *
 * These used to be halves of a `SettingsForm` that owned its own page, its own
 * identity header and its own tab switcher — the second tab strip in a product
 * with one settings page. Both are now mounted as ordinary tabs by whichever
 * settings surface belongs to the viewer (see lib/account-settings-tabs.ts), so
 * what is left here is the panels themselves and nothing about where they sit.
 *
 * The identity header went with the wrapper rather than moving into a panel: it
 * was an avatar, a name and an email stacked directly above the avatar
 * uploader, the name field and the email field that say the same three things
 * and can also edit them.
 *
 * `max-w-2xl` without `mx-auto` — these are forms, they want a readable column,
 * and centring one under a left-aligned tab strip reads as a layout bug.
 */
const PANEL = "max-w-2xl space-y-5";

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

/* ── Shared helpers ───────────────────────────────────────────────────── */

const ROLE_LABEL: Record<Role, string> = {
  KAROS_ADMIN: "Karos Admin",
  KAROS_EMPLOYEE: "Karos Employee",
  CLIENT_USER: "Client",
};

/* ── Profile information panel ────────────────────────────────────────── */

export function AccountProfilePanel({
  user,
  clientName,
}: {
  user: AppUser;
  clientName: string | null;
}) {
  const router = useRouter();
  const [name, setName] = useState(user.name);
  const [savedName, setSavedName] = useState(user.name);
  const [phone, setPhone] = useState(user.phone ?? "");
  const [savedPhone, setSavedPhone] = useState(user.phone ?? "");
  const [photoURL, setPhotoURL] = useState<string | null>(user.photoURL ?? null);
  const [resumeUrl, setResumeUrl] = useState<string | null>(user.resumeUrl ?? null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [isPending, startTransition] = useTransition();

  const dirty =
    (name.trim() !== savedName.trim() && name.trim().length > 0) || phone.trim() !== savedPhone.trim();

  function save(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSuccess(false);
    startTransition(async () => {
      try {
        await updateUserProfileAction(name, phone);
        setSavedName(name.trim());
        setSavedPhone(phone.trim());
        setSuccess(true);
        router.refresh();
        setTimeout(() => setSuccess(false), 3500);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not update profile.");
      }
    });
  }

  return (
    <div className={PANEL}>
      {/* Avatar card */}
      <Card>
        <CardTitle className="mb-4">Profile picture</CardTitle>
        <AvatarUploader
          name={savedName}
          value={photoURL}
          onChange={(url) => {
            setPhotoURL(url);
            router.refresh();
          }}
        />
      </Card>

      {/* Editable fields */}
      <Card>
        <CardTitle className="mb-4">Personal information</CardTitle>
        <form onSubmit={save} className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
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
              <Label htmlFor="settings-phone">Phone (optional)</Label>
              <Input
                id="settings-phone"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="+1 555 000 0000"
                autoComplete="tel"
              />
            </div>
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
              <Icon name="CircleCheck" className="h-3.5 w-3.5" />
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

      {/* Resume / CV - powers the LinkedIn advocacy voice */}
      <Card>
        <CardTitle className="mb-1">Resume / CV</CardTitle>
        <p className="mb-3 text-xs text-muted-2">
          Stored for your Karos team. They use it when writing your LinkedIn advocacy posts.
        </p>
        <ResumeUploader value={resumeUrl} onChange={setResumeUrl} />
      </Card>

      {/* Account metadata - read-only */}
      <Card>
        <CardTitle className="mb-4">Account details</CardTitle>
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

/* ── Account security panel ───────────────────────────────────────────── */

const PROVIDER_META: Record<string, { label: string; sub: string; mark: React.ReactNode }> = {
  "google.com": {
    label: "Signed in via Google",
    sub: "Your credentials are managed by Google. Visit myaccount.google.com to change your password.",
    mark: <GoogleMark />,
  },
};

export function AccountSecurityPanel({ providers }: { providers: string[] }) {
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
    <div className={PANEL}>
      {/* Auth method overview */}
      <Card>
        <CardTitle className="mb-4">Authentication method</CardTitle>
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

      {/* Password change - only for email/password accounts */}
      {hasPassword && (
        <Card>
          <CardTitle className="mb-4">Change password</CardTitle>
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
                <Icon name="CircleCheck" className="h-3.5 w-3.5" />
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

