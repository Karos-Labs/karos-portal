"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Card, CardTitle, Badge, EmptyState } from "@/components/ui";
import { Icon } from "@/components/icon";
import { cn, relativeTime, formatDateTime } from "@/lib/utils";
import { ACTION_ITEM_STATUS_LABELS, ACTION_ITEM_STATUSES } from "@/lib/constants";
import {
  setActionItemStatusAction,
  reassignActionItemAction,
  addActionItemCommentAction,
} from "@/lib/actions";
import type { ActionItem, ActionItemStatus, AppUser, Client } from "@/lib/types";

interface Props {
  /** Managed action items assigned to the current user. */
  items: ActionItem[];
  /** Staff users eligible as reassignment targets. */
  users: AppUser[];
  clients: Client[];
  currentUserId: string;
}

type Filter = "active" | "done";

export function MyActionItems({ items: initialItems, users, clients, currentUserId }: Props) {
  const router = useRouter();
  const [items, setItems] = useState<ActionItem[]>(initialItems);
  const [filter, setFilter] = useState<Filter>("active");
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const visible = useMemo(
    () =>
      items.filter((i) =>
        // Reassigned items drop out of "my" list immediately.
        i.assigneeUserId === currentUserId &&
        (filter === "done" ? i.status === "done" : i.status !== "done"),
      ),
    [items, filter, currentUserId],
  );
  const activeCount = items.filter((i) => i.assigneeUserId === currentUserId && i.status !== "done").length;
  const doneCount = items.filter((i) => i.assigneeUserId === currentUserId && i.status === "done").length;

  const clientName = (id?: string | null) => clients.find((c) => c.id === id)?.name;

  function patchItem(id: string, patch: Partial<ActionItem>) {
    setItems((prev) => prev.map((i) => (i.id === id ? { ...i, ...patch } : i)));
  }

  return (
    <Card>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <CardTitle>My action items</CardTitle>
          <span className="rounded-full bg-neon/15 px-2 py-0.5 text-[11px] font-semibold text-neon">
            {activeCount} open
          </span>
        </div>
        <div className="flex items-center gap-1">
          {(["active", "done"] as Filter[]).map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={cn(
                "rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
                filter === f ? "bg-surface-3 text-foreground" : "text-muted hover:text-foreground",
              )}
            >
              {f === "active" ? `Active (${activeCount})` : `Done (${doneCount})`}
            </button>
          ))}
        </div>
      </div>

      {visible.length === 0 ? (
        <EmptyState
          icon={<Icon name="ClipboardCheck" className="h-6 w-6" />}
          title={filter === "done" ? "Nothing completed yet" : "No open action items"}
          description={
            filter === "done"
              ? "Items you mark Done will appear here."
              : "Action items assigned to you from meetings will appear here."
          }
        />
      ) : (
        <ul className="divide-y divide-border">
          {visible.map((item) => (
            <ActionItemRow
              key={item.id}
              item={item}
              users={users}
              clientName={clientName(item.clientId)}
              currentUserId={currentUserId}
              expanded={expandedId === item.id}
              onToggleExpand={() => setExpandedId((cur) => (cur === item.id ? null : item.id))}
              onPatched={(patch) => {
                patchItem(item.id, patch);
                router.refresh();
              }}
            />
          ))}
        </ul>
      )}
    </Card>
  );
}

/* ── single row ─────────────────────────────────────────────────── */

function ActionItemRow({
  item,
  users,
  clientName,
  currentUserId,
  expanded,
  onToggleExpand,
  onPatched,
}: {
  item: ActionItem;
  users: AppUser[];
  clientName?: string;
  currentUserId: string;
  expanded: boolean;
  onToggleExpand: () => void;
  onPatched: (patch: Partial<ActionItem>) => void;
}) {
  const [pending, setPending] = useState(false);
  const [comment, setComment] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function run(fn: () => Promise<Partial<ActionItem> | void>) {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      const patch = await fn();
      if (patch) onPatched(patch);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong");
    } finally {
      setPending(false);
    }
  }

  async function handleStatus(status: ActionItemStatus) {
    await run(async () => {
      await setActionItemStatusAction(item.id, status);
      return { status };
    });
  }

  async function handleReassign(userId: string) {
    await run(async () => {
      const target = users.find((u) => u.uid === userId);
      await reassignActionItemAction(item.id, userId || null);
      return {
        assigneeUserId: userId || null,
        assigneeName: target ? (target.name ?? target.email) : null,
      };
    });
  }

  async function handleComment() {
    const text = comment.trim();
    if (!text) return;
    await run(async () => {
      const saved = await addActionItemCommentAction(item.id, text);
      setComment("");
      return { comments: [...item.comments, saved] };
    });
  }

  return (
    <li className="py-3">
      <div className="flex min-w-0 flex-wrap items-start gap-2">
        {/* Status */}
        <select
          value={item.status}
          onChange={(e) => handleStatus(e.target.value as ActionItemStatus)}
          disabled={pending}
          aria-label="Status"
          className={cn(
            "h-7 shrink-0 rounded-md border border-border bg-surface-2 px-1.5 text-[11px] outline-none",
            "focus:border-neon/50 disabled:opacity-50",
            item.status === "done" ? "border-neon/30 text-neon" : "text-muted",
          )}
        >
          {ACTION_ITEM_STATUSES.map((s) => (
            <option key={s} value={s}>{ACTION_ITEM_STATUS_LABELS[s]}</option>
          ))}
        </select>

        {/* Text + meta */}
        <div className="min-w-0 flex-1">
          <p
            className={cn(
              "break-words text-sm text-foreground",
              item.status === "done" && "line-through opacity-60",
            )}
          >
            {item.text}
          </p>
          <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-2">
            <Link href={`/transcripts/${item.transcriptId}`} className="inline-flex items-center gap-1 hover:text-neon">
              <Icon name="Mic" className="h-3 w-3" />
              <span className="max-w-[220px] truncate">{item.transcriptTitle}</span>
            </Link>
            {clientName && <Badge tone="neutral">{clientName}</Badge>}
            <span>{relativeTime(item.meetingDate ?? item.createdAt)}</span>
          </p>
        </div>

        {/* Reassign */}
        <select
          value={item.assigneeUserId ?? ""}
          onChange={(e) => handleReassign(e.target.value)}
          disabled={pending}
          aria-label="Reassign"
          className="h-7 max-w-[150px] shrink-0 truncate rounded-md border border-border bg-surface-2 px-1.5 text-[11px] text-muted outline-none focus:border-neon/50 disabled:opacity-50"
        >
          <option value="">Unassigned</option>
          {users.map((u) => (
            <option key={u.uid} value={u.uid}>
              {u.uid === currentUserId ? `Me (${u.name ?? u.email})` : (u.name ?? u.email)}
            </option>
          ))}
        </select>

        {/* Expand */}
        <button
          onClick={onToggleExpand}
          className="flex h-7 shrink-0 items-center gap-1 rounded-md border border-border px-2 text-[11px] text-muted transition-colors hover:border-neon/40 hover:text-foreground"
          aria-expanded={expanded}
        >
          <Icon name="MessageSquare" className="h-3 w-3" />
          {item.comments.length}
          <Icon name={expanded ? "ChevronUp" : "ChevronDown"} className="h-3 w-3" />
        </button>
      </div>

      {error && <p className="mt-1.5 text-xs text-red-400">{error}</p>}

      {expanded && (
        <div className="mt-3 space-y-4 rounded-lg border border-border bg-surface-2/40 p-3">
          {/* Comments */}
          <div>
            <p className="mb-2 text-xs font-semibold text-foreground">Comments</p>
            {item.comments.length === 0 ? (
              <p className="text-xs text-muted-2">No comments yet.</p>
            ) : (
              <ul className="space-y-2">
                {item.comments.map((c) => (
                  <li key={c.id} className="text-xs">
                    <span className="font-medium text-foreground">{c.authorName}</span>
                    <span className="ml-2 text-muted-2">{relativeTime(c.createdAt)}</span>
                    <p className="mt-0.5 whitespace-pre-wrap break-words text-muted">{c.text}</p>
                  </li>
                ))}
              </ul>
            )}
            <div className="mt-2 flex items-start gap-2">
              <textarea
                value={comment}
                onChange={(e) => setComment(e.target.value)}
                placeholder="Add a note…"
                rows={2}
                disabled={pending}
                className="min-h-[36px] flex-1 rounded-md border border-border bg-surface-2 px-2 py-1.5 text-xs text-foreground outline-none placeholder:text-muted-2 focus:border-neon/50 disabled:opacity-50"
              />
              <button
                onClick={handleComment}
                disabled={pending || !comment.trim()}
                className="flex h-7 items-center gap-1 rounded-md border border-neon/40 px-2.5 text-[11px] font-medium text-neon transition-colors hover:bg-neon-soft/30 disabled:opacity-50"
              >
                {pending ? <Icon name="Loader" className="h-3 w-3 animate-spin" /> : <Icon name="Send" className="h-3 w-3" />}
                Post
              </button>
            </div>
          </div>

          {/* History / audit trail */}
          <div>
            <p className="mb-2 text-xs font-semibold text-foreground">History</p>
            <ul className="space-y-1.5">
              {[...item.history].sort((a, b) => a.at - b.at).map((h, i) => (
                <li key={i} className="flex items-start gap-2 text-xs text-muted">
                  <span
                    className={cn(
                      "mt-1 h-1.5 w-1.5 shrink-0 rounded-full",
                      h.type === "created" ? "bg-neon" : "bg-muted-2",
                    )}
                  />
                  <span className="min-w-0 flex-1 break-words">{h.detail}</span>
                  <span className="shrink-0 text-muted-2" title={formatDateTime(h.at)}>
                    {relativeTime(h.at)}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </li>
  );
}
