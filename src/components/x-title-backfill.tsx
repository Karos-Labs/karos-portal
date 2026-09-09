"use client";

import { useState, useTransition } from "react";
import { Badge, Button, Card, CardTitle } from "@/components/ui";
import { Icon } from "@/components/icon";
import {
  backfillXAssetTitlesAction,
  type TitleBackfillResult,
} from "@/lib/actions/asset-title-backfill-actions";

/**
 * The admin's one-press retitle for the X archive (Ops page).
 *
 * Preview first, always: the dry run shows every old -> new title without
 * writing, and the write button only appears once a preview has been seen —
 * an admin never mass-renames client-visible rows sight unseen. Chunked at
 * the action's batch size; `remaining` keeps the button honest about a
 * second press.
 */
export function XTitleBackfill() {
  const [result, setResult] = useState<TitleBackfillResult | null>(null);
  const [wrote, setWrote] = useState(false);
  const [pending, startTransition] = useTransition();

  const run = (write: boolean) =>
    startTransition(async () => {
      const next = await backfillXAssetTitlesAction({ write });
      setResult(next);
      if (next.ok && write) setWrote(true);
    });

  return (
    <Card className="p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <CardTitle>X archive titles</CardTitle>
        {result?.ok && (result.remaining ?? 0) > 0 && (
          <Badge tone="neutral">{result.remaining} still waiting</Badge>
        )}
      </div>
      <p className="mt-2 text-sm text-muted">
        Old X deliveries are still named after the agent instead of what they say. This names each one
        by its topic, the way new deliveries already arrive named. Preview shows every rename before
        anything is written; the old name is kept on the record, so a rename can be undone.
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button size="sm" variant="subtle" disabled={pending} onClick={() => run(false)}>
          <Icon name="Eye" className="h-3.5 w-3.5" />
          {pending ? "Working…" : "Preview renames"}
        </Button>
        {result?.ok && !result.wrote && (result.rows?.length ?? 0) > 0 && (
          <Button size="sm" variant="accent" disabled={pending} onClick={() => run(true)}>
            <Icon name="Check" className="h-3.5 w-3.5" />
            Apply these titles
          </Button>
        )}
        {wrote && result?.ok && (result.remaining ?? 0) > 0 && (
          <Button size="sm" variant="accent" disabled={pending} onClick={() => run(true)}>
            Retitle the next {Math.min(result.remaining ?? 0, 25)}
          </Button>
        )}
      </div>

      {result && !result.ok && <p className="mt-3 text-sm text-danger">{result.error}</p>}

      {result?.ok && (
        <div className="mt-4 space-y-1.5">
          {(result.rows ?? []).length === 0 ? (
            <p className="text-sm text-muted">
              Nothing to rename: every X delivery already has a real title.
            </p>
          ) : (
            <>
              <p className="text-xs text-muted-2">
                {result.wrote ? "Renamed" : "Would rename"} {result.rows!.length}
                {(result.untitled ?? 0) > 0 ? ` · ${result.untitled} could not be named and were left alone` : ""}
              </p>
              {result.rows!.map((row) => (
                <div key={row.assetId} className="rounded-md border border-border px-3 py-2 text-sm">
                  <p className="truncate text-xs text-muted-2">{row.clientName}</p>
                  <p className="truncate">
                    <span className="text-muted line-through">{row.from}</span>
                    <span className="mx-1.5 text-muted-2">→</span>
                    <span>{row.to}</span>
                  </p>
                </div>
              ))}
            </>
          )}
        </div>
      )}
    </Card>
  );
}
