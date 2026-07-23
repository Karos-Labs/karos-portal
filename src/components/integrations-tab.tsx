"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Button, Badge, Input, Label } from "@/components/ui";
import { Icon } from "@/components/icon";
import { cn } from "@/lib/utils";
import {
  saveIntegrationAction,
  deleteIntegrationAction,
  setIntegrationAutoPublishAction,
} from "@/lib/actions";
import { PLATFORM_REGISTRY, OAUTH_SUPPORTED_PLATFORM_IDS, type PlatformConfig } from "@/lib/integrations/platforms";
import { SocialPlatformMark, platformForIntegrationId } from "@/components/agent-identity";
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

/* ── Platform marks — one shared source (agent-identity) for the whole app ── */

function PlatformMark({ id, className }: { id: string; className?: string }) {
  const platform = platformForIntegrationId(id);
  return platform ? <SocialPlatformMark platform={platform} className={className} /> : null;
}

/* ── Branded connect button ──────────────────────────────────────────── */

/**
 * Official OAuth-button treatment: the platform's own brand color carries the
 * button (Instagram keeps its gradient; X and TikTok are brand-black with a
 * hairline ring so they read on the dark ground), white logo + label.
 */
const CONNECT_STYLE: Record<string, { background: string; ring?: boolean }> = {
  instagram: { background: "linear-gradient(45deg, #F58529 0%, #DD2A7B 55%, #8134AF 100%)" },
  facebook: { background: "#1877F2" },
  linkedin: { background: "#0A66C2" },
  twitter: { background: "#000000", ring: true },
  youtube: { background: "#FF0000" },
  tiktok: { background: "#000000", ring: true },
};

interface BrandButtonProps {
  platform: PlatformConfig;
  loading?: boolean;
  onClick: () => void;
}

function BrandedConnectButton({ platform, loading, onClick }: BrandButtonProps) {
  const style = CONNECT_STYLE[platform.id];
  return (
    <button
      onClick={onClick}
      disabled={loading}
      className={cn(
        "relative inline-flex w-full items-center justify-center gap-2.5 rounded-md px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition-all duration-200",
        "hover:-translate-y-px hover:brightness-110 hover:shadow-md",
        style?.ring && "ring-1 ring-inset ring-white/25",
        "disabled:pointer-events-none disabled:opacity-60",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-foreground/40",
      )}
      style={{ background: style?.background ?? "var(--surface-3)" }}
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
        <PlatformMark id={platform.id} className="h-4 w-4" />
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
  // Absent flag = enabled (pre-toggle integrations keep auto-publishing).
  const [autoPublish, setAutoPublish] = useState(integration?.autoPublish !== false);
  const [togglingAuto, setTogglingAuto] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
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
        "overflow-hidden rounded-[var(--radius)] border flex flex-col transition-colors",
        advancedOpen ? "border-border-strong" : "border-border",
      )}
      style={{ background: "var(--surface)" }}
    >
      {/* Header */}
      <div className="flex items-start gap-3 p-4">
        {/* Platform mark — the real brand logo, monochrome chip in our palette */}
        <div className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-md border border-foreground/10 bg-foreground/[0.04] text-foreground/80">
          <PlatformMark id={platform.id} className="h-5 w-5" />
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

      {/* Action area */}
      <div className="px-4 pb-4 space-y-3">
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
            content here; off = content goes out only via manual Publish Now. */}
        {isConnected && (
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

      {/* LinkedIn employee-advocacy multi-seat workspace (connected LinkedIn only) */}
      {platform.id === "linkedin" && isConnected && (
        <LinkedInSeatsWorkspace
          clientId={clientId}
          seats={linkedinSeats ?? []}
          seatLimit={seatLimit ?? 2}
          seatCost={seatCost ?? 100}
        />
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

  const connectedCount = PLATFORM_REGISTRY.filter((p) =>
    integrations.some((i) => i.platform === p.id),
  ).length;

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

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-base font-semibold">Connected Channels</h2>
          <p className="mt-0.5 text-sm text-muted-2">
            Link your social accounts so agents can publish content automatically.
          </p>
        </div>
        {connectedCount > 0 && (
          <Badge tone="neon">
            {connectedCount} / {PLATFORM_REGISTRY.length} connected
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

      {/* Platform grid */}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {PLATFORM_REGISTRY.map((platform) => {
          const integration = integrations.find((i) => i.platform === platform.id);
          const oauthEnabled = oauthEnabledPlatforms.includes(platform.id);
          return (
            <PlatformCard
              key={platform.id}
              platform={platform}
              integration={integration}
              clientId={clientId}
              isOAuthEnabled={oauthEnabled}
              isConnecting={connectingPlatform === platform.id}
              isAdmin={isAdmin}
              onOAuthConnect={() => openOAuthPopup(platform.id)}
              onDisconnected={() => router.refresh()}
              {...(platform.id === "linkedin" ? { linkedinSeats, seatLimit, seatCost } : {})}
            />
          );
        })}
      </div>

      {/* Footer note */}
      <p className="text-xs text-muted-2">
        Credentials are stored securely server-side and accessed only by your agents during
        automated publishing runs. To enable OAuth for additional platforms, add the
        corresponding environment variables (e.g.{" "}
        <span className="font-mono text-muted">LINKEDIN_CLIENT_ID</span>) and redeploy.
      </p>
    </div>
  );
}
