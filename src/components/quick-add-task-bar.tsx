"use client";

import { useState, useTransition, useRef } from "react";
import { useRouter } from "next/navigation";
import { Icon } from "@/components/icon";
import { cn } from "@/lib/utils";
import { ingestCustomUserTaskAction } from "@/lib/actions";
import type { TaskOwner } from "@/lib/types";

interface Props {
  clientId: string;
  /**
   * Fired after a task is successfully added, with the owner the ROUTER chose.
   * The typed text goes through a model that decides between the two owners; the
   * user does not pick, so the caller is the only thing that can put the board
   * on the tab the new card actually landed on.
   *
   * Typed `TaskOwner`, not `string`: the mapping to a board tab has to be total,
   * and it cannot be if the value is any string at all.
   */
  onAdded?: (owner: TaskOwner) => void;
  className?: string;
}

export function QuickAddTaskBar({ clientId, onAdded, className }: Props) {
  const router = useRouter();
  const [value, setValue] = useState("");
  const [isPending, startTransition] = useTransition();
  // "info" is the duplicate case: nothing failed, the work is already on the
  // board — it used to render in the red danger style (QA F61).
  const [feedback, setFeedback] = useState<{
    type: "success" | "info" | "error";
    message: string;
  } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = value.trim();
    if (!trimmed || isPending) return;

    setFeedback(null);
    startTransition(async () => {
      const result = await ingestCustomUserTaskAction(clientId, trimmed);
      if (result.ok) {
        // Name the card that was actually created — the router rewrites the
        // text the user typed (QA F65). The board is already on screen here,
        // so no link is needed.
        const label = result.title
          ? `Added “${result.title}”`
          : result.owner === "karos_managed"
            ? "AI-managed task added"
            : "Action item added";
        setFeedback({ type: "success", message: label });
        setValue("");
        router.refresh();
        onAdded?.(result.owner ?? "client_managed");
        // Clear success feedback after 3 s
        setTimeout(() => setFeedback(null), 3000);
      } else {
        setFeedback({
          type: result.duplicate ? "info" : "error",
          message: result.error ?? "Failed to add task",
        });
      }
    });
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit(e as unknown as React.FormEvent);
    }
    if (e.key === "Escape") {
      setValue("");
      setFeedback(null);
      inputRef.current?.blur();
    }
  }

  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <form
        onSubmit={handleSubmit}
        className="flex items-center gap-2 rounded-md border border-border bg-surface-2 px-3 py-2.5 transition-colors focus-within:border-foreground/25"
      >
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-neon-soft text-neon">
          <Icon name="Plus" className="h-3.5 w-3.5" />
        </span>
        <input
          ref={inputRef}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Describe a task you need done…"
          disabled={isPending}
          maxLength={1000}
          className="flex-1 bg-transparent text-sm text-foreground placeholder:text-muted-2 outline-none disabled:opacity-50"
        />
        <button
          type="submit"
          disabled={!value.trim() || isPending}
          className="flex h-7 items-center gap-1.5 rounded-md bg-primary px-3 text-xs font-semibold text-primary-foreground transition-opacity disabled:opacity-40 hover:opacity-90"
          aria-label="Add task"
        >
          {isPending ? (
            <Icon name="Loader" className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <>
              <Icon name="Sparkles" className="h-3 w-3" />
              Add
            </>
          )}
        </button>
      </form>

      {feedback && (
        <div
          className={cn(
            "flex items-center gap-2 rounded-md px-3 py-1.5 text-xs",
            feedback.type === "success"
              ? "border border-success/25 bg-success/10 text-success"
              : feedback.type === "info"
                ? "border border-border bg-surface-2 text-muted"
                : "border border-danger/20 bg-danger/5 text-danger",
          )}
        >
          <Icon
            name={
              feedback.type === "success"
                ? "CircleCheck"
                : feedback.type === "info"
                  ? "Info"
                  : "TriangleAlert"
            }
            className="h-3.5 w-3.5 shrink-0"
          />
          {feedback.message}
        </div>
      )}
    </div>
  );
}
