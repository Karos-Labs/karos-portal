"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Button, Badge, Input, Label } from "@/components/ui";
import { Icon } from "@/components/icon";
import { Modal } from "@/components/modal";
import { cn } from "@/lib/utils";
import {
  saveIntegrationAction,
  deleteIntegrationAction,
  setIntegrationAutoPublishAction,
} from "@/lib/actions";
import {
  PLATFORM_REGISTRY,
  OAUTH_SUPPORTED_PLATFORM_IDS,
  READ_ONLY_PLATFORM_IDS,
  GOOGLE_READ_ONLY_SUB_PLATFORM_IDS,
  type PlatformConfig,
} from "@/lib/integrations/platforms";
import { integrationNeedsReconnect } from "@/lib/integration-status";
import { LinkedInSeatsWorkspace, type SeatView } from "@/components/linkedin-seats-workspace";
import type { Role } from "@/lib/types";

export type { IntegrationView } from "@/lib/integrations/sanitize";
import type { IntegrationView } from "@/lib/integrations/sanitize";

interface Props {
  clientId: string;
  integrations: IntegrationView[];
  oauthEnabledPlatforms: string[];
  currentUserRole: Role;
  /** Sanitized LinkedIn employee seats (no tokens) for the multi-seat workspace. */
  linkedinSeats?: SeatView[];
  /** Plan seat limit + per-extra-seat credit cost for the monetization gate UI. */
  seatLimit?: number;
  seatCost?: number;
}

/* ── Official SVG logos ──────────────────────────────────────────────── */

function LinkedInLogo() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className="h-5 w-5" aria-hidden="true">
      <path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433a2.062 2.062 0 01-2.063-2.065 2.064 2.064 0 112.063 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z" />
    </svg>
  );
}

function XLogo() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className="h-4 w-4" aria-hidden="true">
      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-4.714-6.231-5.401 6.231H2.744l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
    </svg>
  );
}

function FacebookLogo() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className="h-5 w-5" aria-hidden="true">
      <path d="M9.101 23.691v-7.98H6.627v-3.667h2.474v-1.58c0-4.085 1.848-5.978 5.858-5.978.401 0 .955.042 1.468.103a8.68 8.68 0 011.141.195v3.325a8.623 8.623 0 00-.653-.036 26.805 26.805 0 00-.733-.009c-.707 0-1.259.096-1.675.309a1.686 1.686 0 00-.679.622c-.258.42-.374.995-.374 1.752v1.297h3.919l-.386 2.103-.287 1.564h-3.246v8.245C19.396 23.238 24 18.179 24 12.044c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.628 3.874 10.35 9.101 11.647z" />
    </svg>
  );
}

function InstagramLogo() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className="h-5 w-5" aria-hidden="true">
      <path d="M12 2.163c3.204 0 3.584.012 4.85.07 3.252.148 4.771 1.691 4.919 4.919.058 1.265.069 1.645.069 4.849 0 3.205-.012 3.584-.069 4.849-.149 3.225-1.664 4.771-4.919 4.919-1.266.058-1.644.07-4.85.07-3.204 0-3.584-.012-4.849-.07-3.26-.149-4.771-1.699-4.919-4.92-.058-1.265-.07-1.644-.07-4.849 0-3.204.013-3.583.07-4.849.149-3.227 1.664-4.771 4.919-4.919 1.266-.057 1.645-.069 4.849-.069zm0-2.163c-3.259 0-3.667.014-4.947.072-4.358.2-6.78 2.618-6.98 6.98-.059 1.281-.073 1.689-.073 4.948 0 3.259.014 3.668.072 4.948.2 4.358 2.618 6.78 6.98 6.98 1.281.058 1.689.072 4.948.072 3.259 0 3.668-.014 4.948-.072 4.354-.2 6.782-2.618 6.979-6.98.059-1.28.073-1.689.073-4.948 0-3.259-.014-3.667-.072-4.947-.196-4.354-2.617-6.78-6.979-6.98-1.281-.059-1.69-.073-4.949-.073zm0 5.838c-3.403 0-6.162 2.759-6.162 6.162s2.759 6.163 6.162 6.163 6.162-2.759 6.162-6.163c0-3.403-2.759-6.162-6.162-6.162zm0 10.162c-2.209 0-4-1.79-4-4 0-2.209 1.791-4 4-4s4 1.791 4 4c0 2.21-1.791 4-4 4zm6.406-11.845c-.796 0-1.441.645-1.441 1.44s.645 1.44 1.441 1.44c.795 0 1.439-.645 1.439-1.44s-.644-1.44-1.439-1.44z" />
    </svg>
  );
}

function YouTubeLogo() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className="h-5 w-5" aria-hidden="true">
      <path d="M23.498 6.186a3.016 3.016 0 00-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 00.502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 002.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 002.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z" />
    </svg>
  );
}

function TikTokLogo() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className="h-5 w-5" aria-hidden="true">
      <path d="M12.525.02c1.31-.02 2.61-.01 3.91-.02.08 1.53.63 3.09 1.75 4.17 1.12 1.11 2.7 1.62 4.24 1.79v4.03c-1.44-.05-2.89-.35-4.2-.97-.57-.26-1.1-.59-1.62-.93-.01 2.92.01 5.84-.02 8.75-.08 1.4-.54 2.79-1.35 3.94-1.31 1.92-3.58 3.17-5.91 3.21-1.43.08-2.86-.31-4.08-1.03-2.02-1.19-3.44-3.37-3.65-5.71-.02-.5-.03-1-.01-1.49.18-1.9 1.12-3.72 2.58-4.96 1.66-1.44 3.98-2.13 6.15-1.72.02 1.48-.04 2.96-.04 4.44-.99-.32-2.15-.23-3.02.37-.63.41-1.11 1.04-1.36 1.75-.21.51-.15 1.07-.14 1.61.24 1.64 1.82 3.02 3.5 2.87 1.12-.01 2.19-.66 2.77-1.61.19-.33.4-.67.41-1.06.1-1.79.06-3.57.07-5.36.01-4.03-.01-8.05.02-12.07z" />
    </svg>
  );
}

function GoogleLogo() {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" aria-hidden="true">
      <path fill="#4285F4" d="M23.52 12.273c0-.851-.076-1.67-.218-2.455H12v4.645h6.458a5.52 5.52 0 01-2.394 3.622v3.01h3.878c2.269-2.09 3.578-5.166 3.578-8.822z" />
      <path fill="#34A853" d="M12 24c3.24 0 5.956-1.075 7.942-2.905l-3.878-3.01c-1.075.72-2.45 1.147-4.064 1.147-3.126 0-5.77-2.112-6.715-4.948H1.28v3.108A11.998 11.998 0 0012 24z" />
      <path fill="#FBBC05" d="M5.285 14.284A7.21 7.21 0 014.909 12c0-.793.136-1.564.376-2.284V6.608H1.28A11.998 11.998 0 000 12c0 1.936.463 3.768 1.28 5.392l4.005-3.108z" />
      <path fill="#EA4335" d="M12 4.77c1.762 0 3.344.606 4.588 1.795l3.442-3.442C17.951 1.19 15.236 0 12 0 7.31 0 3.253 2.69 1.28 6.608l4.005 3.108C6.23 6.882 8.874 4.77 12 4.77z" />
    </svg>
  );
}

const PLATFORM_LOGOS: Record<string, React.ReactNode> = {
  linkedin: <LinkedInLogo />,
  linkedin_community: <LinkedInLogo />,
  twitter: <XLogo />,
  facebook: <FacebookLogo />,
  instagram: <InstagramLogo />,
  youtube: <YouTubeLogo />,
  tiktok: <TikTokLogo />,
};

/* ── Branded connect button ──────────────────────────────────────────── */

interface BrandButtonProps {
  platform: PlatformConfig;
  loading?: boolean;
  onClick: () => void;
}

function BrandedConnectButton({ platform, loading, onClick }: BrandButtonProps) {
  /* Platform marks render monochrome in OUR palette (brand §11) — the chip
     carries the border and hover, never the platform's own colors. */
  return (
    <button
      onClick={onClick}
      disabled={loading}
      className={cn(
        "relative inline-flex w-full items-center justify-center gap-2.5 rounded-md border border-border bg-foreground/[0.04] px-4 py-2.5 text-sm font-medium text-foreground/80 transition-colors duration-200",
        "hover:border-neon/50 hover:text-neon",
        "disabled:pointer-events-none disabled:opacity-60",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-foreground/25",
      )}
    >
      {loading ? (
        <svg
          className="h-4 w-4 animate-spin"
          viewBox="0 0 24 24"
          fill="none"
          aria-hidden="true"
        >
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path
            className="opacity-75"
            fill="currentColor"
            d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
          />
        </svg>
      ) : (
        PLATFORM_LOGOS[platform.id]
      )}
      {loading ? "Connecting…" : `Connect with ${platform.name}`}
    </button>
  );
}

/* ── Platform card ───────────────────────────────────────────────────── */

function PlatformCard({
  platform,
  integration,
  clientId,
  isOAuthEnabled,
  isConnecting,
  isAdmin,
  onOAuthConnect,
  onDisconnected,
  linkedinSeats,
  seatLimit,
  seatCost,
}: {
  platform: PlatformConfig;
  integration: IntegrationView | undefined;
  clientId: string;
  isOAuthEnabled: boolean;
  isConnecting: boolean;
  isAdmin: boolean;
  onOAuthConnect: () => void;
  onDisconnected: () => void;
  linkedinSeats?: SeatView[];
  seatLimit?: number;
  seatCost?: number;
}) {
  // True when this platform has an automated OAuth flow defined (static config).
  // Decoupled from isOAuthEnabled (env-var check) so all users can see the
  // Connect button regardless of whether the server env vars are wired up.
  const hasOAuthSupport = OAUTH_SUPPORTED_PLATFORM_IDS.has(platform.id);
  const isConnected = !!integration;
  // "Healthy" (fully connected, no reconnect needed) drives the subtle glow —
  // a reconnect-needed card should read as a warning, not a success state.
  const isHealthyConnected = isConnected && !integrationNeedsReconnect(integration!);
  // Absent flag = enabled (pre-toggle integrations keep auto-publishing).
  const [autoPublish, setAutoPublish] = useState(integration?.autoPublish !== false);
  const [togglingAuto, setTogglingAuto] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [seatsOpen, setSeatsOpen] = useState(false);
  const [accountName, setAccountName] = useState(integration?.accountName ?? "");
  const [fields, setFields] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {};
    for (const f of platform.fields) {
      init[f.key] = f.type === "password" ? "" : (integration?.credentials[f.key] ?? "");
    }
    return init;
  });

  // Re-sync form defaults when integration data changes after OAuth
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional re-sync when integration prop changes
    setAccountName(integration?.accountName ?? "");
    setAutoPublish(integration?.autoPublish !== false);
    const next: Record<string, string> = {};
    for (const f of platform.fields) {
      next[f.key] = f.type === "password" ? "" : (integration?.credentials[f.key] ?? "");
    }
    setFields(next);
  }, [integration, platform.fields]);

  function setField(key: string, value: string) {
    setFields((prev) => ({ ...prev, [key]: value }));
  }

  async function handleManualSave() {
    const missing = platform.fields.filter(
      (f) => f.required && !isConnected && !fields[f.key].trim(),
    );
    if (missing.length > 0) {
      setFormError(`Required: ${missing.map((f) => f.label).join(", ")}`);
      return;
    }
    setSaving(true);
    setFormError(null);
    try {
      // A blank password field means "keep the stored secret" — the server carries
      // it over, since secrets are never sent here to merge back.
      await saveIntegrationAction(clientId, platform.id, fields, accountName || undefined);
      setAdvancedOpen(false);
    } catch (e) {
      setFormError(e instanceof Error ? e.message : "Save failed. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  async function handleAutoPublishToggle() {
    const next = !autoPublish;
    setAutoPublish(next); // optimistic — revalidation corrects on failure
    setTogglingAuto(true);
    try {
      await setIntegrationAutoPublishAction(clientId, platform.id, next);
    } catch {
      setAutoPublish(!next);
    } finally {
      setTogglingAuto(false);
    }
  }

  async function handleDisconnect() {
    setDisconnecting(true);
    try {
      await deleteIntegrationAction(clientId, platform.id);
      setAdvancedOpen(false);
      onDisconnected();
    } catch {
      // revalidation corrects state
    } finally {
      setDisconnecting(false);
    }
  }

  // ── Body ──────────────────────────────────────────────────────────────
  return (
    <div
      className={cn(
        "overflow-hidden rounded-[var(--radius)] border flex h-full flex-col transition-colors",
        advancedOpen
          ? "border-border-strong"
          : isHealthyConnected
            ? "border-success/30 shadow-lg shadow-success/10"
            : "border-border",
      )}
      style={{ background: "var(--surface)" }}
    >
      {/* Header */}
      <div className="flex items-start gap-3 p-4">
        {/* Platform icon — monochrome chip in our palette (brand §11) */}
        <div className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-md border border-foreground/10 bg-foreground/[0.04] text-foreground/80">
          <Icon name={platform.icon} className="h-5 w-5" />
        </div>

        {/* Text */}
        <div className="min-w-0 flex-1 space-y-0.5">
          <div className="flex flex-wrap items-center gap-2">
            <p className="font-semibold leading-none">{platform.name}</p>
            {isConnected ? (
              integration && integrationNeedsReconnect(integration) ? (
                <Badge tone="warning">
                  <Icon name="TriangleAlert" className="h-3 w-3" />
                  Reconnect needed
                </Badge>
              ) : (
                <Badge tone="neon">
                  <Icon name="CheckCircle2" className="h-3 w-3" />
                  Connected
                </Badge>
              )
            ) : (
              <Badge tone="neutral">Not connected</Badge>
            )}
          </div>
          {isConnected && integration?.accountName ? (
            <p className="truncate text-xs text-muted">{integration.accountName}</p>
          ) : (
            <p className="truncate text-xs text-muted-2">{platform.description}</p>
          )}
          {isConnected && (
            <p className="text-[10px] text-muted-2">
              {integration!.method === "oauth" ? "OAuth" : "Manual"}
            </p>
          )}
        </div>
      </div>

      {/* Action area — mt-auto pins it to the bottom of the card regardless of
          how much (or little) header content sits above it, so Connect /
          Reconnect / Disconnect line up across every card in the row. */}
      <div className="mt-auto px-4 pb-4 space-y-3">
        {/* OAuth connect — available to all users when this platform supports OAuth */}
        {!isConnected && hasOAuthSupport && (
          <BrandedConnectButton
            platform={platform}
            loading={isConnecting}
            onClick={onOAuthConnect}
          />
        )}

        {/* Admin-only hint when OAuth flow exists but env vars aren't configured yet */}
        {isAdmin && hasOAuthSupport && !isOAuthEnabled && (
          <p className="text-[11px] text-warning/80">
            OAuth env vars not set. The button above will fail until configured.
          </p>
        )}

        {/* Three-tier publishing control: on = the cron auto-posts scheduled
            content here; off = content goes out only via manual Publish Now.
            Hidden for read/analytics-only platforms — there's nothing to publish. */}
        {isConnected && !READ_ONLY_PLATFORM_IDS.has(platform.id) && (
          <button
            onClick={handleAutoPublishToggle}
            disabled={togglingAuto}
            className="flex w-full items-center justify-between gap-2 rounded-md border border-border bg-foreground/[0.03] px-3 py-2 transition-colors hover:border-border-strong disabled:opacity-60"
            title={
              autoPublish
                ? "Scheduled content posts automatically at its slot"
                : "Auto-posting is off. Publish through the Publish Now button only"
            }
          >
            <span className="flex items-center gap-1.5 text-xs text-muted">
              <Icon name="Zap" className="h-3.5 w-3.5" />
              Auto-publish scheduled content
            </span>
            <span
              className={cn(
                "relative inline-flex h-4 w-7 shrink-0 items-center rounded-full transition-colors",
                autoPublish ? "bg-neon/80" : "bg-foreground/15",
              )}
              aria-checked={autoPublish}
              role="switch"
            >
              <span
                className={cn(
                  "inline-block h-3 w-3 transform rounded-full bg-surface transition-transform",
                  autoPublish ? "translate-x-3.5" : "translate-x-0.5",
                )}
              />
            </span>
          </button>
        )}

        {isConnected && (
          <div className="flex items-center gap-2">
            {hasOAuthSupport && (
              <Button
                size="sm"
                variant="outline"
                onClick={onOAuthConnect}
                loading={isConnecting}
                className="flex-1"
              >
                <Icon name="RefreshCw" className="h-3.5 w-3.5" />
                Reconnect
              </Button>
            )}
            <Button
              size="sm"
              variant="danger"
              onClick={handleDisconnect}
              loading={disconnecting}
              className={hasOAuthSupport ? "" : "flex-1"}
            >
              <Icon name="Unplug" className="h-3.5 w-3.5" />
              Disconnect
            </Button>
          </div>
        )}

        {/* LinkedIn employee-advocacy roster lives in a modal, not inline —
            an unbounded seat list must never dictate this card's height. */}
        {platform.id === "linkedin" && isConnected && (
          <Button size="sm" variant="outline" className="w-full" onClick={() => setSeatsOpen(true)}>
            <Icon name="Users" className="h-3.5 w-3.5" />
            Manage Employee Seats
            {linkedinSeats && linkedinSeats.length > 0 && ` (${linkedinSeats.length}/${seatLimit ?? 2})`}
          </Button>
        )}

        {/* Admin-only: manual credentials toggle */}
        {isAdmin && (
          <button
            onClick={() => setAdvancedOpen((o) => !o)}
            className="flex w-full items-center gap-1.5 text-[11px] text-muted-2 hover:text-muted transition-colors"
          >
            <Icon
              name="ChevronDown"
              className={cn(
                "h-3 w-3 transition-transform duration-200",
                advancedOpen && "rotate-180",
              )}
            />
            {isConnected ? "Edit credentials" : "Manual setup"}
          </button>
        )}
      </div>

      {/* Advanced / manual form — accordion */}
      {isAdmin && (
        <div
          className={cn(
            "grid transition-[grid-template-rows] duration-300 ease-in-out",
            advancedOpen ? "grid-rows-[1fr]" : "grid-rows-[0fr]",
          )}
        >
          <div className="overflow-hidden">
            <div className="space-y-3 border-t border-border px-4 pb-5 pt-4">
              <p className="text-[11px] font-mono font-medium uppercase tracking-[0.14em] text-muted-2">
                Manual credentials
              </p>

              <div>
                <Label>Display name / handle <span className="text-muted-2">(optional)</span></Label>
                <Input
                  value={accountName}
                  onChange={(e) => setAccountName(e.target.value)}
                  placeholder="@yourbrand"
                />
              </div>

              {platform.fields.map((f) => (
                <div key={f.key}>
                  <Label>
                    {f.label}
                    {f.required && <span className="ml-1 text-danger">*</span>}
                  </Label>
                  <Input
                    type={f.type}
                    value={fields[f.key] ?? ""}
                    onChange={(e) => setField(f.key, e.target.value)}
                    placeholder={
                      f.type === "password" && integration?.secretsSet.includes(f.key)
                        ? "Leave blank to keep existing"
                        : f.placeholder
                    }
                    autoComplete="off"
                  />
                  {f.hint && <p className="mt-1 text-[11px] text-muted-2">{f.hint}</p>}
                </div>
              ))}

              {formError && (
                <p className="rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger">
                  {formError}
                </p>
              )}

              <div className="flex gap-2 pt-1">
                <Button size="sm" onClick={handleManualSave} loading={saving}>
                  <Icon name="Save" className="h-3.5 w-3.5" />
                  {isConnected ? "Update" : "Save"}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => { setAdvancedOpen(false); setFormError(null); }}
                  disabled={saving}
                >
                  Cancel
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* LinkedIn employee-advocacy multi-seat workspace — modal, not inline,
          so an unbounded roster never resizes the card in the grid. */}
      {platform.id === "linkedin" && isConnected && (
        <Modal
          open={seatsOpen}
          onClose={() => setSeatsOpen(false)}
          title="Company Employee Roster"
          description="Add teammates to publish and measure content on their own LinkedIn handle."
          className="max-w-2xl"
        >
          <LinkedInSeatsWorkspace
            clientId={clientId}
            seats={linkedinSeats ?? []}
            seatLimit={seatLimit ?? 2}
            seatCost={seatCost ?? 100}
          />
        </Modal>
      )}
    </div>
  );
}

/* ── Unified Google card ─────────────────────────────────────────────
 * Replaces three separate cards (Search Console / Analytics / Business
 * Profile) with one. All three share one OAuth flow (provider id
 * "google_unified" — see oauth.ts) that fans a single token pair out to all
 * three ClientIntegration docs server-side; this card is purely a different
 * way of looking at + managing those same three docs, not a fourth doc of
 * its own. YouTube stays a separate standalone card in the grid — it's also
 * a publish target, unlike these three. ────────────────────────────── */

const GOOGLE_SUB_SERVICES = [
  { id: "google_search_console", label: "Search Console" },
  { id: "google_analytics", label: "Analytics" },
  { id: "google_business_profile", label: "Business Profile" },
] as const;

function GoogleUnifiedCard({
  integrations,
  youtubeConnected,
  clientId,
  isOAuthEnabled,
  isConnecting,
  isAdmin,
  onOAuthConnect,
  onDisconnected,
}: {
  integrations: IntegrationView[];
  /** Whether the (separately-connected, standalone) YouTube card is linked —
   * shown here only as an at-a-glance status pill, not a control. */
  youtubeConnected: boolean;
  clientId: string;
  isOAuthEnabled: boolean;
  isConnecting: boolean;
  isAdmin: boolean;
  onOAuthConnect: () => void;
  onDisconnected: () => void;
}) {
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [disconnectingId, setDisconnectingId] = useState<string | null>(null);

  const byId = new Map(integrations.map((i) => [i.platform, i]));
  const connectedCount = GOOGLE_SUB_SERVICES.filter((s) => byId.has(s.id)).length;
  const allConnected = connectedCount === GOOGLE_SUB_SERVICES.length;
  const anyConnected = connectedCount > 0;
  const anyNeedsReconnect = GOOGLE_SUB_SERVICES.some((s) => {
    const i = byId.get(s.id);
    return i && integrationNeedsReconnect(i);
  });
  const isHealthyConnected = allConnected && !anyNeedsReconnect;

  async function handleDisconnectSub(id: string) {
    setDisconnectingId(id);
    try {
      await deleteIntegrationAction(clientId, id);
      onDisconnected();
    } catch {
      // revalidation corrects state
    } finally {
      setDisconnectingId(null);
    }
  }

  return (
    <div
      className={cn(
        "overflow-hidden rounded-[var(--radius)] border flex h-full flex-col transition-colors",
        advancedOpen
          ? "border-border-strong"
          : isHealthyConnected
            ? "border-success/30 shadow-lg shadow-success/10"
            : "border-border",
      )}
      style={{ background: "var(--surface)" }}
    >
      {/* Header */}
      <div className="flex items-start gap-3 p-4">
        <div className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-md border border-foreground/10 bg-foreground/[0.04]">
          <GoogleLogo />
        </div>
        <div className="min-w-0 flex-1 space-y-0.5">
          <div className="flex flex-wrap items-center gap-2">
            <p className="font-semibold leading-none">Google Services Suite</p>
            {allConnected ? (
              anyNeedsReconnect ? (
                <Badge tone="warning">
                  <Icon name="TriangleAlert" className="h-3 w-3" />
                  Reconnect needed
                </Badge>
              ) : (
                <Badge tone="neon">
                  <Icon name="CheckCircle2" className="h-3 w-3" />
                  Connected
                </Badge>
              )
            ) : anyConnected ? (
              <Badge tone="warning">
                {connectedCount} / {GOOGLE_SUB_SERVICES.length} connected
              </Badge>
            ) : (
              <Badge tone="neutral">Not connected</Badge>
            )}
          </div>
          <p className="truncate text-xs text-muted-2">
            Connect Google Analytics 4, Search Console, YouTube, and Business Profile in a single
            authorization step.
          </p>
          {/* Dynamic per-service status chips — YouTube is informational only
              here (it keeps its own standalone card + OAuth below, since it's
              also a publish target), so this pill isn't part of GOOGLE_SUB_SERVICES. */}
          <div className="flex flex-wrap gap-1.5 pt-1.5">
            {[...GOOGLE_SUB_SERVICES, { id: "youtube", label: "YouTube" }].map((s) => {
              const connected = s.id === "youtube" ? youtubeConnected : byId.has(s.id);
              return (
                <span
                  key={s.id}
                  className={cn(
                    "inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10px] font-medium",
                    connected ? "border-neon/40 text-neon" : "border-border text-muted-2",
                  )}
                >
                  <span
                    className={cn(
                      "h-1.5 w-1.5 rounded-full",
                      connected ? "bg-neon" : "bg-foreground/20",
                    )}
                  />
                  {s.label}
                </span>
              );
            })}
          </div>
        </div>
      </div>

      {/* Action area */}
      <div className="px-4 pb-4 space-y-3">
        <button
          onClick={onOAuthConnect}
          disabled={isConnecting}
          className={cn(
            "relative inline-flex w-full items-center justify-center gap-2.5 rounded-md border border-border bg-foreground/[0.04] px-4 py-2.5 text-sm font-medium text-foreground/80 transition-colors duration-200",
            "hover:border-neon/50 hover:text-neon",
            "disabled:pointer-events-none disabled:opacity-60",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-foreground/25",
          )}
        >
          {isConnecting ? (
            <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
          ) : (
            <GoogleLogo />
          )}
          {isConnecting ? "Connecting…" : anyConnected ? "Reconnect Google Suite" : "Connect Google Suite"}
        </button>

        {isAdmin && !isOAuthEnabled && (
          <p className="text-[11px] text-warning/80">
            OAuth env vars not set (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET). The button above will
            fail until configured.
          </p>
        )}

        {isAdmin && (
          <button
            onClick={() => setAdvancedOpen((o) => !o)}
            className="flex w-full items-center gap-1.5 text-[11px] text-muted-2 hover:text-muted transition-colors"
          >
            <Icon
              name="ChevronDown"
              className={cn("h-3 w-3 transition-transform duration-200", advancedOpen && "rotate-180")}
            />
            Manage individual services
          </button>
        )}
      </div>

      {/* Per-service breakdown — admin only */}
      {isAdmin && (
        <div
          className={cn(
            "grid transition-[grid-template-rows] duration-300 ease-in-out",
            advancedOpen ? "grid-rows-[1fr]" : "grid-rows-[0fr]",
          )}
        >
          <div className="overflow-hidden">
            <div className="space-y-2 border-t border-border px-4 pb-5 pt-4">
              {GOOGLE_SUB_SERVICES.map((s) => {
                const integration = byId.get(s.id);
                return (
                  <div
                    key={s.id}
                    className="flex items-center justify-between gap-2 rounded-md border border-border bg-foreground/[0.03] px-3 py-2"
                  >
                    <div className="min-w-0">
                      <p className="text-xs font-medium">{s.label}</p>
                      <p className="truncate text-[11px] text-muted-2">
                        {integration
                          ? (integration.accountName || "Connected via unified flow")
                          : "Not connected"}
                      </p>
                    </div>
                    {integration && (
                      <Button
                        size="sm"
                        variant="danger"
                        onClick={() => handleDisconnectSub(s.id)}
                        loading={disconnectingId === s.id}
                      >
                        <Icon name="Unplug" className="h-3.5 w-3.5" />
                      </Button>
                    )}
                  </div>
                );
              })}
              <p className="pt-1 text-[11px] text-muted-2">
                Reconnecting always goes through the button above — Google issues one token pair
                covering all three services at once, so there&apos;s no separate per-service OAuth.
              </p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ── Tab root ────────────────────────────────────────────────────────── */

export function IntegrationsTab({
  clientId,
  integrations,
  oauthEnabledPlatforms,
  currentUserRole,
  linkedinSeats = [],
  seatLimit = 2,
  seatCost = 100,
}: Props) {
  const router = useRouter();
  const isAdmin = currentUserRole === "KAROS_ADMIN";
  const [connectingPlatform, setConnectingPlatform] = useState<string | null>(null);
  const [popupError, setPopupError] = useState<string | null>(null);
  const popupTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // The three read-only Google services render as ONE merged card, so they
  // count as one slot here too — otherwise this stat would disagree with
  // what's visually on screen (e.g. "6/9" while only 7 cards are shown).
  const googleMergedIds = new Set<string>(GOOGLE_READ_ONLY_SUB_PLATFORM_IDS);
  const standalonePlatforms = PLATFORM_REGISTRY.filter((p) => !googleMergedIds.has(p.id));
  const connectedGoogleCount = GOOGLE_READ_ONLY_SUB_PLATFORM_IDS.filter((id) =>
    integrations.some((i) => i.platform === id),
  ).length;
  const connectedCount =
    standalonePlatforms.filter((p) => integrations.some((i) => i.platform === p.id)).length +
    (connectedGoogleCount > 0 ? 1 : 0);
  const totalCardCount = standalonePlatforms.length + 1; // +1 for the merged Google Services Suite card

  // Two sections, driven by each platform's registry `category` — a new
  // platform lands in the right section just by declaring one, no UI changes.
  const publishingPlatforms = standalonePlatforms.filter((p) => p.category === "publishing");
  const analyticsStandalonePlatforms = standalonePlatforms.filter((p) => p.category === "analytics");

  // Listen for postMessage from OAuth popup
  useEffect(() => {
    function handleMessage(e: MessageEvent) {
      if (e.origin !== window.location.origin) return;
      if (e.data?.type === "karos_oauth_success") {
        if (popupTimerRef.current) clearInterval(popupTimerRef.current);
        setConnectingPlatform(null);
        setPopupError(null);
        router.refresh();
      }
      if (e.data?.type === "karos_oauth_error") {
        if (popupTimerRef.current) clearInterval(popupTimerRef.current);
        setConnectingPlatform(null);
        setPopupError(e.data.error ?? "OAuth failed. Please try again.");
      }
    }
    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [router]);

  function openOAuthPopup(provider: string) {
    setConnectingPlatform(provider);
    setPopupError(null);

    const w = 600, h = 720;
    const left = Math.max(0, (screen.width - w) / 2);
    const top = Math.max(0, (screen.height - h) / 2);

    const popup = window.open(
      `/api/auth/social/${provider}?clientId=${clientId}`,
      `karos_oauth_${provider}`,
      `width=${w},height=${h},left=${left},top=${top},scrollbars=yes`,
    );

    if (!popup || popup.closed) {
      setConnectingPlatform(null);
      setPopupError("Popup was blocked. Please allow popups for this site and try again.");
      return;
    }

    // Fallback: detect if popup closed without completing
    if (popupTimerRef.current) clearInterval(popupTimerRef.current);
    popupTimerRef.current = setInterval(() => {
      if (popup.closed) {
        clearInterval(popupTimerRef.current!);
        setConnectingPlatform((prev) => (prev === provider ? null : prev));
      }
    }, 600);
  }

  function renderPlatformCard(platform: PlatformConfig) {
    const integration = integrations.find((i) => i.platform === platform.id);
    return (
      <PlatformCard
        key={platform.id}
        platform={platform}
        integration={integration}
        clientId={clientId}
        isOAuthEnabled={oauthEnabledPlatforms.includes(platform.id)}
        isConnecting={connectingPlatform === platform.id}
        isAdmin={isAdmin}
        onOAuthConnect={() => openOAuthPopup(platform.id)}
        onDisconnected={() => router.refresh()}
        {...(platform.id === "linkedin" ? { linkedinSeats, seatLimit, seatCost } : {})}
      />
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-base font-semibold">Connected Channels</h2>
          <p className="mt-0.5 text-sm text-muted-2">
            Link accounts so agents can publish content and pull performance data automatically.
          </p>
        </div>
        {connectedCount > 0 && (
          <Badge tone="neon">
            {connectedCount} / {totalCardCount} connected
          </Badge>
        )}
      </div>

      {/* Popup error banner */}
      {popupError && (
        <div className="flex items-center gap-2.5 rounded-md border border-danger/30 bg-danger/10 px-4 py-3">
          <Icon name="AlertCircle" className="h-4 w-4 shrink-0 text-danger" />
          <p className="text-sm text-danger">{popupError}</p>
          <button
            onClick={() => setPopupError(null)}
            className="ml-auto text-danger/60 hover:text-danger"
            aria-label="Dismiss"
          >
            <Icon name="X" className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {/* Social Publishing & Engagement */}
      <section className="space-y-3">
        <div>
          <h3 className="text-sm font-semibold text-foreground">Social Publishing & Engagement</h3>
          <p className="text-xs text-muted-2">Channels your agents post and schedule content to.</p>
        </div>
        <div className="grid grid-cols-1 items-start gap-6 md:grid-cols-2 lg:grid-cols-3">
          {publishingPlatforms.map(renderPlatformCard)}
        </div>
      </section>

      {/* Analytics & Performance Intelligence — the three read-only Google
          services (Search Console / Analytics / Business Profile) render as
          ONE merged card; YouTube's own standalone card stays in Publishing
          since it's also a post target, but its status still surfaces here
          as an info pill on the Google Suite card. */}
      <section className="space-y-3">
        <div>
          <h3 className="text-sm font-semibold text-foreground">Analytics & Performance Intelligence</h3>
          <p className="text-xs text-muted-2">
            Read-only sources agents pull performance data and content ideas from.
          </p>
        </div>
        <div className="grid grid-cols-1 items-start gap-6 md:grid-cols-2 lg:grid-cols-3">
          {analyticsStandalonePlatforms.map(renderPlatformCard)}
          <GoogleUnifiedCard
            integrations={integrations.filter((i) => googleMergedIds.has(i.platform))}
            youtubeConnected={integrations.some((i) => i.platform === "youtube")}
            clientId={clientId}
            isOAuthEnabled={oauthEnabledPlatforms.includes("google_unified")}
            isConnecting={connectingPlatform === "google_unified"}
            isAdmin={isAdmin}
            onOAuthConnect={() => openOAuthPopup("google_unified")}
            onDisconnected={() => router.refresh()}
          />
        </div>
      </section>

      {/* Footer note */}
      <p className="text-xs text-muted-2">
        Credentials are stored securely server-side and accessed only by your agents during
        automated publishing runs.
      </p>
    </div>
  );
}
