"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Modal } from "@/components/modal";
import { Badge, Button, TabButton } from "@/components/ui";
import { Icon } from "@/components/icon";
import { ContextGroundingNotice } from "@/components/context-grounding-notice";
import { AudienceSimulation } from "@/components/audience-simulation";
import { CopyCaptionButton } from "@/components/copy-caption-button";
import { EmailPreview } from "@/components/email-preview";
import { parseLiDrafts } from "@/lib/li-drafts";
import { LiDraftsBatch, type LiMediaFile } from "@/components/li-drafts-review";
import { isRedditV2Envelope, parseRedditDrafts } from "@/lib/reddit-drafts";
import { RedditDraftsBatch } from "@/components/reddit-drafts-review";
import { parseXDrafts, xThreadParts } from "@/lib/x-drafts";
import { draftsDisplayTitle, hasGeneratedTitle } from "@/lib/deliverable-titles";
import { XDraftsBatch } from "@/components/x-drafts-review";
import {
  PUBLISH_HOLD_HEADING,
  assetStatusLabel,
  isPublishHold,
} from "@/lib/asset-status-copy";
import { looksLikeMarkdown, renderAssetBody } from "@/lib/doc-render";
import { normalizeDashes } from "@/lib/text-utils";
import { asDiscovery, asLicenseConfidence, describeDiscovery, describeLicenseConfidence } from "@/lib/agent-engine/clip-review";
import { MarkPostedRow } from "@/components/mark-posted-row";
import { canMarkAssetPosted } from "@/lib/mark-posted";
import { PostManagementRow } from "@/components/post-management-row";
import { ApprovePanel } from "@/components/approve-panel";
import { approveAssetAction, publishAssetNowAction, unscheduleAssetAction } from "@/lib/actions/asset-actions";
import { PLATFORM_LABELS, PUBLISHABLE_PLATFORMS } from "@/lib/integrations/platforms";
import { isAssetPublishable } from "@/lib/asset-visibility";
import {
  type AssetImage,
  assetDownloadTargets,
  assetImages,
  assetLiMedia,
  assetVideoSrc,
  assetVideos,
} from "@/lib/asset-images";
import { templateForAsset } from "@/lib/post-chain";
import { cn } from "@/lib/utils";
import type { Asset } from "@/lib/types";

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
  // The engine ships an X thread's parts as `meta.thread` (materializeXPost)
  // whether or not the markdown spells them out - the reader hangs them under
  // the post as its replies when the markdown holds the opener alone.
  const xThread = useMemo(
    () => (xBatch ? xThreadParts(assetMeta?.thread) : []),
    [assetMeta, xBatch],
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

  /**
   * D11's line: what this post is for, who it speaks to, and why now.
   *
   * THE ENGINE HAS ALWAYS SENT THIS and the portal has always dropped it. Every
   * drafting agent emits `goal`/`audience`/`whyNow` (Reddit says `whyThread`
   * instead, because a reply has no funnel stage to state), the decision says
   * every output states its point, and a client saw a lane label on X, "why
   * this thread" on Reddit and nothing at all on LinkedIn.
   *
   * Read leniently and rendered only when something is there: a run from an
   * older prompt version, or one that resumed mid-flight, legitimately carries
   * none of it, and an empty labelled block is worse than no block.
   */
  const goalLine = (() => {
    const m = asset.meta ?? {};
    const str = (v: unknown): string | undefined =>
      typeof v === "string" && v.trim().length > 0 ? v.trim() : undefined;
    const GOAL_WORDS: Record<string, string> = {
      attention: "Earn attention",
      expertise: "Show expertise",
      decide: "Help them decide",
    };
    const goalRaw = str(m.goal);
    const rows: Array<{ label: string; value: string }> = [];
    // The stored value is the funnel's own word; the client reads the sentence.
    if (goalRaw) rows.push({ label: "Goal", value: GOAL_WORDS[goalRaw] ?? goalRaw });
    const who = str(m.audience);
    if (who) rows.push({ label: "Who it is for", value: who });
    const why = str(m.whyNow) ?? str(m.whyThread);
    if (why) rows.push({ label: "Why now", value: why });
    return rows;
  })();
  /**
   * A clip's provenance and repair ledger, STAFF ONLY (agent-engine RFC-25).
   *
   * The engine has written these onto the clip deliverable since 2026-09, and
   * nothing in this portal rendered them: once the approval gate was resolved,
   * "whose recording is this clip of" and "did it come out clean or was it
   * salvaged" became unanswerable without opening the run in Firestore. The
   * gate is where the decision is made, but the deliverable is what outlives
   * it, and both questions get asked again months later.
   *
   * Not shown to a client, and that is the CLAUDE.md rule rather than a
   * judgement call: internal meta stays off the client's card. "We had to
   * redact a sentence and swap a picture" is a note between the agent and the
   * people running it. What the client is owed is the clip and the caption
   * carrying its source credit, and both ship regardless.
   */
  const clipProvenance = (() => {
    if (viewerIsClient) return null;
    const m = asset.meta ?? {};
    const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim().length > 0 ? v.trim() : undefined);
    const ctx = (typeof m.sourceContext === "object" && m.sourceContext !== null ? m.sourceContext : {}) as Record<string, unknown>;
    const repairs = Array.isArray(m.contentRepairs)
      ? m.contentRepairs.flatMap((r): Array<{ check: string; action: string; detail: string }> => {
          if (typeof r !== "object" || r === null) return [];
          const row = r as Record<string, unknown>;
          if (str(row.check) === undefined || str(row.detail) === undefined) return [];
          return [{ check: str(row.check)!, action: str(row.action) ?? "unresolved", detail: str(row.detail)! }];
        })
      : [];
    const licence = asLicenseConfidence(m.licenseConfidence);
    const url = str(ctx.url);
    const channel = str(ctx.channel) ?? str(ctx.title);
    const discovery = asDiscovery(ctx.discovery);
    if (licence === undefined && url === undefined && channel === undefined && repairs.length === 0) return null;
    return { licence, url, channel, discovery, repairs };
  })();
  // The engine's email-safe render of a newsletter edition (2026-09-05). Only an
  // email asset carries one; every other type keeps the plain content view.
  const emailHtml = asset.type === "email" && typeof asset.meta?.html === "string" && asset.meta.html.length > 0 ? asset.meta.html : undefined;
  const slides = (asset.meta?.slides as SlideMeta[] | undefined)?.filter(Boolean) ?? [];
  const channels = asset.channels ?? [];
  const when = asset.scheduledAt ?? asset.recommendedAt;
  // Every photo the post carries, in slide order, whatever shape the ingest
  // wrote (meta.slides, meta.images, meta.files, imageUrl). The gallery below
  // draws ALL of them: this modal used to show the first photo only for any
  // post without structured meta.slides — every lab-imported carousel — and a
  // thumbnail list for the rest, so "see each slide" was true for one shape.
  const images = assetImages(asset);
  const coverImageUrl = images.length > 0 ? images[0].url : null;
  const videos = assetVideos(asset);
  // Whether this asset offers anything to download at all — the same helper
  // the buttons use, so a mount and its contents cannot disagree. Photo-only
  // posts get the control in the gallery's header; everything else (clips, or
  // photos beside a clip) gets it once, below the media.
  const downloads = assetDownloadTargets(asset);
  const showGallery = images.length > 0 && videos.length === 0;

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
        {/* Status + template row. The asset's type used to print here too
            ("instagram post" beside a camera); the photos below say it, so
            it was a label for something already on screen (Albert, 2026-09-14). */}
        <div className="flex flex-wrap items-center gap-2">
          {/* Never the raw enum. The tone stays local (presentation is this
              component's business); the WORD comes from the register the viewer
              belongs to (lib/asset-status-copy), which is the same lookup the
              archive one screen away already uses. */}
          <Badge tone={statusTone(asset.status)}>{assetStatusLabel(asset.status, viewerIsClient)}</Badge>
          {template && <Badge tone="neutral">{template.name}</Badge>}
        </div>

        {/* SCRUM-404: the context-grounding note, ABOVE the content it
            qualifies rather than footnoted below it. This modal is the only
            deliverable viewer a client can reach, so it is the one place the
            note has to land for the marker to be genuinely visible — the same
            argument that put the draft-batch readers here. Absent on the normal
            path: a fully-grounded deliverable renders nothing new. */}
        {asset.contextGrounding && <ContextGroundingNotice grounding={asset.contextGrounding} />}

        {/* The facts, in one row. Only facts that exist: a "Channels: -" cell
            told the reader nothing and cost a line, and the two-column grid
            spread three short values over a card taller than the pills above
            it. Same labels, same icons, one line on a desktop width. */}
        {(when != null || asset.publishMode || asset.scheduledPlatform || channels.length > 0) && (
          <div className="flex flex-wrap gap-x-6 gap-y-2 rounded-md border border-border bg-surface-2 px-3 py-2.5">
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
            {channels.length > 0 && (
              <Meta
                icon="Share2"
                label="Channels"
                value={channels.map((c) => PLATFORM_LABELS[c] ?? c).join(", ")}
              />
            )}
          </div>
        )}

        {asset.recommendedReason && asset.scheduledAt == null && (
          <p className="flex items-start gap-1.5 text-[11px] text-muted-2">
            <Icon name="Sparkles" className="mt-0.5 h-3 w-3 shrink-0 text-neon" />
            {asset.recommendedReason}
          </p>
        )}

        {/* The photos — every slide of a carousel, one at a time with the rest
            in a rail underneath, and the download control in the gallery's own
            header where the thing it downloads is. A single-photo post is the
            same component with no rail. Video posts keep the player below and
            skip the gallery: their cover is the player's poster. */}
        {showGallery && (
          // Keyed on the asset so a different post in the same mounted modal
          // starts on its first slide (state resets with the remount).
          <SlideGallery key={asset.id} asset={asset} images={images} slides={slides} />
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
        {/* Downloads — photos AND clips — for whatever the gallery is not
            showing. Gated on the shared helper, never on photos: gating on
            photos was the third place a video-only asset lost its control. */}
        {downloads.length > 0 && (
          !showGallery && (
          <div className="flex justify-end">
            <AssetDownloadButtons asset={asset} />
          </div>
        ))}

        {/* Content - a parsed drafts batch gets the per-draft reader (pick,
            edit, skip, each choice feeding the agent's next run); anything
            else gets the caption with a copy button. */}
        {liBatch ? (
          <div>
            <p className="mb-1.5 text-[10px] font-label font-medium uppercase tracking-[0.14em] text-muted-2">Drafts</p>
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
            <p className="mb-1.5 text-[10px] font-label font-medium uppercase tracking-[0.14em] text-muted-2">Drafts</p>
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
            <p className="mb-1.5 text-[10px] font-label font-medium uppercase tracking-[0.14em] text-muted-2">Drafts</p>
            <XDraftsBatch
              clientId={asset.clientId}
              {...(asset.jobId ? { jobId: asset.jobId } : {})}
              assetId={asset.id}
              accounts={xBatch.accounts}
              {...(xThread.length > 0 ? { thread: xThread } : {})}
            />
          </div>
        ) : emailHtml ? (
          <div>
            <p className="mb-1.5 text-[10px] font-label font-medium uppercase tracking-[0.14em] text-muted-2">Edition</p>
            {/* A newsletter's deliverable is the email, not the markdown: the
                engine renders every approved edition to email-safe HTML in both
                themes (asset.meta.html / htmlDark) and this shows that render,
                with the text the reviewer read under its own tab. */}
            <EmailPreview
              html={emailHtml}
              {...(typeof asset.meta?.htmlDark === "string" ? { htmlDark: asset.meta.htmlDark } : {})}
              textFallback={
                <div>
                  <div className="mb-1.5 flex items-center justify-end">
                    <CopyCaptionButton asset={asset} variant="full" />
                  </div>
                  <AssetContentBody content={asset.content} />
                </div>
              }
            />
          </div>
        ) : (
          <div>
            <div className="mb-1.5 flex items-center justify-between gap-2">
              <p className="text-[10px] font-label font-medium uppercase tracking-[0.14em] text-muted-2">
                {images.length > 0 ? "Caption" : "Content"}
              </p>
              {/* Posting happens by hand from a phone, and this modal is the
                  phone's way into a post - so copy is a primary action here, not
                  the card's hover-revealed icon. */}
              <CopyCaptionButton asset={asset} variant="full" />
            </div>
            <AssetContentBody content={asset.content} />
            {hashtags.length > 0 && (
              <p className="mt-2 text-xs text-muted">{hashtags.map((h) => "#" + h).join(" ")}</p>
            )}
          </div>
        )}

        {hashtags.length > 0 && (liBatch || redditBatch || xBatch || emailHtml) && (
          <p className="text-xs text-muted">{hashtags.map((h) => "#" + h).join(" ")}</p>
        )}

        {goalLine.length > 0 && (
          <div className="rounded-lg bg-surface-2 p-2.5">
            <p className="mb-1.5 text-[10px] font-label font-medium uppercase tracking-[0.14em] text-muted-2">
              The point of this post
            </p>
            <dl className="space-y-1">
              {goalLine.map((row) => (
                <div key={row.label} className="flex gap-1.5 text-xs">
                  <dt className="shrink-0 font-medium text-foreground">{row.label}:</dt>
                  <dd className="text-muted">{row.value}</dd>
                </div>
              ))}
            </dl>
          </div>
        )}

        {imageConcept && (
          <p className="rounded-lg bg-surface-2 p-2 text-xs text-muted">
            <span className="font-medium text-foreground">Visual: </span>
            {imageConcept}
          </p>
        )}

        {/* Staff only — see `clipProvenance` above for why. */}
        {clipProvenance && (
          <div className="rounded-lg bg-surface-2 p-2.5">
            <p className="mb-1.5 text-[10px] font-label font-medium uppercase tracking-[0.14em] text-muted-2">Where this clip came from</p>
            {clipProvenance.licence !== undefined && (
              <p className="text-xs">
                <span className="font-medium text-foreground">{describeLicenseConfidence(clipProvenance.licence).label}</span>
                <span className="text-muted"> · {describeLicenseConfidence(clipProvenance.licence).detail}</span>
              </p>
            )}
            {(clipProvenance.channel !== undefined || clipProvenance.discovery !== undefined) && (
              <p className="mt-1 text-xs text-muted">
                {clipProvenance.channel ?? ""}
                {clipProvenance.channel !== undefined && clipProvenance.discovery !== undefined ? " · " : ""}
                {clipProvenance.discovery !== undefined ? describeDiscovery(clipProvenance.discovery) : ""}
              </p>
            )}
            {clipProvenance.url !== undefined && (
              <a
                href={clipProvenance.url}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-1 inline-block break-all text-xs text-neon underline decoration-dotted underline-offset-2"
              >
                {clipProvenance.url}
              </a>
            )}
            {clipProvenance.repairs.length > 0 && (
              <div className="mt-2 border-t border-border/60 pt-2">
                <p className="text-xs font-medium text-foreground">
                  This run adapted around {clipProvenance.repairs.length} thing{clipProvenance.repairs.length === 1 ? "" : "s"}
                </p>
                <ul className="mt-1 space-y-1">
                  {clipProvenance.repairs.map((r) => (
                    <li key={`${r.check}-${r.detail}`} className="text-xs">
                      <span className="text-muted-2">
                        {r.check} · {r.action}
                      </span>
                      <br />
                      <span className="text-muted">{normalizeDashes(r.detail)}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}

        {/* Unconditional on eligibility - a viewer with no Publish Now button (a
            client, or staff with no compatible connected platform) is exactly
            who most needs to see WHY a scheduled post never went out; the
            retry control below stays gated, the fact of the failure does not. */}
        {asset.publishError && asset.status !== "published" && (
          <PublishStateNotice publishError={asset.publishError} />
        )}

        <ActionFooter asset={asset} canPublish={canPublish} connectedPlatforms={connectedPlatforms ?? []} />
      </div>
      )}
    </Modal>
  );
}

/**
 * Every slide of a post, one at a time, with the rest visible in a rail
 * underneath — the reader gets the whole carousel, not its cover.
 *
 * Three things this replaces at once: the cover-only `<img>` that any post
 * without structured `meta.slides` got (every lab-imported carousel showed
 * slide 1 and hid the other three behind "Download all"); the thumbnail list
 * that the engine's own carousels got instead, which showed each slide at
 * 80×96 beside a copy of text already painted on it; and the separate
 * "Download" section two blocks further down, which is now the control in this
 * gallery's header, beside the count of what it downloads.
 *
 * Scroll-snap does the paging so a phone swipes it natively; the arrows, the
 * counter and the rail are the same gesture for a mouse. The rail's selected
 * ring is the one orange in this block — a control, so the accent rule allows
 * it.
 */
function SlideGallery({ asset, images, slides }: { asset: Asset; images: AssetImage[]; slides: SlideMeta[] }) {
  const stripRef = useRef<HTMLDivElement>(null);
  const [index, setIndex] = useState(0);
  const count = images.length;
  const many = count > 1;

  // The strip is the source of truth for "which slide": a swipe, a wheel and an
  // arrow press all end in a scroll, and this reads the landed position back.
  const onScroll = useCallback(() => {
    const el = stripRef.current;
    if (!el || el.clientWidth === 0) return;
    setIndex(Math.min(count - 1, Math.max(0, Math.round(el.scrollLeft / el.clientWidth))));
  }, [count]);

  const goTo = useCallback(
    (i: number) => {
      const el = stripRef.current;
      if (!el) return;
      const next = Math.min(count - 1, Math.max(0, i));
      el.scrollTo({ left: next * el.clientWidth, behavior: "smooth" });
      setIndex(next);
    },
    [count],
  );

  const current = slides[index];
  const copy = current ? [current.headline, current.body].filter(Boolean).join(" · ") : null;

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <p className="inline-flex items-center gap-1.5 text-[10px] font-label font-medium uppercase tracking-[0.14em] text-muted-2">
          <Icon name={many ? "Images" : "Image"} className="h-3.5 w-3.5" />
          {many ? `${count} slides` : "Photo"}
        </p>
        <AssetDownloadButtons asset={asset} />
      </div>

      <div
        className="group relative overflow-hidden rounded-lg border border-border bg-surface-2"
        tabIndex={many ? 0 : -1}
        onKeyDown={(e) => {
          if (!many) return;
          if (e.key === "ArrowLeft") {
            e.preventDefault();
            goTo(index - 1);
          } else if (e.key === "ArrowRight") {
            e.preventDefault();
            goTo(index + 1);
          }
        }}
        aria-roledescription={many ? "carousel" : undefined}
        aria-label={many ? `${count} slides` : undefined}
      >
        <div
          ref={stripRef}
          onScroll={onScroll}
          className="flex snap-x snap-mandatory overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        >
          {images.map((img, i) => (
            <div key={img.url + i} className="w-full shrink-0 snap-start" aria-hidden={i !== index}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={img.url}
                alt={many ? `Slide ${i + 1} of ${count}` : asset.title}
                loading={i === 0 ? "eager" : "lazy"}
                className="mx-auto max-h-[72vh] w-full object-contain"
              />
            </div>
          ))}
        </div>

        {many && (
          <>
            <button
              type="button"
              onClick={() => goTo(index - 1)}
              disabled={index === 0}
              aria-label="Previous slide"
              className="focus-ring absolute left-2 top-1/2 flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-full border border-border bg-background/85 text-foreground opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 disabled:hidden"
            >
              <Icon name="ChevronLeft" className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={() => goTo(index + 1)}
              disabled={index === count - 1}
              aria-label="Next slide"
              className="focus-ring absolute right-2 top-1/2 flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-full border border-border bg-background/85 text-foreground opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 disabled:hidden"
            >
              <Icon name="ChevronRight" className="h-4 w-4" />
            </button>
            <span
              aria-live="polite"
              className="pointer-events-none absolute bottom-2 right-2 rounded-full border border-border bg-background/85 px-2 py-0.5 font-label text-[11px] tabular-nums text-foreground"
            >
              {index + 1} / {count}
            </span>
          </>
        )}
      </div>

      {many && (
        <div className="flex gap-1.5 overflow-x-auto pb-0.5 [scrollbar-width:thin]">
          {images.map((img, i) => (
            <button
              key={img.url + i}
              type="button"
              onClick={() => goTo(i)}
              aria-label={`Slide ${i + 1}`}
              aria-current={i === index ? "true" : undefined}
              className={cn(
                "focus-ring shrink-0 overflow-hidden rounded border transition-opacity",
                i === index ? "border-neon opacity-100 ring-1 ring-neon" : "border-border opacity-55 hover:opacity-100",
              )}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={img.url} alt="" loading="lazy" className="h-14 w-11 object-cover" />
            </button>
          ))}
        </div>
      )}

      {/* The current slide's copy, for a carousel the engine wrote as text +
          image (meta.slides). Selectable, unlike the text painted on the PNG. */}
      {copy && <p className="text-xs text-muted">{copy}</p>}
    </div>
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
 * Everything a viewer can DO to this post, in one bar at the bottom — the
 * lifecycle move on the left (Approve, Publish now, Unschedule, Mark as posted),
 * the destructive ones on the right (Unpublish, Delete). One hint line, for the
 * leading action only.
 *
 * Before this each control was its own titled section ("Ready to approve?",
 * "Change of plans?", "Manual push", "Already posted it?", "Manage this post"),
 * every one with an eyebrow, a divider and a sentence, so a draft with two
 * possible actions took four blocks and the panel read as a form. The same
 * components answer the same eligibility questions as before (canApprove,
 * isAssetPublishable, canMarkAssetPosted); only the chrome around them is
 * shared now. Approving expands the shared ApprovePanel in place of the bar.
 *
 * Renders nothing when the viewer has nothing to do here (a client on a draft),
 * so a client never sees an empty bar.
 */
function ActionFooter({
  asset,
  canPublish,
  connectedPlatforms,
}: {
  asset: Asset;
  canPublish: boolean;
  connectedPlatforms: string[];
}) {
  const [approving, setApproving] = useState(false);

  // Whether ANY control below would render, asked with the same predicates
  // those controls use — so the bar cannot appear around nothing. The
  // mark-posted rule reads the clock (has this post's day arrived), which is
  // the point of it; the directive scopes to the next source line only.
  // eslint-disable-next-line react-hooks/purity
  const canMarkPosted = canMarkAssetPosted(asset, Date.now());
  const isDraft = asset.status === "draft";
  const isPlanned = asset.status === "approved" || asset.status === "scheduled";
  if (!canPublish && !canMarkPosted) return null;

  if (approving) {
    return (
      <div className="border-t border-border pt-1">
        <ApprovePanel
          asset={asset}
          connectedPlatforms={connectedPlatforms}
          agentChannels={asset.channels}
          onDone={() => setApproving(false)}
        />
      </div>
    );
  }

  return (
    <div className="flex flex-wrap items-start justify-between gap-3 border-t border-border pt-3">
      <div className="flex flex-wrap items-start gap-2">
        {canPublish && isDraft && <ApproveInline asset={asset} onOpenPanel={() => setApproving(true)} />}
        {canPublish && isPlanned && (
          <PublishNowInline asset={asset} canPublish={canPublish} connectedPlatforms={connectedPlatforms} />
        )}
        {canPublish && isPlanned && <UnscheduleInline asset={asset} />}
        <MarkPostedRow asset={asset} variant="button" />
      </div>
      <PostManagementRow asset={asset} canManage={canPublish} variant="button" />
    </div>
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
 * Staff only, same gate as PublishNowInline: `approveAssetAction` is
 * `requireStaff()`, so a client-facing button could only ever error. The
 * caller (ActionFooter) has already checked the status.
 */
function ApproveInline({ asset, onOpenPanel }: { asset: Asset; onOpenPanel: () => void }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
    <div className="flex flex-col gap-1">
      <Button
        size="sm"
        variant="outline"
        onClick={() => (calendarEligible ? onOpenPanel() : handleSimpleApprove())}
        loading={busy}
        title={calendarEligible ? "Pick a publishing tier and a slot; it lands on the content calendar" : "Approves this draft"}
      >
        <Icon name="Check" className="h-3.5 w-3.5" />
        Approve
      </Button>
      <p className="text-[11px] text-muted-2">
        {calendarEligible ? "Pick a tier and a slot, then it lands on the calendar." : "Approves this draft."}
      </p>
      {error && <p className="text-[11px] text-danger">{error}</p>}
    </div>
  );
}

/**
 * Revert an approved or scheduled post back to draft, from the calendar - the
 * same Unschedule the staff Assets list offers (asset-card.tsx). Staff only,
 * same gate as PublishNowInline; the caller has checked the status.
 */
function UnscheduleInline({ asset }: { asset: Asset }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
    <div className="flex flex-col gap-1">
      <Button size="sm" variant="outline" onClick={unschedule} loading={busy} title="Pulls it off the calendar and reverts it to draft">
        <Icon name="RotateCcw" className="h-3.5 w-3.5" />
        Unschedule
      </Button>
      {error && <p className="text-[11px] text-danger">{error}</p>}
    </div>
  );
}

/**
 * Manual push, from the calendar - the control three separate strings tell the
 * user to use here ("On the calendar, you push it live with Publish Now").
 *
 * Staff only, and deliberately so: `publishAssetNowAction` is `requireStaff()`,
 * so a client-facing button could only ever error. It sits BESIDE MarkPostedRow
 * and does not replace it - the two answer different questions. Publish Now is
 * "Karos pushes this through the connected integration now"; Mark as posted is
 * the client's attestation that they posted it by hand, and stays the only
 * control a client sees.
 */
function PublishNowInline({
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

  const targets = asset.scheduledPlatforms?.length
    ? asset.scheduledPlatforms
    : [asset.scheduledPlatform ?? compatibleConnected[0]];
  const targetLabel = targets.map((t) => PLATFORM_LABELS[t] ?? t).join(" + ");

  async function publishNow() {
    setBusy(true);
    setError(null);
    try {
      // No explicit platform: the action reads asset.scheduledPlatforms itself
      // and publishes to every one of them.
      const res = await publishAssetNowAction(asset.id);
      if (res.ok) router.refresh();
      else setError(res.error);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't publish this asset");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-1">
      <Button size="sm" variant="outline" onClick={publishNow} loading={busy} title={`Pushes it live via ${targetLabel} right now, whatever the schedule says`}>
        <Icon name="Send" className="h-3.5 w-3.5" />
        Publish now
      </Button>
      <p className="text-[11px] text-muted-2">Live via {targetLabel} now, whatever the schedule says.</p>
      {error && <p className="text-[11px] text-danger">{error}</p>}
    </div>
  );
}

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
