"use client";

import { useRouter } from "next/navigation";
import { cn } from "@/lib/utils";
import { RANGE_OPTIONS } from "@/lib/analytics-constants";
import type { Client } from "@/lib/types";

interface Props {
  clients: Client[];
  currentClientId?: string;
  currentRange?: string;
}

export function AnalyticsFilters({ clients, currentClientId, currentRange }: Props) {
  const router = useRouter();

  function navigate(updates: { clientId?: string; range?: string }) {
    const params = new URLSearchParams();
    const clientId = "clientId" in updates ? updates.clientId : currentClientId;
    const range    = "range"    in updates ? updates.range    : currentRange;
    if (clientId) params.set("clientId", clientId);
    if (range)    params.set("range", range);
    const qs = params.toString();
    router.push(`/admin/analytics${qs ? `?${qs}` : ""}`);
  }

  return (
    <div className="flex flex-wrap items-center gap-3">
      {/* Range pill group */}
      <div className="flex rounded-lg border border-border bg-surface p-0.5 gap-0.5">
        <button
          onClick={() => navigate({ range: undefined })}
          className={cn(
            "rounded-md px-3 py-1 text-xs font-medium transition-colors",
            !currentRange
              ? "bg-neon text-black"
              : "text-muted hover:text-foreground",
          )}
        >
          All time
        </button>
        {RANGE_OPTIONS.map((o) => (
          <button
            key={o.value}
            onClick={() => navigate({ range: o.value })}
            className={cn(
              "rounded-md px-3 py-1 text-xs font-medium transition-colors",
              currentRange === o.value
                ? "bg-neon text-black"
                : "text-muted hover:text-foreground",
            )}
          >
            {o.label}
          </button>
        ))}
      </div>

      {/* Client dropdown */}
      <select
        value={currentClientId ?? ""}
        onChange={(e) => navigate({ clientId: e.target.value || undefined })}
        className="rounded-lg border border-border bg-surface px-3 py-1.5 text-sm text-foreground focus:border-neon focus:outline-none"
      >
        <option value="">All clients</option>
        {clients.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
      </select>
    </div>
  );
}
