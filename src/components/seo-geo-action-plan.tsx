"use client";

import { useState, useTransition } from "react";
import { Badge, EmptyState } from "@/components/ui";
import { Icon } from "@/components/icon";
import { approveSeoGeoRecommendationAction } from "@/lib/actions";
import type { Lever, Recommendation, RecImpact } from "@/lib/seo-geo";

/**
 * Client-facing SEO/GEO action plan (dev-handoff §3b, QA Fix 6). Each row has a REAL
 * "Approve" control: it persists the client's approval (server action → clientSeoGeo doc +
 * activity timeline the team monitors) and flips to "Approved" - no navigation, so a
 * client viewer never lands on an empty-agents dead end. Renders only the client-safe
 * fields (impact + vertical + plain title + description + owner); no internal producer
 * fields cross the boundary (§4).
 */

/**
 * F144/CD-B1: the vertical badge rendered `r.vertical` - the raw lever code "SEO" /
 * "GEO" / "BOTH" - on every row of the plan a client reads, the one surface on this
 * page that had escaped the presenter's mapping discipline.
 *
 * The words are the presenter's LEVER_LABELS verbatim (seo-geo/presenter.ts), so the
 * badge a client reads on a plan row and the channel chip staff read on the gap
 * behind it say the same thing; seo-geo-presenter.test.ts pins the two together.
 * Copied rather than imported because this is a client leaf and the presenter pulls
 * the whole domain module in with it - the boundary its own header comment sets.
 *
 * `Record<Lever, …>`: a new lever is a compile error here, not a leaked code.
 */
const LEVER_LABELS: Record<Lever, string> = {
  SEO: "search results",
  GEO: "AI answers",
  BOTH: "search + AI answers",
};

const IMPACT_TONES: Record<RecImpact, "danger" | "warning" | "neutral"> = {
  high: "danger",
  medium: "warning",
  low: "neutral",
};
const IMPACT_COLORS: Record<RecImpact, string> = {
  high: "var(--danger)",
  medium: "var(--warning)",
  low: "var(--muted-2)",
};

function cap(s: string): string {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

export function SeoGeoActionPlan({
  clientId,
  recommendations,
  approvedRecIds,
}: {
  clientId: string;
  recommendations: Recommendation[];
  approvedRecIds: string[];
}) {
  const [approved, setApproved] = useState<Set<string>>(new Set(approvedRecIds));
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  function approve(rec: Recommendation) {
    setError(null);
    setBusyId(rec.recId);
    startTransition(async () => {
      const res = await approveSeoGeoRecommendationAction(clientId, rec.recId, rec.title);
      setBusyId(null);
      if ("error" in res && res.error) {
        setError(res.error);
        return;
      }
      if ("approved" in res) setApproved(new Set(res.approved));
    });
  }

  if (recommendations.length === 0) {
    return (
      <EmptyState
        icon={<Icon name="CircleCheck" className="h-6 w-6" />}
        title="Nothing to fix right now"
        description="Every check we measured passed, and no tracked competitor out-ranks you in this snapshot."
      />
    );
  }

  return (
    <>
      {error && <p className="mb-2 text-xs text-danger">{error}</p>}
      <ul className="space-y-2">
        {recommendations.map((r, i) => {
          const isApproved = approved.has(r.recId);
          const isBusy = busyId === r.recId;
          return (
            <li
              key={`${r.recId}-${i}`}
              // CD-J1 directive 6: an approved row LOOKS handed over. The state used
              // to be a few words of green text on an otherwise identical row, so a
              // plan with half its items approved read as one undifferentiated list
              // and nothing confirmed the click had gone anywhere.
              className={
                isApproved
                  ? "rounded-md border border-success/30 bg-success/[0.06] px-3 py-2"
                  : "rounded-md border border-border bg-surface-2 px-3 py-2"
              }
              style={{
                borderLeft: `3px solid ${isApproved ? "var(--success)" : IMPACT_COLORS[r.impact]}`,
              }}
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                  <Badge tone={IMPACT_TONES[r.impact]}>{r.impact}</Badge>
                  <Badge tone="neutral">{LEVER_LABELS[r.vertical]}</Badge>
                  <span className="text-sm font-medium text-foreground">{cap(r.title)}</span>
                </div>
                {isApproved ? (
                  <span className="inline-flex shrink-0 items-center gap-1 text-xs font-medium text-success">
                    <Icon name="CircleCheck" className="h-3.5 w-3.5" /> Approved
                  </span>
                ) : (
                  <button
                    type="button"
                    onClick={() => approve(r)}
                    disabled={isBusy}
                    className="inline-flex shrink-0 items-center gap-1 rounded-md border border-border bg-surface px-2.5 py-1 text-xs font-medium text-foreground transition-colors hover:bg-surface-3 disabled:opacity-40"
                  >
                    <Icon name="Check" className="h-3 w-3" />
                    {isBusy ? "Approving…" : "Approve"}
                  </button>
                )}
              </div>
              {r.description && <p className="mt-1 text-xs text-muted">{r.description}</p>}
              {isApproved ? (
                <p className="mt-1 text-[11px] text-success">
                  With your Karos team - it&apos;ll show in your next snapshot.
                </p>
              ) : (
                <p className="mt-1 font-mono text-[10px] uppercase tracking-[0.06em] text-muted-2">
                  {r.owner}
                </p>
              )}
            </li>
          );
        })}
      </ul>
      {/* CD-J1 directive 6: say what the button does BEFORE it is pressed. Approve
          is authorization, not execution - a person makes the change - and the
          plan never said so anywhere. */}
      <p className="mt-3 text-[11px] text-muted-2">
        Approving sends it to your Karos team - they make the change and it shows in your next
        snapshot. Nothing on your site changes when you click.
      </p>
    </>
  );
}
