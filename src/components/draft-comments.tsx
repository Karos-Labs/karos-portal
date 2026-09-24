"use client";

import { useEffect, useState, useTransition } from "react";
import { Badge, Button, Textarea } from "@/components/ui";
import { Icon } from "@/components/icon";
import { addAssetCommentAction, getAssetCommentsAction } from "@/lib/actions/asset-comment-actions";
import { relativeTime } from "@/lib/utils";
import type { AssetComment } from "@/lib/types";

/**
 * THE CONVERSATION ABOUT A DRAFT, ATTACHED TO THE DRAFT.
 *
 * §09: *"threaded comments on drafts — a conversation between the client and
 * the account manager. A comment mechanism exists for task tickets and there
 * is nothing for content."* A client with an opinion about the second line of
 * a post had a ticket system for "please do this" and nowhere at all for "this
 * line, not that one", so it went to Slack, to email, or nowhere — and none of
 * those are attached to the post when the next person opens it.
 *
 * ## Loaded on open, not on render
 *
 * A thread per card would be one Firestore query per card on a page that shows
 * forty. It loads when the reader opens it, and says so while it does.
 *
 * ## The author's role is shown, because it is the point
 *
 * The thread's value is that BOTH sides are in it. A line with no attribution
 * reads as a note to self; "Client" or "Account manager" beside it is what
 * makes it a conversation somebody replied to.
 */
export function DraftComments({ assetId }: { assetId: string }) {
  const [open, setOpen] = useState(false);
  const [comments, setComments] = useState<AssetComment[] | null>(null);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, startLoading] = useTransition();
  const [sending, startSending] = useTransition();

  useEffect(() => {
    if (!open || comments !== null) return;
    startLoading(async () => {
      const result = await getAssetCommentsAction(assetId);
      setComments(result.comments);
      if (result.error) setError(result.error);
    });
  }, [open, comments, assetId]);

  const count = comments?.length ?? 0;

  return (
    <div className="mt-3 rounded-lg border border-border bg-surface-2/60 p-2">
      <div className="flex flex-wrap items-center gap-2">
        <Icon name="MessageSquare" className="h-3.5 w-3.5 text-muted-2" />
        <span className="text-xs font-medium">Discussion</span>
        {comments !== null && count > 0 && <Badge tone="neutral">{count}</Badge>}
        <Button size="sm" variant="ghost" className="ml-auto" onClick={() => setOpen((o) => !o)}>
          {open ? "Hide" : "Open"}
        </Button>
      </div>

      {open && (
        <div className="mt-2 space-y-2">
          {loading && comments === null ? (
            <p className="text-xs text-muted-2">Loading the thread…</p>
          ) : count === 0 ? (
            <p className="text-xs text-muted-2">Nothing here yet. Ask for a change, or say what works.</p>
          ) : (
            <ul className="space-y-2">
              {comments!.map((comment) => (
                <li key={comment.id} className="rounded-md border border-border/60 bg-surface p-2">
                  <div className="flex flex-wrap items-baseline gap-2 text-[11px] text-muted-2">
                    <span className="font-medium text-foreground">{comment.authorName}</span>
                    <Badge tone="neutral">{comment.authorRole === "CLIENT_USER" ? "Client" : "Account manager"}</Badge>
                    <span className="ml-auto">{relativeTime(comment.createdAt)}</span>
                  </div>
                  <p dir="auto" className="mt-1 whitespace-pre-wrap text-sm">
                    {comment.content}
                  </p>
                </li>
              ))}
            </ul>
          )}

          <Textarea
            value={draft}
            dir="auto"
            rows={2}
            placeholder="Add to the thread"
            onChange={(event) => setDraft(event.target.value)}
          />
          {error && <p className="text-xs text-warning">{error}</p>}
          <div className="flex justify-end">
            <Button
              size="sm"
              loading={sending}
              disabled={draft.trim().length === 0}
              onClick={() =>
                startSending(async () => {
                  const result = await addAssetCommentAction(assetId, draft);
                  if (!result.ok || !result.comment) {
                    setError(result.error ?? "The comment was not saved.");
                    return;
                  }
                  // Appended rather than re-fetched: the reader is mid-thread
                  // and a refetch would reorder under them for no new fact.
                  setComments((current) => [...(current ?? []), result.comment!]);
                  setDraft("");
                  setError(null);
                })
              }
            >
              Send
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
