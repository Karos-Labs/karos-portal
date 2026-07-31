import { Badge } from "@/components/ui";
import { JOB_STATUS_META } from "@/lib/job-status-copy";
import type { JobStatus } from "@/lib/types";

/**
 * The badge that paints a run's state.
 *
 * The WORDS moved to `@/lib/job-status-copy` — a pure module — because this file
 * cannot be imported by a `server-only` caller without dragging `Badge` and JSX
 * along, and the copilot's system-prompt builder is exactly that caller. It had
 * been interpolating `job.status` raw. Re-exported from here so the surfaces
 * already importing `JOB_STATUS_META` from this path keep working; new server
 * callers should import the lib module directly.
 */
export { JOB_STATUS_META, jobStatusLabel } from "@/lib/job-status-copy";

export function JobStatusBadge({ status }: { status: JobStatus }) {
  const c = JOB_STATUS_META[status] ?? JOB_STATUS_META.queued;
  return <Badge tone={c.tone}>{c.label}</Badge>;
}
