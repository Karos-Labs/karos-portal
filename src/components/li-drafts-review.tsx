"use client";

/**
 * The LinkedIn drafts reader: a parsed draft batch rendered as readable cards
 * - grouped per account, one card per post.
 *
 * UNIFIED BUTTON SET (product ruling, 2026-09-21, third iteration): the host
 * (asset-card.tsx / asset-detail-modal.tsx) already renders the same
 * Approve / Publish Now / Download / Delete every other platform's draft
 * gets. This reader used to ALSO render its own competing "Pick & post" /
 * "Pick with edits" / "Request a change" / "Skip" decision tree beside that
 * bar — two uncoordinated button groups on one card, which is exactly what
 * the CEO flagged on a live screenshot ("you just left BOTH the Approve
 * button AND the Pick & post buttons - that's just confusing"). Now this
 * reader offers exactly ONE primary control per draft, "Open in LinkedIn" -
 * a convenience shortcut, never a competing publish mechanism - plus the
 * shared Download. Editing, requesting a change and skipping still exist
 * (the learning loop reads them - see `send()` below) but demoted to plain
 * text links under the primary row, matching how a secondary action reads
 * everywhere else in this codebase (compare "Unschedule" on the scheduled-
 * info strip in asset-card.tsx).
 *
 * "Open in LinkedIn" is also the posting hand-off for content the real
 * OAuth publisher can't reach at all (a personal seat's post, or an older
 * multi-draft batch) - it copies the final text to the clipboard and opens
 * LinkedIn's compose prefilled via linkedin.com/feed/?shareActive=true&text=…
 * (verified live 2026-07-24: full prefill incl. newlines/emoji/links up to
 * LinkedIn's 3,000-char cap; the auth wall carries the link through login).
 * The deep link is undocumented, so the clipboard copy is always made first -
 * if LinkedIn ever drops the prefill, the text is already on the clipboard.
 * Files cannot ride a URL: the card lists them for download + manual attach.
 * ALWAYS available, whatever the draft's Publish Now eligibility or the
 * client's `agentAutoPublish` setting - it only opens a compose window with
 * text in it, so it is harmless to offer even on an already-published draft.
 * Draft-only stays true here - the human presses Post on LinkedIn.
 *
 * v2 ships TEXT posts: no image, no document, no video is sourced for a post
 * (lab decision, 2026-08-03 - the reasoning and the route back are in the lab's
 * references/lanes.md sec 3). The file list is therefore usually empty, and the
 * one case that fills it is an asset the CLIENT supplied through their own drop
 * box, which does ship with its post. That is why the attach affordance stays
 * rather than being removed: we never source a visual, we do use theirs.
 *
 * Chrome-less by design: it embeds wherever outputs live (the asset card in
 * the archive and on the job page).
 */

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Badge, Button, Textarea } from "@/components/ui";
import { Icon, LinkedInLogo } from "@/components/icon";
import { addLiDraftFeedbackAction } from "@/lib/actions/linkedin-agent-actions";
import { laneLabel } from "@/lib/draft-lane-label";
import { stripInlineMarkdown } from "@/lib/doc-render";
import { normalizeDashes } from "@/lib/text-utils";
import { assetFileStem } from "@/lib/asset-images";
import type { LiParsedAccount, LiParsedDraft } from "@/lib/li-drafts";
import { splitMetaLinks } from "@/lib/draft-meta";
import { AwaitingReviewBadge, DownloadDraftButton, DraftMediaDownloads } from "@/components/draft-review-kit";

type SentState = "posted" | "posted_with_edits" | "not_posted" | "edit_request";

/** A client-facing run artifact the reader can offer for manual attach. */
export interface LiMediaFile {
  name: string;
  url: string;
}

const LINKEDIN_POST_CAP = 3_000;

/**
 * LinkedIn compose deep link with the text prefilled. Past the 3,000-char cap
 * the prefill is unreliable - open the bare composer and let the copied text
 * carry the post.
 */
function liComposeUrl(text: string): string {
  if (text.length > LINKEDIN_POST_CAP) return "https://www.linkedin.com/feed/?shareActive=true";
  return `https://www.linkedin.com/feed/?shareActive=true&text=${encodeURIComponent(text)}`;
}

/** "1234 chars" → "1,234 / 3,000" (LinkedIn's post cap). */
function charLabel(chars?: string): string | null {
  const n = chars?.match(/\d+/)?.[0];
  if (!n) return chars ?? null;
  return `${Number(n).toLocaleString()} / 3,000`;
}

/**
 * The artifacts a draft names in its Media bullet, resolved against the run's
 * files. Exact or path-basename matches only - the pinned instructions
 * require exact file names, and substring matching would attach
 * "slide-11.png" to a bullet naming "1.png".
 */
function mediaFor(draft: LiParsedDraft, media: LiMediaFile[], soloDraft: boolean): LiMediaFile[] {
  if (draft.mediaNames.length > 0) {
    return media.filter((m) =>
      draft.mediaNames.some((n) => m.name === n || m.name.split("/").pop() === n),
    );
  }
  // A single-post batch (Path A: one post per run) owns every media artifact.
  return soloDraft ? media : [];
}

function DraftCard({
  clientId,
  jobId,
  assetId,
  accountTitle,
  draft,
  media,
  published,
}: {
  clientId: string;
  jobId?: string;
  assetId: string;
  accountTitle: string;
  draft: LiParsedDraft;
  media: LiMediaFile[];
  /**
   * This asset already went out for real through the OAuth publisher —
   * either `ClientIntegration.agentAutoPublish` fired the instant it was
   * approved, or a staff member pressed the host's own Publish Now. Either
   * way there is nothing left to pick: the card shows a plain confirmation
   * instead of an action row that would otherwise suggest this is still
   * pending. Eligibility for Publish Now requires exactly one account with
   * one draft (agentDraftAutoPublishTarget), so this can only ever be true
   * for that single card — but it is threaded per-draft rather than
   * assumed, same discipline as the old suppression prop it replaces.
   */
  published?: boolean;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [mode, setMode] = useState<"idle" | "editing" | "skipping" | "requesting">("idle");
  const [sent, setSent] = useState<SentState | null>(null);
  const [postUrl, setPostUrl] = useState<string | null>(null);
  const [handedOff, setHandedOff] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [finalText, setFinalText] = useState("");
  const [reason, setReason] = useState("");

  const draftRef = `${accountTitle} · ${draft.lane}`;

  async function send(action: SentState, textUsed?: string) {
    setError(null);
    // Picking IS the posting hand-off (skips and change requests never open
    // the composer). The clipboard write is AWAITED before window.open -
    // Chrome rejects clipboard writes once the new tab steals focus, and the
    // copy is the safety net for the undocumented deep link. The await stays
    // inside the click gesture's transient activation, so popup blockers
    // still allow the open. A retry after a failed feedback write must NOT
    // open a second compose.
    if (action !== "not_posted" && action !== "edit_request" && !handedOff) {
      const text = textUsed ?? draft.text;
      const url = liComposeUrl(text);
      setPostUrl(url);
      setHandedOff(true);
      if (navigator.clipboard) {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
        } catch {
          // The deep link still carries the text; the copy label stays honest.
        }
      }
      window.open(url, "_blank", "noopener");
    }
    start(async () => {
      const result = await addLiDraftFeedbackAction({
        clientId,
        accountTitle,
        ...(jobId ? { jobId } : {}),
        assetId,
        draftRef,
        action,
        ...(action === "posted_with_edits" ? { finalText: textUsed ?? finalText } : {}),
        ...(action === "not_posted" || action === "edit_request" ? { reason } : {}),
      });
      if (result.error) {
        setError(
          handedOff && action !== "not_posted" && action !== "edit_request"
            ? `${result.error} Your post is already open on LinkedIn. Click again to save your choice here (we will not open LinkedIn a second time).`
            : result.error,
        );
        return;
      }
      setSent(action);
      setMode("idle");
      router.refresh();
    });
  }

  return (
    <div className="rounded-lg border border-border bg-surface-2 p-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm font-medium">{laneLabel(draft.lane)}</p>
        <div className="flex items-center gap-2">
          {charLabel(draft.chars) ? (
            <span title="Character count. LinkedIn posts cap at 3,000 characters.">
              <Badge>{charLabel(draft.chars)}</Badge>
            </span>
          ) : null}
          {published ? (
            <Badge tone="success">Posted</Badge>
          ) : sent ? (
            <Badge tone="success">
              {sent === "posted"
                ? "Opened"
                : sent === "posted_with_edits"
                  ? "Opened with edits"
                  : sent === "edit_request"
                    ? "Change requested"
                    : "Skipped"}
            </Badge>
          ) : (
            <AwaitingReviewBadge />
          )}
        </div>
      </div>
      {draft.laneNote ? (
        <p className="mt-1 text-xs text-muted">
          {normalizeDashes(stripInlineMarkdown(draft.laneNote))}
        </p>
      ) : null}

      <div className="mt-3 rounded-md border border-border bg-background p-4">
        <p className="whitespace-pre-wrap text-[15px] leading-relaxed text-foreground">{draft.text}</p>
      </div>

      {/* LinkedIn cannot prefill files, so any media the run attached still has
          to be attached by hand — the shared list (used by every reader) says
          so once, here. */}
      <DraftMediaDownloads media={media} />

      {draft.meta.length > 0 ? (
        <ul className="mt-2 space-y-0.5">
          {draft.meta.map((m, i) => (
            <li key={i} className="break-words text-xs text-muted">
              {/* Linkified AND de-marked: the lab writes these bullets in
                  markdown, so the prose runs are stripped (F70 - raw ** must
                  never reach a client), while a link run is a bare URL and is
                  rendered verbatim; stripping inside an href would corrupt it. */}
              {splitMetaLinks(m).map((seg, j) =>
                seg.href ? (
                  <a
                    key={j}
                    href={seg.href}
                    target="_blank"
                    rel="noopener"
                    className="underline hover:text-foreground"
                  >
                    {seg.text}
                  </a>
                ) : (
                  <span key={j}>{normalizeDashes(stripInlineMarkdown(seg.text))}</span>
                ),
              )}
            </li>
          ))}
        </ul>
      ) : null}

      {published ? (
        // Already went out for real (auto-publish on approval, or a staff
        // click on the host's own Publish Now) — see the `published` prop's
        // own doc. Nothing left to do here but offer the text.
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <DownloadDraftButton text={draft.text} filename={`${assetFileStem(accountTitle)}-linkedin.txt`} />
          <p className="text-[11px] text-muted-2">Karos posted this to LinkedIn.</p>
        </div>
      ) : sent === null ? (
        <div className="mt-3 space-y-2">
          {mode === "editing" ? (
            <>
              <Textarea
                rows={6}
                value={finalText}
                onChange={(e) => setFinalText(e.target.value)}
                placeholder="Your final version."
              />
              {finalText.trim().length > LINKEDIN_POST_CAP ? (
                <p className="text-xs text-danger">
                  {finalText.trim().length.toLocaleString()} characters. LinkedIn posts cap at
                  3,000. Trim it before posting.
                </p>
              ) : null}
              <div className="flex gap-2">
                <Button
                  size="sm"
                  onClick={() => send("posted_with_edits", finalText)}
                  disabled={pending || !finalText.trim() || finalText.trim().length > LINKEDIN_POST_CAP}
                >
                  {pending ? "Opening…" : "Open in LinkedIn"}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setMode("idle")}>
                  Cancel
                </Button>
              </div>
            </>
          ) : mode === "requesting" ? (
            <>
              <Textarea
                rows={2}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="What should change? Tone, angle, a fact to fix. In your own words."
              />
              <div className="flex gap-2">
                <Button
                  size="sm"
                  onClick={() => send("edit_request")}
                  disabled={pending || !reason.trim()}
                >
                  {pending ? "Sending…" : "Request the change"}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setMode("idle")}>
                  Cancel
                </Button>
              </div>
            </>
          ) : mode === "skipping" ? (
            <>
              <Textarea
                rows={2}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Why not this one? That is what teaches the agent."
              />
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant="danger"
                  onClick={() => send("not_posted")}
                  disabled={pending || !reason.trim()}
                >
                  {pending ? "Sending…" : "Skip it"}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setMode("idle")}>
                  Cancel
                </Button>
              </div>
            </>
          ) : (
            <>
              {/* ONE primary control, plus the shared Download — the same
                  weight every other platform's drafts get. "Open in LinkedIn"
                  is a convenience shortcut, not a competing publish
                  mechanism: it just prefills the composer, so it is offered
                  here whatever this draft's Publish Now eligibility is. */}
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="accent" onClick={() => send("posted")} disabled={pending}>
                  <Icon name="ExternalLink" className="mr-1 h-3.5 w-3.5" />
                  {pending ? "Opening…" : "Open in LinkedIn"}
                </Button>
                <DownloadDraftButton
                  text={draft.text}
                  filename={`${assetFileStem(accountTitle)}-linkedin.txt`}
                />
              </div>
              <p className="text-[11px] text-muted-2">
                Copies the text and opens LinkedIn with the post ready
                {media.length > 0 ? "; download the files above and attach them in the composer" : ""}
                . You press Post.
                {/* A suggestion, in the client's words as a suggestion: the agent
                    writes one post a day starting tomorrow, and the client owns
                    the actual date. Preferred over the older window line when
                    both are present — a day is more use than a time of day. */}
                {draft.suggestedDate
                  ? ` Suggested for ${draft.suggestedDate}, but post it whenever suits you.`
                  : draft.postWindow
                    ? ` Best window: ${normalizeDashes(stripInlineMarkdown(draft.postWindow))}.`
                    : ""}
              </p>
              {/* Secondary — still feeds the learning loop (see `send()`),
                  demoted to plain text links so they read as options, not
                  four equal-weight buttons. */}
              <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px]">
                <button
                  type="button"
                  onClick={() => {
                    setFinalText(draft.text);
                    setMode("editing");
                  }}
                  className="text-muted underline hover:text-foreground"
                >
                  Open with edited text
                </button>
                <button
                  type="button"
                  onClick={() => setMode("requesting")}
                  className="text-muted underline hover:text-foreground"
                >
                  Request a change
                </button>
                <button
                  type="button"
                  onClick={() => setMode("skipping")}
                  className="text-muted underline hover:text-foreground"
                >
                  Skip this one
                </button>
              </p>
            </>
          )}
          {error ? <p className="text-xs text-danger">{error}</p> : null}
        </div>
      ) : sent === "posted" || sent === "posted_with_edits" ? (
        <div className="mt-3 flex items-center gap-3">
          <p className="text-[11px] text-muted-2">
            {copied ? "Text copied. Finish on LinkedIn." : "Finish on LinkedIn."}
          </p>
          {postUrl ? (
            <a
              href={postUrl}
              target="_blank"
              rel="noopener"
              className="text-[11px] text-muted underline hover:text-foreground"
            >
              Reopen on LinkedIn →
            </a>
          ) : null}
        </div>
      ) : sent === "edit_request" ? (
        <p className="mt-3 text-[11px] text-muted-2">
          Change requested. It feeds the agent&apos;s next pass on this draft.
        </p>
      ) : null}
    </div>
  );
}

/** A parsed batch, chrome-less - the host (asset card, job page) owns the frame. */
export function LiDraftsBatch({
  clientId,
  jobId,
  assetId,
  accounts,
  media,
  published,
}: {
  clientId: string;
  jobId?: string;
  assetId: string;
  accounts: LiParsedAccount[];
  /** The run's client-facing media artifacts (slides, PDFs) for manual attach. */
  media: LiMediaFile[];
  /**
   * The host already knows (once, for the whole asset) whether this note
   * already went out for real — see `DraftCard`'s own `published` doc.
   * Eligibility for the real publish door requires exactly one account with
   * exactly one draft, so this can only ever apply to that single card — but
   * it is threaded per-draft rather than assumed, so a stale/legacy
   * multi-draft batch (which the door never targets) is never affected.
   */
  published?: boolean;
}) {
  const totalDrafts = accounts.reduce((n, a) => n + a.drafts.length, 0);
  return (
    <div className="space-y-5">
      <p className="text-sm text-muted">
        {totalDrafts === 1 ? "The next post, ready to review." : "Drafts to choose from."} Opening
        it in LinkedIn copies the text and gets the composer ready; edit freely, or skip with a
        reason. Every choice sharpens that account&apos;s voice for the next run.
      </p>
      {accounts.map((acc) => {
        const isCompany = acc.title.toLowerCase().includes("company page");
        return (
          <section key={acc.title} className="overflow-hidden rounded-xl border border-border-strong">
            <header className="flex items-center gap-3 border-b border-border bg-surface-3 px-4 py-3">
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-background">
                <LinkedInLogo className="h-4 w-4 text-foreground" />
              </span>
              <p className="min-w-0 flex-1 truncate text-[15px] font-semibold text-foreground">
                {normalizeDashes(acc.title)}
              </p>
              <Badge tone={isCompany ? "info" : "neon"}>{isCompany ? "Company page" : "Personal seat"}</Badge>
            </header>
            {acc.note ? (
              <p className="px-4 pt-3 text-xs text-muted">
                {normalizeDashes(stripInlineMarkdown(acc.note))}
              </p>
            ) : null}
            <div className="space-y-3 p-4">
              {acc.drafts.map((draft) => (
                <DraftCard
                  key={draft.lane}
                  clientId={clientId}
                  {...(jobId ? { jobId } : {})}
                  assetId={assetId}
                  accountTitle={acc.title}
                  draft={draft}
                  media={mediaFor(draft, media, totalDrafts === 1)}
                  {...(published ? { published } : {})}
                />
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}
