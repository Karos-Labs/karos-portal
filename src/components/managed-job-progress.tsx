import { Icon } from "@/components/icon";
import type { JobStatus } from "@/lib/types";
import { cn } from "@/lib/utils";

const STEPS = [
  { key: "queued", label: "Queued", icon: "Clock" },
  { key: "running", label: "Agent working", icon: "Bot" },
  { key: "review", label: "Ready for review", icon: "CircleCheckBig" },
] as const;

/**
 * Three-step progress strip for managed (agent-service) jobs. Server-safe —
 * pure render from the job status; the page's AutoRefresh keeps it live.
 */
export function ManagedJobProgress({ status }: { status: JobStatus }) {
  const failed = status === "failed";
  const current = status === "queued" ? 0 : status === "running" ? 1 : 2;

  return (
    <div className="mb-6 flex items-center gap-2 rounded-[var(--radius)] border border-border bg-surface px-4 py-3">
      {STEPS.map((step, i) => {
        const reached = i <= current;
        const isCurrent = i === current && !failed && status !== "review" && i !== 2;
        const failedHere = failed && i === current;
        return (
          <div key={step.key} className="flex min-w-0 flex-1 items-center gap-2">
            <div
              className={cn(
                "flex h-7 w-7 shrink-0 items-center justify-center rounded-full border",
                failedHere
                  ? "border-danger/40 bg-danger/10 text-danger"
                  : reached
                    ? "border-success/40 bg-success/10 text-success"
                    : "border-border bg-surface-2 text-muted-2",
                isCurrent && "border-info/40 bg-info/10 text-info",
              )}
            >
              <Icon
                name={failedHere ? "CircleAlert" : step.icon}
                className={cn("h-3.5 w-3.5", isCurrent && "animate-pulse")}
              />
            </div>
            <p
              className={cn(
                "truncate text-xs",
                failedHere ? "text-danger" : reached ? "text-foreground" : "text-muted-2",
              )}
            >
              {failedHere ? "Run failed" : step.label}
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
