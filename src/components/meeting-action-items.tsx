"use client";

import { useState, useMemo } from "react";
import { Icon } from "@/components/icon";
import { cn } from "@/lib/utils";
import { toggleActionItemCompletionAction, setActionItemOwnerAction } from "@/lib/actions";
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
  /** All system users for the owner dropdown (staff-only). */
  users?: AppUser[];
  /** Called after the meeting is auto-archived (all items done). */
  onAutoArchived?: () => void;
}

export function MeetingActionItems({
  transcriptId,
  actionItems,
  actionItemOwners,
  actionItemUserMap = {},
  completedItems: initialCompleted = [],
  users = [],
  onAutoArchived,
}: Props) {
  const [completed, setCompleted] = useState<Set<number>>(new Set(initialCompleted));
  const [owners, setOwners] = useState<(string | null)[]>(actionItemOwners);
  const [pendingToggle, setPendingToggle] = useState<Set<number>>(new Set());
  const [pendingOwner, setPendingOwner] = useState<Set<number>>(new Set());

  if (actionItems.length === 0) {
    return <p className="text-sm text-muted-2">None extracted.</p>;
  }

  // Group item indices by owner for display
  const groups = useMemo(() => {
    const map = new Map<string, number[]>();
    owners.forEach((owner, i) => {
      const key = owner ?? "Unassigned";
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(i);
    });
    // Sort: named owners first, Unassigned last
    return Array.from(map.entries()).sort(([a], [b]) => {
      if (a === "Unassigned") return 1;
      if (b === "Unassigned") return -1;
      return a.localeCompare(b);
    });
  }, [owners]);

  async function handleToggle(index: number) {
    if (pendingToggle.has(index)) return;
    const nowDone = !completed.has(index);
    const next = new Set(completed);
    if (nowDone) next.add(index); else next.delete(index);
    setCompleted(next);
    setPendingToggle((s) => new Set(s).add(index));
    try {
      const { allDone } = await toggleActionItemCompletionAction(transcriptId, index, nowDone);
      if (allDone) onAutoArchived?.();
    } catch {
      // Revert this item's toggle using a functional updater to avoid a stale-closure read
      setCompleted((prev) => {
        const r = new Set(prev);
        if (nowDone) r.delete(index); else r.add(index);
        return r;
      });
    } finally {
      setPendingToggle((s) => { const n = new Set(s); n.delete(index); return n; });
    }
  }

  async function handleOwnerChange(index: number, ownerName: string | null) {
    if (pendingOwner.has(index)) return;
    const prev = [...owners];
    const next = [...owners];
    next[index] = ownerName;
    setOwners(next);
    setPendingOwner((s) => new Set(s).add(index));
    try {
      await setActionItemOwnerAction(transcriptId, index, ownerName);
    } catch {
      setOwners(prev);
    } finally {
      setPendingOwner((s) => { const n = new Set(s); n.delete(index); return n; });
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
          pendingToggle={pendingToggle}
          pendingOwner={pendingOwner}
          users={users}
          actionItemUserMap={actionItemUserMap}
          onToggle={handleToggle}
          onOwnerChange={handleOwnerChange}
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
  pendingToggle,
  pendingOwner,
  users,
  actionItemUserMap,
  onToggle,
  onOwnerChange,
}: {
  ownerName: string;
  indices: number[];
  actionItems: string[];
  completed: Set<number>;
  owners: (string | null)[];
  pendingToggle: Set<number>;
  pendingOwner: Set<number>;
  users: AppUser[];
  actionItemUserMap: Record<string, string>;
  onToggle: (i: number) => void;
  onOwnerChange: (i: number, owner: string | null) => void;
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
            currentOwner={owners[i]}
            done={completed.has(i)}
            pendingToggle={pendingToggle.has(i)}
            pendingOwner={pendingOwner.has(i)}
            users={users}
            onToggle={onToggle}
            onOwnerChange={onOwnerChange}
          />
        ))}
      </ul>
    </div>
  );
}

function ActionItem({
  index,
  text,
  currentOwner,
  done,
  pendingToggle,
  pendingOwner,
  users,
  onToggle,
  onOwnerChange,
}: {
  index: number;
  text: string;
  currentOwner: string | null;
  done: boolean;
  pendingToggle: boolean;
  pendingOwner: boolean;
  users: AppUser[];
  onToggle: (i: number) => void;
  onOwnerChange: (i: number, owner: string | null) => void;
}) {
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

      {/* Owner dropdown — only rendered when users list is provided */}
      {users.length > 0 && (
        <select
          value={currentOwner ?? ""}
          onChange={(e) => onOwnerChange(index, e.target.value || null)}
          disabled={pendingOwner}
          className="ml-1 h-6 shrink-0 rounded-[6px] border border-border bg-surface-2 px-1.5 text-[11px] text-muted outline-none focus:border-neon/50 disabled:opacity-50"
          aria-label="Assign owner"
        >
          <option value="">Unassigned</option>
          {users.map((u) => (
            <option key={u.uid} value={u.name ?? u.email}>
              {u.name ?? u.email}
            </option>
          ))}
        </select>
      )}
    </li>
  );
}
