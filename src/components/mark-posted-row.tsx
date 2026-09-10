"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui";
import { Icon } from "@/components/icon";
import { markAssetPostedAction } from "@/lib/actions";
import { canMarkAssetPosted } from "@/lib/mark-posted";
import type { Asset } from "@/lib/types";

/**
 * The client's "I posted this" attestation — the ONE client-side control that
 * transitions an asset to `published` (markAssetPostedAction).
 *
 * That claim used to be false. The asset card carried its own button, its own
 * copy of the handler and its own eligibility test, and that test had no clause
 * about the date at all — so on the staff Assets list and the job detail page a
 * post whose day had not come showed an ENABLED "Mark as posted" that failed on
 * click with "This post is scheduled for a later day".
 *
 * AND THIS COMPONENT WAS NOT CLEAN EITHER, which is the part worth remembering.
 * Its own test keyed on `asset.locked` — the flag `redactLockedAsset` stamps on
 * the placeholder a CLIENT is handed. Staff receive assets un-redacted
 * (calendar-body only projects `forClient` for a client viewer), so a staff
 * member looking at a future-dated post's day card, or opening it in the detail
 * modal, got the same dead button. One rule, three call sites, and every one of
 * them wrong for staff.
 *
 * The card now renders this component (variant "button") and the eligibility
 * rule lives in `lib/mark-posted`, asked here and again by the server action.
 * Phase 3 adds call sites, never a second mechanism.
 *
 * Composes with the staff-only PublishNowRow (staff push vs client attestation;
 * neither preempts the other) and, on an agent draft batch, with the per-draft
 * pick/edit/skip controls in the reader: those record per-draft outcomes, this
 * marks the whole delivered batch as posted. One control per asset.
 *
 * VARIANTS are presentation only — all three ask the same rule and call the
 * same action:
 *   section — the default; a titled block, for the asset detail modal.
 *   chip    — the inline calendar day-card button.
 *   button  — a peer of Approve / Publish now in the asset card's action row.
 */
export function MarkPostedRow({
  asset,
  variant = "section",
}: {
  asset: Asset;
  variant?: "section" | "chip" | "button";
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // THE rule, not a transcription of it. `canMarkAssetPosted` refuses a draft,
  // a calendar-only placeholder, something already posted, and a post whose day
  // has not come — the last of those both by the server's own `locked` verdict
  // on a redacted payload and by the day comparison, which is what answers for
  // staff (who never receive `locked`). Hiding the control is not the guard:
  // markAssetPostedAction asks `markPostedBlock`, which this is defined from,
  // before it writes.
  //
  // "Has this post's day arrived" can only be asked of the current moment, so
  // the read is genuinely impure and the answer is allowed to change on a later
  // render — that is the point, not a hazard. (Directive on the LAST line
  // before the statement: it applies to the next SOURCE line, so an
  // explanation underneath it suppresses a comment and the rule fires anyway.)
  // eslint-disable-next-line react-hooks/purity
  if (!canMarkAssetPosted(asset, Date.now())) return null;

  async function markPosted() {
    setBusy(true);
    setError(null);
    try {
      const result = await markAssetPostedAction(asset.id);
      if (!result.ok) setError(result.error);
      else router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't mark this as posted");
    } finally {
      setBusy(false);
    }
  }

  if (variant === "chip") {
    return (
      <div
        // The day card itself opens the asset modal on click - the attestation
        // button must not also trigger it.
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
        className="mt-2"
      >
        <button
          type="button"
          onClick={markPosted}
          disabled={busy}
          className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-[11px] font-medium text-muted transition-colors hover:border-border-strong hover:text-foreground disabled:opacity-60"
        >
          <Icon name="CheckCheck" className="h-3 w-3" />
          {busy ? "Marking…" : "Mark as posted"}
        </button>
        {error && <p className="mt-1 text-[11px] text-danger">{error}</p>}
      </div>
    );
  }

  if (variant === "button") {
    return (
      // A column so a refusal can render under the button without stretching
      // the action row it sits in.
      <div className="flex flex-col items-end gap-1">
        <Button
          size="sm"
          variant="outline"
          onClick={markPosted}
          loading={busy}
          title="You posted this yourself. Mark it live so the calendar and status reflect it"
        >
          <Icon name="CheckCheck" className="h-3.5 w-3.5" />
          Mark as posted
        </Button>
        {error && <p className="text-[11px] text-danger">{error}</p>}
      </div>
    );
  }

  return (
    <div className="border-t border-border pt-3">
      <p className="mb-2 text-[10px] font-mono font-medium uppercase tracking-[0.14em] text-muted-2">
        Already posted it?
      </p>
      <button
        type="button"
        onClick={markPosted}
        disabled={busy}
        className="inline-flex h-11 items-center gap-1.5 rounded-md border border-border px-3 text-xs font-medium text-muted transition-colors hover:border-border-strong hover:text-foreground disabled:opacity-60"
      >
        <Icon name="CheckCheck" className="h-3.5 w-3.5" />
        {busy ? "Marking…" : "Mark as posted"}
      </button>
      <p className="mt-1.5 text-[11px] text-muted-2">
        Moves it to Published, so it shows on your calendar and lands in the archive.
      </p>
      {error && <p className="mt-1.5 text-[11px] text-danger">{error}</p>}
    </div>
  );
}
