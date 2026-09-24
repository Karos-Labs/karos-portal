"use client";

import { useMemo, useState } from "react";
import { Badge, Button } from "@/components/ui";
import { Icon } from "@/components/icon";
import { diffWords, summarizeDiff } from "@/lib/text-diff";

/**
 * WHAT THE AGENT WROTE, BESIDE WHAT THE PERSON POSTED.
 *
 * The first human edit of an engine draft stashes the agent's own text on
 * `meta.engineOriginalContent`, and every edit after that leaves the stash
 * alone. `markAssetPostedAction` already sends that pair to the learning loop,
 * where it steers the next draft. Nothing has ever shown it to anybody.
 *
 * §09 of the audit asks for the comparison at review time and gives the
 * reason that matters more than the convenience: *"it is also what makes the
 * learning loop visible"*. A reviewer who can see what their last five edits
 * changed can tell whether the agent is learning from them — and a reviewer
 * who cannot is being asked to trust a loop they have never observed.
 *
 * ## It renders only when there is something to compare
 *
 * No stash, no block. A draft nobody has edited shows its text once, the way
 * it always did: a permanently-present "no changes" panel is furniture, and
 * this surface is already dense.
 *
 * ## Closed by default
 *
 * The current text is what ships and what the reviewer is deciding about. The
 * comparison is the second question, so it opens on a press rather than
 * pushing the post down the card for everybody.
 */
export function VersionComparison({ original, current }: { original: string; current: string }) {
  const [open, setOpen] = useState(false);
  const { segments, summary } = useMemo(() => {
    const next = diffWords(original, current);
    return { segments: next, summary: summarizeDiff(next) };
  }, [original, current]);

  if (summary.identical) return null;

  return (
    <div className="mt-3 rounded-lg border border-border bg-surface-2/60 p-2">
      <div className="flex flex-wrap items-center gap-2">
        <Icon name="GitCompareArrows" className="h-3.5 w-3.5 text-muted-2" />
        <span className="text-xs font-medium">Edited after the agent wrote it</span>
        <Badge tone="neutral">
          +{summary.added} / −{summary.removed} words
        </Badge>
        <Button size="sm" variant="ghost" className="ml-auto" onClick={() => setOpen((o) => !o)}>
          {open ? "Hide" : "Show what changed"}
        </Button>
      </div>

      {open && (
        <div className="mt-2 space-y-2">
          {/* One text with both sides marked, rather than two columns: the
              edits are usually a few words inside a paragraph, and two columns
              of near-identical prose make the reader find them twice. */}
          {/* `dir="auto"` because this is the CLIENT's own words: a Hebrew
              post rendered left-to-right is unreadable, and the diff spans
              inside it inherit the paragraph's direction. */}
          <p dir="auto" className="whitespace-pre-wrap text-sm leading-relaxed">
            {segments.map((segment, index) =>
              segment.kind === "same" ? (
                <span key={index}>{segment.text}</span>
              ) : segment.kind === "added" ? (
                <span key={index} className="rounded-sm bg-success/15 text-foreground underline decoration-success decoration-2 underline-offset-2">
                  {segment.text}
                </span>
              ) : (
                <span key={index} className="rounded-sm bg-warning/15 text-muted line-through decoration-warning">
                  {segment.text}
                </span>
              ),
            )}
          </p>
          <p className="text-[11px] text-muted-2">
            Struck through is the agent&apos;s wording; underlined is what replaced it. This pair is what the next draft learns from.
          </p>
        </div>
      )}
    </div>
  );
}
