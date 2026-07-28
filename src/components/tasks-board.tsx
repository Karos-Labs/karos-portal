"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  DndContext,
  PointerSensor,
  closestCorners,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
  type DraggableAttributes,
  type UniqueIdentifier,
} from "@dnd-kit/core";
import type { SyntheticListenerMap } from "@dnd-kit/core/dist/hooks/utilities";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Icon } from "@/components/icon";
import { Badge, EmptyState } from "@/components/ui";
import { cn, relativeTime } from "@/lib/utils";
import {
  deleteTaskAction,
  previewPendingTasksBatchAction,
  runPendingTasksBatchAction,
  updateTaskStatusAction,
} from "@/lib/actions";
import { TaskTicketModal } from "@/components/task-ticket-modal";
import type { ClientTask, Role, TaskOwner, TaskSource, TaskStatus } from "@/lib/types";

type BoardStatus = Exclude<TaskStatus, "archived">;
type OwnerTab = "karos" | "client";
type StatusFilter = "all" | BoardStatus;
type BoardTask = ClientTask & { _clientName?: string };

const BOARD_COLUMNS: { status: BoardStatus; label: string; icon: string }[] = [
  { status: "pending", label: "Pending", icon: "Circle" },
  { status: "in_progress", label: "In Progress", icon: "PlayCircle" },
  { status: "review_pending", label: "Review Pending", icon: "Eye" },
  { status: "completed", label: "Done", icon: "CheckCircle" },
];

const SOURCE_META: Record<TaskSource, { label: string; icon: string }> = {
  gmail: { label: "Operational Intel", icon: "Globe" },
  competitor_research: { label: "Competitor", icon: "TrendingUp" },
  brand_audit: { label: "Brand Audit", icon: "Search" },
  content_dispatch: { label: "Content", icon: "Zap" },
  copilot: { label: "AI Copilot", icon: "Bot" },
  manual: { label: "Manual", icon: "PenLine" },
  custom: { label: "Quick Add", icon: "Plus" },
};

const PRIORITY_META: Record<string, { tone: "danger" | "warning" | "neutral"; label: string }> = {
  high: { tone: "danger", label: "High" },
  medium: { tone: "warning", label: "Medium" },
  low: { tone: "neutral", label: "Low" },
};

const STATUS_META: Record<BoardStatus, { label: string; dot: string }> = {
  pending: { label: "Pending", dot: "bg-muted-2" },
  in_progress: { label: "Running Agent", dot: "bg-neon" },
  review_pending: { label: "Review Pending", dot: "bg-warning" },
  completed: { label: "Done", dot: "bg-success" },
};

const PRIORITY_RANK: Record<string, number> = { high: 80, medium: 50, low: 25 };

function inferOwner(task: ClientTask): TaskOwner {
  if (task.owner) return task.owner;
  return task.source === "manual" ? "client_managed" : "karos_managed";
}

function statusAfterDrop(status: BoardStatus): { status: BoardStatus; completedAt: number | null } {
  return { status, completedAt: status === "completed" ? Date.now() : null };
}

function taskWeight(task: ClientTask): number {
  return typeof task.weight === "number" ? task.weight : PRIORITY_RANK[task.priority] ?? 0;
}

function compareByWeight(a: ClientTask, b: ClientTask): number {
  return taskWeight(b) - taskWeight(a) || b.createdAt - a.createdAt;
}

function idToString(id: UniqueIdentifier | null | undefined): string | null {
  if (typeof id === "string") return id;
  if (typeof id === "number") return String(id);
  return null;
}

function findStatusFromOver(overId: string | null, tasks: BoardTask[]): BoardStatus | null {
  if (!overId) return null;
  if (overId.startsWith("column:")) {
    const status = overId.replace("column:", "") as BoardStatus;
    return BOARD_COLUMNS.some((c) => c.status === status) ? status : null;
  }
  const overTask = tasks.find((t) => t.id === overId);
  return overTask?.status === "archived" ? null : (overTask?.status as BoardStatus | undefined) ?? null;
}

/**
 * One-shot batch runner. This used to be an "Autopilot" switch that stayed on
 * forever while nothing in the product ever ran a second batch (QA F48), so it
 * is now labelled as what it does: run the next few pending automated tasks.
 */
function RunPendingTasksButton({ clientId }: { clientId: string }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [started, setStarted] = useState<number | null>(null);
  const [preview, setPreview] = useState<{ count: number; credits: number; billable: boolean } | null>(null);
  const [isPending, startTransition] = useTransition();

  // Confirm step: nothing is claimed or charged until the client has seen the
  // task count and the credit total (QA F58).
  function askToRun() {
    setError(null);
    setStarted(null);
    startTransition(async () => {
      const res = await previewPendingTasksBatchAction(clientId);
      if (!res.ok) {
        setError(res.error ?? "Could not check what would run");
        return;
      }
      setPreview({ count: res.count ?? 0, credits: res.credits ?? 0, billable: res.billable ?? false });
    });
  }

  function confirmRun() {
    setError(null);
    startTransition(async () => {
      const res = await runPendingTasksBatchAction(clientId);
      setPreview(null);
      if (!res.ok) {
        setError(res.error ?? "Could not start the run");
        return;
      }
      setStarted(res.started ?? 0);
      router.refresh();
    });
  }

  return (
    <div className="rounded-md border border-border bg-surface-2 px-3 py-2">
      <button
        onClick={askToRun}
        disabled={isPending || preview !== null}
        className="flex items-center gap-2 text-xs font-medium text-foreground disabled:opacity-50"
      >
        <Icon name={isPending ? "Loader" : "Play"} className={cn("h-3.5 w-3.5 text-neon", isPending && "animate-spin")} />
        Run up to 5 pending tasks now
      </button>
      <p className="mt-1 max-w-[260px] text-[11px] leading-relaxed text-muted-2">
        Runs your next few pending automated tasks and charges credits for each one.
      </p>

      {preview && (
        <div className="mt-2 rounded-md border border-border bg-surface px-2.5 py-2">
          {preview.count === 0 ? (
            <p className="text-[11px] text-muted">No pending automated tasks to run right now.</p>
          ) : (
            <p className="text-[11px] leading-relaxed text-foreground">
              {`Runs ${preview.count} pending task${preview.count === 1 ? "" : "s"} `}
              {preview.billable ? (
                <span className="font-medium text-neon">{`for ${preview.credits} credits`}</span>
              ) : (
                <span className="font-medium text-muted">at no credit cost (staff run)</span>
              )}
              .
            </p>
          )}
          <div className="mt-2 flex items-center gap-2">
            {preview.count > 0 && (
              <button
                onClick={confirmRun}
                disabled={isPending}
                className="inline-flex items-center gap-1 rounded-md border border-neon/30 bg-neon/10 px-2.5 py-1 text-[11px] font-medium text-neon hover:border-neon/50 disabled:opacity-50"
              >
                {preview.billable ? `Run & charge ${preview.credits} credits` : "Run now"}
              </button>
            )}
            <button
              onClick={() => setPreview(null)}
              className="rounded-md border border-border px-2.5 py-1 text-[11px] font-medium text-muted hover:text-foreground"
            >
              {preview.count > 0 ? "Cancel" : "Close"}
            </button>
          </div>
        </div>
      )}

      {started !== null && !error && (
        <p className="mt-1 text-[11px] text-muted">
          {started === 0 ? "No pending automated tasks to run." : `Started ${started} task${started === 1 ? "" : "s"}.`}
        </p>
      )}
      {error && <p className="mt-1 text-[11px] text-danger">{error}</p>}
    </div>
  );
}

function TaskCard({
  task,
  showClientName,
  dragging,
  onOpen,
  onMove,
  dragHandle,
  canDelete,
  onDelete,
}: {
  task: BoardTask;
  showClientName?: boolean;
  dragging: boolean;
  onOpen: () => void;
  onMove: (status: BoardStatus) => void;
  dragHandle?: { attributes: DraggableAttributes; listeners: SyntheticListenerMap | undefined };
  canDelete: boolean;
  onDelete: () => void;
}) {
  const priority = PRIORITY_META[task.priority] ?? PRIORITY_META.low;
  const source = SOURCE_META[task.source] ?? SOURCE_META.manual;
  const status = STATUS_META[task.status as BoardStatus];
  const isExecuting = task.metadata?.executing === true;
  const hasError = Boolean(task.metadata?.executionError);
  const owner = inferOwner(task);

  return (
    <article
      onClick={onOpen}
      className={cn(
        "group relative rounded-md border bg-surface px-3 py-2.5 transition-all duration-150",
        "cursor-pointer hover:-translate-y-0.5 hover:border-border-strong hover:shadow-[0_8px_20px_rgba(0,0,0,0.22)]",
        dragging && "opacity-50 ring-2 ring-foreground/25",
      )}
    >
      <button
        className="absolute right-1 top-1 z-10 inline-flex h-5 w-5 items-center justify-center rounded-md text-muted-2 opacity-0 transition-opacity hover:bg-surface-2 hover:text-muted group-hover:opacity-100"
        {...(dragHandle?.attributes ?? {})}
        {...(dragHandle?.listeners ?? {})}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
        }}
        title="Drag task"
        aria-label="Drag task"
      >
        <Icon name="GripVertical" className="h-3.5 w-3.5" />
      </button>

      <div className="mb-2 flex items-center justify-between gap-2 pr-6 text-xs">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", status.dot)} />
          {/* truncate, not nowrap-overflow: on narrow columns an overflowing label
              renders under the translucent priority badge and garbles it */}
          <span className="min-w-0 truncate text-[11px] font-medium text-muted">{status.label}</span>
          <Badge tone={priority.tone} className="shrink-0 px-1.5 py-0 text-[9px]">
            {priority.label}
          </Badge>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {(task.source === "copilot" || owner === "karos_managed") && (
            <span
              title="AI Copilot"
              className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-[4px] border border-neon/25 bg-neon/10 text-neon"
            >
              <Icon name="Bot" className="h-2.5 w-2.5" />
            </span>
          )}
          {showClientName && task._clientName && (
            <span
              title={task._clientName}
              className="max-w-[80px] shrink-0 truncate rounded-[4px] border border-border bg-surface-2 px-1.5 py-0.5 text-[9px] uppercase tracking-[0.06em] text-muted"
            >
              {task._clientName}
            </span>
          )}
        </div>
      </div>

      {hasError && !isExecuting && (
        <div
          className="mb-2 rounded-md border border-danger/35 bg-danger/10 px-2 py-1.5"
          onClick={(e) => e.stopPropagation()}
        >
          <p className="text-[11px] font-medium text-danger">Execution failed.</p>
          <button
            onClick={() => onMove("in_progress")}
            className="mt-1 inline-flex items-center gap-1 text-[11px] font-medium text-danger underline underline-offset-2"
          >
            <Icon name="RotateCcw" className="h-3 w-3" />
            Click to retry
          </button>
        </div>
      )}

      {isExecuting && (
        <div className="mb-2 flex items-center gap-1.5 rounded-md border border-neon/30 bg-neon/10 px-2 py-1">
          <Icon name="Loader" className="h-3 w-3 animate-spin text-neon" />
          <span className="text-[11px] font-medium text-neon">Agent running</span>
        </div>
      )}

      <h3 className="line-clamp-2 text-sm font-semibold leading-snug text-foreground">{task.title}</h3>
      {task.description && <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-muted">{task.description}</p>}

      <div className="mt-2 flex items-center gap-2 text-[10px] text-muted-2">
        {!(task.source === "copilot" || owner === "karos_managed") && (
          <div className="inline-flex min-w-0 items-center gap-1 truncate">
            <Icon name={source.icon} className="h-3 w-3 shrink-0" />
            <span className="truncate">{source.label}</span>
          </div>
        )}
        <span className="ml-auto shrink-0 whitespace-nowrap">{relativeTime(task.updatedAt || task.createdAt)}</span>
      </div>

      {/* flex-wrap: on narrow columns the buttons stack instead of spilling
          past the card border when the hover bar appears */}
      <div
        className="mt-2 flex flex-wrap items-center justify-between gap-2 border-t border-white/5 pt-3 opacity-0 transition-opacity group-hover:opacity-100"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <button
            onClick={onOpen}
            className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-md border border-border bg-surface-2 px-2.5 py-1.5 text-xs font-medium text-foreground hover:border-border-strong"
          >
            <Icon name="ExternalLink" className="h-3 w-3 shrink-0" />
            Open Details
          </button>
          {task.status !== "in_progress" && (
            <button
              onClick={() => onMove("in_progress")}
              className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-md border border-neon/30 bg-neon/10 px-2.5 py-1.5 text-xs font-medium text-neon hover:border-neon/50"
            >
              <Icon name="Play" className="h-3 w-3 shrink-0" />
              {owner === "karos_managed" ? "Run Agent" : "Start"}
            </button>
          )}
        </div>
        {canDelete && (
          <button
            onClick={onDelete}
            className="inline-flex shrink-0 items-center justify-center rounded-md p-1.5 text-muted hover:bg-danger/10 hover:text-danger"
            title="Delete task"
          >
            <Icon name="Trash2" className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
    </article>
  );
}

function SortableTaskCard({
  task,
  showClientName,
  onOpen,
  onMove,
  canDelete,
  onDelete,
}: {
  task: BoardTask;
  showClientName?: boolean;
  onOpen: () => void;
  onMove: (status: BoardStatus) => void;
  canDelete: boolean;
  onDelete: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: task.id,
    data: { kind: "task-card", status: task.status },
    disabled: task.metadata?.executing === true,
  });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  return (
    <div ref={setNodeRef} style={style}>
      <TaskCard
        task={task}
        showClientName={showClientName}
        dragging={isDragging}
        onOpen={onOpen}
        onMove={onMove}
        canDelete={canDelete}
        onDelete={onDelete}
        dragHandle={{ attributes, listeners }}
      />
    </div>
  );
}

function BoardColumn({
  status,
  label,
  icon,
  tasks,
  showClientName,
  draggingTaskId,
  onOpenTask,
  onMoveTask,
  onDeleteTask,
  canDelete,
}: {
  status: BoardStatus;
  label: string;
  icon: string;
  tasks: BoardTask[];
  showClientName?: boolean;
  draggingTaskId: string | null;
  onOpenTask: (id: string) => void;
  onMoveTask: (task: BoardTask, status: BoardStatus) => void;
  onDeleteTask: (task: BoardTask) => void;
  canDelete: boolean;
}) {
  const droppableId = `column:${status}`;
  const { setNodeRef, isOver } = useDroppable({ id: droppableId, data: { kind: "column", status } });
  const columnStatus = STATUS_META[status];
  const isTarget = Boolean(draggingTaskId) && isOver;

  return (
    <section className="flex min-w-0 flex-col">
      <div className="mb-2 flex items-center gap-2 px-1">
        <Icon name={icon} className="h-4 w-4 text-muted" />
        <h3 className="text-sm font-semibold text-foreground">{label}</h3>
        <span className={cn("h-2 w-2 rounded-full", columnStatus.dot)} />
        <span className="ml-auto rounded-full border border-border bg-surface-2 px-2 py-0.5 text-[11px] text-muted">
          {tasks.length}
        </span>
      </div>
      <div
        ref={setNodeRef}
        className={cn(
          "min-h-[280px] rounded-lg border border-border/70 bg-surface-2/65 p-2 transition-colors",
          isTarget && "border-neon/45 bg-neon/10",
        )}
      >
        <SortableContext items={tasks.map((t) => t.id)} strategy={verticalListSortingStrategy}>
          <div id={droppableId} className="flex min-h-[250px] flex-col gap-2">
            {tasks.map((task) => (
              <SortableTaskCard
                key={task.id}
                task={task}
                showClientName={showClientName}
                onOpen={() => onOpenTask(task.id)}
                onMove={(next) => onMoveTask(task, next)}
                canDelete={canDelete}
                onDelete={() => onDeleteTask(task)}
              />
            ))}
            {tasks.length === 0 && (
              <div
                className={cn(
                  "flex min-h-[150px] items-center justify-center rounded-md border border-dashed text-center",
                  isTarget ? "border-neon/50 bg-neon/10" : "border-border/90",
                )}
              >
                <p className="px-4 text-xs text-muted-2">{isTarget ? "Drop task here" : `No ${label.toLowerCase()} tasks`}</p>
              </div>
            )}
          </div>
        </SortableContext>
      </div>
    </section>
  );
}

interface Props {
  tasks: BoardTask[];
  currentUserRole: Role;
  showClientName?: boolean;
  clientId?: string;
}

export function TasksBoard({ tasks, currentUserRole, showClientName = false, clientId }: Props) {
  const router = useRouter();
  const [localTasks, setLocalTasks] = useState<BoardTask[]>(tasks);
  const [activeTab, setActiveTab] = useState<OwnerTab>("karos");
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [clientFilter, setClientFilter] = useState<string>("all");
  const [execError, setExecError] = useState<string | null>(null);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [draggingTaskId, setDraggingTaskId] = useState<string | null>(null);
  const dragSnapshotRef = useRef<BoardTask[] | null>(null);
  const [, startTransition] = useTransition();

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));
  const canDelete = true;
  void currentUserRole;

  // Sync local state when the server re-fetches tasks (e.g., after router.refresh()).
  // Uses the "store previous prop" pattern (react.dev/learn/you-might-not-need-an-effect)
  // to avoid calling setState inside a useEffect body, which triggers cascading renders.
  const [prevTasksProp, setPrevTasksProp] = useState(tasks);
  if (prevTasksProp !== tasks) {
    setPrevTasksProp(tasks);
    setLocalTasks(tasks);
  }

  const hasExecuting = localTasks.some((t) => t.metadata?.executing === true);
  const refreshBoard = useCallback(() => router.refresh(), [router]);
  useEffect(() => {
    if (!hasExecuting) return;
    const id = setInterval(refreshBoard, 4000);
    return () => clearInterval(id);
  }, [hasExecuting, refreshBoard]);

  const tabCounts = useMemo(
    () => ({
      karos: localTasks.filter((t) => inferOwner(t) === "karos_managed").length,
      client: localTasks.filter((t) => inferOwner(t) === "client_managed").length,
    }),
    [localTasks],
  );

  const clientOptions = useMemo(
    () =>
      Array.from(
        new Set(localTasks.map((t) => t._clientName).filter((name): name is string => Boolean(name))),
      ).sort((a, b) => a.localeCompare(b)),
    [localTasks],
  );

  const visibleTasks = useMemo(() => {
    const ownerFiltered = localTasks.filter((task) =>
      activeTab === "karos" ? inferOwner(task) === "karos_managed" : inferOwner(task) === "client_managed",
    );
    const query = search.trim().toLowerCase();

    return ownerFiltered.filter((task) => {
      if (statusFilter !== "all" && task.status !== statusFilter) return false;
      if (clientFilter !== "all" && task._clientName !== clientFilter) return false;
      if (!query) return true;
      return (
        task.title.toLowerCase().includes(query) ||
        task.description?.toLowerCase().includes(query) ||
        task._clientName?.toLowerCase().includes(query)
      );
    });
  }, [activeTab, clientFilter, localTasks, search, statusFilter]);

  const selectedTask = selectedTaskId ? localTasks.find((t) => t.id === selectedTaskId) ?? null : null;

  function setTaskStatusLocal(taskId: string, status: BoardStatus) {
    const patch = statusAfterDrop(status);
    setLocalTasks((prev) =>
      prev.map((task) =>
        task.id === taskId ? { ...task, status: patch.status, completedAt: patch.completedAt, updatedAt: Date.now() } : task,
      ),
    );
  }

  function commitStatusChange(task: BoardTask, nextStatus: BoardStatus, fallbackSnapshot?: BoardTask[]) {
    const previous = task;
    setTaskStatusLocal(task.id, nextStatus);
    setExecError(null);

    startTransition(async () => {
      const res = await updateTaskStatusAction(task.id, nextStatus, task.clientId);
      if (!res.ok) {
        if (fallbackSnapshot) setLocalTasks(fallbackSnapshot);
        else setLocalTasks((prev) => prev.map((item) => (item.id === previous.id ? previous : item)));
        setExecError(res.error ?? "Could not update task status");
      }
      router.refresh();
    });
  }

  function handleDelete(task: BoardTask) {
    const previous = localTasks;
    setLocalTasks((prev) => prev.filter((t) => t.id !== task.id));
    setExecError(null);
    startTransition(async () => {
      const res = await deleteTaskAction(task.id, task.clientId);
      if (!res.ok) {
        setLocalTasks(previous);
        setExecError(res.error ?? "Could not delete task");
      }
      router.refresh();
    });
  }

  function handleDragStart(event: DragStartEvent) {
    const taskId = idToString(event.active.id);
    if (!taskId) return;
    dragSnapshotRef.current = localTasks;
    setDraggingTaskId(taskId);
  }

  function handleDragOver(event: DragOverEvent) {
    const activeId = idToString(event.active.id);
    const overStatus = findStatusFromOver(idToString(event.over?.id), localTasks);
    if (!activeId || !overStatus) return;

    const activeTask = localTasks.find((task) => task.id === activeId);
    if (!activeTask) return;
    if (activeTask.status === overStatus) return;
    setTaskStatusLocal(activeTask.id, overStatus);
  }

  function handleDragCancel() {
    if (dragSnapshotRef.current) setLocalTasks(dragSnapshotRef.current);
    setDraggingTaskId(null);
    dragSnapshotRef.current = null;
  }

  function handleDragEnd(event: DragEndEvent) {
    const activeId = idToString(event.active.id);
    const targetStatus = findStatusFromOver(idToString(event.over?.id), localTasks);
    const snapshot = dragSnapshotRef.current;
    setDraggingTaskId(null);
    dragSnapshotRef.current = null;

    if (!activeId || !targetStatus || !snapshot) {
      if (snapshot) setLocalTasks(snapshot);
      return;
    }

    const previousTask = snapshot.find((task) => task.id === activeId);
    if (!previousTask) {
      setLocalTasks(snapshot);
      return;
    }

    if (previousTask.status === targetStatus) {
      setLocalTasks(snapshot);
      return;
    }

    commitStatusChange(previousTask, targetStatus, snapshot);
  }

  // Client-owned work never sits in "Review Pending" (that state is for AI drafts
  // awaiting review) — the "Depending on you" tab only needs 3 columns.
  const visibleColumns = useMemo(
    () => (activeTab === "client" ? BOARD_COLUMNS.filter((c) => c.status !== "review_pending") : BOARD_COLUMNS),
    [activeTab],
  );

  const tasksByColumn = useMemo(() => {
    const map: Record<BoardStatus, BoardTask[]> = {
      pending: [],
      in_progress: [],
      review_pending: [],
      completed: [],
    };

    for (const task of visibleTasks) {
      if (task.status === "archived") continue;
      map[task.status].push(task);
    }

    for (const key of Object.keys(map) as BoardStatus[]) {
      map[key].sort(compareByWeight);
    }
    return map;
  }, [visibleTasks]);

  if (localTasks.length === 0) {
    return (
      <EmptyState
        icon={<Icon name="CheckSquare" className="h-10 w-10" />}
        title="No tasks yet"
        description="Tasks appear here when AI Copilot or your team creates actionable work items."
      />
    );
  }

  return (
    <>
      <div className="mb-4 flex flex-col gap-3 rounded-lg border border-border bg-surface-2/70 p-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="inline-flex items-center gap-1 rounded-md border border-border bg-surface p-1">
            <button
              onClick={() => setActiveTab("karos")}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
                activeTab === "karos" ? "bg-surface-2 text-foreground" : "text-muted hover:text-foreground",
              )}
            >
              <Icon name="Sparkles" className="h-3.5 w-3.5" />
              Automated
              <span className="rounded-full border border-border bg-surface-3 px-1.5 py-0 text-[10px] text-muted">
                {tabCounts.karos}
              </span>
            </button>
            <button
              onClick={() => setActiveTab("client")}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
                activeTab === "client" ? "bg-surface-2 text-foreground" : "text-muted hover:text-foreground",
              )}
            >
              <Icon name="User" className="h-3.5 w-3.5" />
              Depending on you
              <span className="rounded-full border border-border bg-surface-3 px-1.5 py-0 text-[10px] text-muted">
                {tabCounts.client}
              </span>
            </button>
          </div>

          <div className="flex flex-1 flex-wrap items-center justify-end gap-2">
            <div className="relative w-full min-w-[220px] max-w-[320px]">
              <Icon name="Search" className="pointer-events-none absolute left-2.5 top-2.5 h-3.5 w-3.5 text-muted-2" />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search by task"
                className="h-9 w-full rounded-md border border-border bg-surface px-8 text-sm text-foreground placeholder:text-muted-2"
              />
            </div>
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}
              className="h-9 rounded-md border border-border bg-surface px-2.5 text-xs text-foreground"
            >
              <option value="all">All statuses</option>
              <option value="pending">Pending</option>
              <option value="in_progress">In Progress</option>
              <option value="review_pending">Review Pending</option>
              <option value="completed">Done</option>
            </select>
            {showClientName && (
              <select
                value={clientFilter}
                onChange={(e) => setClientFilter(e.target.value)}
                className="h-9 rounded-md border border-border bg-surface px-2.5 text-xs text-foreground"
              >
                <option value="all">All clients</option>
                {clientOptions.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
            )}
            {activeTab === "karos" && clientId && <RunPendingTasksButton clientId={clientId} />}
          </div>
        </div>

        {execError && (
          <div className="flex items-start justify-between gap-2 rounded-md border border-danger/30 bg-danger/10 px-3 py-2">
            <p className="text-xs text-danger">{execError}</p>
            <button onClick={() => setExecError(null)} className="text-danger/70 hover:text-danger" aria-label="Dismiss">
              <Icon name="X" className="h-3.5 w-3.5" />
            </button>
          </div>
        )}

        {activeTab === "karos" && hasExecuting && (
          <div className="flex items-center gap-2 rounded-md border border-neon/25 bg-neon/10 px-3 py-2">
            <Icon name="Loader" className="h-3.5 w-3.5 animate-spin text-neon" />
            <p className="text-xs text-neon">AI agents are running. Board status updates live.</p>
          </div>
        )}
      </div>

      <DndContext
        sensors={sensors}
        collisionDetection={closestCorners}
        onDragStart={handleDragStart}
        onDragOver={handleDragOver}
        onDragCancel={handleDragCancel}
        onDragEnd={handleDragEnd}
      >
        <div className={cn("grid grid-cols-1 gap-3", visibleColumns.length === 3 ? "xl:grid-cols-3" : "xl:grid-cols-4")}>
          {visibleColumns.map((column) => (
            <BoardColumn
              key={column.status}
              status={column.status}
              label={column.label}
              icon={column.icon}
              tasks={tasksByColumn[column.status]}
              showClientName={showClientName}
              draggingTaskId={draggingTaskId}
              onOpenTask={(id) => setSelectedTaskId(id)}
              onMoveTask={(task, nextStatus) => commitStatusChange(task, nextStatus)}
              onDeleteTask={handleDelete}
              canDelete={canDelete}
            />
          ))}
        </div>
      </DndContext>

      {selectedTask && (
        <TaskTicketModal
          task={selectedTask}
          onClose={() => setSelectedTaskId(null)}
          onStatusChange={(id, status, cid) => {
            if (status === "archived") return;
            const current = localTasks.find((task) => task.id === id);
            if (!current) return;
            commitStatusChange(current, status as BoardStatus);
            void cid;
          }}
          onLocalUpdate={(updated) =>
            setLocalTasks((prev) => prev.map((task) => (task.id === updated.id ? { ...updated } : task)))
          }
        />
      )}
    </>
  );
}
