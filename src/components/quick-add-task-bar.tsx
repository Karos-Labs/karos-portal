"use client";

import { useState, useTransition, useRef } from "react";
import { useRouter } from "next/navigation";
import { Icon } from "@/components/icon";
import { cn } from "@/lib/utils";
import { ingestCustomUserTaskAction } from "@/lib/actions";

interface Props {
  clientId: string;
  /** Optional callback fired after a task is successfully added. */
  onAdded?: (owner: string) => void;
  className?: string;
}

export function QuickAddTaskBar({ clientId, onAdded, className }: Props) {
  const router = useRouter();
  const [value, setValue] = useState("");
  const [isPending, startTransition] = useTransition();
  const [feedback, setFeedback] = useState<{ type: "success" | "error"; message: string } | null>(
    null,
  );
  const inputRef = useRef<HTMLInputElement>(null);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = value.trim();
    if (!trimmed || isPending) return;

    setFeedback(null);
    startTransition(async () => {
      const result = await ingestCustomUserTaskAction(clientId, trimmed);
      if (result.ok) {
        const label =
          result.owner === "karos_managed" ? "AI-managed task added" : "Action item added";
        setFeedback({ type: "success", message: label });
        setValue("");
        router.refresh();
        onAdded?.(result.owner ?? "client_managed");
        // Clear success feedback after 3 s
        setTimeout(() => setFeedback(null), 3000);
      } else {
        setFeedback({ type: "error", message: result.error ?? "Failed to add task" });
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
        className="flex items-center gap-2 rounded-[12px] border border-border bg-surface-2 px-3 py-2.5 transition-colors focus-within:border-neon/50 focus-within:ring-1 focus-within:ring-neon/20"
      >
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-[8px] bg-purple-500/10 text-purple-400">
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
          className="flex h-7 items-center gap-1.5 rounded-[8px] bg-neon px-3 text-xs font-semibold text-black transition-opacity disabled:opacity-40 hover:opacity-90"
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
            "flex items-center gap-2 rounded-[8px] px-3 py-1.5 text-xs",
            feedback.type === "success"
              ? "border border-neon/20 bg-neon/5 text-neon"
              : "border border-red-500/20 bg-red-500/5 text-red-400",
          )}
        >
          <Icon
            name={feedback.type === "success" ? "CheckCircle" : "TriangleAlert"}
            className="h-3.5 w-3.5 shrink-0"
          />
          {feedback.message}
        </div>
      )}
    </div>
  );
}
