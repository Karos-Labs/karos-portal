"use client";

import { useState, useEffect, useTransition, useRef } from "react";
import { Icon } from "@/components/icon";
import { cn, relativeTime } from "@/lib/utils";
import { renderAssetBody } from "@/lib/doc-render";
import { normalizeDashes } from "@/lib/text-utils";
import {
  getTaskCommentsAction,
  addTaskCommentAction,
  generateTaskPlanAction,
  approveTaskArtifactAction,
  requestAdjustmentsAction,
  publishIntegrationAction,
} from "@/lib/actions";
import type { ClientTask, TaskComment, TaskOwner, TaskStatus } from "@/lib/types";

/* ── Helpers ─────────────────────────────────────────────────────── */

const PRIORITY_COLOR: Record<string, string> = {
  high:   "text-danger  bg-danger/10  border-danger/25",
  medium: "text-warning bg-warning/10 border-warning/25",
  low:    "text-muted   bg-surface-2  border-border",
};

/**
 * The badge a task wears in its ticket. Clients open this modal, so the labels
 * name the WORK, never the pipeline that produced it - `content_dispatch`
 * reads "Content", matching the board chip in tasks-board.tsx so the same task
 * does not carry two names between its card and its ticket (A3). This map is
 * not role-branched: there is no staff-only variant of these labels.
 */
const SOURCE_LABEL: Record<string, { label: string; color: string }> = {
  gmail:               { label: "Operational Intel",   color: "#6b9fd4" },
  competitor_research: { label: "Competitor Research", color: "#FF6B2C" },
  brand_audit:         { label: "Brand Audit",         color: "#d9a13d" },
  content_dispatch:    { label: "Content",             color: "#e5484d" },
  copilot:             { label: "AI Copilot",          color: "#FF6B2C" },
  manual:              { label: "Manual",              color: "#9c9ca3" },
};

const STATUS_NEXT: Record<TaskStatus, TaskStatus> = {
  pending:        "in_progress",
  in_progress:    "review_pending",
  review_pending: "completed",
  completed:      "pending",
  archived:       "pending",
};

/**
 * Review Pending is the state an AI draft sits in while Karos reviews it, so
 * client-owned work never belongs there - the "Depending on you" board doesn't
 * even render that column, and a task pushed into it from this footer vanished
 * with no way back (QA F54). Client-managed work goes straight to Done.
 */
function nextStatusFor(task: ClientTask): TaskStatus {
  const next = STATUS_NEXT[task.status];
  if (next === "review_pending" && inferOwner(task) === "client_managed") return "completed";
  return next;
}

const STATUS_LABEL: Record<TaskStatus, string> = {
  pending:        "Pending",
  in_progress:    "In Progress",
  review_pending: "Review Pending",
  completed:      "Done",
  archived:       "Archived",
};

const STATUS_ICON: Record<TaskStatus, string> = {
  pending:        "Circle",
  in_progress:    "Clock",
  review_pending: "Eye",
  completed:      "CircleCheck",
  archived:       "Archive",
};

const ROLE_BADGE: Record<string, string> = {
  KAROS_ADMIN:    "bg-neon/15 text-neon border-neon/25",
  KAROS_EMPLOYEE: "bg-neon/10 text-neon/80 border-neon/15",
  CLIENT_USER:    "bg-surface-3 text-muted border-border",
};

const ROLE_LABEL: Record<string, string> = {
  KAROS_ADMIN:    "Karos",
  KAROS_EMPLOYEE: "Karos",
  CLIENT_USER:    "Client",
};

function inferOwner(task: ClientTask): TaskOwner {
  return task.owner ?? (task.source === "manual" ? "client_managed" : "karos_managed");
}

/* ── Artifact section (Review Pending - Flow A & B) ──────────────── */

const VIDEO_EXT = /\.(mp4|webm|mov|m4v)(\?|$)/i;

function ArtifactSection({
  artifact,
  taskType,
  agentName,
  mediaUrl,
}: {
  artifact: string;
  taskType: string;
  agentName?: string;
  /** Visual deliverable (image or video URL) produced by the agent run. */
  mediaUrl?: string | null;
}) {
  const isEmailArtifact = taskType === "integration_action";
  const isVideo = mediaUrl ? VIDEO_EXT.test(mediaUrl) : false;

  return (
    <div className="rounded-md border border-neon/20 bg-neon/[0.03] p-4">
      <div className="mb-3 flex items-center gap-2">
        <div className="flex h-6 w-6 items-center justify-center rounded-[6px] bg-neon/15 text-neon">
          <Icon name={isEmailArtifact ? "Mail" : "FileText"} className="h-3.5 w-3.5" />
        </div>
        <p className="text-xs font-semibold text-neon">
          {isEmailArtifact ? "Draft Email" : "Generated Deliverable"}
        </p>
        {agentName && (
          <span className="ml-auto inline-flex items-center gap-1 rounded-full border border-neon/25 bg-neon/10 px-2 py-0.5 text-[10px] font-medium text-neon">
            <Icon name="Bot" className="h-2.5 w-2.5" />
            {agentName}
          </span>
        )}
      </div>

      {/* Visual deliverable preview (image / video) */}
      {mediaUrl && (
        <div className="mb-3 overflow-hidden rounded-md border border-border bg-surface-2">
          {isVideo ? (
            <video src={mediaUrl} controls className="max-h-72 w-full object-contain" />
          ) : (
            // eslint-disable-next-line @next/next/no-img-element -- remote agent artifact; dimensions unknown
            <img src={mediaUrl} alt="Generated visual" className="max-h-72 w-full object-contain" />
          )}
        </div>
      )}

      <div className="max-h-64 overflow-y-auto rounded-md border border-border bg-surface-2 p-3">
        <pre className="whitespace-pre-wrap font-sans text-xs leading-relaxed text-foreground">
          {normalizeDashes(artifact)}
        </pre>
      </div>
    </div>
  );
}

/* ── Review panel: Approve + Request Adjustments ─────────────────── */

function ReviewPanel({
  taskId,
  clientId,
  taskType,
  failedUpload,
  failedUploadError,
  onApprove,
  onAdjust,
}: {
  taskId: string;
  clientId: string;
  taskType: string;
  failedUpload?: boolean;
  failedUploadError?: string;
  onApprove: () => void;
  onAdjust: (feedback: string) => void;
}) {
  const [showAdjustForm, setShowAdjustForm] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [adjustError, setAdjustError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [autoPublish, setAutoPublish] = useState(false);
  const [approving, startApproveTransition] = useTransition();
  const [adjusting, startAdjustTransition] = useTransition();
  const [publishing, startPublishTransition] = useTransition();
  const isIntegration = taskType === "integration_action";

  function approve() {
    setActionError(null);
    startApproveTransition(async () => {
      const res = await approveTaskArtifactAction(taskId, clientId, { autoPublish });
      if (res.ok) onApprove();
      else setActionError(res.error ?? "Could not approve the deliverable");
    });
  }

  function submitAdjustment(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = feedback.trim();
    if (!trimmed || adjusting) return;
    setAdjustError(null);
    startAdjustTransition(async () => {
      const res = await requestAdjustmentsAction(taskId, clientId, trimmed);
      if (res.ok) {
        onAdjust(trimmed);
        setFeedback("");
        setShowAdjustForm(false);
      } else {
        setAdjustError(res.error ?? "Could not request adjustments");
      }
    });
  }

  function publish() {
    setActionError(null);
    startPublishTransition(async () => {
      const res = await publishIntegrationAction(taskId, clientId);
      if (res.ok) onApprove();
      else setActionError(res.error ?? "Could not send the email");
    });
  }

  return (
    <div className="flex flex-col gap-3">
      {/* Failed upload alert */}
      {failedUpload && (
        <div className="flex items-start gap-2 rounded-md border border-danger/25 bg-danger/10 px-3 py-2">
          <Icon name="TriangleAlert" className="h-3.5 w-3.5 shrink-0 text-danger mt-px" />
          <div className="min-w-0">
            <p className="text-xs font-semibold text-danger">Send failed</p>
            {failedUploadError && (
              <p className="text-[11px] text-danger/70 mt-0.5 break-words">{failedUploadError}</p>
            )}
            <p className="text-[11px] text-muted mt-0.5">
              The Karos team has been alerted. You can retry or approve to archive.
            </p>
          </div>
        </div>
      )}

      {/* Approve / publish failure */}
      {actionError && (
        <div className="flex items-start gap-2 rounded-md border border-danger/25 bg-danger/10 px-3 py-2">
          <Icon name="TriangleAlert" className="h-3.5 w-3.5 shrink-0 text-danger mt-px" />
          <p className="text-xs text-danger break-words">{actionError}</p>
        </div>
      )}

      {/* Pre-approval publish intent (content deliverables only) */}
      {!isIntegration && (
        <label className="flex cursor-pointer items-start gap-2 rounded-md border border-border bg-surface-2 px-3 py-2">
          <input
            type="checkbox"
            checked={autoPublish}
            onChange={(e) => setAutoPublish(e.target.checked)}
            className="mt-0.5 h-3.5 w-3.5 accent-[var(--color-neon,#39d98a)]"
          />
          <span className="min-w-0">
            <span className="block text-xs font-medium text-foreground">
              Auto-publish at the scheduled time
            </span>
            <span className="block text-[11px] text-muted">
              Requires the target channel to be connected with auto-publish enabled - otherwise it
              lands on the calendar, where you open the post and press Publish Now.
            </span>
          </span>
        </label>
      )}

      {/* Primary actions */}
      <div className="flex flex-wrap gap-2">
        {isIntegration ? (
          <button
            onClick={publish}
            disabled={publishing || approving}
            className="flex flex-1 items-center justify-center gap-2 rounded-md bg-neon px-4 py-2.5 text-sm font-semibold text-black transition-opacity disabled:opacity-50"
          >
            {publishing ? (
              <Icon name="Loader" className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Icon name="Send" className="h-3.5 w-3.5" />
            )}
            {publishing ? "Sending…" : "Send Email"}
          </button>
        ) : (
          <button
            onClick={approve}
            disabled={approving || adjusting}
            className="flex flex-1 items-center justify-center gap-2 rounded-md bg-neon px-4 py-2.5 text-sm font-semibold text-black transition-opacity disabled:opacity-50"
          >
            {approving ? (
              <Icon name="Loader" className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Icon name="Check" className="h-3.5 w-3.5" />
            )}
            {approving ? "Approving…" : "Approve & Schedule"}
          </button>
        )}
        <button
          onClick={() => setShowAdjustForm((v) => !v)}
          disabled={approving || adjusting || publishing}
          className="flex items-center gap-1.5 rounded-md border border-border bg-surface-2 px-4 py-2.5 text-sm font-medium text-foreground transition-colors hover:border-border-strong disabled:opacity-50"
        >
          <Icon name="MessageSquare" className="h-3.5 w-3.5" />
          Request Adjustments
        </button>
      </div>

      {/* Adjustment form */}
      {showAdjustForm && (
        <form onSubmit={submitAdjustment} className="flex flex-col gap-2">
          <textarea
            value={feedback}
            onChange={(e) => setFeedback(e.target.value)}
            placeholder="Describe what you'd like changed or improved…"
            rows={3}
            className="w-full resize-none rounded-md border border-border bg-surface-2 px-3 py-2 text-xs text-foreground placeholder:text-muted-2 outline-none focus:border-neon/50 focus:ring-1 focus:ring-neon/30"
          />
          {adjustError && <p className="text-xs text-danger">{adjustError}</p>}
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setShowAdjustForm(false)}
              className="rounded-md border border-border px-3 py-1.5 text-xs text-muted hover:text-foreground"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!feedback.trim() || adjusting}
              className="flex items-center gap-1.5 rounded-md border border-neon/30 bg-neon/10 px-3 py-1.5 text-xs font-medium text-neon transition-colors hover:bg-neon/20 disabled:opacity-40"
            >
              {adjusting ? (
                <Icon name="Loader" className="h-3 w-3 animate-spin" />
              ) : (
                <Icon name="RefreshCw" className="h-3 w-3" />
              )}
              {adjusting ? "Re-running…" : "Re-run"}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

/* ── AI Plan section ─────────────────────────────────────────────── */

function AiPlanSection({
  taskId,
  clientId,
  initialPlan,
}: {
  taskId: string;
  clientId: string;
  initialPlan: string | null;
}) {
  const [plan, setPlan] = useState<string | null>(initialPlan);
  const [isPending, startTransition] = useTransition();
  // A guide the user just asked for opens; one that was already stored starts
  // folded so it cannot push the comment box below the fold.
  const [expanded, setExpanded] = useState(!initialPlan);

  function generate() {
    startTransition(async () => {
      const result = await generateTaskPlanAction(taskId, clientId);
      if (result.plan) {
        setPlan(result.plan);
        setExpanded(true);
      }
    });
  }

  return (
    <div className="rounded-md border border-neon/20 bg-neon/5 p-4">
      <div className="mb-3 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <div className="flex h-6 w-6 items-center justify-center rounded-[6px] bg-neon/15 text-neon">
            <Icon name="Sparkles" className="h-3.5 w-3.5" />
          </div>
          <p className="text-xs font-semibold text-neon">AI Execution Guide</p>
        </div>
        {!plan && !isPending && (
          <button
            onClick={generate}
            className="flex items-center gap-1.5 rounded-md border border-neon/30 bg-neon/10 px-2.5 py-1 text-[11px] font-medium text-neon transition-colors hover:bg-neon/20"
          >
            <Icon name="WandSparkles" className="h-3 w-3" />
            Generate Plan
          </button>
        )}
        {plan && !isPending && (
          <button
            onClick={() => setExpanded((v) => !v)}
            aria-expanded={expanded}
            className="flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium text-muted transition-colors hover:bg-surface-2 hover:text-foreground"
          >
            {expanded ? "Hide" : "Show"}
            <Icon
              name="ChevronDown"
              className={cn("h-3 w-3 transition-transform", expanded && "rotate-180")}
            />
          </button>
        )}
      </div>

      {isPending ? (
        <div className="flex items-center gap-2 py-4 text-xs text-muted">
          <Icon name="Loader" className="h-3.5 w-3.5 animate-spin text-neon" />
          Generating step-by-step execution plan…
        </div>
      ) : plan ? (
        expanded ? (
          <div
            className="max-h-72 overflow-y-auto break-words text-xs leading-relaxed [&_code]:break-all [&_table]:min-w-0"
            // The generating prompt orders "## Overview / ## Prerequisites / …",
            // so this guide is markdown on every generation. renderAssetBody is
            // the entry point for agent output: unlike renderFullDoc it strips no
            // preamble, so a leading heading or `---` rule is rendered, not eaten.
            dangerouslySetInnerHTML={{ __html: renderAssetBody(plan) }}
          />
        ) : (
          <p className="text-xs text-muted">
            Execution guide ready - {countPlanSteps(plan)}. Press Show to read it.
          </p>
        )
      ) : (
        <p className="text-xs text-muted">
          Click &ldquo;Generate Plan&rdquo; to get an AI-recommended step-by-step execution guide for this task.
        </p>
      )}
    </div>
  );
}

/** Folded-state summary line: how much guide is behind the toggle. */
function countPlanSteps(plan: string): string {
  const sections = (plan.match(/^##\s+/gm) ?? []).length;
  if (sections > 0) return `${sections} section${sections === 1 ? "" : "s"}`;
  const words = plan.trim().split(/\s+/).length;
  return `${words} word${words === 1 ? "" : "s"}`;
}

/* ── Comments section ────────────────────────────────────────────── */

function CommentsSection({
  taskId,
  clientId,
}: {
  taskId: string;
  clientId: string;
}) {
  const [comments, setComments] = useState<TaskComment[]>([]);
  // Start as true so the spinner shows immediately on mount - no synchronous setState in effect.
  const [loading, setLoading] = useState(true);
  const [text, setText] = useState("");
  const [isPending, startTransition] = useTransition();
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    getTaskCommentsAction(taskId, clientId).then((res) => {
      setComments(res.comments ?? []);
      setLoading(false);
    });
  }, [taskId, clientId]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [comments]);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = text.trim();
    if (!trimmed || isPending) return;

    const optimistic: TaskComment = {
      id: `opt-${Date.now()}`,
      taskId,
      clientId,
      content: trimmed,
      authorName: "You",
      authorRole: "CLIENT_USER",
      createdAt: Date.now(),
    };
    setComments((prev) => [...prev, optimistic]);
    setText("");

    startTransition(async () => {
      const result = await addTaskCommentAction(taskId, clientId, trimmed);
      if (result.comment) {
        setComments((prev) =>
          prev.map((c) => (c.id === optimistic.id ? result.comment! : c)),
        );
      }
    });
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs font-semibold text-foreground">
        Comments
        {comments.length > 0 && (
          <span className="ml-1.5 rounded-full bg-surface-2 px-1.5 py-0.5 text-[10px] font-normal text-muted">
            {comments.length}
          </span>
        )}
      </p>

      <div className="flex max-h-48 flex-col gap-2 overflow-y-auto">
        {loading ? (
          <div className="flex items-center gap-2 py-2 text-xs text-muted">
            <Icon name="Loader" className="h-3 w-3 animate-spin" />
            Loading comments…
          </div>
        ) : comments.length === 0 ? (
          <p className="text-xs text-muted-2">No comments yet. Start the conversation below.</p>
        ) : (
          comments.map((c) => (
            <div key={c.id} className="flex gap-2.5">
              <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-surface-3 text-[10px] font-semibold text-muted">
                {c.authorName.charAt(0).toUpperCase()}
              </div>
              <div className="flex-1 rounded-md border border-border bg-surface-2 px-3 py-2">
                <div className="mb-0.5 flex items-center gap-2">
                  <span className="text-[11px] font-medium text-foreground">{c.authorName}</span>
                  <span
                    className={cn(
                      "rounded-full border px-1.5 py-px text-[9px] font-semibold",
                      ROLE_BADGE[c.authorRole] ?? ROLE_BADGE.CLIENT_USER,
                    )}
                  >
                    {ROLE_LABEL[c.authorRole] ?? "User"}
                  </span>
                  <span className="ml-auto text-[10px] text-muted-2">{relativeTime(c.createdAt)}</span>
                </div>
                <p className="text-xs leading-relaxed text-foreground">{c.content}</p>
              </div>
            </div>
          ))
        )}
        <div ref={bottomRef} />
      </div>

      <form onSubmit={submit} className="flex gap-2">
        <input
          type="text"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Add a comment…"
          disabled={isPending}
          className="flex-1 rounded-md border border-border bg-surface-2 px-3 py-2 text-xs text-foreground placeholder:text-muted-2 outline-none focus:border-neon/50 focus:ring-1 focus:ring-neon/30 disabled:opacity-50"
        />
        <button
          type="submit"
          disabled={!text.trim() || isPending}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-neon text-black transition-opacity disabled:opacity-40"
        >
          {isPending ? (
            <Icon name="Loader" className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Icon name="Send" className="h-3.5 w-3.5" />
          )}
        </button>
      </form>
    </div>
  );
}

/* ── Main modal ──────────────────────────────────────────────────── */

interface Props {
  task: ClientTask & { _clientName?: string };
  onClose: () => void;
  onStatusChange: (id: string, status: TaskStatus, clientId: string) => void;
  onLocalUpdate: (updated: ClientTask & { _clientName?: string }) => void;
}

export function TaskTicketModal({ task, onClose, onStatusChange, onLocalUpdate }: Props) {
  const src = SOURCE_LABEL[task.source] ?? SOURCE_LABEL.manual;
  const prio = PRIORITY_COLOR[task.priority] ?? PRIORITY_COLOR.low;
  const initialPlan = (task.metadata?.aiPlan as string | undefined) ?? null;
  const artifact = (task.metadata?.artifact as string | undefined) ?? null;
  const taskType = (task.metadata?.type as string | undefined) ?? "content_generation";
  const executingAgentName = (task.metadata?.agentName as string | undefined) ?? undefined;
  const artifactMediaUrl = (task.metadata?.artifactImageUrl as string | undefined) ?? null;
  const isReviewPending = task.status === "review_pending";
  const isExecuting = task.metadata?.executing === true;
  const failedUpload = task.metadata?.failedUpload as boolean | undefined;
  const failedUploadError = task.metadata?.failedUploadError as string | undefined;
  const nextStatus = nextStatusFor(task);
  // The AI plan is a guide for the client to execute the task themselves -
  // not useful for karos_managed tasks our own agents already run.
  const isClientManaged = inferOwner(task) === "client_managed";

  // Close on Escape
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Lock body scroll
  useEffect(() => {
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = "";
    };
  }, []);

  function handleApprove() {
    // The approve/publish server action already completed the task - only
    // reflect it locally (a second updateTaskStatusAction would double-write).
    onLocalUpdate({
      ...task,
      status: "completed",
      completedAt: Date.now(),
      metadata: { ...(task.metadata ?? {}), failedUpload: null },
    });
    onClose();
  }

  function handleAdjust(feedbackText: string) {
    // Optimistically reflect that the task went back to in_progress + executing
    onLocalUpdate({
      ...task,
      status: "in_progress",
      metadata: {
        ...(task.metadata ?? {}),
        executing: true,
        adjustmentFeedback: feedbackText,
      },
    });
    onClose();
  }

  return (
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center p-4"
      aria-modal="true"
      role="dialog"
    >
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={onClose}
      />

      {/* Panel */}
      <div className="relative z-10 flex max-h-[90vh] w-full max-w-[620px] flex-col overflow-hidden rounded-[20px] border border-border bg-surface shadow-2xl">

        {/* Header */}
        <div className="flex shrink-0 items-start justify-between gap-3 border-b border-border bg-surface-2 px-5 py-4">
          <div className="flex-1 min-w-0">
            {/* Badges row */}
            <div className="mb-2 flex flex-wrap items-center gap-1.5">
              <span
                className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium"
                style={{ background: src.color + "1f", color: src.color }}
              >
                {src.label}
              </span>
              <span
                className={cn(
                  "inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold capitalize",
                  prio,
                )}
              >
                {task.priority}
              </span>
              {failedUpload && (
                <span className="inline-flex items-center gap-1 rounded-full border border-danger/30 bg-danger/10 px-2 py-0.5 text-[10px] font-semibold text-danger">
                  <Icon name="TriangleAlert" className="h-2.5 w-2.5" />
                  Send Failed
                </span>
              )}
              <span className="ml-auto flex items-center gap-1 text-[10px] text-muted-2">
                {isExecuting ? (
                  <Icon name="Loader" className="h-3 w-3 animate-spin text-neon" />
                ) : (
                  <Icon name={STATUS_ICON[task.status]} className="h-3 w-3" />
                )}
                {isExecuting ? "AI Working…" : STATUS_LABEL[task.status]}
              </span>
            </div>
            {/* Title */}
            <h2 className="text-base font-semibold leading-snug text-foreground">
              {task.title}
            </h2>
            {task._clientName && (
              <p className="mt-0.5 text-xs text-muted-2">{task._clientName}</p>
            )}
            {task.campaignId && (
              <a
                href={`/campaigns/${task.campaignId}`}
                className="mt-1 inline-flex items-center gap-1 text-xs text-neon hover:underline"
              >
                <Icon name="Boxes" className="h-3 w-3" />
                Part of a campaign - view run
              </a>
            )}
          </div>
          <button
            onClick={onClose}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-muted-2 transition-colors hover:bg-surface-3 hover:text-foreground"
            aria-label="Close"
          >
            <Icon name="X" className="h-4 w-4" />
          </button>
        </div>

        {/* Scrollable body */}
        <div className="flex-1 overflow-y-auto px-5 py-4 flex flex-col gap-5">

          {/* Executing state */}
          {isExecuting && (
            <div className="flex items-center gap-3 rounded-md border border-neon/20 bg-neon/5 px-4 py-3">
              <Icon name="Loader" className="h-5 w-5 animate-spin text-neon" />
              <div>
                <p className="text-sm font-medium text-neon">Karos AI is working on this task</p>
                <p className="text-xs text-muted">
                  The deliverable will appear here when generation is complete.
                </p>
              </div>
            </div>
          )}

          {/* Generated artifact (review_pending only) */}
          {isReviewPending && artifact && !isExecuting && (
            <ArtifactSection
              artifact={artifact}
              taskType={taskType}
              agentName={executingAgentName}
              mediaUrl={artifactMediaUrl}
            />
          )}

          {/* Review / approval panel (review_pending only) */}
          {isReviewPending && !isExecuting && (
            <ReviewPanel
              taskId={task.id}
              clientId={task.clientId}
              taskType={taskType}
              failedUpload={failedUpload}
              failedUploadError={failedUploadError}
              onApprove={handleApprove}
              onAdjust={handleAdjust}
            />
          )}

          {/* Description */}
          {task.description && (
            <div>
              <p className="mb-1 text-[11px] font-mono font-medium uppercase tracking-[0.14em] text-muted-2">Description</p>
              <p className="text-sm leading-relaxed text-foreground">{task.description}</p>
            </div>
          )}

          {/* AI Execution Guide (non-review_pending, client-managed tasks only) */}
          {!isReviewPending && isClientManaged && (
            <AiPlanSection taskId={task.id} clientId={task.clientId} initialPlan={initialPlan} />
          )}

          {/* Divider */}
          <div className="h-px bg-border" />

          {/* Comments */}
          <CommentsSection taskId={task.id} clientId={task.clientId} />
        </div>

        {/* Footer */}
        <div className="flex shrink-0 items-center justify-between gap-3 border-t border-border bg-surface-2 px-5 py-3">
          <p className="text-xs text-muted-2">
            Created {relativeTime(task.createdAt)}
          </p>
          {/* For review_pending, the footer CTA is handled inside ReviewPanel.
              For other states, show the standard "Move to" button. */}
          {!isReviewPending && (
            <button
              onClick={() => {
                onStatusChange(task.id, nextStatus, task.clientId);
                onClose();
              }}
              disabled={isExecuting}
              className="flex items-center gap-1.5 rounded-md border border-border bg-surface-3 px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:border-neon/40 hover:text-neon disabled:opacity-40"
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
              Move to {STATUS_LABEL[nextStatus]}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
