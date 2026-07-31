import { Badge } from "@/components/ui";
import type { JobStatus } from "@/lib/types";

/**
 * The one place a raw job status becomes words a client may read. Exported
 * because every surface that shows run state has to go through it - printing
 * `job.status` renders the database enum ("review", "delivered") on screen.
 */
export const JOB_STATUS_META: Record<
  JobStatus,
  { tone: "neutral" | "neon" | "warning" | "danger" | "info"; label: string }
> = {
  queued: { tone: "neutral", label: "Queued" },
  running: { tone: "info", label: "Running" },
  review: { tone: "warning", label: "In review" },
  approved: { tone: "neon", label: "Approved" },
  delivered: { tone: "neon", label: "Delivered" },
  failed: { tone: "danger", label: "Failed" },
  cancelled: { tone: "neutral", label: "Cancelled" },
};

export function JobStatusBadge({ status }: { status: JobStatus }) {
  const c = JOB_STATUS_META[status] ?? JOB_STATUS_META.queued;
  return <Badge tone={c.tone}>{c.label}</Badge>;
}
