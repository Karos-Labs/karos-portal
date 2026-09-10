"use client";

/**
 * The Reddit drafts reader: a parsed draft batch rendered as readable cards -
 * grouped per managed account, one card per drafted reply - with the four
 * outcome actions from the lab's portal contract wired into the per-account
 * feedback loop (posted / posted with edits / didn't post + reason / request a
 * change).
 *
 * Reddit's hand-off differs from X's and LinkedIn's: a drafted reply answers an
 * EXISTING thread, so there is no compose deep link to prefill - the reply is
 * typed in the thread itself. Posting copies the reply text and opens the
 * thread; the human pastes and presses reply. As with LinkedIn, the clipboard
 * write is AWAITED before window.open (Chrome rejects a clipboard write once
 * the new tab takes focus) and the await stays inside the click gesture's
 * transient activation so the open still counts as user-initiated.
 *
 * The non-negotiable: there is no post-to-Reddit code path anywhere in this
 * portal, and there never will be one. "Posted" records a human action.
 * Reddit's ban risk for automated marketing replies is why.
 *
 * Chrome-less by design: it embeds wherever outputs live (the asset card in
 * the library and on the job page).
 */

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Badge, Button, Select, Textarea } from "@/components/ui";
import { Icon } from "@/components/icon";
import { SocialPlatformMark } from "@/components/agent-identity";
import { addRedditDraftFeedbackAction } from "@/lib/actions/reddit-agent-actions";
import {
  REDDIT_COMMENT_CAP,
  type RedditParsedAccount,
  type RedditParsedBatch,
  type RedditParsedDraft,
} from "@/lib/reddit-drafts";
import { laneLabel } from "@/lib/draft-lane-label";
import { stripInlineMarkdown } from "@/lib/doc-render";
import { normalizeDashes } from "@/lib/text-utils";
import { splitMetaLinks } from "@/lib/draft-meta";

type SentState = "posted" | "posted_with_edits" | "not_posted" | "edit_request";

/**
 * Why a draft was not posted. These codes are the lab contract's - the weekly
 * manager acts on them, and two "too promotional" rows on one subreddit
 * downgrade that subreddit to value-only.
 */
const NOT_POSTED_REASONS: Array<{ value: string; label: string }> = [
  { value: "too_promotional", label: "Too promotional" },
  { value: "wrong_subreddit", label: "Wrong subreddit" },
  { value: "thread_died", label: "The thread went quiet" },
  { value: "rules", label: "Against the subreddit's rules" },
  { value: "other", label: "Something else" },
];
// "removed" is deliberately NOT in the list above. A removal happens to a reply
// the client DID post, so recording it as "not posted" would both lie to them on
// the card and corrupt the posted-vs-not signal the voice profile learns from.
// It is reported from the posted confirmation instead.
const REMOVED_REASON = "removed";

/** "742 chars" → "742 / 10,000" (Reddit's comment cap). */
function charLabel(chars?: string): string | null {
  const n = chars?.match(/\d+/)?.[0];
  if (!n) return chars ?? null;
  return `${Number(n).toLocaleString()} / ${REDDIT_COMMENT_CAP.toLocaleString()}`;
}

/**
 * The promo verdict badge. Amber for value-only because it is the constraint
 * the poster must respect (a plug there risks the account); slate for
 * mention-ok because a disclosed mention is merely permitted. No badge at all
 * when the draft names no verdict - guessing the permissive one is the
 * dangerous direction.
 */
function VerdictBadge({ draft }: { draft: RedditParsedDraft }) {
  if (!draft.verdict) return null;
  const valueOnly = draft.verdict === "value-only";
  return (
    <span title={draft.verdictNote ? stripInlineMarkdown(draft.verdictNote) : undefined}>
      <Badge tone={valueOnly ? "warning" : "info"}>
        {valueOnly ? "Value only, no mention" : "Mention ok, disclosed"}
      </Badge>
    </span>
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
  draft: RedditParsedDraft;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [mode, setMode] = useState<"idle" | "editing" | "skipping" | "requesting">("idle");
  const [sent, setSent] = useState<SentState | null>(null);
  const [handedOff, setHandedOff] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [finalText, setFinalText] = useState("");
  const [reason, setReason] = useState("");
  const [reasonCode, setReasonCode] = useState(NOT_POSTED_REASONS[0].value);
  const [removedReported, setRemovedReported] = useState(false);
  /**
   * Which of v2's two replies is showing. Defaults to the one the run would pick
   * when `about.txt` says, otherwise the first — never a random one, because the
   * default is what most clients will take and it should be our best guess.
   */
  const approaches = draft.approaches ?? [];
  const [approachId, setApproachId] = useState<"approach-1" | "approach-2">(
    approaches[0]?.id ?? "approach-1",
  );
  const activeApproach = approaches.find((a) => a.id === approachId) ?? approaches[0];
  /** The reply currently on screen: v2's selected approach, or v1's single text. */
  const activeText = activeApproach?.text ?? draft.text;

  const draftRef = `${accountTitle} · ${draft.formula}`;

  async function send(action: SentState, textUsed?: string) {
    setError(null);
    // Posting IS the hand-off (skips and change requests never open the
    // thread). Clipboard first and AWAITED, then the open - the copy is what
    // carries the reply, since a thread URL cannot prefill a comment box. A
    // retry after a failed feedback write must NOT open a second tab.
    if (action !== "not_posted" && action !== "edit_request" && !handedOff) {
      const text = textUsed ?? activeText;
      setHandedOff(true);
      if (navigator.clipboard) {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
        } catch {
          // The card still shows the text to copy by hand; the label stays honest.
        }
      }
      if (draft.threadUrl) window.open(draft.threadUrl, "_blank", "noopener");
    }
    start(async () => {
      const result = await addRedditDraftFeedbackAction({
        clientId,
        accountTitle,
        ...(jobId ? { jobId } : {}),
        assetId,
        draftRef,
        action,
        ...(draft.subreddit ? { subreddit: draft.subreddit } : {}),
        ...(draft.threadUrl ? { threadUrl: draft.threadUrl } : {}),
        ...(action === "posted_with_edits" ? { finalText: textUsed ?? finalText } : {}),
        // WHICH of the two replies they took. Recorded on the two actions where
        // they actually took one; a skip rejected the thread, not an approach, and
        // a change request has not been posted at all. This is the signal v2
        // drafts two replies FOR — the choice they had to make anyway teaches
        // their voice faster than anything we could ask them.
        ...(approaches.length > 1 && (action === "posted" || action === "posted_with_edits")
          ? { selectedApproach: approachId }
          : {}),
        ...(action === "not_posted" ? { reasonCode } : {}),
        ...(action === "not_posted" || action === "edit_request" ? { reason } : {}),
      });
      if (result.error) {
        setError(
          handedOff && action !== "not_posted" && action !== "edit_request"
            ? `${result.error} The thread is already open. Click again to save your choice here (we will not open it a second time).`
            : result.error,
        );
        return;
      }
      setSent(action);
      setMode("idle");
      router.refresh();
    });
  }

  /**
   * Reported after the fact, against a reply that WAS posted: an answer taken
   * down by automod or a moderator is the strongest negative signal Reddit
   * gives, and the run context never repeats that pattern in that subreddit.
   * Written as its own row so the original "posted" outcome stays true.
   */
  function reportRemoved() {
    setError(null);
    start(async () => {
      const result = await addRedditDraftFeedbackAction({
        clientId,
        accountTitle,
        ...(jobId ? { jobId } : {}),
        assetId,
        draftRef,
        action: "posted",
        reasonCode: REMOVED_REASON,
        reason: "The client reported this reply was removed or heavily downvoted.",
        ...(draft.subreddit ? { subreddit: draft.subreddit } : {}),
        ...(draft.threadUrl ? { threadUrl: draft.threadUrl } : {}),
      });
      if (result.error) {
        setError(result.error);
        return;
      }
      setRemovedReported(true);
      router.refresh();
    });
  }

  const overCap = finalText.trim().length > REDDIT_COMMENT_CAP;

  return (
    <div className="rounded-lg border border-border bg-surface-2 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          {draft.subreddit ? <Badge tone="neutral">{draft.subreddit}</Badge> : null}
          <VerdictBadge draft={draft} />
        </div>
        <div className="flex items-center gap-2">
          {charLabel(draft.chars) ? (
            <span title="Character count. Reddit comments cap at 10,000 characters.">
              <Badge>{charLabel(draft.chars)}</Badge>
            </span>
          ) : null}
          {sent ? (
            <Badge tone={sent === "not_posted" ? "neutral" : "success"}>
              {sent === "posted"
                ? "Posted"
                : sent === "posted_with_edits"
                  ? "Posted with edits"
                  : sent === "edit_request"
                    ? "Change requested"
                    : "Not posted"}
            </Badge>
          ) : null}
        </div>
      </div>

      <div className="mt-2 flex items-start justify-between gap-3">
        <div className="min-w-0">
          {/* The lab's own lane vocabulary ("Draft 1 · Thorough value
              answer") is production shorthand, not something a client has
              any way to read (F70) - humanized here, at the render
              boundary only, because the RAW formula is the draftRef the
              feedback actions log against. */}
          <p className="text-sm font-medium text-foreground">
            {draft.threadTitle ? stripInlineMarkdown(draft.threadTitle) : laneLabel(draft.formula)}
          </p>
          {draft.posted ? <p className="mt-0.5 text-[11px] text-muted-2">Thread posted {draft.posted}</p> : null}
        </div>
        {draft.threadUrl ? (
          <a
            href={draft.threadUrl}
            target="_blank"
            rel="noopener"
            className="shrink-0 text-xs text-muted underline hover:text-foreground"
          >
            Open thread <Icon name="ArrowUpRight" className="inline h-3 w-3" />
          </a>
        ) : null}
      </div>

      {/* Commentary ABOUT the draft is de-marked; the reply body and the
          disclosure below are not, because those are what the client posts
          and Reddit renders markdown natively. */}
      {draft.whyThread ? (
        <p className="mt-2 text-xs text-muted">Why this thread: {normalizeDashes(stripInlineMarkdown(draft.whyThread))}</p>
      ) : null}
      {draft.laneNote ? (
        <p className="mt-1 text-xs text-muted">{normalizeDashes(stripInlineMarkdown(draft.laneNote))}</p>
      ) : null}

      {/* v2 writes TWO replies per thread. The toggle is the product feature, not
          a convenience: finding the thread costs ten to fifteen paced Reddit
          requests and the second draft costs one model call, so the choice is
          nearly free — and which one they keep taking is the fastest voice signal
          we can collect, because they had to choose something anyway. Absent on a
          v1 draft, which has one reply. */}
      {approaches.length > 1 ? (
        <div className="mt-3 flex items-center gap-1" role="group" aria-label="Reply approach">
          {approaches.map((a, i) => (
            <button
              key={a.id}
              type="button"
              onClick={() => setApproachId(a.id)}
              aria-pressed={a.id === approachId}
              className={`rounded-full border px-3 py-1 text-xs transition-colors ${
                a.id === approachId
                  ? "border-neon/50 bg-neon/10 text-foreground"
                  : "border-border text-muted hover:text-foreground"
              }`}
            >
              Approach {i + 1}
              {draft.recommendedApproach === a.id ? " · we would pick this" : ""}
            </button>
          ))}
        </div>
      ) : null}

      {/* REWRITE REQUIRED, stated as a demand. Some subreddits ban AI-written
          comments outright and two of the reference client's six ban permanently,
          so "edit if you like" would be the wrong strength: the consequence of
          ignoring this is the account, not the comment. */}
      {draft.rewriteRequired ? (
        <div className="mt-3 rounded-md border border-danger/40 bg-danger/10 px-3 py-2">
          <p className="text-xs font-medium text-danger">
            Rewrite this in your own words before posting.
          </p>
          <p className="mt-0.5 text-[11px] text-foreground">
            This subreddit bans AI-written comments. Posting it as written risks the account.
          </p>
        </div>
      ) : null}
      {draft.karmaWarning ? (
        <div className="mt-2 rounded-md border border-warning/30 bg-warning/10 px-3 py-2">
          <p className="text-[11px] text-warning">
            Account standing: {normalizeDashes(stripInlineMarkdown(draft.karmaWarning))}
          </p>
        </div>
      ) : null}

      <div className="mt-3 rounded-md border border-border bg-background p-4">
        {/* THE REPLY BODY IS NOT NORMALIZED, and that is deliberate.
            normalizeDashes is applied to our own prose about a draft (below), never
            to the draft itself, for two reasons that both bite.

            First, this text is what the client PASTES: the clipboard hand-off
            copies `activeText` raw, so normalizing only the render would show them
            "-" and paste "—" — a display that lies about what they are posting,
            which is worse than either choice on its own.

            Second, v2's robot checker REJECTS a draft for an em dash and, in the
            lab's words, "never edits the draft". Cleaning one up here would hide a
            gate failure instead of surfacing it, and the drafting instructions
            would never learn they need fixing. Reddit renders markdown natively,
            so the comment that goes up must be byte-for-byte what we showed.
            Pinned by reddit-drafts.test.ts. */}
        <p className="whitespace-pre-wrap text-[15px] leading-relaxed text-foreground">
          {activeText}
        </p>
      </div>

      {draft.disclosure ? (
        <div className="mt-2 rounded-md border border-warning/30 bg-warning/10 px-3 py-2">
          <p className="text-[11px] font-medium text-warning">Include this disclosure when you post:</p>
          <p className="mt-0.5 text-xs text-foreground">{draft.disclosure}</p>
        </div>
      ) : null}

      {draft.whySafe ? (
        <p className="mt-2 text-xs text-muted">
          <Icon name="Check" className="mr-1 inline h-3 w-3 text-success" />
          Safe here: {normalizeDashes(stripInlineMarkdown(draft.whySafe))}
        </p>
      ) : null}

      {draft.meta.length > 0 ? (
        <ul className="mt-2 space-y-0.5">
          {draft.meta.map((m, i) => (
            <li key={i} className="break-words text-xs text-muted">
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

      {sent === null ? (
        <div className="mt-3 space-y-3">
          {mode === "editing" ? (
            <>
              <Textarea
                rows={8}
                value={finalText}
                onChange={(e) => setFinalText(e.target.value)}
                placeholder="Your final version. The wording you will actually post."
              />
              {overCap ? (
                <p className="text-xs text-danger">
                  {finalText.trim().length.toLocaleString()} characters. Reddit comments cap at{" "}
                  {REDDIT_COMMENT_CAP.toLocaleString()}. Trim it before posting.
                </p>
              ) : null}
              <div className="flex gap-2">
                <Button
                  size="sm"
                  onClick={() => send("posted_with_edits", finalText)}
                  disabled={pending || !finalText.trim() || overCap}
                >
                  {pending ? "Opening…" : "Save & open the thread"}
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
                <Button size="sm" onClick={() => send("edit_request")} disabled={pending || !reason.trim()}>
                  {pending ? "Sending…" : "Request the change"}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setMode("idle")}>
                  Cancel
                </Button>
              </div>
            </>
          ) : mode === "skipping" ? (
            <>
              <Select value={reasonCode} onChange={(e) => setReasonCode(e.target.value)}>
                {NOT_POSTED_REASONS.map((r) => (
                  <option key={r.value} value={r.value}>
                    {r.label}
                  </option>
                ))}
              </Select>
              <Textarea
                rows={2}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Anything to add? That is what teaches the agent."
              />
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant="danger"
                  onClick={() => send("not_posted")}
                  disabled={pending || !reason.trim()}
                >
                  {pending ? "Sending…" : "Save"}
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
                  {pending ? "Opening…" : "Post this on Reddit"}
                </Button>
                <Button
                  size="sm"
                  variant="subtle"
                  onClick={() => {
                    setFinalText(activeText);
                    setMode("editing");
                  }}
                >
                  Post with edits
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setMode("requesting")}>
                  Request a change
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setMode("skipping")}>
                  Didn&apos;t post
                </Button>
              </div>
              <p className="text-[11px] text-muted-2">
                {draft.threadUrl
                  ? "This copies the reply and opens the thread. You paste it and press reply. Nothing is ever posted for you."
                  : "This copies the reply. The draft names no thread link, so open the thread yourself. Nothing is ever posted for you."}{" "}
                Edit it into your own words first; Reddit rewards that.
              </p>
            </>
          )}
          {error ? <p className="text-xs text-danger">{error}</p> : null}
        </div>
      ) : sent === "posted" || sent === "posted_with_edits" ? (
        <div className="mt-3 space-y-2">
          <div className="flex flex-wrap items-center gap-3">
            <p className="text-[11px] text-muted-2">
              {copied ? "Reply copied. Paste it in the thread." : "Copy the reply above and paste it in the thread."}
            </p>
            {draft.threadUrl ? (
              <a
                href={draft.threadUrl}
                target="_blank"
                rel="noopener"
                className="text-[11px] text-muted underline hover:text-foreground"
              >
                Reopen the thread →
              </a>
            ) : null}
          </div>
          {removedReported ? (
            <p className="text-[11px] text-muted-2">
              Logged. We will not use that approach in {draft.subreddit ?? "that subreddit"} again.
            </p>
          ) : (
            <Button size="sm" variant="ghost" onClick={reportRemoved} disabled={pending}>
              {pending ? "Sending…" : "It was removed or downvoted"}
            </Button>
          )}
          {error ? <p className="text-xs text-danger">{error}</p> : null}
        </div>
      ) : sent === "edit_request" ? (
        <p className="mt-3 text-[11px] text-muted-2">
          Change requested. It feeds the agent&apos;s next pass on this account.
        </p>
      ) : (
        <p className="mt-3 text-[11px] text-muted-2">
          {draft.subreddit
            ? `Logged. The reason tunes ${draft.subreddit}'s rules and the account's voice for the next run.`
            : "Logged. The reason tunes the account's voice for the next run."}
        </p>
      )}
    </div>
  );
}

/** A parsed batch, chrome-less - the host (asset card, job page) owns the frame. */
export function RedditDraftsBatch({
  clientId,
  jobId,
  assetId,
  accounts,
  outcome,
  consideredCount,
  outcomeNote,
}: {
  clientId: string;
  jobId?: string;
  assetId: string;
  accounts: RedditParsedAccount[];
  /** v2's run outcome. Absent on a v1 batch, which has no such record. */
  outcome?: RedditParsedBatch["outcome"];
  /** Threads the run looked at and passed over, so a thin batch explains itself. */
  consideredCount?: number;
  /** Why the run held or degraded, in the client's own language. */
  outcomeNote?: string;
}) {
  const totalDrafts = accounts.reduce((n, a) => n + a.drafts.length, 0);
  return (
    <div className="space-y-5">
      {/* THE DISTINCTION THIS BLOCK EXISTS FOR. Reddit blocks datacenter
          addresses, so a run from cloud infrastructure reads nothing at all — and
          reporting that as "nothing was good enough" would tell a client their
          niche was thin when the truth is our search never came back. Blaming a
          client's market for our outage is the one failure the four-outcome
          contract is written to prevent, so `degraded` gets its own words and
          never borrows the held copy. */}
      {outcome === "degraded" ? (
        <div className="rounded-md border border-danger/40 bg-danger/10 px-4 py-3">
          <p className="text-sm font-medium text-danger">We could not read Reddit.</p>
          <p className="mt-1 text-xs text-foreground">
            The search did not come back this time, so nothing was judged. This is on us, not on your
            subreddits. Your Karos team can see it and nothing was posted.
          </p>
          {outcomeNote ? (
            <p className="mt-1 text-[11px] text-muted">{normalizeDashes(stripInlineMarkdown(outcomeNote))}</p>
          ) : null}
        </div>
      ) : outcome === "blocked_intake" ? (
        <div className="rounded-md border border-warning/30 bg-warning/10 px-4 py-3">
          <p className="text-sm font-medium text-warning">We need your Reddit account first.</p>
          <p className="mt-1 text-xs text-foreground">
            {outcomeNote
              ? normalizeDashes(stripInlineMarkdown(outcomeNote))
              : "Nominate the account we should reply as in your Reddit agent data, and this runs from then on."}
          </p>
        </div>
      ) : outcome === "held" && totalDrafts === 0 ? (
        <div className="rounded-md border border-border bg-surface-2 px-4 py-3">
          <p className="text-sm font-medium text-foreground">Nothing worth replying to this time.</p>
          <p className="mt-1 text-xs text-muted">
            {outcomeNote
              ? normalizeDashes(stripInlineMarkdown(outcomeNote))
              : "We read the threads and none of them earned your account's name. On Reddit a weak reply costs credibility, so we would rather send you nothing."}
          </p>
        </div>
      ) : null}
      {totalDrafts > 0 ? (
        <p className="text-sm text-muted">
          {totalDrafts === 1 ? "The next reply, ready to review." : "Replies to review."} Each one answers a
          real thread. Posting copies the reply and opens the thread so you can paste it; edit freely, or say
          why you skipped it. Every choice sharpens the next run.
          {consideredCount && consideredCount > totalDrafts
            ? ` We looked at ${consideredCount} threads in total; the rest were not worth your account's name.`
            : ""}
        </p>
      ) : null}
      {accounts.map((acc) => (
        <section key={acc.title} className="overflow-hidden rounded-xl border border-border-strong">
          <header className="flex items-center gap-3 border-b border-border bg-surface-3 px-4 py-3">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-background">
              <SocialPlatformMark platform="reddit" className="h-4 w-4 text-foreground" />
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-[15px] font-semibold text-foreground">{acc.title}</p>
              {acc.handle ? <p className="text-[11px] text-muted-2">Posting as {acc.handle}</p> : null}
            </div>
            {acc.mode ? (
              <span
                title={
                  acc.mode === "warming"
                    ? "Warming: pure-value answers only, no product mentions, until the account has genuine history."
                    : "Established: a disclosed product mention is allowed where the subreddit permits it."
                }
              >
                <Badge tone={acc.mode === "warming" ? "warning" : "success"}>
                  {acc.mode === "warming" ? "Warming" : "Established"}
                </Badge>
              </span>
            ) : null}
          </header>
          {acc.note ? (
            <p className="px-4 pt-3 text-xs text-muted">{normalizeDashes(stripInlineMarkdown(acc.note))}</p>
          ) : null}
          <div className="space-y-3 p-4">
            {acc.drafts.map((draft) => (
              <DraftCard
                key={draft.formula}
                clientId={clientId}
                {...(jobId ? { jobId } : {})}
                assetId={assetId}
                accountTitle={acc.title}
                draft={draft}
              />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
