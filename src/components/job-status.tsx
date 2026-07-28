import { Badge } from "@/components/ui";
import type { JobStatus } from "@/lib/types";

const MAP: Record<JobStatus, { tone: "neutral" | "neon" | "warning" | "danger" | "info"; label: string }> = {
  queued: { tone: "neutral", label: "Queued" },
  running: { tone: "info", label: "Running" },
  review: { tone: "warning", label: "In review" },
  approved: { tone: "neon", label: "Approved" },
  delivered: { tone: "neon", label: "Delivered" },
  failed: { tone: "danger", label: "Failed" },
  cancelled: { tone: "neutral", label: "Cancelled" },
};

export function JobStatusBadge({ status }: { status: JobStatus }) {
  const c = MAP[status] ?? MAP.queued;
  return <Badge tone={c.tone}>{c.label}</Badge>;
}
