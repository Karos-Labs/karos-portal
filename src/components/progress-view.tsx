"use client";

import { useState } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { Icon } from "@/components/icon";
import { cn } from "@/lib/utils";
import { TasksBoard } from "@/components/tasks-board";
import { ActivityTimeline } from "@/components/activity-timeline";
import { ArchiveView } from "@/components/archive-view";
import { QuickAddTaskBar } from "@/components/quick-add-task-bar";
import type { ActivityLog, Asset, ClientReport, ClientTask, Job, Role } from "@/lib/types";

const VIEWS = ["board", "activity", "archive"] as const;
type View = (typeof VIEWS)[number];

function parseView(value: string | null): View {
  return VIEWS.includes(value as View) ? (value as View) : "board";
}

/**
 * Client-facing Workspace view — the task board (what's next), the activity
 * timeline (what happened), and the per-agent archive (everything delivered)
 * behind a single segmented toggle.
 *
 * The active tab lives in the `?tab=` search param so other surfaces can deep
 * link into it (the client dashboard's "in review" row points at
 * /tasks?tab=archive). It used to be component-local state, which meant no link
 * could ever open anything but the board.
 */
export function ProgressView({
  tasks,
  currentUserRole,
  clientId,
  activityLogs,
  jobs,
  report,
  assets,
}: {
  tasks: ClientTask[];
  currentUserRole: Role;
  clientId: string;
  activityLogs: ActivityLog[];
  jobs: Job[];
  report: ClientReport | null;
  /** Pre-redacted per viewer role (see TasksBody) — feeds the Archive tab. */
  assets: Asset[];
}) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  // Seeded from the URL so a deep link lands on the right tab; kept in local
  // state (and written back with the native history API rather than
  // router.replace) so switching tabs doesn't re-run this force-dynamic route's
  // server data fetches on every click.
  const [view, setView] = useState<View>(() => parseView(searchParams.get("tab")));

  function selectView(next: View) {
    setView(next);
    const params = new URLSearchParams(searchParams.toString());
    if (next === "board") params.delete("tab");
    else params.set("tab", next);
    const query = params.toString();
    window.history.replaceState(null, "", query ? `${pathname}?${query}` : pathname);
  }

  const agentNameByJobId = Object.fromEntries(jobs.map((j) => [j.id, j.agentName]));

  return (
    <>
      {/* Segmented toggle */}
      <div className="mb-5 inline-flex items-center gap-1 rounded-lg border border-border bg-surface-2 p-1">
        {(
          [
            { id: "board", label: "Board", icon: "ListChecks" },
            { id: "activity", label: "Activity", icon: "History" },
            { id: "archive", label: "Archive", icon: "Archive" },
          ] as { id: View; label: string; icon: string }[]
        ).map((tab) => (
          <button
            key={tab.id}
            onClick={() => selectView(tab.id)}
            className={cn(
              "flex items-center justify-center gap-2 rounded-md px-4 py-2 text-sm font-medium transition-all duration-150",
              view === tab.id
                ? "bg-surface shadow-[0_1px_4px_rgba(0,0,0,0.3)] text-foreground"
                : "text-muted hover:text-foreground",
            )}
          >
            <Icon name={tab.icon} className="h-3.5 w-3.5" />
            {tab.label}
          </button>
        ))}
      </div>

      {view === "board" ? (
        <>
          <div className="mb-4">
            <QuickAddTaskBar clientId={clientId} />
          </div>
          <TasksBoard tasks={tasks} currentUserRole={currentUserRole} clientId={clientId} />
        </>
      ) : view === "activity" ? (
        <ActivityTimeline
          activityLogs={activityLogs}
          jobs={jobs}
          report={report}
          clientId={clientId}
          currentUserRole={currentUserRole}
        />
      ) : (
        <ArchiveView assets={assets} agentNameByJobId={agentNameByJobId} />
      )}
    </>
  );
}
