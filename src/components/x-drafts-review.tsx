"use client";

/**
 * The X drafts reader: a parsed draft batch rendered as readable cards —
 * grouped per account, one card per avenue, the post text large and scannable
 * — with pick / edit / skip actions wired into the per-account feedback loop.
 *
 * Picking is also the posting hand-off: the pick copies the final text to the
 * clipboard and opens X's compose window pre-filled (replies pre-addressed to
 * the target post, quote-comments carrying the quoted URL). Draft-only stays
 * true — the human presses Post on X.
 *
 * Chrome-less by design: it embeds wherever outputs live (the asset card in
 * the archive and on the job page).
 */

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Badge, Button, Textarea } from "@/components/ui";
import { Icon, XLogo } from "@/components/icon";
import { addXDraftFeedbackAction } from "@/lib/actions/x-agent-actions";
import type { XParsedAccount, XParsedDraft } from "@/lib/x-drafts";

type SentState = "posted" | "posted_with_edits" | "not_posted";

/** X compose deep link: text pre-filled, replies addressed, quotes attached. */
function xIntentUrl(draft: XParsedDraft, text: string): string {
  const params = new URLSearchParams();
  params.set("text", draft.quoteUrl ? `${text}\n\n${draft.quoteUrl}` : text);
  const replyId = draft.replyToUrl?.match(/status\/(\d+)/)?.[1];
  if (replyId) params.set("in_reply_to", replyId);
  return `https://x.com/intent/post?${params.toString()}`;
}

/**
 * "256 chars" → "256 / 280" (X's standard limit). Past 280 the draft is a
 * long-form post (X Premium accounts only), labeled as such instead.
 */
function charLabel(chars?: string): string | null {
  const n = chars?.match(/\d+/)?.[0];
  if (!n) return chars ?? null;
  return Number(n) > 280 ? `${Number(n).toLocaleString()} chars · long-form` : `${n} / 280`;
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

  function send(action: SentState, textUsed?: string) {
    setError(null);
    // Picking IS the posting hand-off. Open compose synchronously (inside the
    // click gesture, so popup blockers allow it) and copy the full text —
    // for threads, compose gets post 1 and the clipboard carries every post.
    // A retry after a failed feedback write must NOT open a second compose.
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
      window.open(url, "_blank", "noopener");
      if (navigator.clipboard) {
        navigator.clipboard.writeText(text).then(() => setCopied(true)).catch(() => {});
      }
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
        <p className="text-sm font-medium">{draft.avenue}</p>
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
      {draft.laneNote ? <p className="mt-1 text-xs text-muted">{draft.laneNote}</p> : null}

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
            <li key={i} className="text-xs text-muted">
              {m}
            </li>
          ))}
        </ul>
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

/** A parsed batch, chrome-less — the host (asset card, job page) owns the frame. */
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
  return (
    <div className="space-y-5">
      <p className="text-sm text-muted">
        About a week of posting to choose from. Pick your favorites (each pick opens X with the
        post ready), edit freely, and skip with a reason. Every choice sharpens that
        account&apos;s voice for the next batch.
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
            {acc.note ? <p className="px-4 pt-3 text-xs text-muted">{acc.note}</p> : null}
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
