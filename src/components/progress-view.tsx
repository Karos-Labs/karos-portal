"use client";

import { useState } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { Icon } from "@/components/icon";
import { cn } from "@/lib/utils";
import { TasksBoard } from "@/components/tasks-board";
import {
  ActivityTimeline,
  type TimelineActivity,
  type TimelineJob,
} from "@/components/activity-timeline";
import { ArchiveView } from "@/components/archive-view";
import { QuickAddTaskBar } from "@/components/quick-add-task-bar";
import type { Asset, ClientReport, ClientTask, Role, TaskOwner } from "@/lib/types";

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
  agentLabelByAssetId,
}: {
  tasks: ClientTask[];
  currentUserRole: Role;
  clientId: string;
  /**
   * Projected and redacted per viewer role (see TasksBody) — never whole
   * ActivityLog docs, whose stored actor names and staff notes would then be
   * in the payload for a client to read.
   */
  activityLogs: TimelineActivity[];
  /** Projected to the five fields the timeline renders — never whole Job docs. */
  jobs: TimelineJob[];
  report: ClientReport | null;
  /** Pre-redacted per viewer role (see TasksBody) — feeds the Archive tab. */
  assets: Asset[];
  /**
   * assetId → the ONE name its archive group may carry, resolved server-side
   * through the §7.3 identity helper (F147). This used to be a jobId →
   * job.agentName map built right here, which made the archive a second
   * answer to "who made this" — and the one that still printed the
   * managed-product label next to the umbrella's own name.
   */
  agentLabelByAssetId: Record<string, string>;
}) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  // Seeded from the URL so a deep link lands on the right tab; kept in local
  // state (and written back with the native history API rather than
  // router.replace) so switching tabs doesn't re-run this force-dynamic route's
  // server data fetches on every click.
  const [view, setView] = useState<View>(() => parseView(searchParams.get("tab")));
  /**
   * The owner the router sent the last added task to, and a nonce that changes
   * on every add. The quick-add bar and the board are siblings here, so this is
   * the join between them: without it the board never learned the verdict, the
   * bar's `onAdded` had no caller in any render, and a task routed to Automated
   * while the client sat on "Depending on you" was announced by name and
   * rendered nowhere.
   *
   * A COUNTER, not the owner alone: two adds that route the same way must both
   * reveal, and `{ owner }` on its own is a value that does not change.
   */
  const [revealOwner, setRevealOwner] = useState<{ owner: TaskOwner; nonce: number } | null>(null);

  // Same-route navigation (the client rail's "Workspace" link, or a bell row
  // pointing at ?tab=archive, clicked while already on /tasks) re-renders this
  // component instead of remounting it, so the tab has to follow the URL or it
  // silently desyncs from the address bar (F97 watch-item, folded in with F64).
  const tabParam = searchParams.get("tab");
  const [prevTabParam, setPrevTabParam] = useState(tabParam);
  if (prevTabParam !== tabParam) {
    setPrevTabParam(tabParam);
    setView(parseView(tabParam));
  }

  function selectView(next: View) {
    setView(next);
    const params = new URLSearchParams(searchParams.toString());
    if (next === "board") params.delete("tab");
    else params.set("tab", next);
    const query = params.toString();
    window.history.replaceState(null, "", query ? `${pathname}?${query}` : pathname);
  }

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
            <QuickAddTaskBar
              clientId={clientId}
              onAdded={(owner) =>
                setRevealOwner((prev) => ({ owner, nonce: (prev?.nonce ?? 0) + 1 }))
              }
            />
          </div>
          <TasksBoard
            tasks={tasks}
            currentUserRole={currentUserRole}
            clientId={clientId}
            revealOwner={revealOwner}
          />
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
        <ArchiveView
          assets={assets}
          agentLabelByAssetId={agentLabelByAssetId}
          viewerIsClient={currentUserRole === "CLIENT_USER"}
        />
      )}
    </>
  );
}
