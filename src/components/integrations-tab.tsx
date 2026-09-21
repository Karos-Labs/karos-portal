"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { Button, Badge, Input, Label } from "@/components/ui";
import { Icon } from "@/components/icon";
import { Modal } from "@/components/modal";
import { cn } from "@/lib/utils";
import { CREDIT_COSTS, DEFAULT_LINKEDIN_SEAT_LIMIT } from "@/lib/credits";
import {
  saveIntegrationAction,
  deleteIntegrationAction,
  setIntegrationAutoPublishAction,
  setIntegrationAgentAutoPublishAction,
  fetchClientBusinessInfoAction,
  fetchClientInstagramBusinessInsightsAction,
} from "@/lib/actions";
import type { MetaBusinessAccount } from "@/lib/integrations/meta-business";
import type { InstagramBusinessAccountInsights } from "@/lib/integrations/instagram-business-graph";
import {
  PLATFORM_REGISTRY,
  OAUTH_SUPPORTED_PLATFORM_IDS,
  PENDING_VERIFICATION_PLATFORM_IDS,
  READ_ONLY_PLATFORM_IDS,
  type PlatformConfig,
} from "@/lib/integrations/platforms";
import { SocialPlatformMark, platformForIntegrationId } from "@/components/agent-identity";
import { integrationIsUsable, integrationNeedsReconnect } from "@/lib/integration-status";
import { AGENT_DRAFT_PLATFORM_IDS } from "@/lib/agent-draft-auto-publish";

/**
 * Whether the card's ONE publish-timing switch should bind to
 * `ClientIntegration.agentAutoPublish` (agent-drafted "note" content —
 * LinkedIn/X today) instead of `autoPublish` (the cron's scheduled-content
 * flag, every other platform). Product ruling, 2026-09-21, third round: the
 * product owner rejected a second, separate "Agent draft auto-publish"
 * checklist section outright ("Integrations already has, on every card, a
 * switch for whether there's approval to auto-publish or not") — ONE switch
 * per card, same slot, same component, just pointed at whichever field is
 * actually meaningful for that platform.
 */
function isAgentDraftSwitchPlatform(platformId: string): boolean {
  return (AGENT_DRAFT_PLATFORM_IDS as readonly string[]).includes(platformId);
}

/**
 * The switch's own label + tooltip, chosen by which field it is actually
 * bound to (see `isAgentDraftSwitchPlatform`) — the generic "scheduled
 * content" copy no longer describes what the switch does on a LinkedIn/X
 * card, so it needed its own words rather than reusing the cron's.
 */
function autoPublishSwitchCopy(
  agentDraftSwitch: boolean,
  autoPublish: boolean,
  isClientViewer: boolean,
): { label: string; title: string } {
  if (agentDraftSwitch) {
    return {
      label: "Auto-publish agent drafts once approved",
      title: autoPublish
        ? "An approved agent draft for this channel publishes immediately, through this connection"
        : "Off. An approved agent draft waits here until someone presses that draft's own Publish Now",
    };
  }
  return {
    label: "Auto-publish scheduled content",
    title: autoPublish
      ? "Scheduled content posts automatically at its slot"
      : isClientViewer
        ? "Auto-posting is off. Scheduled content waits on your calendar for you to post it yourself, then mark it as posted"
        : "Auto-posting is off. Scheduled content waits on the calendar until someone opens it and presses Publish Now",
  };
}
import { LinkedInSeatsWorkspace, type SeatView } from "@/components/linkedin-seats-workspace";
import { ContactUsButton } from "@/components/contact-us-modal";
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

/* ── Platform marks - one shared source (agent-identity) for the whole app ── */

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
  // Same brand gradient as "instagram" above — this is Instagram's OTHER
  // login product, not a different platform.
  instagram_business: { background: "linear-gradient(45deg, #F58529 0%, #DD2A7B 55%, #8134AF 100%)" },
  /* No facebook row — this map is keyed by PLATFORM_REGISTRY id and Facebook
     left that registry (portal feedback round 2, 2026-09), so the entry could
     only ever be dead style. */
  linkedin: { background: "#0A66C2" },
  linkedin_community: { background: "#0A66C2" },
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
        // round 6 (rule 2): these keep the platform's own brand fill, but the
        // hover is a colour change and nothing else - no lift, no shadow step -
        // and focus is the portal's one `.focus-ring`.
        "focus-ring relative inline-flex w-full items-center justify-center gap-2.5 rounded-md px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition-colors duration-150",
        "hover:brightness-110",
        style?.ring && "ring-1 ring-inset ring-white/25",
        "disabled:pointer-events-none disabled:opacity-60",
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
  /** Always-full cards that belong to this section, rendered ahead of the grid. */
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
          {/* FLOW AUDIT 2026-09, R17. `expanded` only ever grew: a client who
              opened "Add a channel" to look at a platform could not put it back,
              so an exploratory click permanently lengthened their Settings tab
              for the rest of the session. The card itself is unchanged; the
              control that undoes the expansion sits under it. Only rows that
              were EXPANDED get one — a live or reconnect-needed channel is not
              collapsible and must not look it. */}
          {opened.map((p) => (
            <div key={p.id}>
              {renderCard(p)}
              <button
                type="button"
                onClick={() => setExpanded((prev) => prev.filter((id) => id !== p.id))}
                className="mt-1.5 flex items-center gap-1 text-[11px] text-muted-2 transition-colors hover:text-foreground"
              >
                <Icon name="ChevronUp" className="h-3 w-3" />
                Hide {p.name}
              </button>
            </div>
          ))}
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
  // LinkedIn/X: agentAutoPublish, absent/false ⇒ OFF (every existing client
  // starts off — see the flag's own doc comment in lib/types.ts for why a
  // safe default matters here specifically). Every other platform: the
  // pre-existing autoPublish cron flag, absent ⇒ ON (pre-toggle integrations
  // keep auto-publishing scheduled content, unchanged).
  const agentDraftSwitch = isAgentDraftSwitchPlatform(platform.id);
  const [autoPublish, setAutoPublish] = useState(
    agentDraftSwitch ? integration?.agentAutoPublish === true : integration?.autoPublish !== false,
  );
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
    setAutoPublish(agentDraftSwitch ? integration?.agentAutoPublish === true : integration?.autoPublish !== false);
    const next: Record<string, string> = {};
    for (const f of platform.fields) {
      next[f.key] = f.type === "password" ? "" : (integration?.credentials[f.key] ?? "");
    }
    setFields(next);
  }, [integration, platform.fields, agentDraftSwitch]);

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
      // LinkedIn/X bind this same switch to agentAutoPublish instead of the
      // cron's autoPublish flag — see isAgentDraftSwitchPlatform's own doc.
      const res = agentDraftSwitch
        ? await setIntegrationAgentAutoPublishAction(clientId, platform.id, next)
        : await setIntegrationAutoPublishAction(clientId, platform.id, next);
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
          <>
            <p className="text-[11px] text-muted-2">
              {isAdmin
                ? "OAuth env vars not set for this platform. Add them to enable Connect."
                : "This channel isn't connectable yet. Ask your Karos team to finish setting it up."}
            </p>
            {/* R17: the line above told a client to ask their Karos team and
                gave them nothing to press. An admin reading it has the env-var
                remedy instead, so the control is the client's alone.

                NO `label`: the support dialog keeps its one name (R7). The
                sentence directly above already says who the client is asking
                and what about. */}
            {!isAdmin && (
              <div className="-mx-2">
                <ContactUsButton variant="row" />
              </div>
            )}
          </>
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
            title={autoPublishSwitchCopy(agentDraftSwitch, autoPublish, isClientViewer).title}
          >
            <span className="flex items-center gap-1.5 text-xs text-muted">
              <Icon name="Zap" className="h-3.5 w-3.5" />
              {autoPublishSwitchCopy(agentDraftSwitch, autoPublish, isClientViewer).label}
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
              <p className="text-[11px] font-label font-medium uppercase tracking-[0.14em] text-muted-2">
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

    </div>
  );
}

/* ── Shared: one underlying OAuth connection's status + actions ────────
 * Instagram and LinkedIn each merge TWO real, separately-connected
 * ClientIntegration platforms into one card below (Instagram: `instagram` /
 * `instagram_business`; LinkedIn: `linkedin` / `linkedin_community`) - see
 * the two card components below for why. This is the connect/reconnect/
 * disconnect/auto-publish/manual-credentials block PlatformCard renders
 * once per card, factored out so it can be rendered once PER UNDERLYING
 * PLATFORM inside a merged card instead of being written twice more.
 */
function SubConnection({
  platform,
  integration,
  clientId,
  isOAuthEnabled,
  isConnecting,
  isAdmin,
  isClientViewer,
  onOAuthConnect,
  onDisconnected,
  descriptor,
  label,
  connectLabel,
}: {
  platform: PlatformConfig;
  integration: IntegrationView | undefined;
  clientId: string;
  isOAuthEnabled: boolean;
  isConnecting: boolean;
  isAdmin: boolean;
  isClientViewer: boolean;
  onOAuthConnect: () => void;
  onDisconnected: () => void;
  /** @clientCopy One line describing THIS specific connection (not the merged card's platform in general). */
  descriptor: string;
  /** @clientCopy Heading text for this row. Defaults to platform.name, which is not always specific enough once two rows share one card. */
  label?: string;
  /** @clientCopy Overrides "Connect with {name}" so the button can name the specific login product. */
  connectLabel?: string;
}) {
  const isConnected = !!integration;
  const pendingVerification = !isConnected && PENDING_VERIFICATION_PLATFORM_IDS.has(platform.id);
  const comingSoon = !isConnected && !isOAuthEnabled && !pendingVerification;
  const needsReconnect = isConnected && integrationNeedsReconnect(integration!);
  // Same split as PlatformCard's identical block — see isAgentDraftSwitchPlatform.
  const agentDraftSwitch = isAgentDraftSwitchPlatform(platform.id);
  const [autoPublish, setAutoPublish] = useState(
    agentDraftSwitch ? integration?.agentAutoPublish === true : integration?.autoPublish !== false,
  );
  const [togglingAuto, setTogglingAuto] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [accountName, setAccountName] = useState(integration?.accountName ?? "");
  const [fields, setFields] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {};
    for (const f of platform.fields) {
      init[f.key] = f.type === "password" ? "" : (integration?.credentials[f.key] ?? "");
    }
    return init;
  });

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional re-sync when integration prop changes
    setAccountName(integration?.accountName ?? "");
    setAutoPublish(agentDraftSwitch ? integration?.agentAutoPublish === true : integration?.autoPublish !== false);
    const next: Record<string, string> = {};
    for (const f of platform.fields) {
      next[f.key] = f.type === "password" ? "" : (integration?.credentials[f.key] ?? "");
    }
    setFields(next);
  }, [integration, platform.fields, agentDraftSwitch]);

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
    setAutoPublish(next);
    setTogglingAuto(true);
    setActionError(null);
    try {
      // LinkedIn/X bind this same switch to agentAutoPublish instead of the
      // cron's autoPublish flag — see isAgentDraftSwitchPlatform's own doc.
      const res = agentDraftSwitch
        ? await setIntegrationAgentAutoPublishAction(clientId, platform.id, next)
        : await setIntegrationAutoPublishAction(clientId, platform.id, next);
      if (res.error) {
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

  return (
    <div className="space-y-2.5 rounded-md border border-border/70 bg-foreground/[0.015] p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <PlatformMark id={platform.id} className="h-3.5 w-3.5 shrink-0 text-muted-2" />
          <p className="truncate text-xs font-semibold text-foreground">{label ?? platform.name}</p>
        </div>
        {isConnected ? (
          needsReconnect ? (
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
        <p className="truncate text-[11px] text-muted">{integration.accountName}</p>
      ) : (
        <p className="text-[11px] text-muted-2">{descriptor}</p>
      )}

      {!isConnected && !pendingVerification && !comingSoon && (
        <BrandedConnectButton
          platform={connectLabel ? { ...platform, name: connectLabel } : platform}
          loading={isConnecting}
          onClick={onOAuthConnect}
        />
      )}

      {pendingVerification && (
        <p className="rounded-md border border-warning/25 bg-warning/10 px-3 py-2 text-[11px] leading-relaxed text-warning">
          {platform.name} is reviewing our developer account. Connecting is not available yet.
        </p>
      )}

      {comingSoon && (
        <>
          <button
            disabled
            className="flex w-full items-center justify-center gap-2 rounded-md border border-border bg-foreground/[0.03] px-3 py-2 text-xs font-semibold text-muted-2 opacity-70"
          >
            <Icon name="Clock" className="h-3.5 w-3.5" />
            Coming soon
          </button>
          <p className="text-[11px] text-muted-2">
            {isAdmin
              ? "OAuth env vars not set for this connection. Add them to enable Connect."
              : "This connection isn't set up yet. Ask your Karos team to finish setting it up."}
          </p>
        </>
      )}

      {isConnected && !READ_ONLY_PLATFORM_IDS.has(platform.id) && (
        <button
          onClick={handleAutoPublishToggle}
          disabled={togglingAuto}
          className="flex w-full items-center justify-between gap-2 rounded-md border border-border bg-foreground/[0.03] px-2.5 py-1.5 transition-colors hover:border-border-strong disabled:opacity-60"
          title={autoPublishSwitchCopy(agentDraftSwitch, autoPublish, isClientViewer).title}
        >
          <span className="flex items-center gap-1.5 text-[11px] text-muted">
            <Icon name="Zap" className="h-3.5 w-3.5" />
            {autoPublishSwitchCopy(agentDraftSwitch, autoPublish, isClientViewer).label}
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
          <Button size="sm" variant="outline" onClick={onOAuthConnect} loading={isConnecting} className="flex-1">
            <Icon name="RefreshCw" className="h-3.5 w-3.5" />
            Reconnect
          </Button>
          {!isClientViewer && (
            <Button size="sm" variant="danger" onClick={handleDisconnect} loading={disconnecting}>
              <Icon name="Unplug" className="h-3.5 w-3.5" />
              Disconnect
            </Button>
          )}
        </div>
      )}

      {actionError && (
        <p className="rounded-md border border-danger/30 bg-danger/10 px-2.5 py-2 text-[11px] text-danger">
          {actionError}
        </p>
      )}

      {isAdmin && (
        <button
          onClick={() => setAdvancedOpen((o) => !o)}
          className="flex w-full items-center gap-1.5 text-[10px] text-muted-2 hover:text-muted transition-colors"
        >
          <Icon
            name="ChevronDown"
            className={cn("h-3 w-3 transition-transform duration-200", advancedOpen && "rotate-180")}
          />
          {isConnected ? "Edit credentials" : "Manual setup"}
        </button>
      )}

      {isAdmin && (
        <div
          className={cn(
            "grid transition-[grid-template-rows] duration-300 ease-in-out",
            advancedOpen ? "grid-rows-[1fr]" : "grid-rows-[0fr]",
          )}
        >
          <div className="overflow-hidden">
            <div className="space-y-2.5 border-t border-border pt-3">
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
                <p className="rounded-md border border-danger/30 bg-danger/10 px-2.5 py-2 text-xs text-danger">
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
    </div>
  );
}

/* ── Swipeable pane switcher — Instagram/LinkedIn's two underlying
 * connections, one visible at a time ───────────────────────────────────
 * The merged cards used to stack both connections vertically in one card
 * (SubConnection rendered twice, back to back), which the product owner saw
 * live and called unclear + too long: a client could not tell at a glance
 * what each block was for, and the card grew tall enough to dominate the
 * grid. This swaps the CONTAINER only - same SubConnection content per
 * connection, same required-first/fallback-second ordering - for a
 * horizontally paged one: one pane on screen, swipe (touch/trackpad) or the
 * dots/arrows below to move to the other.
 *
 * Plain CSS scroll-snap, no carousel library (none is in package.json and a
 * two-pane swipe does not need one): each pane is a full-width flex child,
 * `snap-x snap-mandatory` on the scroller and `snap-start` on each pane is
 * the whole mechanism. `active` is read back off scroll position (rounded to
 * the nearest pane) rather than driven only by the dot clicks, so a real
 * finger-swipe updates the dots too.
 */
function SwipePanes({ panes }: { panes: { id: string; label: string; content: ReactNode }[] }) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(0);

  function scrollToIndex(i: number) {
    const el = scrollerRef.current;
    if (!el || i < 0 || i >= panes.length) return;
    el.scrollTo({ left: i * el.clientWidth, behavior: "smooth" });
    setActive(i);
  }

  function handleScroll() {
    const el = scrollerRef.current;
    if (!el || el.clientWidth === 0) return;
    const i = Math.round(el.scrollLeft / el.clientWidth);
    setActive(Math.max(0, Math.min(panes.length - 1, i)));
  }

  if (panes.length === 1) return <>{panes[0]!.content}</>;

  return (
    <div className="space-y-2">
      <div
        ref={scrollerRef}
        onScroll={handleScroll}
        className="flex snap-x snap-mandatory overflow-x-auto scroll-smooth [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {panes.map((p, i) => (
          <div
            key={p.id}
            role="tabpanel"
            aria-hidden={i !== active}
            className="w-full shrink-0 snap-start px-px"
          >
            {p.content}
          </div>
        ))}
      </div>

      <div className="flex items-center justify-center gap-2">
        <button
          type="button"
          onClick={() => scrollToIndex(active - 1)}
          disabled={active === 0}
          aria-label="Previous connection"
          className="rounded p-0.5 text-muted-2 transition-colors hover:text-foreground disabled:pointer-events-none disabled:opacity-30"
        >
          <Icon name="ChevronLeft" className="h-3.5 w-3.5" />
        </button>
        <div className="flex items-center gap-1.5" role="tablist">
          {panes.map((p, i) => (
            <button
              key={p.id}
              type="button"
              role="tab"
              aria-selected={i === active}
              aria-label={`Show ${p.label}`}
              onClick={() => scrollToIndex(i)}
              className={cn(
                "h-1.5 rounded-full transition-all",
                i === active ? "w-4 bg-foreground/60" : "w-1.5 bg-foreground/20 hover:bg-foreground/35",
              )}
            />
          ))}
        </div>
        <button
          type="button"
          onClick={() => scrollToIndex(active + 1)}
          disabled={active === panes.length - 1}
          aria-label="Next connection"
          className="rounded p-0.5 text-muted-2 transition-colors hover:text-foreground disabled:pointer-events-none disabled:opacity-30"
        >
          <Icon name="ChevronRight" className="h-3.5 w-3.5" />
        </button>
      </div>
      <p className="text-center text-[10px] text-muted-2">{panes[active]!.label}</p>
    </div>
  );
}

/* ── Instagram — one card, two OAuth connections ────────────────────────
 * `instagram` (Facebook Login: requires the client's Instagram professional
 * account to be linked to a Facebook Page) and `instagram_business`
 * ("Instagram API with Instagram Login": no Facebook Page needed) are two
 * separate, independently-connectable ClientIntegration platforms and stay
 * that way (oauth.ts, instagram-business-graph.ts and publishers.ts are
 * unchanged) - this only merges how the TWO cards they used to be present.
 *
 * BOTH CAN PUBLISH. `instagram_business` gained its own publish path
 * (`publishToInstagramBusiness`, publishers.ts) on 2026-09-20 - the day
 * before this merge - and is now in fact the ONLY Instagram target the
 * auto-publish cron can infer (`PUBLISHABLE_PLATFORMS.instagram_post`) and
 * the channel a fresh image upload books by default (media-kinds.ts). A
 * card that told a client this connection was "insights only" would be
 * wrong, not merely out of date - so this card states what each connection
 * can actually do rather than carrying that framing over.
 *
 * `instagram_business` is offered FIRST because it is the one every
 * Instagram account can use; the Facebook-Login option is revealed by the
 * link below it (or automatically, for a client who already has it
 * connected) rather than requiring a client to know up front which one
 * their account needs.
 */
const INSTAGRAM_BUSINESS_DESCRIPTOR =
  "Works without a linked Facebook Page. Publishes posts and Reels, and reads account insights (reach, profile views).";
const INSTAGRAM_FACEBOOK_DESCRIPTOR =
  "Requires your Instagram professional account to be linked to a Facebook Page. Publishes posts and Reels, and shows which Business Manager accounts this connection can see.";

function InstagramUnifiedCard({
  clientId,
  integrations,
  oauthEnabledPlatforms,
  connectingPlatform,
  isAdmin,
  isClientViewer,
  onOAuthConnect,
  onDisconnected,
}: {
  clientId: string;
  integrations: IntegrationView[];
  oauthEnabledPlatforms: string[];
  connectingPlatform: string | null;
  isAdmin: boolean;
  isClientViewer: boolean;
  onOAuthConnect: (provider: string) => void;
  onDisconnected: () => void;
}) {
  const igBusiness = integrations.find((i) => i.platform === "instagram_business");
  const igFacebook = integrations.find((i) => i.platform === "instagram");
  const businessPlatform = PLATFORM_REGISTRY.find((p) => p.id === "instagram_business")!;
  const facebookPlatform = PLATFORM_REGISTRY.find((p) => p.id === "instagram")!;

  const businessLive = !!igBusiness && integrationIsUsable(igBusiness);
  const facebookLive = !!igFacebook && integrationIsUsable(igFacebook);
  const anyLive = businessLive || facebookLive;
  const anyConnected = !!igBusiness || !!igFacebook;
  const anyNeedsReconnect = anyConnected && !anyLive;

  const [businessInfoOpen, setBusinessInfoOpen] = useState(false);
  const [businessInfoLoading, setBusinessInfoLoading] = useState(false);
  const [businessInfoError, setBusinessInfoError] = useState<string | null>(null);
  const [businessAccounts, setBusinessAccounts] = useState<MetaBusinessAccount[] | null>(null);

  async function handleOpenBusinessInfo() {
    setBusinessInfoOpen(true);
    if (businessAccounts !== null || businessInfoLoading) return;
    setBusinessInfoLoading(true);
    setBusinessInfoError(null);
    try {
      const res = await fetchClientBusinessInfoAction(clientId);
      if ("error" in res) setBusinessInfoError(res.error);
      else setBusinessAccounts(res.accounts);
    } catch {
      setBusinessInfoError("Couldn't load business info. Please try again.");
    } finally {
      setBusinessInfoLoading(false);
    }
  }

  const [igInsightsOpen, setIgInsightsOpen] = useState(false);
  const [igInsightsLoading, setIgInsightsLoading] = useState(false);
  const [igInsightsError, setIgInsightsError] = useState<string | null>(null);
  const [igInsights, setIgInsights] = useState<InstagramBusinessAccountInsights | null>(null);

  async function handleOpenIgInsights() {
    setIgInsightsOpen(true);
    if (igInsights !== null || igInsightsLoading) return;
    setIgInsightsLoading(true);
    setIgInsightsError(null);
    try {
      const res = await fetchClientInstagramBusinessInsightsAction(clientId);
      if ("error" in res) setIgInsightsError(res.error);
      else setIgInsights(res.insights);
    } catch {
      setIgInsightsError("Couldn't load insights. Please try again.");
    } finally {
      setIgInsightsLoading(false);
    }
  }

  return (
    <div
      className={cn(
        "overflow-hidden rounded-[var(--radius)] border flex h-full flex-col transition-colors",
        anyLive && !anyNeedsReconnect ? "border-success/30 shadow-lg shadow-success/10" : "border-border",
      )}
      style={{ background: "var(--surface)" }}
    >
      <div className="flex items-start gap-3 p-4">
        <div className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-md border border-foreground/10 bg-foreground/[0.04] text-foreground/80">
          <PlatformMark id="instagram" className="h-5 w-5" />
        </div>
        <div className="min-w-0 flex-1 space-y-1">
          <p className="font-semibold leading-none">Instagram</p>
          <div className="flex flex-wrap items-center gap-2">
            {anyLive ? (
              <Badge tone="neon">
                <Icon name="CircleCheck" className="h-3 w-3" />
                Connected
              </Badge>
            ) : anyNeedsReconnect ? (
              <Badge tone="warning">
                <Icon name="TriangleAlert" className="h-3 w-3" />
                Reconnect needed
              </Badge>
            ) : (
              <Badge tone="neutral">Not connected</Badge>
            )}
          </div>
          <p className="truncate text-xs text-muted-2">
            Publish posts and Reels, and read account performance.
          </p>
        </div>
      </div>

      <div className="mt-auto px-4 pb-4">
        <SwipePanes
          panes={[
            {
              id: "instagram_business",
              label: "Direct login (no Facebook Page needed)",
              content: (
                <div className="space-y-2.5">
                  <SubConnection
                    platform={businessPlatform}
                    integration={igBusiness}
                    clientId={clientId}
                    isOAuthEnabled={oauthEnabledPlatforms.includes("instagram_business")}
                    isConnecting={connectingPlatform === "instagram_business"}
                    isAdmin={isAdmin}
                    isClientViewer={isClientViewer}
                    onOAuthConnect={() => onOAuthConnect("instagram_business")}
                    onDisconnected={onDisconnected}
                    descriptor={INSTAGRAM_BUSINESS_DESCRIPTOR}
                    label="Direct login (no Facebook Page needed)"
                    connectLabel="Instagram"
                  />
                  {igBusiness && (
                    <Button size="sm" variant="outline" className="w-full" onClick={handleOpenIgInsights}>
                      <Icon name="TrendingUp" className="h-3.5 w-3.5" />
                      View insights
                    </Button>
                  )}
                </div>
              ),
            },
            {
              id: "instagram",
              label: "Facebook Login (alternative)",
              content: (
                <div className="space-y-2.5">
                  <SubConnection
                    platform={facebookPlatform}
                    integration={igFacebook}
                    clientId={clientId}
                    isOAuthEnabled={oauthEnabledPlatforms.includes("instagram")}
                    isConnecting={connectingPlatform === "instagram"}
                    isAdmin={isAdmin}
                    isClientViewer={isClientViewer}
                    onOAuthConnect={() => onOAuthConnect("instagram")}
                    onDisconnected={onDisconnected}
                    descriptor={INSTAGRAM_FACEBOOK_DESCRIPTOR}
                    label="Facebook Login"
                  />
                  {igFacebook && (
                    <Button size="sm" variant="outline" className="w-full" onClick={handleOpenBusinessInfo}>
                      <Icon name="Building2" className="h-3.5 w-3.5" />
                      View business info
                    </Button>
                  )}
                </div>
              ),
            },
          ]}
        />
      </div>

      <Modal
        open={businessInfoOpen}
        onClose={() => setBusinessInfoOpen(false)}
        title="Business info"
        description="Business Manager accounts your connected Instagram login has access to."
        className="max-w-md"
      >
        <div className="mb-3 flex items-center gap-2 text-xs font-medium text-muted-2">
          <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md border border-foreground/10 bg-foreground/[0.04] text-foreground/80">
            <PlatformMark id="instagram" className="h-3.5 w-3.5" />
          </div>
          Instagram
        </div>
        {businessInfoLoading && (
          <p className="flex items-center gap-2 py-4 text-sm text-muted">
            <Icon name="Loader" className="h-4 w-4 animate-spin" />
            Loading...
          </p>
        )}
        {!businessInfoLoading && businessInfoError && (
          <p className="rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger">
            {businessInfoError}
          </p>
        )}
        {!businessInfoLoading && !businessInfoError && businessAccounts && businessAccounts.length === 0 && (
          <p className="py-4 text-sm text-muted-2">
            No Business Manager accounts found for this connection.
          </p>
        )}
        {!businessInfoLoading && !businessInfoError && businessAccounts && businessAccounts.length > 0 && (
          <ul className="space-y-2">
            {businessAccounts.map((b) => (
              <li key={b.id} className="flex items-center gap-2.5 rounded-md border border-border px-3 py-2.5">
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-foreground/10 bg-foreground/[0.04] text-foreground/80">
                  <Icon name="Building2" className="h-4 w-4" />
                </div>
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium leading-none">{b.name}</p>
                  <p className="mt-1 truncate text-[11px] text-muted-2">{b.id}</p>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Modal>

      <Modal
        open={igInsightsOpen}
        onClose={() => setIgInsightsOpen(false)}
        title="Account insights"
        description="Reach and profile views for the connected Instagram account, last full day."
        className="max-w-md"
      >
        <div className="mb-3 flex items-center gap-2 text-xs font-medium text-muted-2">
          <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md border border-foreground/10 bg-foreground/[0.04] text-foreground/80">
            <PlatformMark id="instagram_business" className="h-3.5 w-3.5" />
          </div>
          Instagram
        </div>
        {igInsightsLoading && (
          <p className="flex items-center gap-2 py-4 text-sm text-muted">
            <Icon name="Loader" className="h-4 w-4 animate-spin" />
            Loading...
          </p>
        )}
        {!igInsightsLoading && igInsightsError && (
          <p className="rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger">
            {igInsightsError}
          </p>
        )}
        {!igInsightsLoading && !igInsightsError && igInsights && (
          <div className="grid grid-cols-2 gap-2">
            <div className="rounded-md border border-border px-3 py-2.5">
              <p className="text-[11px] text-muted-2">Reach</p>
              <p className="text-lg font-semibold leading-tight">{igInsights.reach ?? "-"}</p>
            </div>
            <div className="rounded-md border border-border px-3 py-2.5">
              <p className="text-[11px] text-muted-2">Profile views</p>
              <p className="text-lg font-semibold leading-tight">{igInsights.profileViews ?? "-"}</p>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}

/* ── LinkedIn — one card, two OAuth connections ─────────────────────────
 * `linkedin` (Sign In + Share, publish-capable, also backs employee-
 * advocacy seats) and `linkedin_community` (LinkedIn's Community Management
 * API - company-page follower/demographics/post-performance reads) stay two
 * separate ClientIntegration platforms: LinkedIn requires the Community
 * Management product on a SEPARATE developer app from Sign In/Share
 * (oauth.ts), so there is no way to fold them into one OAuth flow. Unlike
 * Instagram's either/or choice, these are ADDITIVE - a client can have both
 * connected at once, since one publishes and the other only reads company
 * analytics (`fetchLinkedInOrgFollowers`, wired into the daily follower-sync
 * cron at src/app/api/followers/sync/route.ts).
 */
const LINKEDIN_DESCRIPTOR =
  "Sign In + Share on LinkedIn. Publish as yourself or your company page, and back employee-advocacy seats.";
const LINKEDIN_COMMUNITY_DESCRIPTOR =
  "Read-only. LinkedIn requires this as a separate connection from posting: company-page follower counts, demographics, and post performance.";

function LinkedInUnifiedCard({
  clientId,
  integrations,
  oauthEnabledPlatforms,
  connectingPlatform,
  isAdmin,
  isClientViewer,
  onOAuthConnect,
  onDisconnected,
  linkedinSeats,
  seatLimit,
  seatCost,
}: {
  clientId: string;
  integrations: IntegrationView[];
  oauthEnabledPlatforms: string[];
  connectingPlatform: string | null;
  isAdmin: boolean;
  isClientViewer: boolean;
  onOAuthConnect: (provider: string) => void;
  onDisconnected: () => void;
  linkedinSeats?: SeatView[];
  seatLimit?: number;
  seatCost?: number;
}) {
  const li = integrations.find((i) => i.platform === "linkedin");
  const liCommunity = integrations.find((i) => i.platform === "linkedin_community");
  const liPlatform = PLATFORM_REGISTRY.find((p) => p.id === "linkedin")!;
  const communityPlatform = PLATFORM_REGISTRY.find((p) => p.id === "linkedin_community")!;

  const liLive = !!li && integrationIsUsable(li);
  const communityLive = !!liCommunity && integrationIsUsable(liCommunity);
  const anyLive = liLive || communityLive;
  const anyConnected = !!li || !!liCommunity;
  const anyNeedsReconnect = anyConnected && !anyLive;

  const [seatsOpen, setSeatsOpen] = useState(false);

  return (
    <div
      className={cn(
        "overflow-hidden rounded-[var(--radius)] border flex h-full flex-col transition-colors",
        anyLive && !anyNeedsReconnect ? "border-success/30 shadow-lg shadow-success/10" : "border-border",
      )}
      style={{ background: "var(--surface)" }}
    >
      <div className="flex items-start gap-3 p-4">
        <div className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-md border border-foreground/10 bg-foreground/[0.04] text-foreground/80">
          <PlatformMark id="linkedin" className="h-5 w-5" />
        </div>
        <div className="min-w-0 flex-1 space-y-1">
          <p className="font-semibold leading-none">LinkedIn</p>
          <div className="flex flex-wrap items-center gap-2">
            {anyLive ? (
              <Badge tone="neon">
                <Icon name="CircleCheck" className="h-3 w-3" />
                Connected
              </Badge>
            ) : anyNeedsReconnect ? (
              <Badge tone="warning">
                <Icon name="TriangleAlert" className="h-3 w-3" />
                Reconnect needed
              </Badge>
            ) : (
              <Badge tone="neutral">Not connected</Badge>
            )}
          </div>
          <p className="truncate text-xs text-muted-2">
            Share posts, and optionally read company-page analytics.
          </p>
        </div>
      </div>

      <div className="mt-auto px-4 pb-4">
        <SwipePanes
          panes={[
            {
              id: "linkedin",
              label: "Sign In + Share",
              content: (
                <div className="space-y-2.5">
                  <SubConnection
                    platform={liPlatform}
                    integration={li}
                    clientId={clientId}
                    isOAuthEnabled={oauthEnabledPlatforms.includes("linkedin")}
                    isConnecting={connectingPlatform === "linkedin"}
                    isAdmin={isAdmin}
                    isClientViewer={isClientViewer}
                    onOAuthConnect={() => onOAuthConnect("linkedin")}
                    onDisconnected={onDisconnected}
                    descriptor={LINKEDIN_DESCRIPTOR}
                    label="Sign In + Share"
                  />
                  {li && (
                    <Button size="sm" variant="outline" className="w-full" onClick={() => setSeatsOpen(true)}>
                      <Icon name="Users" className="h-3.5 w-3.5" />
                      Manage employee seats
                      {linkedinSeats && linkedinSeats.length > 0 && ` (${linkedinSeats.length}/${seatLimit ?? DEFAULT_LINKEDIN_SEAT_LIMIT})`}
                    </Button>
                  )}
                </div>
              ),
            },
            {
              id: "linkedin_community",
              // ADDITIVE, not a replacement - unlike Instagram's either/or pane 2,
              // connecting this does not stand in for Sign In + Share. Said in the
              // pane label (read under the dots) and in SubConnection's own label
              // and descriptor, so it is visible whichever one a client's eye lands on.
              label: "Also connect: company page analytics",
              content: (
                <SubConnection
                  platform={communityPlatform}
                  integration={liCommunity}
                  clientId={clientId}
                  isOAuthEnabled={oauthEnabledPlatforms.includes("linkedin_community")}
                  isConnecting={connectingPlatform === "linkedin_community"}
                  isAdmin={isAdmin}
                  isClientViewer={isClientViewer}
                  onOAuthConnect={() => onOAuthConnect("linkedin_community")}
                  onDisconnected={onDisconnected}
                  descriptor={LINKEDIN_COMMUNITY_DESCRIPTOR}
                  label="Also connect: company page analytics"
                />
              ),
            },
          ]}
        />
      </div>

      {li && (
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
            seatLimit={seatLimit ?? DEFAULT_LINKEDIN_SEAT_LIMIT}
            seatCost={seatCost ?? CREDIT_COSTS.employeeSeat}
          />
        </Modal>
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
  seatLimit = DEFAULT_LINKEDIN_SEAT_LIMIT,
  seatCost = CREDIT_COSTS.employeeSeat,
}: Props) {
  const router = useRouter();
  const isAdmin = currentUserRole === "KAROS_ADMIN";
  // This tab renders on /clients/[id]/settings, which a client can open for
  // their own workspace - so copy here has to know who is reading it.
  const isClientViewer = currentUserRole === "CLIENT_USER";
  const [connectingPlatform, setConnectingPlatform] = useState<string | null>(null);
  const [popupError, setPopupError] = useState<string | null>(null);
  const popupTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  /**
   * Which providers' popups have reported back, by provider id.
   *
   * A REF, not state: the closed-poll below reads it from inside an interval
   * that was created in an earlier render and must see the CURRENT value, and
   * nothing renders off it. It is what separates "the person closed the window
   * half way through" from "the flow finished and the window closed itself",
   * which look identical to `popup.closed` (flow audit 2026-09, R17).
   *
   * KEYED BY PROVIDER (review wave, 2026-09). It was one boolean for the whole
   * tab, and `openOAuthPopup` clears it on every press — so a second connection
   * started while a first was still open wiped the first's answer. Instagram
   * finishing and closing itself then read as "closed before it finished", and
   * the card said nothing was connected under a connection that had just
   * succeeded. Both postMessages already carry `platform` (see
   * lib/integrations/oauth-popup.ts), so the answer can be filed under the flow
   * it belongs to instead of shared between flows that have nothing to do with
   * each other.
   */
  const oauthReportedRef = useRef<Record<string, boolean>>({});

  // Instagram (`instagram` / `instagram_business`) and LinkedIn (`linkedin` /
  // `linkedin_community`) each render as ONE merged card (InstagramUnifiedCard /
  // LinkedInUnifiedCard, below) covering two real ClientIntegration platforms,
  // so they're pulled out of the generic per-platform grid entirely — same
  // pattern the removed GoogleUnifiedCard used for its three Google services.
  const instagramMergedIds = new Set<string>(["instagram", "instagram_business"]);
  const linkedinMergedIds = new Set<string>(["linkedin", "linkedin_community"]);
  const mergedCardIds = new Set<string>([...instagramMergedIds, ...linkedinMergedIds]);

  // A `hidden` platform (see PlatformConfig.hidden) stays off the grid unless
  // this client already has an integration document for it — retired from new
  // connections, but a client already connected through it can still see and
  // manage that card.
  const standalonePlatforms = PLATFORM_REGISTRY.filter(
    (p) => !mergedCardIds.has(p.id) && (!p.hidden || integrations.some((i) => i.platform === p.id)),
  );

  /** "live" if ANY of the merged card's underlying platforms is usable, same rule the merged cards use for their own badge. */
  function mergedCardStatus(ids: Set<string>): "live" | "needs-reconnect" | "absent" {
    const matches = integrations.filter((i) => ids.has(i.platform));
    if (matches.length === 0) return "absent";
    return matches.some((i) => integrationIsUsable(i)) ? "live" : "needs-reconnect";
  }
  const instagramCardStatus = mergedCardStatus(instagramMergedIds);
  const linkedinCardStatus = mergedCardStatus(linkedinMergedIds);

  // The badge used to count any integration DOC as connected, with no status
  // check, so an expired channel was tallied as working - the count and the
  // card contradicted each other. "Connected" now means usable; anything
  // needing a reconnect is reported separately rather than being quietly
  // folded into a green number. The two merged cards count as ONE slot each
  // here too - otherwise this stat would disagree with what's visually on
  // screen.
  const connectedCount =
    standalonePlatforms.filter((p) => platformStatus(p) === "live").length +
    (instagramCardStatus === "live" ? 1 : 0) +
    (linkedinCardStatus === "live" ? 1 : 0);
  const needsReconnectCount =
    standalonePlatforms.filter((p) => platformStatus(p) === "needs-reconnect").length +
    (instagramCardStatus === "needs-reconnect" ? 1 : 0) +
    (linkedinCardStatus === "needs-reconnect" ? 1 : 0);
  const totalCardCount = standalonePlatforms.length + 2;

  // One remaining section, driven by each platform's registry `category` - a
  // new "publishing" platform lands in it just by declaring the category, no
  // UI changes. The former "analytics" section (Google Search Console/
  // Analytics/Business Profile, Reddit, Instagram performance) was removed
  // 2026-09-21 once every category:"analytics" standalone platform had been
  // retired, leaving it permanently empty.
  const publishingPlatforms = standalonePlatforms.filter((p) => p.category === "publishing");

  // Listen for postMessage from OAuth popup
  useEffect(() => {
    function handleMessage(e: MessageEvent) {
      if (e.origin !== window.location.origin) return;
      // The provider this window was opened for. Both pages send it; a message
      // without one can only have come from an older popup still open across a
      // deploy, and it is treated as the flow currently on screen.
      const platform: string | null =
        typeof e.data?.platform === "string" ? e.data.platform : null;
      if (e.data?.type === "karos_oauth_success") {
        if (platform) oauthReportedRef.current[platform] = true;
        if (popupTimerRef.current) clearInterval(popupTimerRef.current);
        // Only the flow that reported clears the spinner: with two windows open,
        // the first to come back used to blank the second's "Connecting…" too.
        setConnectingPlatform((prev) => (platform && prev !== platform ? prev : null));
        setPopupError(null);
        router.refresh();
      }
      if (e.data?.type === "karos_oauth_error") {
        if (platform) oauthReportedRef.current[platform] = true;
        if (popupTimerRef.current) clearInterval(popupTimerRef.current);
        setConnectingPlatform((prev) => (platform && prev !== platform ? prev : null));
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
    // This provider's own slot, so a press here cannot forget what another
    // provider's window has already reported.
    oauthReportedRef.current[provider] = false;

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
      if (!popup.closed) return;
      clearInterval(popupTimerRef.current!);
      setConnectingPlatform((prev) => (prev === provider ? null : prev));
      // R17: this branch used to clear the spinner and say NOTHING, so a client
      // who closed the window (or whose provider closed it on a cancel) watched
      // the button return to "Connect with …" with no explanation and no way to
      // tell a failure from a slow success. The window reporting back — either
      // outcome — clears this flag and this interval, so the only run that
      // reaches here is a genuine early close.
      if (!oauthReportedRef.current[provider]) {
        setPopupError(
          "The connection window closed before it finished, so nothing was connected. Press Connect to try again.",
        );
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
        leadingCards={
          // Instagram and LinkedIn each cover two real connections and carry
          // their own internal connected/not state, so - like the removed
          // GoogleUnifiedCard before them - they always render in full rather
          // than partitioning with the standalone platforms.
          <>
            <InstagramUnifiedCard
              key="instagram_unified"
              clientId={clientId}
              integrations={integrations}
              oauthEnabledPlatforms={oauthEnabledPlatforms}
              connectingPlatform={connectingPlatform}
              isAdmin={isAdmin}
              isClientViewer={isClientViewer}
              onOAuthConnect={openOAuthPopup}
              onDisconnected={() => router.refresh()}
            />
            <LinkedInUnifiedCard
              key="linkedin_unified"
              clientId={clientId}
              integrations={integrations}
              oauthEnabledPlatforms={oauthEnabledPlatforms}
              connectingPlatform={connectingPlatform}
              isAdmin={isAdmin}
              isClientViewer={isClientViewer}
              onOAuthConnect={openOAuthPopup}
              onDisconnected={() => router.refresh()}
              linkedinSeats={linkedinSeats}
              seatLimit={seatLimit}
              seatCost={seatCost}
            />
          </>
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
