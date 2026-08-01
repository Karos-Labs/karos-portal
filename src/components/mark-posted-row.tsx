"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Icon } from "@/components/icon";
import { markAssetPostedAction } from "@/lib/actions";
import type { Asset } from "@/lib/types";

/**
 * The client's "I posted this" attestation — the ONE client-side transition to
 * `published` (markAssetPostedAction). Mounted in the asset detail modal and on
 * the calendar day card; Phase 3 adds call sites, never a second mechanism.
 *
 * Composes with the staff-only PublishNowRow (staff push vs client attestation;
 * neither preempts the other) and, on an agent draft batch, with the per-draft
 * pick/edit/skip controls in the reader: those record per-draft outcomes, this
 * marks the whole delivered batch as posted. One control per asset.
 *
 * `compact` renders the inline day-card variant (button only, no section head).
 */
export function MarkPostedRow({ asset, compact = false }: { asset: Asset; compact?: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // A locked (future-dated) card is a redacted placeholder: redactLockedAsset
  // keeps `status`, and drops `publishMode` for every value EXCEPT the client
  // promise "placeholder" (which now crosses so the calendar can classify a
  // roadmap entry on sight). Either way the plain predicate said TRUE
  // and one click per future day would flip the post to published — ending the
  // redaction and revealing the whole pre-generated batch. That is exactly the
  // churn scenario A3/A4 exists to prevent, so locked cards get no control at
  // all (the action refuses it too — the UI is not the guard).
  const eligible =
    !asset.locked &&
    (asset.status === "approved" || asset.status === "scheduled" || asset.status === "delivered") &&
    asset.publishMode !== "placeholder";
  if (!eligible) return null;

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

  if (compact) {
    return (
      <div
        // The day card itself opens the asset modal on click — the attestation
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
        Moves it to Published, so it shows on your calendar and lands in your archive.
      </p>
      {error && <p className="mt-1.5 text-[11px] text-danger">{error}</p>}
    </div>
  );
}
