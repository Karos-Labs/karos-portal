"use client";

/**
 * The LinkedIn drafts reader: a parsed draft batch rendered as readable cards
 * — grouped per account, one card per post — with pick / edit / skip actions
 * wired into the per-account feedback loop.
 *
 * Picking is also the posting hand-off: the pick copies the final text to the
 * clipboard and opens LinkedIn's compose prefilled via
 * linkedin.com/feed/?shareActive=true&text=… (verified live 2026-07-24: full
 * prefill incl. newlines/emoji/links up to LinkedIn's 3,000-char cap; the
 * auth wall carries the link through login). The deep link is undocumented,
 * so the clipboard copy is always made first — if LinkedIn ever drops the
 * prefill, the text is already on the clipboard. Files (carousel PDFs,
 * slides) cannot ride a URL: the card lists them for download + manual
 * attach. Draft-only stays true — the human presses Post on LinkedIn.
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
import type { LiParsedAccount, LiParsedDraft } from "@/lib/li-drafts";

type SentState = "posted" | "posted_with_edits" | "not_posted" | "edit_request";

/** A client-facing run artifact the reader can offer for manual attach. */
export interface LiMediaFile {
  name: string;
  url: string;
}

const LINKEDIN_POST_CAP = 3_000;

/**
 * LinkedIn compose deep link with the text prefilled. Past the 3,000-char cap
 * the prefill is unreliable — open the bare composer and let the copied text
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
 * files. Exact or path-basename matches only — the pinned instructions
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
}: {
  clientId: string;
  jobId?: string;
  assetId: string;
  accountTitle: string;
  draft: LiParsedDraft;
  media: LiMediaFile[];
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
    // the composer). The clipboard write is AWAITED before window.open —
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
            ? `${result.error} Your post is already open on LinkedIn — click again to save your choice here (we will not open LinkedIn a second time).`
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
          {sent ? (
            <Badge tone="success">
              {sent === "posted"
                ? "Picked"
                : sent === "posted_with_edits"
                  ? "Picked with edits"
                  : sent === "edit_request"
                    ? "Change requested"
                    : "Skipped"}
            </Badge>
          ) : null}
        </div>
      </div>
      {draft.laneNote ? (
        <p className="mt-1 text-xs text-muted">{stripInlineMarkdown(draft.laneNote)}</p>
      ) : null}

      <div className="mt-3 rounded-md border border-border bg-background p-4">
        <p className="whitespace-pre-wrap text-[15px] leading-relaxed text-foreground">{draft.text}</p>
      </div>

      {media.length > 0 ? (
        <div className="mt-2 rounded-md border border-border bg-background px-3 py-2">
          <p className="text-[11px] font-medium text-muted">
            Attach when posting (LinkedIn cannot prefill files):
          </p>
          <ul className="mt-1 flex flex-wrap gap-x-4 gap-y-1">
            {media.map((m) => (
              <li key={m.name}>
                <a
                  href={m.url}
                  target="_blank"
                  rel="noopener"
                  download
                  className="text-xs text-muted underline hover:text-foreground"
                >
                  <Icon name="Download" className="mr-1 inline h-3 w-3" />
                  {m.name.split("/").pop()}
                </a>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {draft.meta.length > 0 ? (
        <ul className="mt-2 space-y-0.5">
          {draft.meta.map((m, i) => (
            <li key={i} className="text-xs text-muted">
              {stripInlineMarkdown(m)}
            </li>
          ))}
        </ul>
      ) : null}

      {sent === null ? (
        <div className="mt-3 space-y-3">
          {mode === "editing" ? (
            <>
              <Textarea
                rows={6}
                value={finalText}
                onChange={(e) => setFinalText(e.target.value)}
                placeholder="Your final version."
              />
              {finalText.trim().length > LINKEDIN_POST_CAP ? (
                <p className="text-xs text-red-400">
                  {finalText.trim().length.toLocaleString()} characters — LinkedIn posts cap at
                  3,000. Trim it before posting.
                </p>
              ) : null}
              <div className="flex gap-2">
                <Button
                  size="sm"
                  onClick={() => send("posted_with_edits", finalText)}
                  disabled={pending || !finalText.trim() || finalText.trim().length > LINKEDIN_POST_CAP}
                >
                  {pending ? "Opening…" : "Save & post on LinkedIn"}
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
                placeholder="What should change? Tone, angle, a fact to fix — in your own words."
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
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="accent" onClick={() => send("posted")} disabled={pending}>
                  <Icon name="Check" className="mr-1 h-3.5 w-3.5" />
                  {pending ? "Opening…" : "Pick & post on LinkedIn"}
                </Button>
                <Button
                  size="sm"
                  variant="subtle"
                  onClick={() => {
                    setFinalText(draft.text);
                    setMode("editing");
                  }}
                >
                  Pick with edits
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setMode("requesting")}>
                  Request a change
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setMode("skipping")}>
                  Skip
                </Button>
              </div>
              <p className="text-[11px] text-muted-2">
                Picking copies the text and opens LinkedIn with the post ready
                {media.length > 0 ? "; download the files above and attach them in the composer" : ""}
                . You press Post.
                {draft.postWindow ? ` Best window: ${draft.postWindow}.` : ""}
              </p>
            </>
          )}
          {error ? <p className="text-xs text-red-400">{error}</p> : null}
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
          Change requested — it feeds the agent&apos;s next pass on this draft.
        </p>
      ) : null}
    </div>
  );
}

/** A parsed batch, chrome-less — the host (asset card, job page) owns the frame. */
export function LiDraftsBatch({
  clientId,
  jobId,
  assetId,
  accounts,
  media,
}: {
  clientId: string;
  jobId?: string;
  assetId: string;
  accounts: LiParsedAccount[];
  /** The run's client-facing media artifacts (slides, PDFs) for manual attach. */
  media: LiMediaFile[];
}) {
  const totalDrafts = accounts.reduce((n, a) => n + a.drafts.length, 0);
  return (
    <div className="space-y-5">
      <p className="text-sm text-muted">
        {totalDrafts === 1 ? "The next post, ready to review." : "Drafts to choose from."} Picking
        opens LinkedIn with the post ready; edit freely, or skip with a reason. Every choice
        sharpens that account&apos;s voice for the next run.
      </p>
      {accounts.map((acc) => {
        const isCompany = acc.title.toLowerCase().includes("company page");
        return (
          <section key={acc.title} className="overflow-hidden rounded-xl border border-border-strong">
            <header className="flex items-center gap-3 border-b border-border bg-surface-3 px-4 py-3">
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-background">
                <LinkedInLogo className="h-4 w-4 text-foreground" />
              </span>
              <p className="min-w-0 flex-1 truncate text-[15px] font-semibold text-foreground">{acc.title}</p>
              <Badge tone={isCompany ? "info" : "neon"}>{isCompany ? "Company page" : "Personal seat"}</Badge>
            </header>
            {acc.note ? <p className="px-4 pt-3 text-xs text-muted">{stripInlineMarkdown(acc.note)}</p> : null}
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
                />
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}
