"use client";

import { useState } from "react";
import { Icon } from "@/components/icon";
import { cn } from "@/lib/utils";
import { TasksBoard } from "@/components/tasks-board";
import { ActivityTimeline } from "@/components/activity-timeline";
import { QuickAddTaskBar } from "@/components/quick-add-task-bar";
import type { ActivityLog, ClientReport, ClientTask, Job, Role } from "@/lib/types";

type View = "board" | "activity";

/**
 * Client-facing Progress view — merges the task board (what's next) with the
 * activity timeline (what's done) behind a single segmented toggle.
 */
export function ProgressView({
  tasks,
  currentUserRole,
  clientId,
  autopilotEnabled,
  activityLogs,
  jobs,
  report,
}: {
  tasks: ClientTask[];
  currentUserRole: Role;
  clientId: string;
  autopilotEnabled: boolean;
  activityLogs: ActivityLog[];
  jobs: Job[];
  report: ClientReport | null;
}) {
  const [view, setView] = useState<View>("board");

  return (
    <>
      {/* Segmented toggle */}
      <div className="mb-5 inline-flex items-center gap-1 rounded-lg border border-border bg-surface-2 p-1">
        {(
          [
            { id: "board", label: "Board", icon: "ListChecks" },
            { id: "activity", label: "Activity", icon: "History" },
          ] as { id: View; label: string; icon: string }[]
        ).map((tab) => (
          <button
            key={tab.id}
            onClick={() => setView(tab.id)}
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
          <TasksBoard
            tasks={tasks}
            currentUserRole={currentUserRole}
            clientId={clientId}
            autopilotEnabled={autopilotEnabled}
          />
        </>
      ) : (
        <ActivityTimeline
          activityLogs={activityLogs}
          jobs={jobs}
          report={report}
          clientId={clientId}
          currentUserRole={currentUserRole}
        />
      )}
    </>
  );
}
