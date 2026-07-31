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
import { splitMetaLinks } from "@/lib/draft-meta";
import { xIntentUrl, type XParsedAccount, type XParsedDraft } from "@/lib/x-drafts";

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
}: {
  clientId: string;
  jobId?: string;
  assetId: string;
  accountTitle: string;
  draft: XParsedDraft;
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
  const isThread = draft.posts.length > 1;
  const fullText = draft.posts.map((p) => p.text).join("\n\n");

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
      const composeText =
        textUsed !== undefined ? (isThread ? textUsed.split(/\n{2,}/)[0] : textUsed) : draft.posts[0].text;
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
            ? `${result.error} Your post is already open on X - click again to retry recording the pick (X will not reopen).`
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
            <span title="A connected thread, written to post in order.">
              <Badge>{draft.posts.length}-post thread</Badge>
            </span>
          ) : charLabel(draft.posts[0]?.chars) ? (
            <span title="Character count. Standard X posts cap at 280; long-form needs X Premium.">
              <Badge>{charLabel(draft.posts[0]?.chars)}</Badge>
            </span>
          ) : null}
          {sent ? (
            <Badge tone="success">
              {sent === "posted" ? "Picked" : sent === "posted_with_edits" ? "Picked with edits" : "Skipped"}
            </Badge>
          ) : null}
        </div>
      </div>
      {draft.laneNote ? (
        <p className="mt-1 text-xs text-muted">{stripInlineMarkdown(draft.laneNote)}</p>
      ) : null}

      <div className="mt-3 space-y-2">
        {draft.posts.map((post, i) => (
          <div key={i} className="rounded-md border border-border bg-background p-4">
            {post.marker ? (
              <p className="mb-1.5 font-mono text-[10px] uppercase tracking-wider text-muted">{post.marker}</p>
            ) : null}
            <p className="whitespace-pre-wrap text-[15px] leading-relaxed text-foreground">{post.text}</p>
            {post.marker && charLabel(post.chars) ? (
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

      {draft.meta.length > 0 ? (
        <ul className="mt-2 space-y-0.5">
          {draft.meta.map((m, i) => (
            <li key={i} className="break-words text-xs text-muted">
              {/* Link runs verbatim, prose runs de-marked (F70). */}
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
                  <span key={j}>{stripInlineMarkdown(seg.text)}</span>
                ),
              )}
            </li>
          ))}
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
              </div>
              <p className="text-[11px] text-muted-2">
                Picking copies the text and opens X with the post ready
                {draft.replyToUrl ? ", already addressed to the post it answers" : ""}
                {draft.quoteUrl ? ", with the quoted post attached" : ""}
                {isThread
                  ? `. Threads: X opens with post 1 of ${draft.posts.length}; we copy the full thread for pasting the rest`
                  : ""}
                . You press Post.
              </p>
            </>
          )}
          {error ? <p className="text-xs text-red-400">{error}</p> : null}
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
}: {
  clientId: string;
  jobId?: string;
  assetId: string;
  accounts: XParsedAccount[];
}) {
  const totalDrafts = accounts.reduce((n, a) => n + a.drafts.length, 0);
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
              <p className="min-w-0 flex-1 truncate text-[15px] font-semibold text-foreground">{acc.title}</p>
              <Badge tone={isCompany ? "info" : "neon"}>{isCompany ? "Company page" : "Personal seat"}</Badge>
            </header>
            {acc.note ? <p className="px-4 pt-3 text-xs text-muted">{stripInlineMarkdown(acc.note)}</p> : null}
            <div className="space-y-3 p-4">
              {acc.drafts.map((draft) => (
                <DraftCard
                  key={draft.avenue}
                  clientId={clientId}
                  {...(jobId ? { jobId } : {})}
                  assetId={assetId}
                  accountTitle={acc.title}
                  draft={draft}
                />
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}
