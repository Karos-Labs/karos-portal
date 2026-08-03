import { Icon } from "@/components/icon";
import { cn } from "@/lib/utils";
import { normalizeDashes } from "@/lib/text-utils";
import type { ClientTask } from "@/lib/types";

const ROLE_ICON: Record<string, string> = {
  anchor: "Newspaper",
  distribution: "Mail",
  social: "Share2",
};

type StepTone = "done" | "review" | "active" | "failed" | "waiting" | "idle";

function stepTone(task: ClientTask, blocked: boolean): StepTone {
  if (task.status === "completed") return "done";
  if (task.status === "review_pending") return "review";
  if (task.metadata?.executing === true || task.status === "in_progress") return "active";
  if (task.metadata?.executionError) return "failed";
  if (blocked) return "waiting";
  return "idle";
}

const TONE_LABEL: Record<StepTone, string> = {
  done: "Completed",
  review: "Ready for review",
  active: "Working",
  failed: "Failed",
  waiting: "Waiting",
  idle: "Not started",
};

const TONE_ICON: Record<StepTone, string> = {
  done: "CircleCheckBig",
  review: "Eye",
  active: "Bot",
  failed: "CircleAlert",
  waiting: "Clock",
  idle: "Circle",
};

const TONE_CHIP: Record<StepTone, string> = {
  done: "border-success/40 bg-success/10 text-success",
  review: "border-info/40 bg-info/10 text-info",
  active: "border-info/40 bg-info/10 text-info",
  failed: "border-danger/40 bg-danger/10 text-danger",
  waiting: "border-border-strong bg-surface-2 text-muted",
  idle: "border-border bg-surface-2 text-muted-2",
};

/**
 * Data-driven step-by-step progress bar for a Campaign run - one step per
 * dependency-wired task (anchor → newsletter → socials), each colored by its
 * OWN task status rather than a fixed 3-phase job strip (see
 * ManagedJobProgress, which this generalizes for a multi-task run). Pure
 * render from the tasks the caller already fetched - no data fetching here.
 */
export function CampaignStepProgress({ tasks }: { tasks: ClientTask[] }) {
  const tasksById = new Map(tasks.map((t) => [t.id, t]));

  return (
    <div className="mb-6 space-y-2 rounded-[var(--radius)] border border-border bg-surface p-4">
      {tasks.map((task, i) => {
        const blockers = (task.dependsOnTaskIds ?? [])
          .map((id) => tasksById.get(id))
          .filter((dep): dep is ClientTask => !!dep)
          .filter((dep) => dep.status !== "review_pending" && dep.status !== "completed");
        const tone = stepTone(task, blockers.length > 0);
        const roleIcon = ROLE_ICON[(task.metadata?.campaignRole as string) ?? ""] ?? "FileText";

        return (
          <div key={task.id} className="flex items-start gap-3">
            <div className="flex flex-col items-center">
              <div
                className={cn(
                  "flex h-8 w-8 shrink-0 items-center justify-center rounded-full border",
                  TONE_CHIP[tone],
                )}
              >
                <Icon
                  name={tone === "idle" ? roleIcon : TONE_ICON[tone]}
                  className={cn("h-4 w-4", tone === "active" && "animate-pulse")}
                />
              </div>
              {i < tasks.length - 1 && <div className="my-1 h-6 w-px bg-border" />}
            </div>
            <div className="min-w-0 flex-1 pb-2">
              <div className="flex flex-wrap items-center gap-2">
                <p className="truncate text-sm font-medium text-foreground">{task.title}</p>
                <span
                  className={cn(
                    "shrink-0 rounded-[4px] border px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-[0.08em]",
                    TONE_CHIP[tone],
                  )}
                >
                  {TONE_LABEL[tone]}
                </span>
              </div>
              {tone === "waiting" && blockers.length > 0 && (
                <p className="mt-0.5 text-xs text-muted-2">
                  Waiting on &quot;{blockers[0].title}&quot;
                </p>
              )}
              {tone === "failed" && task.metadata?.executionError ? (
                <p className="mt-0.5 truncate text-xs text-danger">
                  {normalizeDashes(String(task.metadata.executionError))}
                </p>
              ) : null}
            </div>
          </div>
        );
      })}
    </div>
  );
}
