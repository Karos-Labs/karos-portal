"use client";

import { useState, useTransition } from "react";
import { Badge, EmptyState } from "@/components/ui";
import { Icon } from "@/components/icon";
import { approveSeoGeoRecommendationAction } from "@/lib/actions";
import type { Recommendation, RecImpact } from "@/lib/seo-geo";

/**
 * Client-facing SEO/GEO action plan (dev-handoff §3b, QA Fix 6). Each row has a REAL
 * "Approve" control: it persists the client's approval (server action → clientSeoGeo doc +
 * activity timeline the team monitors) and flips to "Approved" — no navigation, so a
 * client viewer never lands on an empty-agents dead end. Renders only the client-safe
 * fields (impact + vertical + plain title + description + owner); no internal producer
 * fields cross the boundary (§4).
 */

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
        icon={<Icon name="CheckCircle2" className="h-6 w-6" />}
        title="No open recommendations"
        description="Every measured check passed and no competitor out-ranks this brand in the capture."
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
              className="rounded-md border border-border bg-surface-2 px-3 py-2"
              style={{ borderLeft: `3px solid ${IMPACT_COLORS[r.impact]}` }}
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                  <Badge tone={IMPACT_TONES[r.impact]}>{r.impact}</Badge>
                  <Badge tone="neutral">{r.vertical}</Badge>
                  <span className="text-sm font-medium text-foreground">{cap(r.title)}</span>
                </div>
                {isApproved ? (
                  <span className="inline-flex shrink-0 items-center gap-1 text-xs font-medium text-success">
                    <Icon name="CheckCircle2" className="h-3.5 w-3.5" /> Approved
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
              <p className="mt-1 font-mono text-[10px] uppercase tracking-[0.06em] text-muted-2">{r.owner}</p>
            </li>
          );
        })}
      </ul>
    </>
  );
}
