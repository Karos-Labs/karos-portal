"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Modal } from "@/components/modal";
import { Badge, TabButton } from "@/components/ui";
import { Icon } from "@/components/icon";
import { AudienceSimulation } from "@/components/audience-simulation";
import { CopyCaptionButton } from "@/components/copy-caption-button";
import { parseLiDrafts } from "@/lib/li-drafts";
import { LiDraftsBatch, type LiMediaFile } from "@/components/li-drafts-review";
import { isRedditV2Envelope, parseRedditDrafts } from "@/lib/reddit-drafts";
import { RedditDraftsBatch } from "@/components/reddit-drafts-review";
import { parseXDrafts } from "@/lib/x-drafts";
import { draftsDisplayTitle, hasGeneratedTitle } from "@/lib/deliverable-titles";
import { XDraftsBatch } from "@/components/x-drafts-review";
import {
  PUBLISH_HOLD_HEADING,
  assetStatusLabel,
  isPublishHold,
} from "@/lib/asset-status-copy";
import { looksLikeMarkdown, renderAssetBody } from "@/lib/doc-render";
import { normalizeDashes } from "@/lib/text-utils";
import { MarkPostedRow } from "@/components/mark-posted-row";
import { PostManagementRow } from "@/components/post-management-row";
import { ApprovePanel } from "@/components/approve-panel";
import { approveAssetAction, publishAssetNowAction, unscheduleAssetAction } from "@/lib/actions/asset-actions";
import { PLATFORM_LABELS, PUBLISHABLE_PLATFORMS } from "@/lib/integrations/platforms";
import { isAssetPublishable } from "@/lib/asset-visibility";
import {
  assetDownloadTargets,
  assetImages,
  assetLiMedia,
  assetVideoSrc,
  assetVideos,
} from "@/lib/asset-images";
import { templateForAsset } from "@/lib/post-chain";
import type { Asset } from "@/lib/types";

const TYPE_ICON: Record<string, string> = {
  instagram_post: "Camera",
  email: "Mail",
  article: "Newspaper",
  social_post: "Share2",
  note: "FileText",
};

const MODE_LABELS: Record<string, string> = {
  auto: "Auto-publish",
  manual: "Manual push",
  placeholder: "Placeholder",
};

function statusTone(status: Asset["status"]): "warning" | "neon" | "info" | "neutral" {
  if (status === "draft") return "warning";
  if (status === "approved") return "neon";
  if (status === "scheduled") return "info";
  return "neutral";
}

function fmt(t: number): string {
  return new Date(t).toLocaleString([], {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/** Native download action for an asset's deliverables — anchors to the shared download
 *  route (a photo, a zip when the asset carries a carousel, or a clip). What is on offer
 *  comes from `assetDownloadTargets`, so a video-only asset gets a control instead of the
 *  old photos-only gate; WHO may have it stays this component's own call, unchanged. */
export function AssetDownloadButtons({ asset, className }: { asset: Asset; className?: string }) {
  // This modal's own pre-existing refusal, kept here rather than pushed into the
  // shared helper: the card never had it, and the server gate (authorizeAssetMedia)
  // is what actually withholds a future-dated post.
  if (asset.locked) return null;
  const targets = assetDownloadTargets(asset);
  if (targets.length === 0) return null;
  return (
    <div className={className ?? "flex flex-wrap gap-1.5"}>
      {targets.map((t) => (
        <a
          key={t.href}
          href={t.href}
          download
          title={t.title}
          className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-[11px] font-medium text-muted transition-colors hover:border-border-strong hover:text-foreground"
        >
          <Icon name={t.icon} className="h-3.5 w-3.5" />
          <Icon name="Download" className="h-3 w-3" />
          {t.label}
        </a>
      ))}
    </div>
  );
}

type SlideMeta = {
  role?: string;
  headline?: string;
  body?: string | null;
  imageUrl?: string | null;
  attribution?: string | null;
};

/**
 * Read-only detail view of a single asset - full output content plus all its
 * metadata (status, channels, schedule, platform, publish mode). Opened from the
 * content calendar when a scheduled item is clicked.
 */
export function AssetDetailModal({
  asset,
  open,
  onClose,
  viewerIsClient,
  canPublish = false,
  connectedPlatforms,
}: {
  asset: Asset | null;
  open: boolean;
  onClose: () => void;
  /**
   * Which status register this modal reads its words from. REQUIRED, with no
   * default, and that is the fix: this modal printed `asset.status` raw, so a
   * paying client opening a tile from their own archive read the lowercase
   * Firestore enum "published" while the archive behind it said "Posted". It is
   * reachable by clients from archive-view, clip-gallery and the calendar, so a
   * defaulted flag would have let the next mount silently pick a register — the
   * missing prop is a compile error instead.
   *
   * Separate from `canPublish` below on purpose. That one is a capability
   * ("may this viewer push a post live"); this one is an audience ("whose
   * vocabulary is this"). Staff in View as Client differ on the two.
   */
  viewerIsClient: boolean;
  /**
   * Staff viewer. `publishAssetNowAction` is `requireStaff()`, so a client-facing
   * Publish Now here could only ever error - the client's path is Mark as posted.
   * Never inferred from the asset: the caller knows the viewer's role.
   */
  canPublish?: boolean;
  /** The asset owner's usable publish integrations - staff payload only. */
  connectedPlatforms?: string[];
}) {
  const [tab, setTab] = useState<"details" | "simulation">("details");

  // Agent draft batches are pinned markdown structures, not captions. This
  // modal is the ONLY deliverable viewer a client can reach (the asset card
  // lives on staff-only routes), so the pick / edit / skip reader has to mount
  // here too - otherwise the loop the intake forms promise doesn't exist for
  // the person it was written for. LinkedIn and Reddit are sniffed FIRST: both
  // write "## Account N · …" headings, which contain the X sniff's "# Account "
  // substring, so both must be tested before X or the X reader claims their
  // batches. Each of the two carries a distinct h1 marker, so they cannot claim
  // each other. Same order as asset-card.tsx - the two viewers of the same
  // deliverable must not disagree about what it is.
  const content = asset?.content;
  const liBatch = useMemo(
    () => (content?.includes("# LinkedIn drafts") ? parseLiDrafts(content) : null),
    [content],
  );
  const redditBatch = useMemo(
    () =>
      // v2 envelope or v1 markdown — parseRedditDrafts picks between them.
      !liBatch &&
      content &&
      (isRedditV2Envelope(content) || content.includes("# Reddit answer drafts"))
        ? parseRedditDrafts(content)
        : null,
    [content, liBatch],
  );
  const xBatch = useMemo(
    () =>
      !liBatch && !redditBatch && content?.includes("# Account ")
        ? parseXDrafts(content)
        : null,
    [content, liBatch, redditBatch],
  );
  // The run's attachable media for the LinkedIn reader (shared definition -
  // the asset card renders the same list).
  const assetMeta = asset?.meta;
  const liMedia = useMemo<LiMediaFile[]>(
    () => (liBatch ? assetLiMedia(assetMeta) : []),
    [assetMeta, liBatch],
  );

  if (!asset) return null;

  const template = templateForAsset(asset);

  // Defensive lock guard: the calendar/Today never open a locked asset, but if
  // one reaches here (belt-and-braces) show only the template placeholder + the
  // unlock date - never content, images, hashtags, or the download buttons.
  if (asset.locked) {
    const unlockStr =
      asset.scheduledAt != null
        ? new Date(asset.scheduledAt).toLocaleDateString([], {
            weekday: "short",
            month: "short",
            day: "numeric",
          })
        : null;
    return (
      <Modal open={open} onClose={onClose} title={template?.name ?? "Upcoming post"} className="max-w-md">
        <div className="flex flex-col items-center gap-3 py-6 text-center">
          {/* CREATION language, not lock language (§4.1 item 1). "This
              deliverable unlocks on Thursday" tells the client the post already
              exists and is being withheld from them - which is the single fact
              the whole slot model is built to keep indistinguishable, and it
              made every pre-generated batch legible as one. A padlock says the
              same thing in an icon, so it goes too. */}
          <div className="flex h-12 w-12 items-center justify-center rounded-full border border-border bg-surface-2 text-muted-2">
            <Icon name="CalendarClock" className="h-5 w-5" />
          </div>
          {template && <Badge tone="neutral">{template.name}</Badge>}
          <p className="text-sm font-medium text-foreground">Upcoming post</p>
          <p className="max-w-xs text-xs text-muted-2">
            {unlockStr
              ? `This post is created on ${unlockStr}. It'll appear here that morning.`
              : "This post is created on its scheduled day. It'll appear here that morning."}
          </p>
        </div>
      </Modal>
    );
  }

  const hashtags = (asset.meta?.hashtags as string[] | undefined) ?? [];
  const imageConcept = asset.meta?.imageConcept as string | undefined;
  const slides = (asset.meta?.slides as SlideMeta[] | undefined)?.filter(Boolean) ?? [];
  const channels = asset.channels ?? [];
  const when = asset.scheduledAt ?? asset.recommendedAt;
  const images = assetImages(asset);
  // The lead photo whenever this isn't a structured meta.slides carousel. NOT
  // `length === 1`: a post with several photos and no meta.slides (every
  // multi-photo lab import) would then show nothing at all, where the old
  // asset.imageUrl-only cover at least showed the first one. The rest stay
  // reachable via Download all below.
  const coverImageUrl = images.length > 0 ? images[0].url : null;
  const videos = assetVideos(asset);
  // Whether this asset offers anything to download at all — same helper the
  // buttons use, so the section and its contents cannot disagree. Locked assets
  // returned at the guard above, so this is only ever an unlocked asset and the
  // section can never render empty around a refused button.
  const downloads = assetDownloadTargets(asset);

  return (
    <Modal
      open={open}
      onClose={onClose}
      // The SAME name the row that opened this panel shows. Stored titles for
      // LEGACY agent-service deliveries are just the agent's name ("X Agent"),
      // so printing `asset.title` meant clicking a row called "X post ·
      // <subject>" and landing on a panel headed "X Agent". One composer, both
      // surfaces. New deliveries carry a generated topic title (asset-titles.ts,
      // meta.titleGenerated) — the archive row already shows any non-generic
      // stored title, so the panel must prefer it too or the two disagree again.
      // Falls back to the stored title for everything that is not an X or
      // LinkedIn drafts deliverable.
      title={hasGeneratedTitle(asset) ? asset.title : draftsDisplayTitle(content) ?? asset.title}
      className={liBatch || xBatch ? "max-w-3xl" : "max-w-2xl"}
    >
      {/* Tabs */}
      <div className="mb-4 flex gap-1 border-b border-border">
        <TabButton active={tab === "details"} onClick={() => setTab("details")} icon="FileText">
          Details
        </TabButton>
        <TabButton active={tab === "simulation"} onClick={() => setTab("simulation")} icon="Users">
          Audience Simulation
        </TabButton>
      </div>

      {tab === "simulation" ? (
        <AudienceSimulation
          key={asset.id}
          clientId={asset.clientId}
          assetId={asset.id}
          viewerIsClient={viewerIsClient}
        />
      ) : (
      <div className="space-y-4">
        {/* Status + template + type row */}
        <div className="flex flex-wrap items-center gap-2">
          {/* Never the raw enum. The tone stays local (presentation is this
              component's business); the WORD comes from the register the viewer
              belongs to (lib/asset-status-copy), which is the same lookup the
              archive one screen away already uses. */}
          <Badge tone={statusTone(asset.status)}>{assetStatusLabel(asset.status, viewerIsClient)}</Badge>
          {template && <Badge tone="neutral">{template.name}</Badge>}
          <span className="inline-flex items-center gap-1.5 text-xs text-muted-2">
            <Icon name={TYPE_ICON[asset.type] ?? "FileText"} className="h-3.5 w-3.5" />
            {asset.type.replace(/_/g, " ")}
          </span>
        </div>

        {/* Metadata grid */}
        <div className="grid gap-3 rounded-md border border-border bg-surface-2 p-3 sm:grid-cols-2">
          {when != null && (
            <Meta
              icon={asset.scheduledAt != null ? "CalendarClock" : "Sparkles"}
              label={asset.scheduledAt != null ? "Scheduled for" : "Recommended slot"}
              value={fmt(when)}
            />
          )}
          {asset.publishMode && (
            <Meta icon="Settings2" label="Publishing" value={MODE_LABELS[asset.publishMode] ?? asset.publishMode} />
          )}
          {asset.scheduledPlatform && (
            <Meta icon="Send" label="Platform" value={PLATFORM_LABELS[asset.scheduledPlatform] ?? asset.scheduledPlatform} />
          )}
          <Meta
            icon="Share2"
            label="Channels"
            value={channels.length ? channels.map((c) => PLATFORM_LABELS[c] ?? c).join(", ") : "-"}
          />
        </div>

        {asset.recommendedReason && asset.scheduledAt == null && (
          <p className="flex items-start gap-1.5 text-[11px] text-muted-2">
            <Icon name="Sparkles" className="mt-0.5 h-3 w-3 shrink-0 text-neon" />
            {asset.recommendedReason}
          </p>
        )}

        {/* Cover image (non-carousel). Sourced from assetImages() rather than
            asset.imageUrl alone, which missed any import whose photos landed in
            meta.files - the same gap that rendered those assets' cards blank. */}
        {slides.length === 0 && coverImageUrl && videos.length === 0 && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={coverImageUrl} alt={asset.title} className="w-full rounded-lg border border-border" />
        )}

        {/* Video deliverables - podcast cuts, branded shorts, TikTok. Until
            this existed the clips were emailed by hand (QA F150); the caption
            copy button below is the other half of "post it yourself". The src
            is our own route, never the stored URL: a bulk-uploaded clip's
            stored URL is a 7-day signed link that has usually expired by the
            day the clip is shown. */}
        {videos.map((v, i) => (
          <video
            key={v.url}
            src={assetVideoSrc(asset.id, i)}
            controls
            preload="metadata"
            {...(coverImageUrl ? { poster: coverImageUrl } : {})}
            className="max-h-96 w-full rounded-lg border border-border bg-black object-contain"
          />
        ))}

        {/* Content - a parsed drafts batch gets the per-draft reader (pick,
            edit, skip, each choice feeding the agent's next run); anything
            else gets the caption with a copy button. */}
        {liBatch ? (
          <div>
            <p className="mb-1.5 text-[10px] font-mono font-medium uppercase tracking-[0.14em] text-muted-2">Drafts</p>
            <LiDraftsBatch
              clientId={asset.clientId}
              {...(asset.jobId ? { jobId: asset.jobId } : {})}
              assetId={asset.id}
              accounts={liBatch.accounts}
              media={liMedia}
            />
          </div>
        ) : redditBatch ? (
          <div>
            <p className="mb-1.5 text-[10px] font-mono font-medium uppercase tracking-[0.14em] text-muted-2">Drafts</p>
            <RedditDraftsBatch
              clientId={asset.clientId}
              {...(asset.jobId ? { jobId: asset.jobId } : {})}
              assetId={asset.id}
              accounts={redditBatch.accounts}
                  outcome={redditBatch.outcome}
                  {...(redditBatch.consideredCount !== undefined ? { consideredCount: redditBatch.consideredCount } : {})}
                  {...(redditBatch.outcomeNote ? { outcomeNote: redditBatch.outcomeNote } : {})}
            />
          </div>
        ) : xBatch ? (
          <div>
            <p className="mb-1.5 text-[10px] font-mono font-medium uppercase tracking-[0.14em] text-muted-2">Drafts</p>
            <XDraftsBatch
              clientId={asset.clientId}
              {...(asset.jobId ? { jobId: asset.jobId } : {})}
              assetId={asset.id}
              accounts={xBatch.accounts}
            />
          </div>
        ) : (
          <div>
            <div className="mb-1.5 flex items-center justify-between gap-2">
              <p className="text-[10px] font-mono font-medium uppercase tracking-[0.14em] text-muted-2">Content</p>
              {/* Posting happens by hand from a phone, and this modal is the
                  phone's way into a post - so copy is a primary action here, not
                  the card's hover-revealed icon. */}
              <CopyCaptionButton asset={asset} variant="full" />
            </div>
            <AssetContentBody content={asset.content} />
          </div>
        )}

        {hashtags.length > 0 && (
          <p className="text-xs text-muted">{hashtags.map((h) => "#" + h).join(" ")}</p>
        )}

        {imageConcept && (
          <p className="rounded-lg bg-surface-2 p-2 text-xs text-muted">
            <span className="font-medium text-foreground">Visual: </span>
            {imageConcept}
          </p>
        )}

        {/* Carousel slides */}
        {slides.length > 0 && (
          <div className="space-y-2">
            {slides.map((s, i) => (
              <div key={i} className="flex gap-2 rounded-lg bg-surface-2 p-2">
                {s.imageUrl && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={s.imageUrl} alt="" className="h-24 w-20 shrink-0 rounded border border-border object-cover" />
                )}
                <div className="min-w-0">
                  <p className="text-xs font-medium">
                    {i + 1}. {s.headline}
                    {s.role ? <span className="text-muted-2"> · {s.role}</span> : null}
                  </p>
                  {s.body ? <p className="mt-0.5 whitespace-pre-wrap text-xs text-muted">{s.body}</p> : null}
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Downloads — photos AND clips. Gating the section on photos was the
            third place a video-only asset lost its download control, after the
            button itself and the card's inline link. */}
        {downloads.length > 0 && (
          <div className="border-t border-border pt-3">
            <p className="mb-2 text-[10px] font-mono font-medium uppercase tracking-[0.14em] text-muted-2">Download</p>
            <AssetDownloadButtons asset={asset} />
          </div>
        )}

        <ApproveRow asset={asset} canApprove={canPublish} connectedPlatforms={connectedPlatforms ?? []} />
        <UnscheduleRow asset={asset} canApprove={canPublish} />

        {/* Unconditional on eligibility - a viewer with no Publish Now button (a
            client, or staff with no compatible connected platform) is exactly
            who most needs to see WHY a scheduled post never went out; the
            retry control below stays gated, the fact of the failure does not. */}
        {asset.publishError && asset.status !== "published" && (
          <PublishStateNotice publishError={asset.publishError} />
        )}
        <PublishNowRow
          asset={asset}
          canPublish={canPublish}
          connectedPlatforms={connectedPlatforms ?? []}
        />
        <MarkPostedRow asset={asset} />
        <PostManagementRow asset={asset} canManage={canPublish} />
      </div>
      )}
    </Modal>
  );
}

/**
 * The panel over a stored `publishError` — and the heading has to match the body.
 *
 * `publishError` carries two different facts. Usually it is the platform SDK's
 * exception (collapsed to one client-safe sentence at the server boundary,
 * lib/asset-visibility). But the publish cron writes its benign ORDERING HOLD
 * into the same field, and this panel headed that "Publish failed" in danger red
 * over a body reading "This post is waiting for an earlier post in this
 * format…" — a heading contradicting its own paragraph, on the client's screen.
 *
 * Which of the two it is comes from `isPublishHold`, the single test for that
 * (lib/asset-status-copy), so this panel, the calendar's chip and the sanitizer
 * cannot disagree about the same stored string. The hold's heading is the same
 * string the chip is labelled with, for the same reason.
 *
 * A hold needs nothing from the reader — the cron releases it by itself on the
 * next tick once the predecessor is posted — so it gets the neutral treatment,
 * not a red one.
 */
function PublishStateNotice({ publishError }: { publishError: string }) {
  if (isPublishHold(publishError)) {
    return (
      <div className="rounded-[var(--radius)] border border-border bg-surface-2 px-3 py-2.5">
        <p className="flex items-center gap-1.5 text-xs font-medium text-foreground">
          <Icon name="CalendarClock" className="h-3.5 w-3.5 shrink-0 text-muted-2" />
          {PUBLISH_HOLD_HEADING}
        </p>
        <p className="mt-0.5 text-xs text-muted">{publishError}</p>
      </div>
    );
  }
  return (
    <div className="rounded-[var(--radius)] border border-danger/30 bg-danger/10 px-3 py-2.5">
      <p className="text-xs font-medium text-danger">Publish failed</p>
      <p className="mt-0.5 text-xs text-danger/90">{publishError}</p>
    </div>
  );
}

/**
 * The deliverable body for everything that isn't a parsed drafts batch.
 *
 * This modal is the only viewer a client can reach, so it may not print
 * machine formatting on screen: an agent deliverable that carries Markdown
 * structure (headings, bullets, tables, bold, blockquotes) goes through
 * renderAssetBody - the asset-specific entry point of the client-safe renderer,
 * which HTML-escapes the source before it touches any markup and, unlike the
 * context-doc entry point, strips no preamble (an agent's first line is its own
 * headline and a leading `---` is a draft separator, not frontmatter). Plain
 * captions keep the verbatim whitespace-pre-wrap paragraph: their line breaks
 * are the content, and reflowing them would misrepresent what gets posted.
 */
function AssetContentBody({ content }: { content: string }) {
  if (!looksLikeMarkdown(content)) {
    return <p className="whitespace-pre-wrap text-sm text-foreground/90">{normalizeDashes(content)}</p>;
  }
  return (
    <div
      className="break-words [&_code]:break-all [&_table]:min-w-0"
      dangerouslySetInnerHTML={{ __html: renderAssetBody(content) }}
    />
  );
}

/**
 * Approve a draft, from the calendar - the same two-step flow the staff Assets
 * list offers (asset-card.tsx): a non-schedulable draft (a note) approves
 * straight through, everything else opens the shared ApprovePanel to pick a
 * publishing tier and a calendar slot. Before this the calendar could only
 * ever DISPLAY a draft that had already been approved elsewhere - opening a
 * draft here offered no way to move it forward at all.
 *
 * Staff only, same gate as PublishNowRow: `approveAssetAction` is
 * `requireStaff()`, so a client-facing button could only ever error.
 */
function ApproveRow({
  asset,
  canApprove,
  connectedPlatforms,
}: {
  asset: Asset;
  canApprove: boolean;
  connectedPlatforms: string[];
}) {
  const router = useRouter();
  const [approving, setApproving] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!canApprove || asset.status !== "draft") return null;

  // Notes have no scheduling dimension - same rule asset-card.tsx applies.
  const calendarEligible = asset.type !== "note";

  async function handleSimpleApprove() {
    setBusy(true);
    setError(null);
    try {
      await approveAssetAction(asset.id);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Approval failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="border-t border-border pt-3">
      {approving ? (
        <ApprovePanel
          asset={asset}
          connectedPlatforms={connectedPlatforms}
          onDone={() => setApproving(false)}
        />
      ) : (
        <>
          <p className="mb-2 text-[10px] font-mono font-medium uppercase tracking-[0.14em] text-muted-2">
            Ready to approve?
          </p>
          <button
            type="button"
            onClick={() => (calendarEligible ? setApproving(true) : handleSimpleApprove())}
            disabled={busy}
            className="inline-flex h-11 items-center gap-1.5 rounded-md border border-border px-3 text-xs font-medium text-muted transition-colors hover:border-border-strong hover:text-foreground disabled:opacity-60"
          >
            <Icon name="Check" className="h-3.5 w-3.5" />
            {busy ? "Approving…" : "Approve"}
          </button>
          <p className="mt-1.5 text-[11px] text-muted-2">
            {calendarEligible
              ? "Pick a publishing tier and a slot, then it lands on the content calendar."
              : "Approves this draft."}
          </p>
          {error && <p className="mt-1.5 text-[11px] text-danger">{error}</p>}
        </>
      )}
    </div>
  );
}

/**
 * Revert an approved or scheduled post back to draft, from the calendar - the
 * same Unschedule the staff Assets list offers (asset-card.tsx). Staff only,
 * same gate as PublishNowRow.
 */
function UnscheduleRow({ asset, canApprove }: { asset: Asset; canApprove: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!canApprove || (asset.status !== "approved" && asset.status !== "scheduled")) return null;

  async function unschedule() {
    setBusy(true);
    setError(null);
    try {
      await unscheduleAssetAction(asset.id);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't unschedule this asset");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="border-t border-border pt-3">
      <p className="mb-2 text-[10px] font-mono font-medium uppercase tracking-[0.14em] text-muted-2">
        Change of plans?
      </p>
      <button
        type="button"
        onClick={unschedule}
        disabled={busy}
        className="inline-flex h-11 items-center gap-1.5 rounded-md border border-border px-3 text-xs font-medium text-muted transition-colors hover:border-border-strong hover:text-foreground disabled:opacity-60"
      >
        <Icon name="RotateCcw" className="h-3.5 w-3.5" />
        {busy ? "Working…" : "Unschedule"}
      </button>
      <p className="mt-1.5 text-[11px] text-muted-2">Pulls it off the calendar and reverts it to draft.</p>
      {error && <p className="mt-1.5 text-[11px] text-danger">{error}</p>}
    </div>
  );
}

/**
 * Manual push, from the calendar - the control three separate strings tell the
 * user to use here ("On the calendar, you push it live with Publish Now").
 *
 * Staff only, and deliberately so: `publishAssetNowAction` is `requireStaff()`,
 * so a client-facing button could only ever error. It sits ABOVE MarkPostedRow
 * and does not replace it - the two answer different questions. Publish Now is
 * "Karos pushes this through the connected integration now"; Mark as posted is
 * the client's attestation that they posted it by hand, and stays the only
 * control a client sees.
 */
function PublishNowRow({
  asset,
  canPublish,
  connectedPlatforms,
}: {
  asset: Asset;
  canPublish: boolean;
  connectedPlatforms: string[];
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(asset.publishError ?? null);

  // Literally the same gate as the asset card now: a connected platform must be
  // able to carry this asset type, and isAssetPublishable — the one shared rule,
  // also enforced by publishAssetNowAction — must accept the asset. This row
  // excluded placeholders by hand but still offered the button on an unapproved
  // draft, which is how "correct here, wrong on the card" hid the real hole.
  const compatibleConnected = (PUBLISHABLE_PLATFORMS[asset.type] ?? []).filter((p) =>
    connectedPlatforms.includes(p),
  );
  const eligible = canPublish && compatibleConnected.length > 0 && isAssetPublishable(asset);
  if (!eligible) return null;

  const target = asset.scheduledPlatform ?? compatibleConnected[0];

  async function publishNow() {
    setBusy(true);
    setError(null);
    try {
      const res = await publishAssetNowAction(asset.id, asset.scheduledPlatform);
      if (res.ok) router.refresh();
      else setError(res.error);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't publish this asset");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="border-t border-border pt-3">
      <p className="mb-2 text-[10px] font-mono font-medium uppercase tracking-[0.14em] text-muted-2">
        Manual push
      </p>
      <button
        type="button"
        onClick={publishNow}
        disabled={busy}
        className="inline-flex h-11 items-center gap-1.5 rounded-md border border-border px-3 text-xs font-medium text-muted transition-colors hover:border-border-strong hover:text-foreground disabled:opacity-60"
      >
        <Icon name="Send" className="h-3.5 w-3.5" />
        {busy ? "Publishing…" : "Publish Now"}
      </button>
      <p className="mt-1.5 text-[11px] text-muted-2">
        Pushes it live via {PLATFORM_LABELS[target] ?? target} right now, whatever the schedule says.
      </p>
      {error && <p className="mt-1.5 text-[11px] text-danger">{error}</p>}
    </div>
  );
}

/**
 * "I posted this myself." The calendar → modal path is how a post gets read on
 * a phone, and posting is done by hand from there (copy the caption, paste it
 * into the platform), so this is where the loop has to be closed - without it
 * nothing the user does can ever move the asset off approved/scheduled.
 */

function Meta({ icon, label, value }: { icon: string; label: string; value: string }) {
  return (
    <div className="flex items-start gap-2">
      <Icon name={icon} className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-2" />
      <div className="min-w-0">
        <p className="text-[10px] uppercase tracking-wide text-muted-2">{label}</p>
        <p className="truncate text-xs font-medium text-foreground">{value}</p>
      </div>
    </div>
  );
}
