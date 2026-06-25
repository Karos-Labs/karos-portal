"use client";

import { useState, useMemo } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Card, Badge, EmptyState } from "@/components/ui";
import { Icon } from "@/components/icon";
import { archiveTranscriptAction, unarchiveTranscriptAction } from "@/lib/actions";
import { relativeTime } from "@/lib/utils";
import type { AppUser, Client, Role, Transcript } from "@/lib/types";

/* ── Types ───────────────────────────────────────────────────────── */

interface Props {
  transcripts: Transcript[];
  clients: Client[];
  users: AppUser[];
  currentUserRole: Role;
  currentClientId?: string | null;
}

type Tab = "active" | "archived";
type Timeframe = "all" | "7d" | "30d" | "90d";

const TIMEFRAME_LABELS: Record<Timeframe, string> = {
  all: "All time",
  "7d": "Last 7 days",
  "30d": "Last 30 days",
  "90d": "Last 90 days",
};

const TIMEFRAME_MS: Record<Exclude<Timeframe, "all">, number> = {
  "7d": 7 * 86_400_000,
  "30d": 30 * 86_400_000,
  "90d": 90 * 86_400_000,
};

/* ── Main component ──────────────────────────────────────────────── */

export function MeetingsClient({ transcripts, clients, users, currentUserRole, currentClientId }: Props) {
  const isStaff = currentUserRole !== "client";
  const [tab, setTab] = useState<Tab>("active");
  const [timeframe, setTimeframe] = useState<Timeframe>("all");
  const [clientFilter, setClientFilter] = useState<string>("");

  const clientName = (id?: string | null) => clients.find((c) => c.id === id)?.name;

  const filtered = useMemo(() => {
    const now = Date.now();
    return transcripts.filter((t) => {
      // Tab
      if (tab === "active" && t.archived) return false;
      if (tab === "archived" && !t.archived) return false;
      // Timeframe
      if (timeframe !== "all") {
        const date = t.meetingDate ?? t.createdAt;
        if (date < now - TIMEFRAME_MS[timeframe]) return false;
      }
      // Client filter — client role: always scoped to own client
      if (!isStaff) {
        if (currentClientId && t.clientId !== currentClientId) return false;
      } else if (clientFilter === "__karos__") {
        if (!t.isKarosInternal) return false;
      } else if (clientFilter === "__unassigned__") {
        if (t.clientId || t.isKarosInternal) return false;
      } else if (clientFilter) {
        if (t.clientId !== clientFilter) return false;
      }
      return true;
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [transcripts, tab, timeframe, clientFilter, isStaff, currentClientId]);

  const activeCount = transcripts.filter((t) => !t.archived).length;
  const archivedCount = transcripts.filter((t) => t.archived).length;

  return (
    <div className="w-full min-w-0 space-y-5">
      {/* Tabs */}
      <div className="flex items-center gap-1 border-b border-border">
        {(["active", "archived"] as Tab[]).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`flex items-center gap-1.5 border-b-2 px-4 py-2.5 text-sm font-medium transition-colors ${
              tab === t
                ? "border-neon text-neon"
                : "border-transparent text-muted hover:text-foreground"
            }`}
          >
            {t === "active" ? "Active" : "Archived"}
            <span
              className={`rounded-full px-1.5 py-0.5 text-[10px] font-semibold ${
                tab === t ? "bg-neon/20 text-neon" : "bg-surface-3 text-muted-2"
              }`}
            >
              {t === "active" ? activeCount : archivedCount}
            </span>
          </button>
        ))}
      </div>

      {/* Filters — staff only */}
      {isStaff && (
        <div className="flex flex-wrap items-center gap-2">
          {/* Timeframe */}
          <div className="flex items-center gap-1.5">
            <Icon name="CalendarDays" className="h-3.5 w-3.5 text-muted" />
            <select
              value={timeframe}
              onChange={(e) => setTimeframe(e.target.value as Timeframe)}
              className="h-8 rounded-[8px] border border-border bg-surface-2 px-2.5 text-xs text-foreground outline-none focus:border-neon/50"
            >
              {(Object.keys(TIMEFRAME_LABELS) as Timeframe[]).map((k) => (
                <option key={k} value={k}>{TIMEFRAME_LABELS[k]}</option>
              ))}
            </select>
          </div>

          {/* Client filter */}
          <div className="flex items-center gap-1.5">
            <Icon name="Building2" className="h-3.5 w-3.5 text-muted" />
            <select
              value={clientFilter}
              onChange={(e) => setClientFilter(e.target.value)}
              className="h-8 rounded-[8px] border border-border bg-surface-2 px-2.5 text-xs text-foreground outline-none focus:border-neon/50"
            >
              <option value="">All</option>
              <option value="__karos__">Karos Labs Internal</option>
              <option value="__unassigned__">Unassigned</option>
              {clients.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          </div>

          {/* Active filter chips */}
          {(timeframe !== "all" || clientFilter) && (
            <button
              onClick={() => { setTimeframe("all"); setClientFilter(""); }}
              className="flex h-8 items-center gap-1 rounded-[8px] border border-border px-2.5 text-xs text-muted hover:border-neon/40 hover:text-foreground"
            >
              <Icon name="X" className="h-3 w-3" /> Clear filters
            </button>
          )}
        </div>
      )}

      {/* List */}
      {filtered.length === 0 ? (
        <EmptyState
          icon={<Icon name={tab === "archived" ? "Archive" : "Mic"} className="h-7 w-7" />}
          title={tab === "archived" ? "No archived meetings" : "No meetings"}
          description={
            tab === "archived"
              ? "Meetings move here when all action items are completed or manually archived."
              : "Meetings appear here once synced or imported."
          }
        />
      ) : (
        <div className="space-y-3">
          {filtered.map((t) => (
            <MeetingRow
              key={t.id}
              transcript={t}
              isStaff={isStaff}
              clientName={t.isKarosInternal ? "Karos Labs Internal" : clientName(t.clientId)}
              isArchived={!!t.archived}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/* ── Meeting row card ────────────────────────────────────────────── */

function MeetingRow({
  transcript: t,
  isStaff,
  clientName,
  isArchived,
}: {
  transcript: Transcript;
  isStaff: boolean;
  clientName?: string;
  isArchived: boolean;
}) {
  const router = useRouter();
  const [archiving, setArchiving] = useState(false);

  const total = t.actionItems?.length ?? 0;
  const done = t.completedItems?.length ?? 0;
  const progress = total > 0 ? Math.round((done / total) * 100) : null;

  async function handleArchiveToggle(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    setArchiving(true);
    try {
      if (isArchived) await unarchiveTranscriptAction(t.id);
      else await archiveTranscriptAction(t.id);
      router.refresh();
    } finally {
      setArchiving(false);
    }
  }

  return (
    <Card className="flex min-w-0 flex-wrap items-start justify-between gap-3">
      <Link href={`/transcripts/${t.id}`} className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <p className="truncate font-medium">{t.title}</p>
          {t.isKarosInternal && <Badge tone="neutral">Karos Labs</Badge>}
          {!t.isKarosInternal && t.assignment === "auto" && <Badge tone="neon">Auto-matched</Badge>}
          {!t.isKarosInternal && t.assignment === "unassigned" && <Badge tone="warning">Unassigned</Badge>}
          {t.source === "fireflies" && <Badge tone="neutral">Fireflies</Badge>}
          {t.contextDocSignalAt && <Badge tone="neon">Intel</Badge>}
          {isArchived && <Badge tone="neutral">Archived</Badge>}
          {isStaff && t.hiddenFromClient && (
            <span className="flex items-center gap-1 rounded-full border border-warning/30 bg-warning/10 px-2 py-0.5 text-[10px] text-warning">
              <Icon name="EyeOff" className="h-2.5 w-2.5" />
              Hidden
            </span>
          )}
        </div>
        <p className="mt-1 line-clamp-2 text-sm text-muted">{t.summary || "Processing summary…"}</p>
        <div className="mt-1 flex flex-wrap items-center gap-3 text-xs text-muted-2">
          <span>{relativeTime(t.meetingDate ?? t.createdAt)}</span>
          {t.participants.length > 0 && <span>{t.participants.length} participants</span>}
          {isStaff && clientName && <span>{clientName}</span>}
          {progress !== null && (
            <span className={progress === 100 ? "text-neon" : ""}>
              {done}/{total} done
            </span>
          )}
        </div>
        {/* Progress bar for action items */}
        {total > 0 && (
          <div className="mt-2 h-1 w-full max-w-[200px] overflow-hidden rounded-full bg-surface-3">
            <div
              className="h-full rounded-full bg-neon transition-all"
              style={{ width: `${progress}%` }}
            />
          </div>
        )}
      </Link>

      {/* Archive / Unarchive button — staff only */}
      {isStaff && (
        <button
          onClick={handleArchiveToggle}
          disabled={archiving}
          title={isArchived ? "Unarchive" : "Archive meeting"}
          className="flex h-8 shrink-0 items-center gap-1.5 rounded-[8px] border border-border px-2.5 text-xs text-muted transition-colors hover:border-neon/40 hover:text-foreground disabled:opacity-50"
        >
          <Icon
            name={archiving ? "Loader" : isArchived ? "ArchiveRestore" : "Archive"}
            className={cn("h-3.5 w-3.5", archiving && "animate-spin")}
          />
          {isArchived ? "Unarchive" : "Archive"}
        </button>
      )}
    </Card>
  );
}

function cn(...classes: (string | false | undefined | null)[]): string {
  return classes.filter(Boolean).join(" ");
}
