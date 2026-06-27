"use client";

import { useState, useMemo } from "react";
import { Icon } from "@/components/icon";
import { cn } from "@/lib/utils";
import {
  toggleActionItemCompletionAction,
  assignActionItemToUserAction,
} from "@/lib/actions";
import type { AppUser } from "@/lib/types";

interface Props {
  transcriptId: string;
  actionItems: string[];
  /** Per-item owner names, parallel to actionItems[]. null = unassigned. */
  actionItemOwners: (string | null)[];
  /** ownerName → userId for auto-matched users. */
  actionItemUserMap?: Record<string, string>;
  /** Persisted completed item indices. */
  completedItems?: number[];
  /** Per-item explicit user-ID assignment, parallel to actionItems[]. */
  actionItemAssignedUserIds?: (string | null)[];
  /** All eligible users for the assignment dropdown. */
  users?: AppUser[];
  /** UID of the currently logged-in user (for "Assign to me"). */
  currentUserId?: string;
  /** Called after the meeting is auto-archived (all items done). */
  onAutoArchived?: () => void;
}

export function MeetingActionItems({
  transcriptId,
  actionItems,
  actionItemOwners,
  actionItemUserMap = {},
  completedItems: initialCompleted = [],
  actionItemAssignedUserIds: initialAssignedIds = [],
  users = [],
  currentUserId,
  onAutoArchived,
}: Props) {
  const [completed, setCompleted] = useState<Set<number>>(new Set(initialCompleted));
  // owners drives the visual grouping (display names)
  const [owners, setOwners] = useState<(string | null)[]>(actionItemOwners);
  // assignedIds drives the notification system (user IDs)
  const [assignedIds, setAssignedIds] = useState<(string | null)[]>(() => {
    const base = [...initialAssignedIds];
    while (base.length < actionItems.length) base.push(null);
    return base;
  });
  const [pendingToggle, setPendingToggle] = useState<Set<number>>(new Set());
  const [pendingAssign, setPendingAssign] = useState<Set<number>>(new Set());

  // Group item indices by owner name for display (must precede any early return — hooks must not be conditional)
  const groups = useMemo(() => {
    const map = new Map<string, number[]>();
    owners.forEach((owner, i) => {
      const key = owner ?? "Unassigned";
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(i);
    });
    return Array.from(map.entries()).sort(([a], [b]) => {
      if (a === "Unassigned") return 1;
      if (b === "Unassigned") return -1;
      return a.localeCompare(b);
    });
  }, [owners]);

  if (actionItems.length === 0) {
    return <p className="text-sm text-muted-2">None extracted.</p>;
  }

  async function handleToggle(index: number) {
    if (pendingToggle.has(index)) return;
    const nowDone = !completed.has(index);
    setCompleted((prev) => {
      const next = new Set(prev);
      if (nowDone) next.add(index); else next.delete(index);
      return next;
    });
    setPendingToggle((s) => new Set(s).add(index));
    try {
      const { allDone } = await toggleActionItemCompletionAction(transcriptId, index, nowDone);
      if (allDone) onAutoArchived?.();
    } catch {
      setCompleted((prev) => {
        const r = new Set(prev);
        if (nowDone) r.delete(index); else r.add(index);
        return r;
      });
    } finally {
      setPendingToggle((s) => { const n = new Set(s); n.delete(index); return n; });
    }
  }

  async function handleAssign(index: number, userId: string | null) {
    if (pendingAssign.has(index)) return;
    // Optimistic update: resolve display name from users list
    const targetUser = userId ? users.find((u) => u.uid === userId) : null;
    const displayName = targetUser ? (targetUser.name ?? targetUser.email) : null;
    setOwners((prev) => { const n = [...prev]; n[index] = displayName; return n; });
    setAssignedIds((prev) => { const n = [...prev]; n[index] = userId; return n; });
    setPendingAssign((s) => new Set(s).add(index));
    try {
      await assignActionItemToUserAction(transcriptId, index, userId);
    } catch {
      // Revert both pieces of state on failure
      setOwners((prev) => { const n = [...prev]; n[index] = actionItemOwners[index] ?? null; return n; });
      setAssignedIds((prev) => { const n = [...prev]; n[index] = initialAssignedIds[index] ?? null; return n; });
    } finally {
      setPendingAssign((s) => { const n = new Set(s); n.delete(index); return n; });
    }
  }

  const doneCount = completed.size;
  const total = actionItems.length;

  return (
    <div className="space-y-5">
      {/* Progress bar */}
      {total > 0 && (
        <div className="flex items-center gap-2">
          <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-3">
            <div
              className="h-full rounded-full bg-neon transition-all duration-300"
              style={{ width: `${(doneCount / total) * 100}%` }}
            />
          </div>
          <span className="shrink-0 text-xs text-muted-2">{doneCount}/{total}</span>
        </div>
      )}

      {groups.map(([ownerName, indices]) => (
        <OwnerGroup
          key={ownerName}
          ownerName={ownerName}
          indices={indices}
          actionItems={actionItems}
          completed={completed}
          owners={owners}
          assignedIds={assignedIds}
          pendingToggle={pendingToggle}
          pendingAssign={pendingAssign}
          users={users}
          currentUserId={currentUserId}
          actionItemUserMap={actionItemUserMap}
          onToggle={handleToggle}
          onAssign={handleAssign}
        />
      ))}
    </div>
  );
}

function OwnerGroup({
  ownerName,
  indices,
  actionItems,
  completed,
  owners,
  assignedIds,
  pendingToggle,
  pendingAssign,
  users,
  currentUserId,
  actionItemUserMap,
  onToggle,
  onAssign,
}: {
  ownerName: string;
  indices: number[];
  actionItems: string[];
  completed: Set<number>;
  owners: (string | null)[];
  assignedIds: (string | null)[];
  pendingToggle: Set<number>;
  pendingAssign: Set<number>;
  users: AppUser[];
  currentUserId?: string;
  actionItemUserMap: Record<string, string>;
  onToggle: (i: number) => void;
  onAssign: (i: number, uid: string | null) => void;
}) {
  const doneCount = indices.filter((i) => completed.has(i)).length;
  const allDone = doneCount === indices.length;
  const userId = ownerName !== "Unassigned" ? actionItemUserMap[ownerName] : undefined;
  const matchedUser = users.find((u) => u.uid === userId);

  return (
    <div>
      <div className="mb-2 flex items-center gap-2">
        <div
          className={cn(
            "flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold",
            allDone ? "bg-neon/20 text-neon" : "bg-surface-3 text-muted",
          )}
        >
          {(ownerName[0] ?? "?").toUpperCase()}
        </div>
        <p className="text-xs font-semibold text-foreground">{ownerName}</p>
        {matchedUser && (
          <span className="rounded-full bg-neon-soft/40 px-1.5 py-0.5 text-[10px] text-neon">
            {matchedUser.name ?? matchedUser.email}
          </span>
        )}
        <span className="text-xs text-muted-2">{doneCount}/{indices.length}</span>
      </div>
      <ul className="space-y-2 pl-7">
        {indices.map((i) => (
          <ActionItem
            key={i}
            index={i}
            text={actionItems[i]}
            assignedUserId={assignedIds[i]}
            done={completed.has(i)}
            pendingToggle={pendingToggle.has(i)}
            pendingAssign={pendingAssign.has(i)}
            users={users}
            currentUserId={currentUserId}
            onToggle={onToggle}
            onAssign={onAssign}
          />
        ))}
      </ul>
    </div>
  );
}

function ActionItem({
  index,
  text,
  assignedUserId,
  done,
  pendingToggle,
  pendingAssign,
  users,
  currentUserId,
  onToggle,
  onAssign,
}: {
  index: number;
  text: string;
  assignedUserId: string | null;
  done: boolean;
  pendingToggle: boolean;
  pendingAssign: boolean;
  users: AppUser[];
  currentUserId?: string;
  onToggle: (i: number) => void;
  onAssign: (i: number, uid: string | null) => void;
}) {
  // Build the dropdown options.
  // Always show "Assign to me" if the current user isn't already in the list.
  const options = users;
  const showDropdown = users.length > 0 || !!currentUserId;

  return (
    <li className="flex min-w-0 items-start gap-2 text-sm">
      {/* Checkbox */}
      <button
        onClick={() => onToggle(index)}
        disabled={pendingToggle}
        className="mt-0.5 shrink-0 disabled:opacity-50"
        aria-label={done ? "Mark incomplete" : "Mark complete"}
      >
        <Icon
          name={pendingToggle ? "Loader" : done ? "SquareCheck" : "Square"}
          className={cn(
            "h-4 w-4 transition-colors",
            pendingToggle && "animate-spin",
            done ? "text-neon" : "text-muted-2",
          )}
        />
      </button>

      {/* Task text */}
      <span
        className={cn(
          "min-w-0 flex-1 break-words text-muted transition-opacity select-none",
          done && "line-through opacity-50",
        )}
      >
        {text}
      </span>

      {/* Assignee dropdown — visible when there are users to choose from */}
      {showDropdown && (
        <select
          value={assignedUserId ?? ""}
          onChange={(e) => onAssign(index, e.target.value || null)}
          disabled={pendingAssign || done}
          className={cn(
            "ml-1 h-6 max-w-[130px] shrink-0 truncate rounded-[6px] border border-border",
            "bg-surface-2 px-1.5 text-[11px] text-muted outline-none",
            "focus:border-neon/50 disabled:opacity-50",
            assignedUserId && "border-neon/30 text-neon",
          )}
          aria-label="Assign to user"
        >
          <option value="">Unassigned</option>
          {/* "Assign to me" shortcut when current user is not in the list */}
          {currentUserId && !options.find((u) => u.uid === currentUserId) && (
            <option value={currentUserId}>Assign to me</option>
          )}
          {options.map((u) => (
            <option key={u.uid} value={u.uid}>
              {u.uid === currentUserId ? `Me (${u.name ?? u.email})` : (u.name ?? u.email)}
            </option>
          ))}
        </select>
      )}
    </li>
  );
}
