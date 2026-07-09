"use client";

import { useState, useTransition, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import { Icon } from "@/components/icon";
import { Badge } from "@/components/ui";
import { cn, relativeTime } from "@/lib/utils";
import {
  updateTaskStatusAction,
  deleteTaskAction,
  updateAutopilotAction,
  startTaskExecutionAction,
} from "@/lib/actions";
import { TaskTicketModal } from "@/components/task-ticket-modal";
import type { ClientTask, TaskOwner, TaskStatus, TaskSource, Role } from "@/lib/types";

/* ── Constants ───────────────────────────────────────────────────── */

/* Sources are categories, not judgments — they all render neutral. The label
   and icon carry the meaning; color is reserved for the good/bad scale. */
const SOURCE_META: Record<TaskSource, { label: string; icon: string; color: string }> = {
  gmail:               { label: "Operational Intel", icon: "Globe",      color: "#9c9ca3" },
  competitor_research: { label: "Competitor",        icon: "TrendingUp", color: "#9c9ca3" },
  brand_audit:         { label: "Brand Audit",       icon: "Search",     color: "#9c9ca3" },
  content_dispatch:    { label: "Content",           icon: "Zap",        color: "#9c9ca3" },
  copilot:             { label: "AI Copilot",        icon: "Bot",        color: "#9c9ca3" },
  manual:              { label: "Manual",            icon: "PenLine",    color: "#9c9ca3" },
  custom:              { label: "Quick Add",         icon: "Plus",       color: "#9c9ca3" },
};

const PRIORITY_BADGE: Record<string, { tone: "danger" | "warning" | "neon" | "neutral" }> = {
  high:   { tone: "danger"  },
  medium: { tone: "warning" },
  low:    { tone: "neutral" },
};

const COLUMNS: { status: TaskStatus; label: string; icon: string }[] = [
  { status: "pending",        label: "Pending",        icon: "Circle"      },
  { status: "in_progress",    label: "In Progress",    icon: "Clock"       },
  { status: "review_pending", label: "Review Pending", icon: "Eye"         },
  { status: "completed",      label: "Completed",      icon: "CheckCircle" },
];

/** Infer the owner from task source when the owner field is absent (backward compat). */
function inferOwner(task: ClientTask): TaskOwner {
  if (task.owner) return task.owner;
  return task.source === "manual" ? "client_managed" : "karos_managed";
}

function nextStatusFor(current: TaskStatus): TaskStatus {
  switch (current) {
    case "pending":        return "in_progress";
    case "in_progress":    return "review_pending";
    case "review_pending": return "completed";
    case "completed":      return "pending";
  }
}

/* ── Autopilot toggle ────────────────────────────────────────────── */

function AutopilotToggle({ clientId, enabled }: { clientId: string; enabled: boolean }) {
  const [isOn, setIsOn] = useState(enabled);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function toggle() {
    const next = !isOn;
    setIsOn(next);
    setError(null);
    startTransition(async () => {
      const res = await updateAutopilotAction(clientId, next);
      if (!res.ok) {
        setIsOn(!next);
        setError(res.error ?? "Could not update Autopilot");
      }
    });
  }

  return (
    <div className="flex items-center gap-3 rounded-md border border-border bg-surface-2 px-4 py-3">
      <div
        className={cn(
          "flex h-8 w-8 shrink-0 items-center justify-center rounded-md transition-colors",
          isOn ? "bg-success/10 text-success" : "bg-surface-3 text-muted",
        )}
      >
        <Icon name="Zap" className="h-4 w-4" />
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-semibold text-foreground">Autopilot Mode</p>
        <p className="text-xs text-muted truncate">
          {isOn
            ? "Karos AI is executing pending tasks automatically"
            : "Tasks are queued. Toggle on to execute automatically"}
        </p>
        {error && <p className="mt-0.5 text-xs text-danger">{error}</p>}
      </div>
      <button
        onClick={toggle}
        disabled={isPending}
        aria-checked={isOn}
        role="switch"
        className={cn(
          "relative inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent transition-colors duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-foreground/25 disabled:opacity-50",
          isOn ? "bg-success" : "bg-surface-3",
        )}
      >
        <span
          className={cn(
            "pointer-events-none inline-block h-5 w-5 transform rounded-full bg-primary shadow-md transition-transform duration-200",
            isOn ? "translate-x-5" : "translate-x-0",
          )}
        />
      </button>
    </div>
  );
}

/* ── Task card ───────────────────────────────────────────────────── */

interface TaskCardProps {
  task: ClientTask & { _clientName?: string };
  canDelete: boolean;
  showClientName?: boolean;
  draggable?: boolean;
  isDragging?: boolean;
  onStatusChange: (id: string, status: TaskStatus, clientId: string) => void;
  onDelete: (id: string, clientId: string) => void;
  onClick: () => void;
  onDragStart?: (e: React.DragEvent) => void;
  onDragEnd?: () => void;
}

function TaskCard({
  task,
  canDelete,
  showClientName,
  draggable: isDraggable = false,
  isDragging = false,
  onStatusChange,
  onDelete,
  onClick,
  onDragStart,
  onDragEnd,
}: TaskCardProps) {
  const src = SOURCE_META[task.source] ?? SOURCE_META.manual;
  const prio = PRIORITY_BADGE[task.priority] ?? { tone: "neutral" as const };
  const isExecuting = task.metadata?.executing === true;
  const hasError = Boolean(task.metadata?.executionError);
  const nextStatus = nextStatusFor(task.status);
  const isReviewPending = task.status === "review_pending";

  return (
    <div
      draggable={isDraggable && !isExecuting}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onClick={onClick}
      className={cn(
        "group relative rounded-md border bg-surface p-3.5 transition-all duration-150 cursor-pointer",
        task.status === "completed"
          ? "border-border opacity-60"
          : isReviewPending
            ? "border-warning/40 bg-warning/[0.03] hover:border-warning/60"
            : "border-border hover:border-border-strong hover:shadow-[0_2px_12px_rgba(0,0,0,0.25)]",
        isDraggable && !isDragging && "cursor-grab active:cursor-grabbing",
        isDragging && "opacity-40 cursor-grabbing ring-2 ring-foreground/25",
        isExecuting && "animate-pulse",
      )}
    >
      {/* Executing overlay banner */}
      {isExecuting && (
        <div className="mb-2 flex items-center gap-1.5 rounded-[6px] bg-neon/10 px-2 py-1">
          <Icon name="Loader" className="h-3 w-3 animate-spin text-neon" />
          <span className="text-[10px] font-medium text-neon">AI Working…</span>
        </div>
      )}

      {/* Error badge */}
      {hasError && !isExecuting && (
        <div className="mb-2 flex items-center gap-1.5 rounded-[6px] bg-danger/10 px-2 py-1">
          <Icon name="AlertTriangle" className="h-3 w-3 text-danger" />
          <span className="text-[10px] font-medium text-danger">Execution failed. Click to retry</span>
        </div>
      )}

      {/* Review pending badge */}
      {isReviewPending && !isExecuting && (
        <div className="mb-2 flex items-center gap-1.5 rounded-[6px] bg-warning/10 px-2 py-1">
          <Icon name="Eye" className="h-3 w-3 text-warning" />
          <span className="text-[10px] font-medium text-warning">Ready for review</span>
        </div>
      )}

      {/* Source badge + priority */}
      <div className="mb-2 flex items-center gap-2">
        <span
          className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium"
          style={{ background: src.color + "1f", color: src.color }}
        >
          <Icon name={src.icon} className="h-2.5 w-2.5" />
          {src.label}
        </span>
        <Badge tone={prio.tone} className="text-[9px] px-1.5 py-0">
          {task.priority}
        </Badge>
        {showClientName && task._clientName && (
          <span className="ml-auto text-[10px] text-muted-2 truncate max-w-[100px]">
            {task._clientName}
          </span>
        )}
      </div>

      {/* Title */}
      <p
        className={cn(
          "text-sm font-medium text-foreground leading-snug",
          task.status === "completed" && "line-through text-muted",
        )}
      >
        {task.title}
      </p>

      {/* Description preview */}
      {task.description && (
        <p className="mt-1 text-xs text-muted line-clamp-2 leading-relaxed">
          {task.description}
        </p>
      )}

      {/* Footer */}
      <div className="mt-3 flex items-center justify-between gap-2">
        <span className="text-[10px] text-muted-2">{relativeTime(task.createdAt)}</span>
        <div
          className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity"
          onClick={(e) => e.stopPropagation()}
        >
          {/* Don't show status advance button for review_pending (use modal instead) */}
          {!isReviewPending && !isExecuting && (
            <button
              onClick={() => onStatusChange(task.id, nextStatus, task.clientId)}
              className="flex h-6 px-1.5 items-center gap-1 rounded-[6px] text-[10px] text-muted hover:bg-surface-2 hover:text-foreground transition-colors"
              title={`Move to ${nextStatus.replace(/_/g, " ")}`}
            >
              <Icon
                name={
                  nextStatus === "completed"
                    ? "Check"
                    : nextStatus === "in_progress"
                      ? "Play"
                      : nextStatus === "review_pending"
                        ? "Eye"
                        : "RotateCcw"
                }
                className="h-3 w-3"
              />
              {nextStatus.replace(/_/g, " ")}
            </button>
          )}
          {canDelete && (
            <button
              onClick={() => onDelete(task.id, task.clientId)}
              className="flex h-6 w-6 items-center justify-center rounded-[6px] text-muted hover:bg-danger/10 hover:text-danger transition-colors"
              title="Delete task"
            >
              <Icon name="Trash2" className="h-3 w-3" />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/* ── Kanban column ───────────────────────────────────────────────── */

function KanbanColumn({
  status,
  label,
  icon,
  tasks,
  canDelete,
  showClientName,
  enableDnD,
  draggingId,
  dropTarget,
  onStatusChange,
  onDelete,
  onCardClick,
  onDragStart,
  onDragEnd,
  onDragOver,
  onDrop,
}: {
  status: TaskStatus;
  label: string;
  icon: string;
  tasks: (ClientTask & { _clientName?: string })[];
  canDelete: boolean;
  showClientName?: boolean;
  enableDnD: boolean;
  draggingId: string | null;
  dropTarget: TaskStatus | null;
  onStatusChange: (id: string, s: TaskStatus, clientId: string) => void;
  onDelete: (id: string, clientId: string) => void;
  onCardClick: (id: string) => void;
  onDragStart: (e: React.DragEvent, task: ClientTask) => void;
  onDragEnd: () => void;
  onDragOver: (e: React.DragEvent, status: TaskStatus) => void;
  onDrop: (e: React.DragEvent, status: TaskStatus) => void;
}) {
  const isTarget = dropTarget === status;

  return (
    <div
      className="flex flex-col gap-3"
      onDragOver={enableDnD ? (e) => onDragOver(e, status) : undefined}
      onDrop={enableDnD ? (e) => onDrop(e, status) : undefined}
    >
      {/* Column header */}
      <div
        className={cn(
          "flex items-center gap-2 rounded-md px-1 py-0.5 transition-colors",
          isTarget && "bg-foreground/[0.04]",
        )}
      >
        <Icon
          name={icon}
          className={cn(
            "h-4 w-4",
            status === "completed"      ? "text-success"
            : status === "review_pending" ? "text-warning"
            : status === "in_progress"    ? "text-warning"
            : "text-muted",
          )}
        />
        <span className="text-sm font-semibold text-foreground">{label}</span>
        <span className="ml-auto rounded-full bg-surface-2 px-2 py-0.5 text-[11px] font-medium text-muted">
          {tasks.length}
        </span>
      </div>

      {/* Drop zone + cards */}
      <div
        className={cn(
          "flex flex-col gap-2 min-h-[80px] rounded-md transition-all duration-150",
          isTarget && "bg-foreground/[0.04] ring-2 ring-foreground/20 p-2",
        )}
      >
        {tasks.length === 0 ? (
          <div
            className={cn(
              "rounded-md border border-dashed py-8 text-center transition-colors",
              isTarget ? "border-foreground/30" : "border-border",
            )}
          >
            <p className="text-xs text-muted-2">
              {isTarget ? "Drop here" : `No ${label.toLowerCase()} tasks`}
            </p>
          </div>
        ) : (
          tasks.map((task) => (
            <TaskCard
              key={task.id}
              task={task}
              canDelete={canDelete}
              showClientName={showClientName}
              draggable={enableDnD}
              isDragging={draggingId === task.id}
              onStatusChange={onStatusChange}
              onDelete={onDelete}
              onClick={() => onCardClick(task.id)}
              onDragStart={(e) => onDragStart(e, task)}
              onDragEnd={onDragEnd}
            />
          ))
        )}
      </div>
    </div>
  );
}

/* ── Main board ──────────────────────────────────────────────────── */

interface Props {
  tasks: (ClientTask & { _clientName?: string })[];
  currentUserRole: Role;
  showClientName?: boolean;
  clientId?: string;
  autopilotEnabled?: boolean;
}

export function TasksBoard({
  tasks,
  currentUserRole,
  showClientName = false,
  clientId,
  autopilotEnabled = false,
}: Props) {
  const router = useRouter();
  const [localTasks, setLocalTasks] = useState(tasks);
  const [activeTab, setActiveTab] = useState<"karos" | "client">("karos");
  const [execError, setExecError] = useState<string | null>(null);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<TaskStatus | null>(null);
  const [, startTransition] = useTransition();

  const canDelete =
    currentUserRole === "KAROS_ADMIN" || currentUserRole === "KAROS_EMPLOYEE";

  // Sync local state when the server re-fetches tasks (e.g., after router.refresh()).
  // Uses the "store previous prop" pattern (react.dev/learn/you-might-not-need-an-effect)
  // to avoid calling setState inside a useEffect body, which triggers cascading renders.
  const [prevTasksProp, setPrevTasksProp] = useState(tasks);
  if (prevTasksProp !== tasks) {
    setPrevTasksProp(tasks);
    setLocalTasks(tasks);
  }

  const karosTasks = localTasks.filter((t) => inferOwner(t) === "karos_managed");
  const clientTasks = localTasks.filter((t) => inferOwner(t) === "client_managed");
  const visibleTasks = activeTab === "karos" ? karosTasks : clientTasks;
  const selectedTask = selectedTaskId
    ? localTasks.find((t) => t.id === selectedTaskId) ?? null
    : null;

  // Poll while any tasks are executing — triggers router.refresh() every 4s
  const hasExecuting = localTasks.some((t) => t.metadata?.executing === true);
  const stableRefresh = useCallback(() => router.refresh(), [router]);
  useEffect(() => {
    if (!hasExecuting) return;
    const id = setInterval(stableRefresh, 4000);
    return () => clearInterval(id);
  }, [hasExecuting, stableRefresh]);

  /* Status change handler — detects karos execution path.
     Moving any karos_managed task into In Progress (drag, card button, or
     modal footer) triggers its mapped ecosystem agent. */
  function handleStatusChange(id: string, status: TaskStatus, cid: string) {
    const task = localTasks.find((t) => t.id === id);
    const isKarosExecution =
      status === "in_progress" &&
      task &&
      inferOwner(task) === "karos_managed" &&
      task.status === "pending";

    if (isKarosExecution) {
      // Optimistic: mark as in_progress + executing immediately
      setLocalTasks((prev) =>
        prev.map((t) =>
          t.id === id
            ? { ...t, status: "in_progress", metadata: { ...(t.metadata ?? {}), executing: true } }
            : t,
        ),
      );
      setExecError(null);
      startTransition(async () => {
        const res = await startTaskExecutionAction(id, cid);
        if (!res.ok) {
          // Revert the optimistic in_progress flip and show why (e.g. credits).
          setLocalTasks((prev) =>
            prev.map((t) =>
              t.id === id
                ? { ...t, status: "pending", metadata: { ...(t.metadata ?? {}), executing: false } }
                : t,
            ),
          );
          setExecError(res.error ?? "Could not start the task");
        }
        // Refresh layout so notification bell reflects updated task counts.
        router.refresh();
      });
    } else {
      setLocalTasks((prev) =>
        prev.map((t) =>
          t.id === id
            ? { ...t, status, completedAt: status === "completed" ? Date.now() : null }
            : t,
        ),
      );
      startTransition(async () => {
        await updateTaskStatusAction(id, status, cid);
        // Refresh layout so notification bell reflects updated task counts.
        router.refresh();
      });
    }
  }

  function handleDelete(id: string, cid: string) {
    setLocalTasks((prev) => prev.filter((t) => t.id !== id));
    startTransition(async () => {
      await deleteTaskAction(id, cid);
      router.refresh();
    });
  }

  /* DnD handlers (client tab only) */
  function handleDragStart(e: React.DragEvent, task: ClientTask) {
    setDraggingId(task.id);
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("taskId", task.id);
  }

  function handleDragEnd() {
    setDraggingId(null);
    setDropTarget(null);
  }

  function handleDragOver(e: React.DragEvent, status: TaskStatus) {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setDropTarget(status);
  }

  function handleDrop(e: React.DragEvent, targetStatus: TaskStatus) {
    e.preventDefault();
    const taskId = e.dataTransfer.getData("taskId");
    const task = localTasks.find((t) => t.id === taskId);
    if (task && task.status !== targetStatus) {
      handleStatusChange(taskId, targetStatus, task.clientId);
    }
    setDraggingId(null);
    setDropTarget(null);
  }

  if (localTasks.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center rounded-[var(--radius)] border border-dashed border-border py-20 text-center">
        <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-full border border-foreground/10 bg-foreground/[0.04] text-foreground/70">
          <Icon name="CheckSquare" className="h-6 w-6" />
        </div>
        <p className="text-sm font-medium text-foreground">No tasks yet</p>
        <p className="mt-1 max-w-sm text-sm text-muted">
          Tasks appear here when the AI Copilot analyzes your market footprint, researches competitors, or runs an audit.
          Open the chatbot to get started.
        </p>
      </div>
    );
  }

  return (
    <>
      {/* Tab switcher */}
      <div className="mb-5 flex items-center gap-1 rounded-md border border-border bg-surface-2 p-1">
        <button
          onClick={() => setActiveTab("karos")}
          className={cn(
            "flex flex-1 items-center justify-center gap-2 rounded-md px-4 py-2 text-sm font-medium transition-all duration-150",
            activeTab === "karos"
              ? "bg-surface shadow-[0_1px_4px_rgba(0,0,0,0.3)] text-foreground"
              : "text-muted hover:text-foreground",
          )}
        >
          <Icon name="Sparkles" className="h-3.5 w-3.5" />
          Karos Managed
          <span className="rounded-full bg-surface-3 px-1.5 py-0.5 text-[10px] font-semibold text-muted">
            {karosTasks.length}
          </span>
        </button>
        <button
          onClick={() => setActiveTab("client")}
          className={cn(
            "flex flex-1 items-center justify-center gap-2 rounded-md px-4 py-2 text-sm font-medium transition-all duration-150",
            activeTab === "client"
              ? "bg-surface shadow-[0_1px_4px_rgba(0,0,0,0.3)] text-foreground"
              : "text-muted hover:text-foreground",
          )}
        >
          <Icon name="User" className="h-3.5 w-3.5" />
          Client Managed
          <span className="rounded-full bg-surface-3 px-1.5 py-0.5 text-[10px] font-semibold text-muted">
            {clientTasks.length}
          </span>
        </button>
      </div>

      {/* Autopilot toggle (Karos tab + clientId present) */}
      {activeTab === "karos" && clientId && (
        <div className="mb-5">
          <AutopilotToggle clientId={clientId} enabled={autopilotEnabled} />
        </div>
      )}

      {/* Execution error (e.g. credit denial) */}
      {execError && (
        <div className="mb-4 flex items-start justify-between gap-2 rounded-md border border-danger/25 bg-danger/10 px-3 py-2">
          <p className="text-xs text-danger">{execError}</p>
          <button
            onClick={() => setExecError(null)}
            className="shrink-0 text-xs text-danger/70 hover:text-danger"
            aria-label="Dismiss"
          >
            <Icon name="X" className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {/* DnD hint */}
      {activeTab === "client" ? (
        <p className="mb-4 text-xs text-muted-2">
          Drag cards between columns to update status, or click any card to open the detail view.
        </p>
      ) : (
        <p className="mb-4 text-xs text-muted-2">
          Drag a card to In Progress to dispatch its AI agent, or click any card to open the detail view.
        </p>
      )}

      {/* Executing hint for karos tab */}
      {activeTab === "karos" && hasExecuting && (
        <div className="mb-4 flex items-center gap-2 rounded-md border border-neon/20 bg-neon/5 px-3 py-2">
          <Icon name="Loader" className="h-3.5 w-3.5 animate-spin text-neon" />
          <p className="text-xs text-neon">
            Karos AI is generating deliverables. Cards will update automatically.
          </p>
        </div>
      )}

      {/* Kanban grid — 4 columns */}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {COLUMNS.map(({ status, label, icon }) => (
          <KanbanColumn
            key={status}
            status={status}
            label={label}
            icon={icon}
            tasks={visibleTasks.filter((t) => t.status === status)}
            canDelete={canDelete}
            showClientName={showClientName}
            enableDnD
            draggingId={draggingId}
            dropTarget={dropTarget}
            onStatusChange={handleStatusChange}
            onDelete={handleDelete}
            onCardClick={setSelectedTaskId}
            onDragStart={handleDragStart}
            onDragEnd={handleDragEnd}
            onDragOver={handleDragOver}
            onDrop={handleDrop}
          />
        ))}
      </div>

      {/* Ticket modal */}
      {selectedTask && (
        <TaskTicketModal
          task={selectedTask}
          onClose={() => setSelectedTaskId(null)}
          onStatusChange={handleStatusChange}
          onLocalUpdate={(updated) =>
            setLocalTasks((prev) => prev.map((t) => (t.id === updated.id ? updated : t)))
          }
        />
      )}
    </>
  );
}
