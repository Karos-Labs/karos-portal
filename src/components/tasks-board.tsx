"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useRouter, useSearchParams } from "next/navigation";
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
  previewTaskRunAction,
  runPendingTasksBatchAction,
  updateTaskStatusAction,
} from "@/lib/actions";
import { TaskTicketModal } from "@/components/task-ticket-modal";
import { ranWithoutDeliverable } from "@/lib/task-outcome-copy";
import type { ClientTask, Role, TaskOwner, TaskSource, TaskStatus } from "@/lib/types";

type BoardStatus = Exclude<TaskStatus, "archived">;
type OwnerTab = "karos" | "client";
type StatusFilter = "all" | BoardStatus;
type BoardTask = ClientTask & { _clientName?: string };

const BOARD_COLUMNS: { status: BoardStatus; label: string; icon: string }[] = [
  { status: "pending", label: "Pending", icon: "Circle" },
  { status: "in_progress", label: "In Progress", icon: "CirclePlay" },
  { status: "review_pending", label: "Review Pending", icon: "Eye" },
  { status: "completed", label: "Done", icon: "CircleCheck" },
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

/**
 * The tab an owner's work lives on — the board's ONE owner→tab mapping, asked by
 * the deep link, by the owner filter, and by the reveal that follows a routed
 * add. `TaskOwner` has two members, so this is total; it was three separate
 * inline ternaries before, and the third one is what a routed add needed.
 */
function ownerTab(owner: TaskOwner): OwnerTab {
  return owner === "client_managed" ? "client" : "karos";
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
      {/* Honest about the skip the §2 guard rail introduced: a task whose agent
          is still being set up is passed over rather than run, and the price
          below is quoted on what will actually run. */}
      <p className="mt-1 max-w-[420px] text-[11px] leading-relaxed text-muted-2">
        Runs your next few pending automated tasks and charges credits for each. Anything waiting on
        an agent that is still being set up is skipped.
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
  runPrompt,
  pricing,
  onConfirmRun,
  onCancelRun,
}: {
  task: BoardTask;
  showClientName?: boolean;
  dragging: boolean;
  onOpen: () => void;
  onMove: (status: BoardStatus) => void;
  dragHandle?: { attributes: DraggableAttributes; listeners: SyntheticListenerMap | undefined };
  canDelete: boolean;
  onDelete: () => void;
  /** Set once the server has priced this card's run — the credits to confirm. */
  runPrompt: { credits: number } | null;
  /** The price lookup for this card is in flight. */
  pricing: boolean;
  onConfirmRun: () => void;
  onCancelRun: () => void;
}) {
  const priority = PRIORITY_META[task.priority] ?? PRIORITY_META.low;
  const source = SOURCE_META[task.source] ?? SOURCE_META.manual;
  const status = STATUS_META[task.status as BoardStatus];
  const isExecuting = task.metadata?.executing === true;
  const hasError = Boolean(task.metadata?.executionError);
  /**
   * Released BECAUSE the run came back with nothing, and still sitting there —
   * the whole conjunction is in `ranWithoutDeliverable`, because "was there a
   * nothing-run" is not the question a card can answer with. Mutually exclusive
   * with `hasError` by construction (it requires no stored error), so the two
   * blocks below can never both paint.
   */
  const noDeliverable = ranWithoutDeliverable(task);
  const owner = inferOwner(task);
  // Two-step confirm for this row's destructive control, the shape
  // scheduled-runs.tsx uses for a scheduled-run delete: the trash icon arms the
  // question, the question names the task, and `onDelete` (⇒ deleteTaskAction)
  // is unreachable until "Yes, delete it".
  const [confirmingDelete, setConfirmingDelete] = useState(false);

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
        // `focus-visible:opacity-100` because this is the ONE focusable control in a
        // resting card — the finding that opened the touch-reach work said so — and
        // at opacity 0 a keyboard user tabbing onto it saw nothing at all, focus ring
        // included. No `[@media(hover:none)]` reveal: dragging on touch is served by
        // the dnd sensors on the card itself, so a permanently visible handle on every
        // mobile card would be a design change, not a fix.
        className="absolute right-1 top-1 z-10 inline-flex h-5 w-5 items-center justify-center rounded-md text-muted-2 opacity-0 transition-opacity hover:bg-surface-2 hover:text-muted group-hover:opacity-100 focus-visible:opacity-100"
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

      {/* A run that reported success and delivered nothing. Warning, not danger:
          it did not break, and the client has already had the credits back —
          what they need is the fact and the way to try again. */}
      {noDeliverable && (
        <div
          className="mb-2 rounded-md border border-warning/35 bg-warning/10 px-2 py-1.5"
          onClick={(e) => e.stopPropagation()}
        >
          <p className="text-[11px] font-medium text-warning">Nothing came back from this run.</p>
          <button
            onClick={() => onMove("in_progress")}
            className="mt-1 inline-flex items-center gap-1 text-[11px] font-medium text-warning underline underline-offset-2"
          >
            <Icon name="RotateCcw" className="h-3 w-3" />
            Run it again
          </button>
        </div>
      )}

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

      {/* Compact by design: title, chips, age. The description lives in the
          ticket modal (and the hover tooltip) — its two extra lines per card
          were what pushed the count off screen (QA F136). */}
      <h3
        className="line-clamp-2 text-sm font-semibold leading-snug text-foreground"
        title={task.description || task.title}
      >
        {task.title}
      </h3>

      <div className="mt-1.5 flex items-center gap-2 text-[10px] text-muted-2">
        {!(task.source === "copilot" || owner === "karos_managed") && (
          <div className="inline-flex min-w-0 items-center gap-1 truncate">
            <Icon name={source.icon} className="h-3 w-3 shrink-0" />
            <span className="truncate">{source.label}</span>
          </div>
        )}
        <span className="ml-auto shrink-0 whitespace-nowrap">{relativeTime(task.updatedAt || task.createdAt)}</span>
      </div>

      {/* Both confirms render OUTSIDE the action row below, on purpose: that row
          is still hover-revealed wherever a pointer exists, and a confirmation
          that vanishes when the pointer leaves the card is not a confirmation.
          The run confirm can also be raised by a drag that ends nowhere near
          this card. */}
      {confirmingDelete && (
        <div
          className="mt-2 rounded-md border border-danger/35 bg-danger/10 px-2 py-1.5"
          onClick={(e) => e.stopPropagation()}
        >
          <p className="line-clamp-3 text-[11px] leading-relaxed text-danger">
            Delete &ldquo;{task.title}&rdquo;? This cannot be undone.
          </p>
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            <button
              onClick={() => {
                setConfirmingDelete(false);
                onDelete();
              }}
              className="rounded-md border border-danger/40 bg-danger/15 px-2 py-1 text-[11px] font-medium text-danger hover:border-danger/60"
            >
              Yes, delete it
            </button>
            <button
              onClick={() => setConfirmingDelete(false)}
              className="rounded-md border border-border px-2 py-1 text-[11px] font-medium text-muted hover:text-foreground"
            >
              Keep it
            </button>
          </div>
        </div>
      )}

      {/* The per-card twin of the batch runner's price panel
          (RunPendingTasksButton above): state the credits, then charge only on
          confirm. The figure is the server's own planned cost for this task, not
          a constant. */}
      {runPrompt && (
        <div
          className="mt-2 rounded-md border border-neon/30 bg-neon/10 px-2 py-1.5"
          onClick={(e) => e.stopPropagation()}
        >
          <p className="text-[11px] leading-relaxed text-foreground">
            {"Runs this task now for "}
            <span className="font-medium text-neon">
              {`${runPrompt.credits} credit${runPrompt.credits === 1 ? "" : "s"}`}
            </span>
            .
          </p>
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            <button
              onClick={onConfirmRun}
              className="rounded-md border border-neon/30 bg-neon/15 px-2 py-1 text-[11px] font-medium text-neon hover:border-neon/50"
            >
              {`Run & charge ${runPrompt.credits} credit${runPrompt.credits === 1 ? "" : "s"}`}
            </button>
            <button
              onClick={onCancelRun}
              className="rounded-md border border-border px-2 py-1 text-[11px] font-medium text-muted hover:text-foreground"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* REACHABLE WITHOUT A POINTER. This row used to be `hidden … group-hover:flex`
          — display:none until hover — so on a touch device every per-card action
          was unreachable, and `group-focus-within` could not rescue it from the
          inside because a `hidden` child is not focusable.

          The resting state is now `flex`; the HIDE is what carries a condition,
          `@media (hover: hover)`, which is the very media query Tailwind v4 wraps
          `group-hover:` in (compile `group-hover:flex` and read it). So the hide
          and the reveal are co-extensive BY CONSTRUCTION: no device can be told to
          hide this row without also being able to hover it back, and a device with
          no hover keeps the row. Where a pointer exists the resting card height is
          exactly what it was.

          flex-wrap: on narrow columns the buttons stack instead of spilling past
          the card border. */}
      <div
        className="mt-2 flex flex-wrap items-center justify-between gap-2 border-t border-white/5 pt-3 [@media(hover:hover)]:hidden group-hover:flex group-focus-within:flex"
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
          {/* onMove is routed through the board's price gate, so this button
              (and the retry above) asks before a managed run charges. While the
              price panel is up the button is gone — the panel is the control. */}
          {task.status !== "in_progress" && !runPrompt && (
            <button
              onClick={() => onMove("in_progress")}
              disabled={pricing}
              className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-md border border-neon/30 bg-neon/10 px-2.5 py-1.5 text-xs font-medium text-neon hover:border-neon/50 disabled:opacity-50"
            >
              <Icon
                name={pricing ? "Loader" : "Play"}
                className={cn("h-3 w-3 shrink-0", pricing && "animate-spin")}
              />
              {owner === "karos_managed" ? "Run Agent" : "Start"}
            </button>
          )}
        </div>
        {canDelete && !confirmingDelete && (
          <button
            onClick={() => setConfirmingDelete(true)}
            className="inline-flex shrink-0 items-center justify-center rounded-md p-1.5 text-muted hover:bg-danger/10 hover:text-danger"
            title="Delete task"
            aria-label="Delete task"
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
  runPrompt,
  pricing,
  onConfirmRun,
  onCancelRun,
}: {
  task: BoardTask;
  showClientName?: boolean;
  onOpen: () => void;
  onMove: (status: BoardStatus) => void;
  canDelete: boolean;
  onDelete: () => void;
  runPrompt: { credits: number } | null;
  pricing: boolean;
  onConfirmRun: () => void;
  onCancelRun: () => void;
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
        runPrompt={runPrompt}
        pricing={pricing}
        onConfirmRun={onConfirmRun}
        onCancelRun={onCancelRun}
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
  runPrompt,
  pricingTaskId,
  onConfirmRun,
  onCancelRun,
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
  /** The one card, board-wide, currently showing a run price to confirm. */
  runPrompt: { taskId: string; credits: number } | null;
  pricingTaskId: string | null;
  onConfirmRun: () => void;
  onCancelRun: () => void;
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
          "min-h-[160px] rounded-lg border border-border/70 bg-surface-2/65 p-2 transition-colors",
          isTarget && "border-neon/45 bg-neon/10",
        )}
      >
        <SortableContext items={tasks.map((t) => t.id)} strategy={verticalListSortingStrategy}>
          <div id={droppableId} className="flex min-h-[130px] flex-col gap-2">
            {tasks.map((task) => (
              <SortableTaskCard
                key={task.id}
                task={task}
                showClientName={showClientName}
                onOpen={() => onOpenTask(task.id)}
                onMove={(next) => onMoveTask(task, next)}
                canDelete={canDelete}
                onDelete={() => onDeleteTask(task)}
                runPrompt={runPrompt?.taskId === task.id ? { credits: runPrompt.credits } : null}
                pricing={pricingTaskId === task.id}
                onConfirmRun={onConfirmRun}
                onCancelRun={onCancelRun}
              />
            ))}
            {tasks.length === 0 && (
              <div
                className={cn(
                  "flex min-h-[110px] items-center justify-center rounded-md border border-dashed text-center",
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
  /**
   * The owner the router just sent a newly added task to, with a `nonce` that
   * changes on every add.
   *
   * `ingestCustomUserTaskAction` puts the typed text through a model that picks
   * the owner — the client never chooses it — and its success line names the
   * card ("Added …"). Without this the board stayed on whatever tab it was on,
   * so a task routed to Automated while the client sat on "Depending on you"
   * was announced by name and rendered nowhere.
   *
   * The nonce is what makes a SECOND add to the same tab register: the owner
   * alone does not change between two adds, so an owner-only comparison fires
   * once and then goes quiet.
   */
  revealOwner?: { owner: TaskOwner; nonce: number } | null;
}

export function TasksBoard({
  tasks,
  currentUserRole,
  showClientName = false,
  clientId,
  revealOwner = null,
}: Props) {
  const router = useRouter();
  const searchParams = useSearchParams();
  // Deep link from the notification bell: ?owner= picks the tab, ?task= opens
  // the ticket (QA F64). Distinct keys — ?tab= is the Workspace's
  // board/activity/archive toggle and must not be re-keyed. Unknown values are
  // ignored, so a stale link degrades to the default board.
  const ownerParam = searchParams.get("owner");
  const taskParam = searchParams.get("task");
  const linkedTask = taskParam ? tasks.find((t) => t.id === taskParam) : undefined;
  const initialTab: OwnerTab = linkedTask
    ? ownerTab(inferOwner(linkedTask))
    : ownerParam === "client"
      ? "client"
      : "karos";

  const [localTasks, setLocalTasks] = useState<BoardTask[]>(tasks);
  const [activeTab, setActiveTab] = useState<OwnerTab>(initialTab);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [clientFilter, setClientFilter] = useState<string>("all");
  const [execError, setExecError] = useState<string | null>(null);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(linkedTask?.id ?? null);
  const [draggingTaskId, setDraggingTaskId] = useState<string | null>(null);
  // The one card, board-wide, whose run has been priced and is awaiting a yes.
  const [runPrompt, setRunPrompt] = useState<{ taskId: string; credits: number } | null>(null);
  const [pricingTaskId, setPricingTaskId] = useState<string | null>(null);
  const dragSnapshotRef = useRef<BoardTask[] | null>(null);
  const [, startTransition] = useTransition();

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));
  const canDelete = true;
  // The price confirmation exists to protect a CLIENT's credits, so staff never
  // meet it — not even the round trip that prices the run. An admin in "View as
  // Client" also reads as CLIENT_USER here and is sorted out by the server's own
  // `billable` verdict in askToRun, which is the only place that can know.
  const isClientViewer = currentUserRole === "CLIENT_USER";

  // Sync local state when the server re-fetches tasks (e.g., after router.refresh()).
  // Uses the "store previous prop" pattern (react.dev/learn/you-might-not-need-an-effect)
  // to avoid calling setState inside a useEffect body, which triggers cascading renders.
  const [prevTasksProp, setPrevTasksProp] = useState(tasks);
  if (prevTasksProp !== tasks) {
    setPrevTasksProp(tasks);
    setLocalTasks(tasks);
  }

  // Same-route navigation (bell row clicked while already on /tasks) doesn't
  // remount, so the deep-link params have to be re-read when they change —
  // otherwise the board keeps whatever tab it was on (QA F64 / F97 watch-item).
  const linkSignature = `${ownerParam ?? ""}|${taskParam ?? ""}`;
  const [prevLinkSignature, setPrevLinkSignature] = useState(linkSignature);
  if (prevLinkSignature !== linkSignature) {
    setPrevLinkSignature(linkSignature);
    setActiveTab(initialTab);
    if (taskParam) setSelectedTaskId(linkedTask?.id ?? null);
  }

  // FOLLOW THE ROUTER'S VERDICT (same store-previous-prop pattern as the two
  // blocks above). The quick-add bar hands the routed owner up on every
  // successful add; the board goes to that owner's tab.
  //
  // The tab is not the only thing that can hide a brand-new card, and a reveal
  // that fixes one of three is a promise half kept: a `statusFilter` on anything
  // but Pending hides a just-created task just as completely, and so does a
  // stale search query the routed title does not match (the model rewrites what
  // the client typed). Both are cleared, so the card the success line names is
  // on screen.
  const revealNonce = revealOwner?.nonce ?? null;
  const [prevRevealNonce, setPrevRevealNonce] = useState(revealNonce);
  if (prevRevealNonce !== revealNonce) {
    setPrevRevealNonce(revealNonce);
    if (revealOwner) {
      setActiveTab(ownerTab(revealOwner.owner));
      setStatusFilter("all");
      setSearch("");
    }
  }

  const hasExecuting = localTasks.some((t) => t.metadata?.executing === true);
  const refreshBoard = useCallback(() => router.refresh(), [router]);
  useEffect(() => {
    if (!hasExecuting) return;
    const id = setInterval(refreshBoard, 4000);
    return () => clearInterval(id);
  }, [hasExecuting, refreshBoard]);

  // Open work only: a chip counting Done cards disagreed with every other
  // count in the portal (dashboard attention row, notification bell).
  const tabCounts = useMemo(
    () => ({
      karos: localTasks.filter((t) => inferOwner(t) === "karos_managed" && t.status !== "completed")
        .length,
      client: localTasks.filter(
        (t) => inferOwner(t) === "client_managed" && t.status !== "completed",
      ).length,
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
    const ownerFiltered = localTasks.filter((task) => ownerTab(inferOwner(task)) === activeTab);
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

  /**
   * True when this status move is the one that spends credits: moving a
   * karos_managed task into In Progress is what updateTaskStatusAction claims,
   * charges and dispatches. Every other move on this board is free — a "Start"
   * on client-owned work charges nothing and must not grow a price dialog.
   */
  function chargesCredits(task: BoardTask, nextStatus: BoardStatus): boolean {
    return nextStatus === "in_progress" && inferOwner(task) === "karos_managed";
  }

  /**
   * The single door every board path into a status change goes through — card
   * button, retry link, drag into a column, ticket-modal footer. A billable run
   * is priced and confirmed first; everything else commits straight away, so the
   * gate cannot be walked around by picking a different control.
   */
  function requestStatusChange(
    task: BoardTask,
    nextStatus: BoardStatus,
    fallbackSnapshot?: BoardTask[],
  ) {
    if (isClientViewer && chargesCredits(task, nextStatus)) {
      // Leave the board exactly as it was while the question is open: a drag
      // has already moved the card optimistically, and nothing has been charged.
      if (fallbackSnapshot) setLocalTasks(fallbackSnapshot);
      askToRunTask(task);
      return;
    }
    commitStatusChange(task, nextStatus, fallbackSnapshot);
  }

  /** Price the run server-side, then ask. Nothing is claimed or charged yet. */
  function askToRunTask(task: BoardTask) {
    setExecError(null);
    setRunPrompt(null);
    setPricingTaskId(task.id);
    startTransition(async () => {
      const res = await previewTaskRunAction(task.id, task.clientId);
      setPricingTaskId(null);
      if (!res.ok) {
        setExecError(res.error ?? "Could not check what this run costs");
        return;
      }
      // Nothing will be charged (staff, or an admin viewing as this client), so
      // there is nothing to confirm — run it.
      if (!res.billable) {
        commitStatusChange(task, "in_progress");
        return;
      }
      // A billable run whose price did not come back must NOT fall through to a
      // zero: "Run & charge 0 credits" over a real charge is consent to the
      // wrong amount, which is worse than refusing to quote.
      if (typeof res.credits !== "number") {
        setExecError("Could not check what this run costs — try again in a moment.");
        return;
      }
      setRunPrompt({ taskId: task.id, credits: res.credits });
    });
  }

  function confirmTaskRun() {
    if (!runPrompt) return;
    const task = localTasks.find((t) => t.id === runPrompt.taskId);
    // Clear FIRST, so a second press during the transition cannot commit twice:
    // the charge sits behind an atomic claim server-side, but a UI that lets a
    // client press "charge me" twice is not something to leave to that.
    setRunPrompt(null);
    if (!task) {
      // The panel outlived its card (a refresh archived or deleted it). Say so
      // rather than silently doing nothing — the client pressed a charge button.
      setExecError("That task is no longer on your board — nothing was charged.");
      return;
    }
    commitStatusChange(task, "in_progress");
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

    // Dragging a managed card into In Progress is the run button by another
    // name — same claim, same charge — so it meets the same price gate.
    requestStatusChange(previousTask, targetStatus, snapshot);
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
      // The "Depending on you" tab renders no Review Pending column, so any
      // client-owned task already stuck in that state (moved there before the
      // status machine refused it — QA F54) surfaces in Pending instead of
      // silently disappearing while still counting in the tab total.
      if (activeTab === "client" && task.status === "review_pending") {
        map.pending.push(task);
        continue;
      }
      map[task.status].push(task);
    }

    for (const key of Object.keys(map) as BoardStatus[]) {
      map[key].sort(compareByWeight);
    }
    return map;
  }, [activeTab, visibleTasks]);

  if (localTasks.length === 0) {
    return (
      <EmptyState
        icon={<Icon name="SquareCheck" className="h-10 w-10" />}
        title="No tasks yet"
        description="Tasks appear here when AI Copilot or your team creates actionable work items."
      />
    );
  }

  return (
    <>
      <div className="mb-4 flex flex-col gap-3 rounded-lg border border-border bg-surface-2/70 p-3">
        {/* ONE straight row (CD-G10): tabs · search · status on a shared
            baseline. It used to be `flex-wrap` with the run-pending CTA sitting
            inside the right-hand group — and that CTA is a tall two-line card,
            not a control. Its height plus the search field's min-width blew the
            row apart: the tabs dropped to a second line bottom-left while
            search and the status filter stayed top-right, with the card
            floating between them. No wrap here any more; the phone layout is an
            explicit column instead of whatever wrapping happened to produce. */}
        {/* CD-H7a: the one-line arrangement engages off the CONTENT COLUMN, not
            the viewport. `sm:` only knows the window is 640+, so with the
            copilot rail out at 1280 the row still tried to fit tabs (336px) +
            search + filters into 548-580px: the search field was squeezed to
            41px in the client shell and to ZERO — with the row overflowing by
            29px — in the staff shell, which carries a second select. The (app)
            shells wrap every page in @container, so @3xl (768px of actual
            column) is a width the row can honestly hold; below it the toolbar
            uses the column layout CD-G10 already defines, rather than a
            straight row with an unusable control in it. */}
        <div className="flex flex-col gap-2 @3xl:flex-row @3xl:items-center @3xl:gap-3">
          {/* Full width in the column layout so the two tabs split it evenly
              instead of "Depending on you" wrapping to a second line inside its
              own pill. */}
          <div className="inline-flex w-full shrink-0 items-center gap-1 self-start rounded-md border border-border bg-surface p-1 @3xl:w-auto @3xl:self-auto">
            <button
              onClick={() => setActiveTab("karos")}
              className={cn(
                "inline-flex flex-1 items-center justify-center gap-1.5 whitespace-nowrap rounded-md px-3 py-1.5 text-sm font-medium transition-colors @3xl:flex-none @3xl:justify-start",
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
                "inline-flex flex-1 items-center justify-center gap-1.5 whitespace-nowrap rounded-md px-3 py-1.5 text-sm font-medium transition-colors @3xl:flex-none @3xl:justify-start",
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

          {/* min-w-0 on the group and the field is what actually keeps the row
              straight: without it the search input's own minimum width wins
              over flex shrinking and pushes its siblings out of the line. */}
          {/* Narrow column: search takes its own line and the selects share the
              one below, rather than three controls fighting over 343px and
              leaving the search box showing four characters. */}
          <div className="flex min-w-0 flex-1 flex-col gap-2 @3xl:flex-row @3xl:items-center @3xl:justify-end">
            {/* The floor that makes the row honest: once it IS a row, the field
                never shrinks past 8rem — below that the placeholder is cut and
                the control stops reading as a search box. */}
            <div className="relative min-w-0 w-full @3xl:min-w-[8rem] @3xl:max-w-[320px] @3xl:flex-1">
              <Icon name="Search" className="pointer-events-none absolute left-2.5 top-2.5 h-3.5 w-3.5 text-muted-2" />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search by task"
                className="h-9 w-full rounded-md border border-border bg-surface px-8 text-sm text-foreground placeholder:text-muted-2"
              />
            </div>
            <div className="flex min-w-0 items-center gap-2">
              <select
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}
                className="h-9 min-w-0 flex-1 rounded-md border border-border bg-surface px-2.5 text-xs text-foreground @3xl:flex-none @3xl:shrink-0"
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
                  className="h-9 min-w-0 flex-1 rounded-md border border-border bg-surface px-2.5 text-xs text-foreground @3xl:flex-none @3xl:shrink-0"
                >
                  <option value="all">All clients</option>
                  {clientOptions.map((name) => (
                    <option key={name} value={name}>
                      {name}
                    </option>
                  ))}
                </select>
              )}
            </div>
          </div>
        </div>

        {/* The CTA gets its own clean row (CD-G10). It is a card that grows a
            price-confirmation panel when pressed, so there is no width at which
            it belongs on the filter line — inside the row it distorted the
            toolbar, and on the row it distorted nothing. */}
        {activeTab === "karos" && clientId && (
          <div className="border-t border-border/60 pt-3">
            <RunPendingTasksButton clientId={clientId} />
          </div>
        )}

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
        <div
          className={cn(
            "grid grid-cols-1 gap-3 @3xl:grid-cols-2",
            visibleColumns.length === 3 ? "@5xl:grid-cols-3" : "@5xl:grid-cols-4",
          )}
        >
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
              onMoveTask={(task, nextStatus) => requestStatusChange(task, nextStatus)}
              onDeleteTask={handleDelete}
              canDelete={canDelete}
              runPrompt={runPrompt}
              pricingTaskId={pricingTaskId}
              onConfirmRun={confirmTaskRun}
              onCancelRun={() => setRunPrompt(null)}
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
            // The ticket footer's "Move to In Progress" charges exactly like the
            // card button, and the modal closes on press — so the price panel it
            // raises lands on the card the client just came from.
            requestStatusChange(current, status as BoardStatus);
            void cid;
          }}
          onLocalUpdate={(updated) =>
            setLocalTasks((prev) => prev.map((task) => (task.id === updated.id ? { ...updated } : task)))
          }
          // The ticket footer's delete is the SAME handler the card's trash icon
          // reaches — one delete path, one authorization, one optimistic removal
          // and one rollback. It is the only one a touch device can get to.
          onDelete={() => handleDelete(selectedTask)}
        />
      )}
    </>
  );
}
