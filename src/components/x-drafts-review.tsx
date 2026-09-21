"use client";

/**
 * The X drafts reader: a parsed draft batch rendered as readable cards -
 * grouped per account, one card per avenue, the post text large and scannable
 * - with pick / edit / skip actions wired into the per-account feedback loop.
 *
 * Picking is also the posting hand-off: the pick copies the final text to the
 * clipboard and opens X's compose window pre-filled (replies pre-addressed to
 * the target post, quote-comments carrying the quoted URL). Draft-only stays
 * true - the human presses Post on X.
 *
 * Chrome-less by design: it embeds wherever outputs live (the asset card in
 * the archive and on the job page).
 */

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Badge, Button, Textarea } from "@/components/ui";
import { Icon, XLogo } from "@/components/icon";
import { addXDraftFeedbackAction } from "@/lib/actions/x-agent-actions";
import { laneLabel } from "@/lib/draft-lane-label";
import { stripInlineMarkdown } from "@/lib/doc-render";
import { normalizeDashes } from "@/lib/text-utils";
import { assetFileStem } from "@/lib/asset-images";
import { splitMetaLinks } from "@/lib/draft-meta";
import { AwaitingReviewBadge, DownloadDraftButton } from "@/components/draft-review-kit";
import {
  classifyXMetaBullet,
  xIntentUrl,
  xThreadReplies,
  type XParsedAccount,
  type XParsedDraft,
  type XParsedPost,
} from "@/lib/x-drafts";

type SentState = "posted" | "posted_with_edits" | "not_posted";

/**
 * "256 chars" → "256 / 280" (X's standard limit). Past 280 the draft is a
 * long-form post (X Premium accounts only), labeled as such instead.
 */
function charLabel(chars?: string): string | null {
  const n = chars?.match(/\d+/)?.[0];
  if (!n) return chars ?? null;
  return Number(n) > 280 ? `${Number(n).toLocaleString()} chars · long-form` : `${n} / 280`;
}

/** A look at the post a reply or quote-comment aims at - records nothing. */
function TargetLink({ href, label }: { href: string; label: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener"
      title="Opens the post on X in a new tab. Reading it records no choice here."
      className="text-[11px] text-muted underline hover:text-foreground"
    >
      <Icon name="ExternalLink" className="mr-1 inline h-3 w-3" />
      {label}
    </a>
  );
}

function DraftCard({
  clientId,
  jobId,
  assetId,
  accountTitle,
  draft,
  thread,
}: {
  clientId: string;
  jobId?: string;
  assetId: string;
  accountTitle: string;
  draft: XParsedDraft;
  /** The engine's own chain (asset meta.thread), for a draft written as one post. */
  thread?: readonly string[];
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [mode, setMode] = useState<"idle" | "editing" | "skipping">("idle");
  const [sent, setSent] = useState<SentState | null>(null);
  const [postUrl, setPostUrl] = useState<string | null>(null);
  const [handedOff, setHandedOff] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [finalText, setFinalText] = useState("");
  const [reason, setReason] = useState("");

  const draftRef = `${accountTitle} · ${draft.avenue}`;
  // A THREAD IS ONE POST WITH ITS REPLIES (product ruling, 2026-09-15) - so the
  // opener is the post and the rest hang under it as a chain, rather than N
  // equal cards a reader has to renumber in their head.
  //
  // The chain comes from the markdown when the deliverable wrote it out, and
  // otherwise from the engine's own `meta.thread` (passed down only for a
  // single-draft batch, which is every run since one run = one post). Never
  // both: a deliverable that spelled the thread out is the one that shipped.
  const mainPost = draft.posts[0];
  const replies: XParsedPost[] =
    draft.posts.length > 1
      ? draft.posts.slice(1)
      : thread && mainPost
        ? xThreadReplies(thread, mainPost.text).map((text) => ({ text }))
        : [];
  const isThread = replies.length > 0;
  const chain = mainPost ? [mainPost, ...replies] : [];
  const fullText = chain.map((p) => p.text).join("\n\n");

  async function send(action: SentState, textUsed?: string) {
    setError(null);
    // Picking IS the posting hand-off. The clipboard write is AWAITED before
    // window.open - Chrome rejects clipboard writes once the new tab steals
    // focus, and for threads the clipboard is what carries posts 2..N. The
    // await stays inside the click gesture's transient activation, so popup
    // blockers still allow the open. A retry after a failed feedback write
    // must NOT open a second compose.
    if (action !== "not_posted" && !handedOff) {
      const text = textUsed ?? fullText;
      // Post 1 only, deliberately: X's compose takes one post, and the replies
      // ride the clipboard. `mainPost` is the same post the card leads with.
      const composeText =
        textUsed !== undefined ? (isThread ? textUsed.split(/\n{2,}/)[0] : textUsed) : (mainPost?.text ?? "");
      // Long-form posts make intent URLs unreliable; open a blank compose and
      // let the copied text carry the post.
      const url =
        composeText.length > 2000 ? "https://x.com/compose/post" : xIntentUrl(draft, composeText);
      setPostUrl(url);
      setHandedOff(true);
      if (navigator.clipboard) {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
        } catch {
          // Compose still carries the post text; the copy label stays honest.
        }
      }
      window.open(url, "_blank", "noopener");
    }
    start(async () => {
      const result = await addXDraftFeedbackAction({
        clientId,
        accountTitle,
        ...(jobId ? { jobId } : {}),
        assetId,
        draftRef,
        action,
        ...(action === "posted_with_edits" ? { finalText: textUsed ?? finalText } : {}),
        ...(action === "not_posted" ? { reason } : {}),
      });
      if (result.error) {
        setError(
          handedOff && action !== "not_posted"
            ? `${result.error} Your post is already open on X. Click again to retry recording the pick (X will not reopen).`
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
        <p className="text-sm font-medium">{laneLabel(draft.avenue)}</p>
        <div className="flex items-center gap-2">
          {isThread ? (
            <span title="One post with its replies, written to go up in order.">
              <Badge>
                {replies.length === 1 ? "Post + 1 reply" : `Post + ${replies.length} replies`}
              </Badge>
            </span>
          ) : charLabel(mainPost?.chars) ? (
            <span title="Character count. Standard X posts cap at 280; long-form needs X Premium.">
              <Badge>{charLabel(mainPost?.chars)}</Badge>
            </span>
          ) : null}
          {sent ? (
            <Badge tone="success">
              {sent === "posted" ? "Picked" : sent === "posted_with_edits" ? "Picked with edits" : "Skipped"}
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

      {/* The post, then its replies indented on one chain - the shape X itself
          shows, instead of the lab's "1/3" numbering on equal cards. */}
      <div className="mt-3">
        {mainPost ? (
          <div className="rounded-md border border-border bg-background p-4">
            <p className="whitespace-pre-wrap text-[15px] leading-relaxed text-foreground">{mainPost.text}</p>
            {isThread && charLabel(mainPost.chars) ? (
              <p
                className="mt-2 text-right font-mono text-[10px] text-muted-2"
                title="Character count. X's limit per post is 280."
              >
                {charLabel(mainPost.chars)}
              </p>
            ) : null}
          </div>
        ) : null}
        {isThread ? (
          <div className="ml-4 space-y-2 border-l border-border pl-4 pt-2">
            {replies.map((post, i) => (
              <div key={i} className="rounded-md border border-border bg-background p-4">
                <p className="mb-1.5 flex items-center gap-1 font-label text-[10px] uppercase tracking-wider text-muted">
                  <Icon name="CornerDownRight" className="h-3 w-3" />
                  Reply {i + 1}
                </p>
                <p className="whitespace-pre-wrap text-[15px] leading-relaxed text-foreground">{post.text}</p>
                {charLabel(post.chars) ? (
                  <p
                    className="mt-2 text-right font-mono text-[10px] text-muted-2"
                    title="Character count. X's limit per post is 280."
                  >
                    {charLabel(post.chars)}
                  </p>
                ) : null}
              </div>
            ))}
          </div>
        ) : null}
      </div>

      {draft.meta.length > 0 ? (
        <ul className="mt-2 space-y-0.5">
          {draft.meta.map((m, i) => {
            // A bullet only keeps its own label when that label tells the truth
            // about its URL. "First reply: <a page that is not an X post>" gets
            // the label taken off and reads as the source it is - linked, so a
            // client can still open it, never as the post this draft answers.
            const bullet = classifyXMetaBullet(m);
            return (
              <li key={i} className="break-words text-xs text-muted">
                {bullet.label ? <span>{bullet.label}: </span> : null}
                {/* Link runs verbatim, prose runs de-marked (F70). */}
                {splitMetaLinks(bullet.text).map((seg, j) =>
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
            );
          })}
        </ul>
      ) : null}

      {sent === null && (draft.replyToUrl || draft.quoteUrl) ? (
        <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1">
          <span className="text-[11px] text-muted-2">Before you pick:</span>
          {draft.replyToUrl ? (
            <TargetLink href={draft.replyToUrl} label="Read the post this answers" />
          ) : null}
          {draft.quoteUrl ? (
            <TargetLink href={draft.quoteUrl} label="Read the post being quoted" />
          ) : null}
        </div>
      ) : null}

      {sent === null ? (
        <div className="mt-3 space-y-3">
          {mode === "editing" ? (
            <>
              <Textarea
                rows={4}
                value={finalText}
                onChange={(e) => setFinalText(e.target.value)}
                placeholder="Your final version."
              />
              <div className="flex gap-2">
                <Button
                  size="sm"
                  onClick={() => send("posted_with_edits", finalText)}
                  disabled={pending || !finalText.trim()}
                >
                  {pending ? "Opening…" : "Save & post on X"}
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
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="accent" onClick={() => send("posted")} disabled={pending}>
                  <Icon name="Check" className="mr-1 h-3.5 w-3.5" />
                  {pending ? "Opening…" : "Pick & post on X"}
                </Button>
                <Button
                  size="sm"
                  variant="subtle"
                  onClick={() => {
                    setFinalText(fullText);
                    setMode("editing");
                  }}
                >
                  Pick with edits
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setMode("skipping")}>
                  Skip
                </Button>
                {/* ALWAYS present, same as every other reader — the full
                    chain (post + any replies) as one text file, for a client
                    who wants to post it themselves. */}
                <DownloadDraftButton
                  text={fullText}
                  filename={`${assetFileStem(accountTitle)}-x.txt`}
                />
              </div>
              <p className="text-[11px] text-muted-2">
                Picking copies the text and opens X with the post ready
                {draft.replyToUrl ? ", already addressed to the post it answers" : ""}
                {draft.quoteUrl ? ", with the quoted post attached" : ""}
                {isThread
                  ? `. X opens with the post itself; the ${
                      replies.length === 1 ? "reply is" : `${replies.length} replies are`
                    } on your clipboard to paste after it`
                  : ""}
                . You press Post.
              </p>
            </>
          )}
          {error ? <p className="text-xs text-danger">{error}</p> : null}
        </div>
      ) : sent !== "not_posted" ? (
        <div className="mt-3 flex items-center gap-3">
          <p className="text-[11px] text-muted-2">{copied ? "Text copied. Finish on X." : "Finish on X."}</p>
          {postUrl ? (
            <a
              href={postUrl}
              target="_blank"
              rel="noopener"
              className="text-[11px] text-muted underline hover:text-foreground"
            >
              Reopen on X →
            </a>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** A parsed batch, chrome-less - the host (asset card, job page) owns the frame. */
export function XDraftsBatch({
  clientId,
  jobId,
  assetId,
  accounts,
  thread,
}: {
  clientId: string;
  jobId?: string;
  assetId: string;
  accounts: XParsedAccount[];
  /**
   * The run's own thread parts (`asset.meta.thread`, as the engine sent them),
   * for a deliverable whose markdown holds the opener alone.
   */
  thread?: readonly string[];
}) {
  const totalDrafts = accounts.reduce((n, a) => n + a.drafts.length, 0);
  // The chain belongs to ONE post, and the asset names no draft - so it is only
  // safe to hang it under a draft when there is exactly one, which is every run
  // since "one run produces one post" (docs/x-agent-portal.md). An older
  // multi-draft batch in the archive keeps the markdown's own threads.
  const chain = totalDrafts === 1 && thread && thread.length > 0 ? thread : undefined;
  return (
    <div className="space-y-5">
      {/* A3/A4: this used to open "About a week of posting to choose from" and
          close on "the next batch" - two statements of the batch shape on the
          one client-reachable surface where the drafts are visibly a set. The
          LinkedIn twin was scrubbed already; this is the same treatment, so the
          two reviews say the same thing about how the work arrives (nothing). */}
      <p className="text-sm text-muted">
        {totalDrafts === 1 ? "The next post, ready to review." : "Drafts to choose from."} Picking
        opens X with the post ready; edit freely, or skip with a reason. Every choice sharpens
        that account&apos;s voice for the next run.
      </p>
      {accounts.map((acc) => {
        const isCompany = acc.title.toLowerCase().includes("company page");
        return (
          <section key={acc.title} className="overflow-hidden rounded-xl border border-border-strong">
            <header className="flex items-center gap-3 border-b border-border bg-surface-3 px-4 py-3">
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-background">
                <XLogo className="h-4 w-4 text-foreground" />
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
                  key={draft.avenue}
                  clientId={clientId}
                  {...(jobId ? { jobId } : {})}
                  assetId={assetId}
                  accountTitle={acc.title}
                  draft={draft}
                  {...(chain ? { thread: chain } : {})}
                />
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}
