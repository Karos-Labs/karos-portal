"use client";

/**
 * Shared building blocks for the "review a drafted post and act on it"
 * surfaces: the per-network drafts readers (LinkedIn, X, Reddit — this
 * repo's own catalogue of "grew independently" review UIs) and the plain
 * asset card / detail modal that renders everything else.
 *
 * THE ASK this answers (CEO, 2026-09-21, verbatim in translation): the same
 * buttons and the same UI for publishing across every network, a Download
 * that is ALWAYS there — for a platform we have no API for (Reddit, a hard
 * product rule — see docs/reddit-agent-portal.md) or one staff simply chose
 * to bypass auto-publish on for this one post — and unambiguous state
 * labeling so an unapproved draft never reads as ready-to-publish.
 *
 * Three small pieces, not one mega-component: the five review surfaces keep
 * real per-platform differences (Reddit's approach toggle and reason codes, a
 * thread's reply chain, LinkedIn's simplest shape) that a forced single
 * component would either lose or paper over. What was actually missing and
 * actually shared is the DOWNLOAD control (X and Reddit had none at all; only
 * LinkedIn's media list existed, and nothing offered the text itself) and the
 * "not yet reviewed" badge (present as an absence of a badge, which is the
 * exact ambiguity the CEO flagged one screen over on the calendar).
 */

import { Badge, Button } from "@/components/ui";
import { Icon } from "@/components/icon";
import { assetStatusLabel } from "@/lib/asset-status-copy";

/** A client-facing run artifact a reader can offer for manual attach/upload. */
export interface DraftMediaFile {
  name: string;
  url: string;
}

/**
 * Saves `text` as a `.txt` file straight from the browser. No server route
 * and no asset id, deliberately: a single draft inside a multi-draft batch
 * (one of several LinkedIn/X accounts, one of several Reddit replies) is not
 * its own Asset record, so there is nothing else to download it FROM — the
 * text on screen, exactly as the reviewer is about to post it (edits and all,
 * when a caller passes the edited copy), is the only correct source.
 */
export function downloadTextFile(text: string, filename: string): void {
  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    // Deferred: revoking in the same tick as the click can race the browser's
    // own read of the blob URL on some engines.
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

/**
 * THE one Download control every drafts reader offers, in the same position
 * and with the same label and icon whatever the platform underneath it —
 * Reddit included, which has no publish integration of any kind to fall back
 * on. This is the affordance the CEO's ask names directly: staff can always
 * get the raw content to post by hand, whether because the platform has no
 * API integration (Reddit) or because they chose to bypass auto-publish for
 * one post.
 */
export function DownloadDraftButton({
  text,
  filename,
  label = "Download",
}: {
  /** The exact text a poster would use — whatever is on screen right now. */
  text: string;
  /** Full filename, extension included (e.g. "acme-linkedin.txt"). */
  filename: string;
  label?: string;
}) {
  return (
    <Button
      type="button"
      size="sm"
      variant="outline"
      onClick={() => downloadTextFile(text, filename)}
      title="Save this text as a file, to post yourself"
    >
      <Icon name="Download" className="h-3.5 w-3.5" />
      {label}
    </Button>
  );
}

/**
 * The run's attachable media, rendered as a small downloadable file list —
 * LinkedIn's own "Attach when posting" block (li-drafts-review.tsx),
 * generalized so X and Reddit can offer the same thing the moment either
 * platform starts carrying media on a draft, rather than growing a second
 * copy of this list when that day comes.
 */
export function DraftMediaDownloads({ media }: { media: DraftMediaFile[] }) {
  if (media.length === 0) return null;
  return (
    <div className="mt-2 rounded-md border border-border bg-background px-3 py-2">
      <p className="text-[11px] font-medium text-muted">Attach when posting:</p>
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
  );
}

/**
 * The one "you have not acted on this yet" badge every drafts reader shows
 * before a pick / post / skip choice is recorded.
 *
 * Reuses the STAFF register's own word for an unapproved asset
 * (`assetStatusLabel("draft", false)`, "Awaiting review" — asset-status-copy.ts)
 * and the same tone asset-card.tsx's own `statusTone` already reads "draft"
 * as ("warning"), rather than inventing a fourth vocabulary for the same
 * fact. Before this, "not yet reviewed" was rendered as the ABSENCE of a
 * badge — indistinguishable from "this card has nothing to show here" at a
 * glance, which is exactly the ambiguity the CEO's calendar note is about,
 * one layer down: the individual draft, not just the day it sits on.
 */
export function AwaitingReviewBadge() {
  return <Badge tone="warning">{assetStatusLabel("draft", false)}</Badge>;
}
