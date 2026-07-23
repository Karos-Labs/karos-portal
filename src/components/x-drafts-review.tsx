"use client";

/**
 * The X drafts reader: a parsed draft batch rendered as readable cards —
 * grouped per account, one card per avenue, the post text large and scannable
 * — with pick / edit / skip actions wired into the per-account feedback loop.
 * Chrome-less by design: it embeds wherever outputs live (the asset card in
 * the Library and on the job page).
 */

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Badge, Button, Textarea } from "@/components/ui";
import { Icon } from "@/components/icon";
import { addXDraftFeedbackAction } from "@/lib/actions/x-agent-actions";
import type { XParsedAccount, XParsedDraft } from "@/lib/x-drafts";

type SentState = "posted" | "posted_with_edits" | "not_posted";

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
  const [error, setError] = useState<string | null>(null);
  const [finalText, setFinalText] = useState("");
  const [reason, setReason] = useState("");

  const draftRef = `${accountTitle} · ${draft.avenue}`;

  function send(action: SentState) {
    setError(null);
    start(async () => {
      const result = await addXDraftFeedbackAction({
        clientId,
        accountTitle,
        ...(jobId ? { jobId } : {}),
        assetId,
        draftRef,
        action,
        ...(action === "posted_with_edits" ? { finalText } : {}),
        ...(action === "not_posted" ? { reason } : {}),
      });
      if (result.error) {
        setError(result.error);
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
          {draft.posts[0]?.chars ? (
            <Badge>{draft.posts.length > 1 ? `${draft.posts.length}-post thread` : draft.posts[0].chars}</Badge>
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
            {post.marker && post.chars ? (
              <p className="mt-2 text-right font-mono text-[10px] text-muted-2">{post.chars}</p>
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
                <Button size="sm" onClick={() => send("posted_with_edits")} disabled={pending || !finalText.trim()}>
                  {pending ? "Sending…" : "Save my version"}
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
                <Button size="sm" variant="danger" onClick={() => send("not_posted")} disabled={pending || !reason.trim()}>
                  {pending ? "Sending…" : "Skip it"}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setMode("idle")}>
                  Cancel
                </Button>
              </div>
            </>
          ) : (
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="accent" onClick={() => send("posted")} disabled={pending}>
                <Icon name="Check" className="mr-1 h-3.5 w-3.5" />
                {pending ? "Sending…" : "Pick this one"}
              </Button>
              <Button
                size="sm"
                variant="subtle"
                onClick={() => {
                  setFinalText(draft.posts.map((p) => p.text).join("\n\n"));
                  setMode("editing");
                }}
              >
                Pick with edits
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setMode("skipping")}>
                Skip
              </Button>
            </div>
          )}
          {error ? <p className="text-xs text-red-400">{error}</p> : null}
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
    <div className="space-y-6">
      <p className="text-sm text-muted">
        About a week of posting to choose from. Pick your favourites, edit freely, and skip with a
        reason - every choice sharpens that account&apos;s voice for the next batch.
      </p>
      {accounts.map((acc) => (
        <div key={acc.title}>
          <div className="mb-2 flex items-center gap-2">
            <Icon name="AtSign" className="h-4 w-4 text-muted" />
            <p className="text-sm font-semibold">{acc.title}</p>
          </div>
          {acc.note ? <p className="mb-2 text-xs text-muted">{acc.note}</p> : null}
          <div className="space-y-3">
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
        </div>
      ))}
    </div>
  );
}
