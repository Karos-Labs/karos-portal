import { Icon } from "@/components/icon";
import { jobStatusLabel } from "@/lib/job-status-copy";
import type { JobStatus } from "@/lib/types";
import { cn } from "@/lib/utils";

/**
 * The ladder, as STATES — no words of its own.
 *
 * It carried three: "Queued", "Agent working", "Ready for review", against the
 * register's "Queued", "Running", "In review". Two of the three disagreed, and
 * the strip is not somewhere obscure — legacy-agent-panel mounts it on a
 * client's own agent page while that run's `JobStatusBadge` is a scroll away on
 * the same screen, so one run state read two ways at once.
 *
 * ICONS STAY HERE, words do not: presentation belongs to the component and the
 * name of a state does not, the same split `asset-status-copy` and
 * `calendar-kind` made when they took the words and left the classes.
 *
 * The `satisfies` is what makes each key a real run state rather than a string
 * that looks like one. Without it a mis-spelled key still compiles, and
 * `jobStatusLabel`'s fallback would quietly paint that step "Queued" — a wrong
 * word arriving through a typo instead of through a second map.
 */
const STEPS = [
  { key: "queued", icon: "Clock" },
  { key: "running", icon: "Bot" },
  { key: "review", icon: "CircleCheckBig" },
] as const satisfies readonly { key: JobStatus; icon: string }[];

/**
 * Three-step progress strip for managed (agent-service) jobs. Server-safe —
 * pure render from the job status; the page's AutoRefresh keeps it live.
 */
export function ManagedJobProgress({
  status,
  className,
}: {
  status: JobStatus;
  /** Overrides the standalone strip's chrome when it sits inside a list row. */
  className?: string;
}) {
  const failed = status === "failed";
  const cancelled = status === "cancelled";
  // Neither a failed nor a cancelled managed job ever reached "review" (that's a
  // success state), so pin the outcome to the working step rather than the final
  // one. A cancelled run is reported neutrally — somebody chose to stop it.
  const stopped = failed || cancelled;
  const current = status === "queued" ? 0 : status === "running" || stopped ? 1 : 2;

  return (
    <div
      className={cn(
        "mb-6 flex items-center gap-2 rounded-[var(--radius)] border border-border bg-surface px-4 py-3",
        className,
      )}
    >
      {STEPS.map((step, i) => {
        const reached = i <= current;
        // "in progress" pulse only on a non-terminal working step (i !== 2 already
        // excludes the review/done step).
        const isCurrent = i === current && !stopped && i !== 2;
        const failedHere = failed && i === current;
        const cancelledHere = cancelled && i === current;
        return (
          <div key={step.key} className="flex min-w-0 flex-1 items-center gap-2">
            <div
              className={cn(
                "flex h-7 w-7 shrink-0 items-center justify-center rounded-full border",
                failedHere
                  ? "border-danger/40 bg-danger/10 text-danger"
                  : cancelledHere
                    ? "border-border-strong bg-surface-2 text-muted"
                    : reached
                      ? "border-success/40 bg-success/10 text-success"
                      : "border-border bg-surface-2 text-muted-2",
                isCurrent && "border-info/40 bg-info/10 text-info",
              )}
            >
              <Icon
                name={failedHere ? "CircleAlert" : cancelledHere ? "CircleSlash" : step.icon}
                className={cn("h-3.5 w-3.5", isCurrent && "animate-pulse")}
              />
            </div>
            <p
              className={cn(
                "truncate text-xs",
                failedHere
                  ? "text-danger"
                  : cancelledHere
                    ? "text-muted"
                    : reached
                      ? "text-foreground"
                      : "text-muted-2",
              )}
            >
              {/* The two OUTCOME states take the register's words too. "Run
                  failed" was a fourth name for `failed`, one word off the
                  register's "Failed" and on the same screen as the badge that
                  prints it. */}
              {failedHere
                ? jobStatusLabel("failed")
                : cancelledHere
                  ? jobStatusLabel("cancelled")
                  : jobStatusLabel(step.key)}
            </p>
            {i < STEPS.length - 1 && (
              <div className={cn("h-px flex-1", i < current ? "bg-success/40" : "bg-border")} />
            )}
          </div>
        );
      })}
    </div>
  );
}
