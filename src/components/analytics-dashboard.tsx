"use client";

import { useRouter } from "next/navigation";
import { cn } from "@/lib/utils";
import { RANGE_OPTIONS } from "@/lib/analytics-constants";
import { Badge, CardTitle, EmptyState } from "@/components/ui";
import { Icon } from "@/components/icon";
import { FEEDBACK_CATEGORY_LABEL } from "@/lib/client-agent-feedback";
import type { Client, ClientAgentFeedback, Feedback } from "@/lib/types";

interface Props {
  clients: Client[];
  currentClientId?: string;
  currentRange?: string;
  currentAgentKey?: string;
}

export function AnalyticsFilters({ clients, currentClientId, currentRange, currentAgentKey }: Props) {
  const router = useRouter();

  function navigate(updates: { clientId?: string; range?: string }) {
    const params = new URLSearchParams();
    const clientId = "clientId" in updates ? updates.clientId : currentClientId;
    const range    = "range"    in updates ? updates.range    : currentRange;
    if (clientId) params.set("clientId", clientId);
    if (range)    params.set("range", range);
    // Preserve the agent filter across range/client pill changes - only the
    // chip's own clear link drops it.
    if (currentAgentKey) params.set("agentKey", currentAgentKey);
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

/* ── Feedback table ──────────────────────────────────────────────── */

interface FeedbackTableProps {
  feedbacks: Feedback[];
  clients: Client[];
}

export function FeedbackTable({ feedbacks, clients }: FeedbackTableProps) {
  const clientMap = new Map(clients.map((c) => [c.id, c.name]));

  function downloadCSV() {
    function cell(v: string) {
      return `"${String(v).replace(/"/g, '""')}"`;
    }
    const header = ["Date", "Agent", "Client", "Scope", "Doc Type", "Role", "Feedback"]
      .map(cell)
      .join(",");
    const rows = feedbacks.map((f) =>
      [
        new Date(f.createdAt).toISOString(),
        f.agentId,
        clientMap.get(f.clientId) ?? f.clientId,
        f.scope === "single_doc" ? "Single Doc" : "Global",
        f.docType ?? "",
        f.creatorRole,
        f.feedbackText,
      ]
        .map(cell)
        .join(","),
    );
    const csv = "﻿" + [header, ...rows].join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `feedback-${new Date().toISOString().split("T")[0]}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  return (
    <>
      <div className="mb-4 flex items-center justify-between">
        <CardTitle>Agent feedback</CardTitle>
        {feedbacks.length > 0 && (
          <button
            onClick={downloadCSV}
            className="flex items-center gap-1.5 rounded-lg border border-border bg-surface px-3 py-1.5 text-xs font-medium text-muted transition-colors hover:border-neon hover:text-neon"
          >
            <Icon name="Download" className="h-3.5 w-3.5" />
            Download CSV
          </button>
        )}
      </div>

      {feedbacks.length === 0 ? (
        <EmptyState
          icon={<Icon name="MessageSquare" className="h-5 w-5" />}
          title="No feedback collected"
          description="Agent corrections submitted by staff and clients appear here."
        />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs text-muted">
                <th className="pb-2 pr-4 font-medium">Date</th>
                <th className="pb-2 pr-4 font-medium">Client</th>
                <th className="pb-2 pr-4 font-medium">Scope</th>
                <th className="pb-2 pr-4 font-medium">Doc Type</th>
                <th className="pb-2 pr-4 font-medium">Role</th>
                <th className="pb-2 font-medium">Feedback</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {feedbacks.map((f) => (
                <tr key={f.id} className="text-xs transition-colors hover:bg-surface-2/40">
                  <td className="py-2 pr-4 font-mono tabular-nums text-muted-2 whitespace-nowrap">
                    {new Date(f.createdAt).toISOString().slice(0, 16).replace("T", " ")}
                  </td>
                  <td className="py-2 pr-4">
                    {clientMap.get(f.clientId) ?? f.clientId}
                  </td>
                  <td className="py-2 pr-4">
                    <span
                      className={cn(
                        "inline-flex rounded-full px-2 py-0.5 text-[10px] font-medium",
                        f.scope === "global"
                          ? "bg-neon/10 text-neon"
                          : "bg-surface-2 text-muted",
                      )}
                    >
                      {f.scope === "single_doc" ? "Single doc" : "Global"}
                    </span>
                  </td>
                  <td className="py-2 pr-4 text-muted-2">{f.docType ?? "-"}</td>
                  <td className="py-2 pr-4 capitalize text-muted-2">{f.creatorRole}</td>
                  <td className="py-2 max-w-xs">
                    <p className="line-clamp-2">{f.feedbackText}</p>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

/* ── Agent feedback history table ────────────────────────────────────
   The two-level client-agent feedback (Phase 3, §5), NOT the table above -
   that one is the doc-correction `Feedback` collection consumed by the
   context-doc pipeline. This is the standing per-agent/per-template notes
   clients and staff leave on a live umbrella (client-agents/feedback-modal.tsx
   is where they're written), now surfaced here so the agency can see the
   whole history in one place instead of per-agent only. */

interface AgentFeedbackHistoryTableProps {
  rows: ClientAgentFeedback[];
  clients: Client[];
  /** clientAgentId → the umbrella's display name, resolved server-side. */
  agentNames: Record<string, string>;
}

export function AgentFeedbackHistoryTable({ rows, clients, agentNames }: AgentFeedbackHistoryTableProps) {
  const clientMap = new Map(clients.map((c) => [c.id, c.name]));

  function downloadCSV() {
    function cell(v: string) {
      return `"${String(v).replace(/"/g, '""')}"`;
    }
    const header = ["Date", "Client", "Agent", "Scope", "Category", "Status", "Role", "Feedback"]
      .map(cell)
      .join(",");
    const csvRows = rows.map((r) =>
      [
        new Date(r.createdAt).toISOString(),
        clientMap.get(r.clientId) ?? r.clientId,
        agentNames[r.clientAgentId] ?? r.clientAgentId,
        r.scope === "template" ? `Template (${r.templateKey ?? "?"})` : "Agent-wide",
        r.category ? FEEDBACK_CATEGORY_LABEL[r.category] : "",
        r.status,
        r.creatorRole,
        r.text,
      ]
        .map(cell)
        .join(","),
    );
    const csv = "﻿" + [header, ...csvRows].join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `agent-feedback-history-${new Date().toISOString().split("T")[0]}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  return (
    <>
      <div className="mb-4 flex items-center justify-between">
        <CardTitle>Agent feedback history</CardTitle>
        {rows.length > 0 && (
          <button
            onClick={downloadCSV}
            className="flex items-center gap-1.5 rounded-lg border border-border bg-surface px-3 py-1.5 text-xs font-medium text-muted transition-colors hover:border-neon hover:text-neon"
          >
            <Icon name="Download" className="h-3.5 w-3.5" />
            Download CSV
          </button>
        )}
      </div>

      {rows.length === 0 ? (
        <EmptyState
          icon={<Icon name="MessageSquare" className="h-5 w-5" />}
          title="No agent feedback yet"
          description="Notes clients and staff leave on a live agent - from its feedback panel or from Copilot chat - appear here."
        />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs text-muted">
                <th className="pb-2 pr-4 font-medium">Date</th>
                <th className="pb-2 pr-4 font-medium">Client</th>
                <th className="pb-2 pr-4 font-medium">Agent</th>
                <th className="pb-2 pr-4 font-medium">Scope</th>
                <th className="pb-2 pr-4 font-medium">Category</th>
                <th className="pb-2 pr-4 font-medium">Status</th>
                <th className="pb-2 font-medium">Feedback</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {rows.map((r) => (
                <tr key={r.id} className="text-xs transition-colors hover:bg-surface-2/40">
                  <td className="py-2 pr-4 font-mono tabular-nums text-muted-2 whitespace-nowrap">
                    {new Date(r.createdAt).toISOString().slice(0, 16).replace("T", " ")}
                  </td>
                  <td className="py-2 pr-4">{clientMap.get(r.clientId) ?? r.clientId}</td>
                  <td className="py-2 pr-4">{agentNames[r.clientAgentId] ?? r.clientAgentId}</td>
                  <td className="py-2 pr-4">
                    <span
                      className={cn(
                        "inline-flex rounded-full px-2 py-0.5 text-[10px] font-medium",
                        r.scope === "agent" ? "bg-neon/10 text-neon" : "bg-surface-2 text-muted",
                      )}
                    >
                      {r.scope === "agent" ? "Agent-wide" : (r.templateKey ?? "Template")}
                    </span>
                  </td>
                  <td className="py-2 pr-4 text-muted-2">
                    {r.category ? FEEDBACK_CATEGORY_LABEL[r.category] : "-"}
                  </td>
                  <td className="py-2 pr-4">
                    <Badge tone={r.status === "active" ? "success" : "neutral"}>
                      {r.status === "active" ? "Active" : r.status === "resolved" ? "Resolved" : "Withdrawn"}
                    </Badge>
                  </td>
                  <td className="py-2 max-w-xs">
                    <p className="line-clamp-2">{r.text}</p>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
