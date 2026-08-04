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
  PENDING_VERIFICATION_PLATFORM_IDS,
  READ_ONLY_PLATFORM_IDS,
  GOOGLE_READ_ONLY_SUB_PLATFORM_IDS,
  type PlatformConfig,
} from "@/lib/integrations/platforms";
import { SocialPlatformMark, platformForIntegrationId } from "@/components/agent-identity";
import { integrationIsUsable, integrationNeedsReconnect } from "@/lib/integration-status";
import { LinkedInSeatsWorkspace, type SeatView } from "@/components/linkedin-seats-workspace";
import type { Role } from "@/lib/types";

export type { IntegrationView } from "@/lib/integrations/sanitize";
import type { IntegrationView } from "@/lib/integrations/sanitize";

interface Props {
  clientId: string;
  integrations: IntegrationView[];
  oauthEnabledPlatforms: string[];
  /** False until Google approves Business Profile access — see oauth.ts. */
  googleBusinessProfileRequested: boolean;
  currentUserRole: Role;
  /** Sanitized LinkedIn employee seats (no tokens) for the multi-seat workspace. */
  linkedinSeats?: SeatView[];
  /** Plan seat limit + per-extra-seat credit cost for the monetization gate UI. */
  seatLimit?: number;
  seatCost?: number;
}

/* ── Platform marks - one shared source (agent-identity) for the whole app ── */

function PlatformMark({ id, className }: { id: string; className?: string }) {
  const platform = platformForIntegrationId(id);
  return platform ? <SocialPlatformMark platform={platform} className={className} /> : null;
}

/** Google's multicolor G - inherently multi-color, so it stays local rather than
    joining the monochrome shared marks. Used by the Google Services Suite card. */
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
  linkedin_community: { background: "#0A66C2" },
  twitter: { background: "#000000", ring: true },
  youtube: { background: "#FF0000" },
  tiktok: { background: "#000000", ring: true },
  reddit: { background: "#FF4500" },
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

/**
 * Refusals from the card's actions arrive as DATA ({ error }) and are already
 * written for a client to read, so they render verbatim. A throw reaching these
 * handlers is therefore not a refusal but a transport failure - or an exception
 * Next has masked behind an opaque production digest ("An error occurred in the
 * Server Components render… digest: 1234567890"). Never render that: the catch
 * blocks below always substitute their own line, which is the allowlist
 * direction F34 established (no internal string reaches a client because a
 * filter failed to recognise it).
 */

/**
 * One channels section, connected first. Every platform used to render as an
 * identical full-height card whether it was live or had never been touched, so
 * on a nine-card grid reading "Not connected" eight times, the one channel that
 * actually mattered was lost in the noise.
 *
 * Live channels keep the full card. The rest collapse into a compact add-row
 * list; clicking one expands that platform's real card in place, so nothing is
 * removed - only deferred.
 */
function ChannelSection({
  title,
  blurb,
  platforms,
  statusOf,
  tagOf,
  renderCard,
  leadingCards,
}: {
  title: string;
  blurb: string;
  platforms: PlatformConfig[];
  /**
   * Three buckets, not two. "needs-reconnect" MUST keep its full card: an
   * expired token is the one state a client has to act on, and collapsing it
   * into the add-list hid the Reconnect badge behind a click and replaced the
   * warning with the platform's marketing blurb - a broken channel reading as
   * fine and filed away. Only a platform with no integration doc at all is
   * genuinely "not set up" and safe to collapse.
   */
  statusOf: (p: PlatformConfig) => "live" | "needs-reconnect" | "absent";
  /**
   * Short status word for a collapsed row - "Coming soon" / "Pending
   * verification" - so a client can tell a platform isn't connectable yet
   * without clicking to expand it. Null when the platform is simply unset up
   * but fully connectable right now.
   */
  tagOf?: (p: PlatformConfig) => string | null;
  renderCard: (p: PlatformConfig) => React.ReactNode;
  /** Always-full cards that belong to this section (the merged Google suite). */
  leadingCards?: React.ReactNode;
}) {
  const [expanded, setExpanded] = useState<string[]>([]);
  const live = platforms.filter((p) => statusOf(p) === "live");
  const needsReconnect = platforms.filter((p) => statusOf(p) === "needs-reconnect");
  const absent = platforms.filter((p) => statusOf(p) === "absent");
  const opened = absent.filter((p) => expanded.includes(p.id));
  const collapsed = absent.filter((p) => !expanded.includes(p.id));

  return (
    <section className="space-y-3">
      <div>
        <h3 className="text-sm font-semibold text-foreground">{title}</h3>
        <p className="text-xs text-muted-2">{blurb}</p>
      </div>

      {(live.length > 0 || needsReconnect.length > 0 || opened.length > 0 || leadingCards) && (
        <div className="grid grid-cols-1 items-start gap-6 @2xl:grid-cols-2 @4xl:grid-cols-3">
          {/* Healthy first, then the ones needing attention - both as full
              cards, so a Reconnect badge is never a click away. */}
          {live.map(renderCard)}
          {needsReconnect.map(renderCard)}
          {leadingCards}
          {opened.map(renderCard)}
        </div>
      )}

      {collapsed.length > 0 && (
        <div className="overflow-hidden rounded-[var(--radius)] border border-border">
          <p className="border-b border-border bg-foreground/[0.03] px-3 py-2 text-[11px] font-medium uppercase tracking-wide text-muted-2">
            Add a channel
          </p>
          <ul className="divide-y divide-border">
            {collapsed.map((p) => {
              const tag = tagOf?.(p) ?? null;
              return (
                <li key={p.id}>
                  <button
                    type="button"
                    onClick={() => setExpanded((prev) => [...prev, p.id])}
                    className="flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors hover:bg-surface-2/60"
                  >
                    <PlatformMark id={p.id} className="h-4 w-4 shrink-0 text-muted-2" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm text-foreground">{p.name}</span>
                      <span className="block truncate text-[11px] text-muted-2">{p.description}</span>
                    </span>
                    {tag && (
                      <span className="shrink-0 rounded-full border border-border px-2 py-0.5 text-[10px] font-medium text-muted-2">
                        {tag}
                      </span>
                    )}
                    <Icon name="Plus" className="h-3.5 w-3.5 shrink-0 text-muted-2" />
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </section>
  );
}

function PlatformCard({
  platform,
  integration,
  clientId,
  isOAuthEnabled,
  isConnecting,
  isAdmin,
  isClientViewer,
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
  /** Required, not defaulted: a missing role must not fail open to staff copy. */
  isClientViewer: boolean;
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
  // The OAuth flow exists but the platform has not approved our developer
  // account yet, so a Connect click can only end in a failed popup. Say so.
  const pendingVerification = !isConnected && PENDING_VERIFICATION_PLATFORM_IDS.has(platform.id);
  // Nothing to connect to yet on OUR side: the OAuth app credentials for this
  // platform haven't been set (isOAuthEnabled reads the env vars live, so this
  // flips the moment ops adds them - no redeploy-and-hope, no stale flag). A
  // client pressing a live-looking Connect button here would only open a popup
  // that fails, so the button is replaced with a disabled "Coming soon" state
  // instead of shipping a control that cannot work.
  const comingSoon = !isConnected && hasOAuthSupport && !isOAuthEnabled && !pendingVerification;
  // "Healthy" (fully connected, no reconnect needed) drives the subtle glow -
  // a reconnect-needed card should read as a warning, not a success state.
  const isHealthyConnected = isConnected && !integrationNeedsReconnect(integration!);
  // Absent flag = enabled (pre-toggle integrations keep auto-publishing).
  const [autoPublish, setAutoPublish] = useState(integration?.autoPublish !== false);
  const [togglingAuto, setTogglingAuto] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  /**
   * Failures from the card's own controls (auto-publish, Disconnect). Separate
   * from formError, which renders inside the admin credentials form and is
   * therefore invisible whenever that form is collapsed - which is exactly when
   * these two controls are used.
   */
  const [actionError, setActionError] = useState<string | null>(null);
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
      // A blank password field means "keep the stored secret" - the server carries
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
    setAutoPublish(next); // optimistic - reverted below if the write is refused
    setTogglingAuto(true);
    setActionError(null);
    try {
      const res = await setIntegrationAutoPublishAction(clientId, platform.id, next);
      if (res.error) {
        // The revert stays; what was missing is the reason. A switch that moves
        // twice on its own is indistinguishable from a network blip.
        setAutoPublish(!next);
        setActionError(res.error);
      }
    } catch {
      setAutoPublish(!next);
      setActionError("Couldn't change auto-publish. Please try again.");
    } finally {
      setTogglingAuto(false);
    }
  }

  async function handleDisconnect() {
    setDisconnecting(true);
    setActionError(null);
    try {
      const res = await deleteIntegrationAction(clientId, platform.id);
      if (res.error) {
        // The old comment here claimed "revalidation corrects state" - nothing
        // revalidates on the failure path, so the card just stayed Connected and
        // said nothing.
        setActionError(res.error);
        return;
      }
      setAdvancedOpen(false);
      onDisconnected();
    } catch {
      setActionError("Couldn't disconnect this channel. Please try again.");
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
        {/* Platform mark - the real brand logo, monochrome chip in our palette */}
        <div className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-md border border-foreground/10 bg-foreground/[0.04] text-foreground/80">
          <PlatformMark id={platform.id} className="h-5 w-5" />
        </div>

        {/* Text - name and status stack on every card (a wrapping row let the
            badge sit beside short names like TikTok, breaking the grid rhythm) */}
        <div className="min-w-0 flex-1 space-y-1">
          <p className="font-semibold leading-none">{platform.name}</p>
          <div className="flex flex-wrap items-center gap-2">
            {isConnected ? (
              integration && integrationNeedsReconnect(integration) ? (
                <Badge tone="warning">
                  <Icon name="TriangleAlert" className="h-3 w-3" />
                  Reconnect needed
                </Badge>
              ) : (
                <Badge tone="neon">
                  <Icon name="CircleCheck" className="h-3 w-3" />
                  Connected
                </Badge>
              )
            ) : pendingVerification ? (
              <Badge tone="warning">
                <Icon name="Clock" className="h-3 w-3" />
                Pending verification
              </Badge>
            ) : comingSoon ? (
              <Badge tone="neutral">
                <Icon name="Clock" className="h-3 w-3" />
                Coming soon
              </Badge>
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

      {/* Action area - mt-auto pins it to the bottom of the card regardless of
          how much (or little) header content sits above it, so Connect /
          Reconnect / Disconnect line up across every card in the row. */}
      <div className="mt-auto px-4 pb-4 space-y-3">
        {/* OAuth connect - available to all users when this platform supports
            OAuth, EXCEPT while the platform still has to approve our developer
            account: that button can only open a popup that fails. */}
        {!isConnected && hasOAuthSupport && !pendingVerification && !comingSoon && (
          <BrandedConnectButton
            platform={platform}
            loading={isConnecting}
            onClick={onOAuthConnect}
          />
        )}

        {pendingVerification && (
          <p className="rounded-md border border-warning/25 bg-warning/10 px-3 py-2 text-[11px] leading-relaxed text-warning">
            {platform.name} is reviewing our developer account. Connecting is not available yet.
            Your Karos team will turn it on the moment it is approved.
          </p>
        )}

        {/* Disabled in place of a Connect button that could only fail - no
            popup gets a chance to open. Same disabled-control treatment
            everyone sees; only the line below it is role-aware. Removed the
            moment isOAuthEnabled flips true (ops adding the platform's env
            vars), no other change needed - see comingSoon above. */}
        {comingSoon && (
          <button
            disabled
            className="flex w-full items-center justify-center gap-2 rounded-md border border-border bg-foreground/[0.03] px-4 py-2.5 text-sm font-semibold text-muted-2 opacity-70"
          >
            <Icon name="Clock" className="h-3.5 w-3.5" />
            Coming soon
          </button>
        )}
        {comingSoon && (
          <p className="text-[11px] text-muted-2">
            {isAdmin
              ? "OAuth env vars not set for this platform. Add them to enable Connect."
              : "This channel isn't connectable yet. Ask your Karos team to finish setting it up."}
          </p>
        )}

        {/* Three-tier publishing control: on = the cron auto-posts scheduled
            content here; off = it goes out by hand. WHOSE hand differs, so the
            off-copy is role-aware: Publish Now lives in the calendar's post
            detail panel and is staff-only (publishAssetNowAction is
            requireStaff), while a client posts from their own account and
            records it with "Mark as posted". Naming a control the reader cannot
            see is the defect this whole finding is about.
            Hidden for read/analytics-only platforms - there's nothing to publish. */}
        {isConnected && !READ_ONLY_PLATFORM_IDS.has(platform.id) && (
          <button
            onClick={handleAutoPublishToggle}
            disabled={togglingAuto}
            className="flex w-full items-center justify-between gap-2 rounded-md border border-border bg-foreground/[0.03] px-3 py-2 transition-colors hover:border-border-strong disabled:opacity-60"
            title={
              autoPublish
                ? "Scheduled content posts automatically at its slot"
                : isClientViewer
                  ? "Auto-posting is off. Scheduled content waits on your calendar for you to post it yourself, then mark it as posted"
                  : "Auto-posting is off. Scheduled content waits on the calendar until someone opens it and presses Publish Now"
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
            {/* Staff only. deleteIntegrationAction is requireStaff, so for a
                client this button could never do anything but fail - and it
                failed silently, giving them a spinner and nothing else, every
                single time. Gated on staff rather than isAdmin because
                employees are permitted to disconnect. */}
            {!isClientViewer && (
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
            )}
          </div>
        )}

        {actionError && (
          <p className="rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger">
            {actionError}
          </p>
        )}

        {/* LinkedIn employee-advocacy roster lives in a modal, not inline -
            an unbounded seat list must never dictate this card's height. */}
        {platform.id === "linkedin" && isConnected && (
          <Button size="sm" variant="outline" className="w-full" onClick={() => setSeatsOpen(true)}>
            <Icon name="Users" className="h-3.5 w-3.5" />
            Manage employee seats
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

      {/* Advanced / manual form - accordion */}
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
          so an unbounded roster never resizes the card in the grid.

          Titled "Employee seats" and not "Company Employee Roster": this card is
          on the client settings page AND inside the onboarding wizard, and the
          button that opens it says "Manage employee seats" — a dialog must not
          rename the thing its own trigger just named. */}
      {platform.id === "linkedin" && isConnected && (
        <Modal
          open={seatsOpen}
          onClose={() => setSeatsOpen(false)}
          title="Employee seats"
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
 * "google_unified" - see oauth.ts) that fans a single token pair out to all
 * three ClientIntegration docs server-side; this card is purely a different
 * way of looking at + managing those same three docs, not a fourth doc of
 * its own. YouTube stays a separate standalone card in the grid - it's also
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
  businessProfileRequested,
  onOAuthConnect,
  onDisconnected,
}: {
  integrations: IntegrationView[];
  /** Whether the (separately-connected, standalone) YouTube card is linked -
   * shown here only as an at-a-glance status pill, not a control. */
  youtubeConnected: boolean;
  clientId: string;
  isOAuthEnabled: boolean;
  isConnecting: boolean;
  isAdmin: boolean;
  /**
   * Whether the consent request actually asks for Business Profile. Google
   * gates that scope behind a manual approval, and until it lands the portal
   * deliberately leaves it out — so the card must not count it as a service
   * the client failed to connect.
   */
  businessProfileRequested: boolean;
  onOAuthConnect: () => void;
  onDisconnected: () => void;
}) {
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [disconnectingId, setDisconnectingId] = useState<string | null>(null);
  /** Failure text for a per-service disconnect - this card had no error slot. */
  const [subError, setSubError] = useState<string | null>(null);

  const byId = new Map(integrations.map((i) => [i.platform, i]));
  // A service the consent screen never asked for is not one the client failed
  // to connect. Without this the gated Business Profile scope makes a perfect
  // connect read "2 / 3 connected" and never reach the healthy badge.
  const offered = GOOGLE_SUB_SERVICES.filter(
    (s) => s.id !== "google_business_profile" || businessProfileRequested,
  );
  const connectedCount = offered.filter((s) => byId.has(s.id)).length;
  const allConnected = connectedCount === offered.length;
  const anyConnected = connectedCount > 0;
  // Same "nothing to connect to yet on our side" gate as the platform cards -
  // Google shares one OAuth app across all four services, so it's one flag.
  const comingSoon = !anyConnected && !isOAuthEnabled;
  const anyNeedsReconnect = offered.some((s) => {
    const i = byId.get(s.id);
    return i && integrationNeedsReconnect(i);
  });
  const isHealthyConnected = allConnected && !anyNeedsReconnect;

  async function handleDisconnectSub(id: string) {
    setDisconnectingId(id);
    setSubError(null);
    try {
      const res = await deleteIntegrationAction(clientId, id);
      if (res.error) {
        // Same empty catch as the platform card had, and the same claim that
        // "revalidation corrects state" - it doesn't on the failure path. This
        // card had no error slot at all, so the refusal had nowhere to go.
        setSubError(res.error);
        return;
      }
      onDisconnected();
    } catch {
      setSubError("Couldn't disconnect this service. Please try again.");
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
        {/* Name and status stack, matching every platform card */}
        <div className="min-w-0 flex-1 space-y-1">
          <p className="font-semibold leading-none">Google Services Suite</p>
          <div className="flex flex-wrap items-center gap-2">
            {allConnected ? (
              anyNeedsReconnect ? (
                <Badge tone="warning">
                  <Icon name="TriangleAlert" className="h-3 w-3" />
                  Reconnect needed
                </Badge>
              ) : (
                <Badge tone="neon">
                  <Icon name="CircleCheck" className="h-3 w-3" />
                  Connected
                </Badge>
              )
            ) : anyConnected ? (
              <Badge tone="warning">
                {connectedCount} / {offered.length} connected
              </Badge>
            ) : comingSoon ? (
              <Badge tone="neutral">
                <Icon name="Clock" className="h-3 w-3" />
                Coming soon
              </Badge>
            ) : (
              <Badge tone="neutral">Not connected</Badge>
            )}
          </div>
          <p className="truncate text-xs text-muted-2">
            Connect Google Analytics 4, Search Console, YouTube, and Business Profile in a single
            authorization step.
          </p>
          {/* Dynamic per-service status chips - YouTube is informational only
              here (it keeps its own standalone card + OAuth below, since it's
              also a publish target), so this pill isn't part of GOOGLE_SUB_SERVICES. */}
          <div className="flex flex-wrap gap-1.5 pt-1.5">
            {[...offered, { id: "youtube", label: "YouTube" }].map((s) => {
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
        {/* Official Google button treatment: white ground, multicolor G, dark label.
            Replaced entirely by a disabled "Coming soon" control while the app's
            own Google OAuth credentials aren't set - see comingSoon above. */}
        {comingSoon ? (
          <button
            disabled
            className="flex w-full items-center justify-center gap-2 rounded-md border border-border bg-foreground/[0.03] px-4 py-2.5 text-sm font-semibold text-muted-2 opacity-70"
          >
            <Icon name="Clock" className="h-3.5 w-3.5" />
            Coming soon
          </button>
        ) : (
          <button
            onClick={onOAuthConnect}
            disabled={isConnecting}
            className={cn(
              "relative inline-flex w-full items-center justify-center gap-2.5 rounded-md bg-white px-4 py-2.5 text-sm font-semibold text-[#1f1f1f] shadow-sm transition-all duration-200",
              "hover:-translate-y-px hover:shadow-md hover:brightness-[0.97]",
              "disabled:pointer-events-none disabled:opacity-60",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-foreground/40",
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
        )}

        {/* Same rule as the platform cards: everyone who can press the button
            gets told it can't work yet (QA F55) - only admins get the env-var
            detail. */}
        {comingSoon && (
          <p className="text-[11px] text-muted-2">
            {isAdmin
              ? "OAuth env vars not set (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET). Add them to enable Connect."
              : "Google Suite isn't connectable yet. Ask your Karos team to finish setting it up."}
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

      {/* Per-service breakdown - admin only */}
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
              {subError && (
                <p className="rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger">
                  {subError}
                </p>
              )}
              <p className="pt-1 text-[11px] text-muted-2">
                Reconnecting always goes through the button above. Google issues one token pair
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
  googleBusinessProfileRequested,
  currentUserRole,
  linkedinSeats = [],
  seatLimit = 2,
  seatCost = 100,
}: Props) {
  const router = useRouter();
  const isAdmin = currentUserRole === "KAROS_ADMIN";
  // This tab renders on /clients/[id]/settings, which a client can open for
  // their own workspace - so copy here has to know who is reading it.
  const isClientViewer = currentUserRole === "CLIENT_USER";
  const [connectingPlatform, setConnectingPlatform] = useState<string | null>(null);
  const [popupError, setPopupError] = useState<string | null>(null);
  const popupTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // The three read-only Google services render as ONE merged card, so they
  // count as one slot here too - otherwise this stat would disagree with
  // what's visually on screen (e.g. "6/9" while only 7 cards are shown).
  const googleMergedIds = new Set<string>(GOOGLE_READ_ONLY_SUB_PLATFORM_IDS);
  const standalonePlatforms = PLATFORM_REGISTRY.filter((p) => !googleMergedIds.has(p.id));
  // Counts follow the same three-bucket rule as the grid. The badge used to
  // count any integration DOC as connected, with no status check, so an expired
  // channel was tallied as working - the count and the card contradicted each
  // other. "Connected" now means usable; anything needing a reconnect is
  // reported separately rather than being quietly folded into a green number.
  const usableGoogleCount = GOOGLE_READ_ONLY_SUB_PLATFORM_IDS.filter((id) => {
    const i = integrations.find((x) => x.platform === id);
    return !!i && integrationIsUsable(i);
  }).length;
  const staleGoogleCount = GOOGLE_READ_ONLY_SUB_PLATFORM_IDS.filter((id) => {
    const i = integrations.find((x) => x.platform === id);
    return !!i && !integrationIsUsable(i);
  }).length;
  const connectedCount =
    standalonePlatforms.filter((p) => platformStatus(p) === "live").length +
    (usableGoogleCount > 0 ? 1 : 0);
  const needsReconnectCount =
    standalonePlatforms.filter((p) => platformStatus(p) === "needs-reconnect").length +
    (usableGoogleCount === 0 && staleGoogleCount > 0 ? 1 : 0);
  const totalCardCount = standalonePlatforms.length + 1; // +1 for the merged Google Services Suite card

  // Two sections, driven by each platform's registry `category` - a new
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
    return () => {
      window.removeEventListener("message", handleMessage);
      // The popup-closed poll started by openOAuthPopup outlives this effect
      // (it's keyed off a ref, not effect state) - without this, navigating
      // away while a popup is still open leaves its setInterval running forever.
      if (popupTimerRef.current) clearInterval(popupTimerRef.current);
    };
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

  /**
   * Which of the three buckets a platform sits in. "absent" means no
   * integration doc at all - the only state that is genuinely not set up. A
   * dead-token integration is "needs-reconnect": still a channel the client
   * owns, and the one that most needs to stay on screen.
   */
  function platformStatus(platform: PlatformConfig): "live" | "needs-reconnect" | "absent" {
    const integration = integrations.find((i) => i.platform === platform.id);
    if (!integration) return "absent";
    return integrationIsUsable(integration) ? "live" : "needs-reconnect";
  }

  /** Collapsed-row tag - same two gates the full card uses (see comingSoon
      in PlatformCard), computed here without an integration to point at. */
  function platformTag(platform: PlatformConfig): string | null {
    if (PENDING_VERIFICATION_PLATFORM_IDS.has(platform.id)) return "Pending verification";
    if (OAUTH_SUPPORTED_PLATFORM_IDS.has(platform.id) && !oauthEnabledPlatforms.includes(platform.id)) {
      return "Coming soon";
    }
    return null;
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
        isClientViewer={isClientViewer}
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
          <h2 className="text-base font-semibold">Connected channels</h2>
          <p className="mt-0.5 text-sm text-muted-2">
            Link accounts so agents can publish content and pull performance data automatically.
          </p>
        </div>
        {(connectedCount > 0 || needsReconnectCount > 0) && (
          <div className="shrink-0 text-right">
            {connectedCount > 0 && (
              <Badge tone="neon">
                {connectedCount} / {totalCardCount} connected
              </Badge>
            )}
            {needsReconnectCount > 0 && (
              <p className="mt-1 text-[11px] text-warning">
                {needsReconnectCount} {needsReconnectCount === 1 ? "needs" : "need"} attention
              </p>
            )}
          </div>
        )}
      </div>

      {/* Popup error banner */}
      {popupError && (
        <div className="flex items-center gap-2.5 rounded-md border border-danger/30 bg-danger/10 px-4 py-3">
          <Icon name="CircleAlert" className="h-4 w-4 shrink-0 text-danger" />
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

      {/* Social publishing & engagement */}
      <ChannelSection
        title="Social publishing &amp; engagement"
        blurb="Channels your agents post and schedule content to."
        platforms={publishingPlatforms}
        statusOf={platformStatus}
        tagOf={platformTag}
        renderCard={renderPlatformCard}
      />

      {/* Analytics & Performance Intelligence - the three read-only Google
          services (Search Console / Analytics / Business Profile) render as
          ONE merged card; YouTube's own standalone card stays in Publishing
          since it's also a post target, but its status still surfaces here
          as an info pill on the Google Suite card. */}
      <ChannelSection
        title="Analytics &amp; performance intelligence"
        blurb="Read-only sources agents pull performance data and content ideas from."
        platforms={analyticsStandalonePlatforms}
        statusOf={platformStatus}
        tagOf={platformTag}
        renderCard={renderPlatformCard}
        leadingCards={
          // The merged Google suite is one card covering three services and has
          // its own internal connected/not state, so it always renders in full
          // rather than partitioning with the standalone platforms.
          <GoogleUnifiedCard
            key="google_unified"
            integrations={integrations.filter((i) => googleMergedIds.has(i.platform))}
            youtubeConnected={integrations.some((i) => i.platform === "youtube")}
            clientId={clientId}
            isOAuthEnabled={oauthEnabledPlatforms.includes("google_unified")}
            businessProfileRequested={googleBusinessProfileRequested}
            isConnecting={connectingPlatform === "google_unified"}
            isAdmin={isAdmin}
            onOAuthConnect={() => openOAuthPopup("google_unified")}
            onDisconnected={() => router.refresh()}
          />
        }
      />

      {/* Footer note */}
      <p className="text-xs text-muted-2">
        Credentials are stored securely server-side and accessed only by your agents during
        automated publishing runs.
      </p>
    </div>
  );
}
