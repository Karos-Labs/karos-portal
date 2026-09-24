"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Badge, Button } from "@/components/ui";
import { Icon } from "@/components/icon";
import { bulkApproveAssetsAction, previewBulkApproveAction, type BulkApproveRow } from "@/lib/actions/bulk-approve-actions";
import { platformLabel } from "@/lib/integrations/platforms";

/**
 * THE SUMMARY IS THE FEATURE.
 *
 * §09 asks for bulk approval *"with a summary of exactly what will go out"*,
 * and the summary is the half that makes the button pressable: eight drafts
 * approved into a schedule nobody previewed is eight posts somebody has to go
 * and check. So the plan is fetched from the server BEFORE anything is
 * written, by the same function that will write it — one planner, so the dates
 * on screen are the dates that land.
 *
 * The reviewer picks one thing: the day the batch starts. Everything after
 * that is the client's own pace and posting days, which the app already
 * decides for a single post and should not decide differently because eight
 * were approved at once.
 *
 * `manual` is the tier, deliberately and not as a default that could drift to
 * `auto`: a bulk press is the one moment a reviewer is least likely to be
 * thinking about a specific post going live by itself. The posts land on the
 * calendar and a person publishes them — the same tier the card's own approve
 * panel picks when there is no usable integration.
 */
export function BulkApproveBar({
  selectedIds,
  onDone,
  onClear,
}: {
  selectedIds: string[];
  onDone: () => void;
  onClear: () => void;
}) {
  const router = useRouter();
  const [startAt, setStartAt] = useState(() => tomorrowMorning());
  const [preview, setPreview] = useState<{ rows: BulkApproveRow[]; refusal?: string } | null>(null);
  const [outcome, setOutcome] = useState<{ approved: number; failures: Array<{ id: string; error: string }> } | null>(null);
  const [loading, startLoading] = useTransition();
  const [saving, startSaving] = useTransition();

  // The plan follows the selection and the start day. A stale summary is worse
  // than none: it is the thing the reviewer is agreeing to.
  useEffect(() => {
    // Every `setState` here is INSIDE the transition, never synchronous in the
    // effect body: a synchronous set cascades a render before the browser has
    // painted this one, which the lint refuses and which shows up as the bar
    // flickering as a selection is built up.
    const at = new Date(startAt).getTime();
    startLoading(async () => {
      setOutcome(null);
      if (selectedIds.length === 0) {
        setPreview(null);
        return;
      }
      const next = await previewBulkApproveAction(selectedIds, Number.isFinite(at) ? at : Date.now());
      setPreview(next);
    });
    // `startLoading` is stable; the plan depends on exactly these two.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedIds.join(","), startAt]);

  if (selectedIds.length === 0) return null;

  const rows = preview?.rows ?? [];

  return (
    <div className="sticky bottom-0 z-20 mt-4 rounded-lg border border-border bg-surface-2 p-3 shadow-lg">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone="info">{selectedIds.length} selected</Badge>
        <label className="flex items-center gap-1.5 text-xs text-muted-2">
          Starts
          <input
            type="date"
            value={startAt}
            onChange={(event) => setStartAt(event.target.value)}
            className="h-8 rounded-md border border-border bg-surface px-2 text-xs text-foreground focus:outline-none focus:ring-2 focus:ring-neon/40"
          />
        </label>
        <div className="ml-auto flex items-center gap-1.5">
          <Button variant="ghost" onClick={onClear}>
            Clear
          </Button>
          <Button
            loading={saving}
            disabled={rows.length === 0 || loading}
            onClick={() =>
              startSaving(async () => {
                const at = new Date(startAt).getTime();
                const result = await bulkApproveAssetsAction(selectedIds, Number.isFinite(at) ? at : Date.now());
                const failures = result.results
                  .filter((r): r is { id: string; error: string } => typeof r.error === "string")
                  .map((r) => ({ id: r.id, error: r.error }));
                setOutcome({ approved: result.results.length - failures.length, failures });
                router.refresh();
                if (failures.length === 0) onDone();
              })
            }
          >
            <Icon name="CheckCheck" className="h-3.5 w-3.5" />
            Approve {rows.length > 0 ? rows.length : selectedIds.length}
          </Button>
        </div>
      </div>

      {/* WHAT WILL GO OUT, before it does. A refusal reads here as a sentence
          rather than as an empty list: "25 is the most one approval may cover"
          is an answer, and a blank box is not. */}
      <div className="mt-2 max-h-52 overflow-y-auto rounded-md border border-border/60 bg-surface p-2">
        {loading && rows.length === 0 ? (
          <p className="text-xs text-muted-2">Working out the schedule…</p>
        ) : preview?.refusal ? (
          <p className="text-xs text-muted-2">{preview.refusal}</p>
        ) : (
          <ul className="space-y-1">
            {rows.map((row) => (
              <li key={row.id} className="flex flex-wrap items-baseline gap-2 text-xs">
                <span className="font-medium tabular-nums text-foreground">{formatSlot(row.scheduledAt)}</span>
                <span className="text-muted">{row.title}</span>
                {row.platform ? <Badge tone="neutral">{platformLabel(row.platform)}</Badge> : <span className="text-muted-2">no channel yet; it will land on the calendar for a person to publish</span>}
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* One failed row never hides the ones that landed. */}
      {outcome && (
        <div className="mt-2 text-xs">
          <p className="text-muted">
            {outcome.approved} approved{outcome.failures.length > 0 ? `, ${outcome.failures.length} refused` : ""}.
          </p>
          {outcome.failures.length > 0 && (
            <ul className="mt-1 space-y-0.5">
              {outcome.failures.map((failure) => (
                <li key={failure.id} className="text-warning">
                  {failure.error}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

/** Tomorrow, as the `<input type="date">` value — a batch approved now almost never means "today". */
function tomorrowMorning(): string {
  const date = new Date();
  date.setDate(date.getDate() + 1);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** "Mon 29 Sep, 09:00" — the reader's own timezone, which is the one they schedule in. */
function formatSlot(at: number): string {
  return new Date(at).toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}
