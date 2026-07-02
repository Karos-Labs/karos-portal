"use client";

import { useState, useTransition, useRef } from "react";
import { useRouter } from "next/navigation";
import { Card, CardTitle, Button, Badge } from "@/components/ui";
import { Icon } from "@/components/icon";
import { cn } from "@/lib/utils";
import {
  addCompetitorAndAnalyzeAction,
  backfillCompetitorsAction,
  deleteCompetitorAction,
} from "@/lib/actions";
import type { ClientCompetitor } from "@/lib/types";

/* ── Read-only data cell ─────────────────────────────────────────── */

function DataCell({ items, fallback = "—" }: { items: string[]; fallback?: string }) {
  if (items.length === 0) {
    return <span className="text-xs italic text-muted-2">{fallback}</span>;
  }
  if (items.length === 1) {
    return <span className="text-sm text-foreground">{items[0]}</span>;
  }
  return (
    <ul className="space-y-0.5">
      {items.map((item, i) => (
        <li key={i} className="flex items-start gap-1.5 text-sm text-foreground">
          <span className="mt-[5px] h-1 w-1 shrink-0 rounded-full bg-neon/60" />
          {item}
        </li>
      ))}
    </ul>
  );
}

/* ── Tier / Threat badges ────────────────────────────────────────── */

function TierBadge({ tier }: { tier: ClientCompetitor["marketTier"] }) {
  const tone =
    tier === "Leader" ? ("neon" as const) : tier === "Challenger" ? ("info" as const) : ("neutral" as const);
  return (
    <Badge tone={tone} className="text-[9px]">
      {tier}
    </Badge>
  );
}

function ThreatBadge({ level }: { level?: ClientCompetitor["threatLevel"] }) {
  if (!level) return null;
  const tone =
    level === "HIGH" ? ("danger" as const) : level === "MEDIUM" ? ("warning" as const) : ("neutral" as const);
  return (
    <Badge tone={tone} className="text-[9px]">
      {level}
    </Badge>
  );
}

/* ── Analyzing overlay ───────────────────────────────────────────── */

function AnalyzingBanner() {
  return (
    <div className="flex items-center gap-2.5 rounded-md border border-neon/30 bg-neon-soft/10 px-4 py-3">
      <div className="h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-neon/30 border-t-neon" />
      <div>
        <p className="text-sm font-medium text-neon">Analyzing competitors…</p>
        <p className="text-xs text-muted-2">This may take 15–30 seconds. The table will update automatically.</p>
      </div>
    </div>
  );
}

/* ── Add competitor name bar ─────────────────────────────────────── */

function AddNameBar({
  clientId,
  disabled,
  onAnalyzing,
}: {
  clientId: string;
  disabled: boolean;
  onAnalyzing: (v: boolean) => void;
}) {
  const router = useRouter();
  const [adding, startAdd] = useTransition();
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const isLoading = adding || disabled;

  function submit() {
    const trimmed = name.trim();
    if (!trimmed) {
      setError("Enter a competitor name");
      inputRef.current?.focus();
      return;
    }
    setError(null);
    onAnalyzing(true);
    startAdd(async () => {
      try {
        await addCompetitorAndAnalyzeAction(clientId, trimmed);
        setName("");
        router.refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to add competitor");
      } finally {
        onAnalyzing(false);
      }
    });
  }

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2">
        <input
          ref={inputRef}
          value={name}
          onChange={(e) => { setName(e.target.value); setError(null); }}
          onKeyDown={(e) => e.key === "Enter" && submit()}
          disabled={isLoading}
          placeholder="Enter competitor name…"
          className={cn(
            "flex-1 rounded-md border border-border bg-surface-2 px-3 py-2 text-sm text-foreground placeholder:text-muted-2 outline-none transition-colors",
            "focus:border-neon/50 focus:ring-1 focus:ring-neon/20",
            "disabled:cursor-not-allowed disabled:opacity-50",
            error && "border-danger/50",
          )}
        />
        <Button size="sm" onClick={submit} disabled={isLoading} loading={adding}>
          <Icon name="Plus" className="h-3.5 w-3.5" />
          Add
        </Button>
      </div>
      {error && <p className="text-[11px] text-danger">{error}</p>}
    </div>
  );
}

/* ── Competitor table row ────────────────────────────────────────── */

function CompetitorRow({
  competitor,
  isStaff,
  deleting,
  onDelete,
}: {
  competitor: ClientCompetitor;
  isStaff: boolean;
  deleting: boolean;
  onDelete: () => void;
}) {
  const hasProfile = competitor.positioning || competitor.keyStrengths.length > 0 || competitor.keyWeaknesses.length > 0;

  return (
    <tr
      className={cn(
        "group border-b border-border transition-colors hover:bg-surface-2/40",
        deleting && "pointer-events-none opacity-40",
        !hasProfile && "opacity-70",
      )}
    >
      {/* Competitor name */}
      <td className="px-4 py-3">
        <p className="font-medium text-foreground">{competitor.company}</p>
        {competitor.url && (
          <a
            href={competitor.url.startsWith("http") ? competitor.url : `https://${competitor.url}`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-muted-2 transition-colors hover:text-neon"
          >
            {competitor.url.replace(/^https?:\/\//, "").replace(/\/$/, "")}
          </a>
        )}
        <div className="mt-1.5 flex flex-wrap gap-1">
          <TierBadge tier={competitor.marketTier} />
          <ThreatBadge level={competitor.threatLevel} />
          {!hasProfile && (
            <Badge tone="neutral" className="text-[9px] italic">
              pending analysis
            </Badge>
          )}
        </div>
      </td>

      {/* Value proposition */}
      <td className="px-4 py-3 align-top">
        {competitor.positioning ? (
          <p className="text-sm leading-relaxed text-foreground">{competitor.positioning}</p>
        ) : (
          <span className="text-xs italic text-muted-2">—</span>
        )}
      </td>

      {/* Core strength */}
      <td className="px-4 py-3 align-top">
        <DataCell items={competitor.keyStrengths} />
      </td>

      {/* Vulnerability */}
      <td className="px-4 py-3 align-top">
        <DataCell items={competitor.keyWeaknesses} />
      </td>

      {/* Delete */}
      {isStaff && (
        <td className="px-4 py-3">
          <button
            onClick={onDelete}
            disabled={deleting}
            title="Remove competitor"
            className="flex h-7 w-7 items-center justify-center rounded-[6px] text-muted-2 opacity-0 transition-all hover:bg-danger/10 hover:text-danger group-hover:opacity-100 disabled:opacity-40"
            aria-label="Remove competitor"
          >
            <Icon name="Trash2" className="h-3.5 w-3.5" />
          </button>
        </td>
      )}
    </tr>
  );
}

/* ── Main component ──────────────────────────────────────────────── */

interface Props {
  competitors: ClientCompetitor[];
  clientId: string;
  hasReport: boolean;
  isStaff: boolean;
}

export function CompetitorManager({ competitors, clientId, hasReport, isStaff }: Props) {
  const router = useRouter();
  const [discovering, startDiscover] = useTransition();
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [discoverError, setDiscoverError] = useState<string | null>(null);

  const isLoading = analyzing || discovering;

  function handleDelete(id: string) {
    setDeletingId(id);
    deleteCompetitorAction(id)
      .then(() => router.refresh())
      .catch(() => setDeletingId(null));
  }

  function handleDiscover() {
    setDiscoverError(null);
    startDiscover(async () => {
      try {
        await backfillCompetitorsAction(clientId);
        router.refresh();
      } catch (e) {
        setDiscoverError(e instanceof Error ? e.message : "Discovery failed. Try again.");
      }
    });
  }

  const tableHeaders = isStaff
    ? ["Competitor", "Value Proposition", "Core Strength", "Vulnerability", ""]
    : ["Competitor", "Value Proposition", "Core Strength", "Vulnerability"];

  return (
    <div className="space-y-4">
      {/* Header row */}
      <div className="flex items-center justify-between gap-2">
        <CardTitle>Competitor Intelligence</CardTitle>
        {competitors.length > 0 && (
          <span className="text-xs text-muted-2">{competitors.length} tracked</span>
        )}
      </div>

      {/* Analyzing state */}
      {isLoading && <AnalyzingBanner />}

      {/* Staff: add-name input bar */}
      {isStaff && (
        <AddNameBar
          clientId={clientId}
          disabled={isLoading}
          onAnalyzing={setAnalyzing}
        />
      )}

      {/* Discover error */}
      {discoverError && (
        <div className="flex items-center gap-2 rounded-md border border-danger/30 bg-danger/10 px-3 py-2">
          <Icon name="TriangleAlert" className="h-4 w-4 shrink-0 text-danger" />
          <p className="text-xs text-danger">{discoverError}</p>
        </div>
      )}

      {/* Empty states */}
      {competitors.length === 0 && (
        <div className="flex flex-col items-center gap-4 rounded-md border border-dashed border-border py-12 text-center">
          <div className="flex h-12 w-12 items-center justify-center rounded-md bg-surface-2">
            <Icon name="Users" className="h-6 w-6 text-muted-2" />
          </div>

          {isStaff ? (
            <>
              <div>
                <p className="text-sm font-medium text-foreground">No competitors tracked</p>
                <p className="mt-1 text-xs text-muted-2 max-w-xs mx-auto">
                  {hasReport
                    ? "No competitors were found in the Intel Report. Add competitor names above to analyze their profiles."
                    : "Enter competitor names above, or let AI discover the top competitors for this client automatically."}
                </p>
              </div>
              {!hasReport && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={handleDiscover}
                  disabled={isLoading}
                  loading={discovering}
                >
                  <Icon name="Sparkles" className="h-3.5 w-3.5" />
                  {discovering ? "Discovering…" : "Discover & Analyze"}
                </Button>
              )}
            </>
          ) : (
            <div>
              <p className="text-sm font-medium text-foreground">Competitor analysis pending</p>
              <p className="mt-1 text-xs text-muted-2">
                Competitor intelligence will appear once the Intel Report has been generated.
              </p>
            </div>
          )}
        </div>
      )}

      {/* Table */}
      {competitors.length > 0 && (
        <Card className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[700px] text-sm">
              <thead>
                <tr className="border-b border-border">
                  {tableHeaders.map((h, i) => (
                    <th
                      key={i}
                      className={cn(
                        "px-4 py-3 text-left text-[10px] font-mono font-medium uppercase tracking-[0.14em] text-muted-2",
                        i === 0 && "w-[200px]",
                        i === tableHeaders.length - 1 && isStaff && "w-10",
                      )}
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {competitors.map((c) => (
                  <CompetitorRow
                    key={c.id}
                    competitor={c}
                    isStaff={isStaff}
                    deleting={deletingId === c.id}
                    onDelete={() => handleDelete(c.id)}
                  />
                ))}
              </tbody>
            </table>
          </div>

          {/* Staff: discover button when table already has data */}
          {isStaff && (
            <div className="border-t border-border px-4 py-3">
              <Button
                size="sm"
                variant="ghost"
                onClick={handleDiscover}
                disabled={isLoading}
                loading={discovering}
                className="text-muted-2 hover:text-foreground"
              >
                <Icon name="Sparkles" className="h-3.5 w-3.5" />
                {discovering ? "Re-discovering…" : "Re-discover all from AI"}
              </Button>
            </div>
          )}
        </Card>
      )}
    </div>
  );
}
