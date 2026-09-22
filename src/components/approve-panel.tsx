"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui";
import { Icon } from "@/components/icon";
import { approveAssetAction, recommendAssetScheduleAction } from "@/lib/actions";
import {
  PUBLISHABLE_PLATFORMS,
  PLATFORM_LABELS,
  platformSupportsAssetMedia,
} from "@/lib/integrations/platforms";
import { cn } from "@/lib/utils";
import type { Asset, PublishMode } from "@/lib/types";

const MODE_LABELS: Record<PublishMode, string> = {
  auto: "Auto-publish",
  manual: "Manual push",
  placeholder: "Placeholder",
};

/** epoch millis → value for <input type="datetime-local"> in the user's timezone */
function toLocalInputValue(t: number): string {
  const d = new Date(t);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * The pre-approval step for a draft: pick the publishing tier (auto/manual/
 * placeholder) and the publication slot, then Approve. Approving stamps the asset
 * onto the content calendar at the chosen time. Auto-publish is only offered when
 * the agent's channel integration is connected and active for this client.
 *
 * Shared by the staff Assets list (asset-card.tsx) and the calendar's detail
 * modal (asset-detail-modal.tsx) — one implementation, so approving a draft
 * asks the same questions and calls the same action wherever staff reach it.
 */
export function ApprovePanel({
  asset,
  connectedPlatforms,
  agentChannels,
  onDone,
}: {
  asset: Asset;
  connectedPlatforms: string[];
  agentChannels?: string[];
  onDone: () => void;
}) {
  const router = useRouter();
  // PUBLISHABLE_PLATFORMS[type] is the coarse, TYPE-LEVEL ceiling (every
  // platform that type could ever carry, media aside). This asset's actual
  // media — does it carry video, an image, or neither — narrows that ceiling
  // further: a text-only draft should never offer Instagram/TikTok/YouTube,
  // and a video-less post should never offer YouTube. See
  // platformSupportsAssetMedia (platforms.ts) for the product owner's rule.
  const compatiblePlatforms = (PUBLISHABLE_PLATFORMS[asset.type] ?? []).filter((p) =>
    platformSupportsAssetMedia(p, asset),
  );
  // The agent's declared channels are the DEFAULT pick, not the ceiling: a
  // client can still check any other connected platform the asset type
  // supports (e.g. an Instagram-agent carousel also going out to TikTok),
  // so the offered list is every compatible+connected platform, full stop.
  const channelPlatforms =
    agentChannels && agentChannels.length
      ? agentChannels.filter((p) => compatiblePlatforms.includes(p))
      : compatiblePlatforms;
  // `instagram` (Facebook Login) and `instagram_business` (direct login) are
  // two real, separately-connected integrations, but from this picker's POV
  // they're one product: "Instagram". Whichever one the client actually
  // connected is the one that works, and this panel should just say
  // "Instagram" once, not make staff pick between two technical connection
  // methods for the same platform. Collapse to the preferred member
  // (instagram_business — works without a linked Facebook Page) whenever
  // both happen to be present in a list; the other member is dropped from
  // every list this component renders or submits from this point on.
  const dedupeInstagram = (ids: string[]): string[] =>
    ids.includes("instagram_business") ? ids.filter((p) => p !== "instagram") : ids;
  const availablePlatforms = dedupeInstagram(connectedPlatforms.filter((p) => compatiblePlatforms.includes(p)));
  // Pre-checked on open: the agent's own channel(s), narrowed to what's
  // actually connected — everything else in availablePlatforms is offered
  // but starts unchecked.
  const defaultPlatforms = dedupeInstagram(connectedPlatforms.filter((p) => channelPlatforms.includes(p)));
  const canAuto = availablePlatforms.length > 0;
  /** Display label for a picker entry — "Instagram" for BOTH underlying ids, never "Instagram (direct login)"; that distinction belongs on the Integrations tab, not here. */
  const pickerLabel = (p: string): string => (p === "instagram" || p === "instagram_business" ? "Instagram" : PLATFORM_LABELS[p] ?? p);

  // eslint-disable-next-line react-hooks/purity -- initial values only; component mounts once per open
  const now = Date.now();
  const minDatetime = toLocalInputValue(now + 60_000);
  // A draft that already holds a calendar slot (the one-post-a-day chain gives
  // its drafts one) keeps it: the panel used to open on the AI's pick instead,
  // so the modal read "Scheduled for Mon 11:00" above a form proposing another
  // time. The slot is only a default when it is still ahead of us — a missed
  // one falls through to the recommendation like before.
  const held = asset.scheduledAt && asset.scheduledAt > now + 60_000 ? asset.scheduledAt : null;
  const recommended =
    held ?? (asset.recommendedAt && asset.recommendedAt > now + 60_000 ? asset.recommendedAt : null);
  const [datetime, setDatetime] = useState(
    recommended ? toLocalInputValue(recommended) : minDatetime,
  );
  const [mode, setMode] = useState<PublishMode>(canAuto ? "auto" : "placeholder");
  // Multiple platforms may be checked at once — the asset then publishes to
  // every one of them (see publishAssetToPlatform's per-platform loop in
  // asset-actions.ts / the auto-publish cron). Starts on the agent's own
  // channel(s) (defaultPlatforms) so the common single-platform case needs no
  // extra click; every other compatible+connected platform is still offered,
  // just unchecked, for an explicit cross-post pick.
  const [platforms, setPlatforms] = useState<string[]>(defaultPlatforms);
  function togglePlatform(p: string) {
    setPlatforms((prev) => (prev.includes(p) ? prev.filter((x) => x !== p) : [...prev, p]));
  }
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // AI recommendation aware of the client's calendar density (fetched on open).
  const [aiRec, setAiRec] = useState<{ at: number; reason: string } | null>(null);
  const [recLoading, setRecLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    recommendAssetScheduleAction(asset.id)
      .then((rec) => {
        if (cancelled || !rec) return;
        setAiRec(rec);
        // Offer the recommendation; take it only when the draft holds no slot of
        // its own (a held slot stays the default, the AI's pick stays a click).
        if (!held && rec.at > Date.now() + 60_000) setDatetime(toLocalInputValue(rec.at));
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setRecLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [asset.id, held]);

  const suggestedAt = aiRec?.at ?? recommended;
  const suggestedReason = aiRec?.reason ?? asset.recommendedReason;
  const usingSuggested = suggestedAt != null && datetime === toLocalInputValue(suggestedAt);
  const showPlatformPicker = mode !== "placeholder" && availablePlatforms.length > 0;

  const modeOptions: { id: PublishMode; label: string; hint: string; disabled?: boolean }[] = [
    {
      id: "auto",
      label: MODE_LABELS.auto,
      hint: "Posts automatically at the scheduled time",
      disabled: !canAuto,
    },
    {
      id: "manual",
      label: MODE_LABELS.manual,
      hint: "On the calendar, you push it live with Publish Now",
    },
    {
      id: "placeholder",
      label: MODE_LABELS.placeholder,
      hint: "Calendar-only roadmap item. Karos never posts it",
    },
  ];

  async function handleApprove() {
    if (!datetime) return;
    if (mode !== "placeholder" && platforms.length === 0) {
      setError("Pick at least one platform");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await approveAssetAction(asset.id, {
        scheduledAt: new Date(datetime).getTime(),
        platforms: mode === "placeholder" ? undefined : platforms,
        publishMode: mode,
      });
      router.refresh();
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Approval failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-3 space-y-2.5 rounded-md border border-border bg-surface-2 p-3">
      <p className="text-[11px] font-label font-medium uppercase tracking-[0.14em] text-muted-2">
        Approve &amp; add to content calendar
      </p>

      {/* Publishing tier */}
      <div className="flex flex-wrap gap-1.5">
        {modeOptions.map((opt) => (
          <button
            key={opt.id}
            onClick={() => !opt.disabled && setMode(opt.id)}
            disabled={opt.disabled}
            title={opt.disabled ? "Connect this agent's channel integration to enable auto-publishing" : opt.hint}
            className={cn(
              "rounded-md border px-2.5 py-1.5 text-[11px] font-medium transition-colors",
              mode === opt.id
                ? "border-neon/60 bg-neon/10 text-neon"
                : "border-border text-muted hover:text-foreground",
              opt.disabled && "cursor-not-allowed opacity-40",
            )}
          >
            {opt.label}
          </button>
        ))}
      </div>
      <p className="text-[11px] text-muted-2">
        {modeOptions.find((o) => o.id === mode)?.hint}
      </p>

      <div className="flex flex-wrap items-end gap-2">
        {/* Date + time */}
        <div className="min-w-[180px] flex-1">
          <label className="mb-1 block text-[11px] text-muted-2">Date &amp; time</label>
          <input
            type="datetime-local"
            value={datetime}
            min={minDatetime}
            onChange={(e) => setDatetime(e.target.value)}
            className="h-8 w-full rounded-md border border-border bg-surface px-2.5 text-xs text-foreground focus:outline-none focus:ring-2 focus:ring-neon/40"
          />
        </div>

        {/* Platform picker (auto/manual modes with connected platforms) — check
            as many as apply; the asset publishes to every one checked. */}
        {showPlatformPicker && (
          <div className="min-w-[130px]">
            <label className="mb-1 block text-[11px] text-muted-2">
              Platform{platforms.length > 1 ? "s" : ""}
            </label>
            <div className="flex flex-wrap gap-1.5">
              {availablePlatforms.map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => togglePlatform(p)}
                  aria-pressed={platforms.includes(p)}
                  className={cn(
                    "flex h-8 items-center gap-1.5 rounded-md border px-2.5 text-xs font-medium transition-colors",
                    platforms.includes(p)
                      ? "border-neon/60 bg-neon/10 text-neon"
                      : "border-border text-muted hover:text-foreground",
                  )}
                >
                  <Icon
                    name={platforms.includes(p) ? "SquareCheck" : "Square"}
                    className="h-3.5 w-3.5"
                  />
                  {pickerLabel(p)}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* AI recommendation (calendar-density aware) */}
      {recLoading ? (
        <p className="flex items-center gap-1.5 text-[11px] text-muted-2">
          <Icon name="Loader" className="h-3 w-3 shrink-0 animate-spin text-neon" />
          Finding an optimal slot…
        </p>
      ) : (
        suggestedAt != null && (
          <p className="flex items-center gap-1.5 text-[11px] text-muted-2">
            <Icon name="Sparkles" className="h-3 w-3 shrink-0 text-neon" />
            <span>
              {usingSuggested ? "Using the recommended slot" : "AI recommends "}
              {!usingSuggested && (
                <button
                  onClick={() => setDatetime(toLocalInputValue(suggestedAt))}
                  className="font-medium text-neon hover:underline"
                >
                  {new Date(suggestedAt).toLocaleString([], {
                    month: "short",
                    day: "numeric",
                    hour: "numeric",
                    minute: "2-digit",
                  })}
                </button>
              )}
              {suggestedReason ? ` · ${suggestedReason}` : ""}
            </span>
          </p>
        )
      )}

      {!canAuto && compatiblePlatforms.length > 0 && (
        <p className="text-[11px] text-muted-2">
          <Icon name="CircleAlert" className="mr-1 inline h-3 w-3 text-warning" />
          Connect{" "}
          {dedupeInstagram(channelPlatforms).map(pickerLabel).join(" or ")}{" "}
          in the Integrations tab to enable auto-publishing.
        </p>
      )}

      {error && (
        <p className="rounded-md border border-danger/30 bg-danger/10 px-2.5 py-1.5 text-[11px] text-danger">
          {error}
        </p>
      )}

      <div className="flex gap-2">
        <Button size="sm" onClick={handleApprove} loading={busy} disabled={!datetime}>
          <Icon name="Check" className="h-3.5 w-3.5" />
          Approve
        </Button>
        <Button size="sm" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
