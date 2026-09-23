import Link from "next/link";
import { Card, CardTitle, Badge } from "@/components/ui";
import { Icon } from "@/components/icon";
import { relativeTime } from "@/lib/utils";
import { AgentMark } from "@/components/agent-identity";
import type { Client } from "@/lib/types";
import type { WaitingOnYouItem } from "@/lib/agent-engine/read-run";

/**
 * The runs that have stopped and are waiting for a person.
 *
 * ## Why this is a component and not a screen
 *
 * `awaiting_gate` deliberately does not change `job.status` — the approval is
 * rendered on the job page by `AgentEngineRunPanel`, which is the right place
 * to ANSWER a gate and the wrong place to DISCOVER one. So a run needing a
 * decision was visible only to whoever already thought to open that job.
 *
 * Measured 2026-09-22: 39 runs parked at a gate in prep and 3 in production,
 * the oldest untouched for 734 hours. A dedicated screen would not have found
 * them either — nobody visits a screen to learn that they should have visited
 * it. This sits on the page people already open.
 *
 * ## What it says that a count would not
 *
 * Two things a reader needs and cannot get from "3 pending":
 *
 *  - **How long it has been sitting.** A gate answered in ten minutes and one
 *    ignored for a month are otherwise the same row.
 *  - **Whether it ships without you.** `auto_approve` means the deadline is
 *    real and the work goes out either way; `hold` means nothing happens,
 *    ever, until someone acts. Those deserve opposite reactions, and the gate
 *    record is the only place the distinction exists.
 */
export function WaitingOnYou({
  items,
  clients,
  truncated,
}: {
  items: WaitingOnYouItem[];
  clients: Client[];
  /** More jobs were in flight than one read covers — the list is a floor, not a total. */
  truncated: boolean;
}) {
  if (items.length === 0) return null;

  const clientName = (clientId: string) => clients.find((c) => c.id === clientId)?.name ?? "Unknown client";
  // The oldest is the headline: it has been ignored longest, and it is the
  // only number that makes this feel urgent exactly when it should.
  const oldest = items[0];
  const holding = items.filter((item) => item.ifIgnored === "hold").length;

  return (
    <Card className="border-warning/30 bg-warning/5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <CardTitle className="flex items-center gap-2">
          <Icon name="Hourglass" className="h-4 w-4 text-warning" />
          Waiting on you
          <Badge tone="warning">{truncated ? `${items.length}+` : items.length}</Badge>
        </CardTitle>
        {oldest && <p className="text-xs text-muted">Oldest has been waiting {relativeTime(oldest.updatedAt)}</p>}
      </div>

      {holding > 0 && (
        <p className="mt-2 text-xs text-muted">
          {holding === items.length
            ? holding === 1
              ? "This one will not ship on its own. It waits until you decide."
              : "None of these ship on their own. They wait until you decide."
            : `${holding} of these will not ship on their own.`}
        </p>
      )}

      <ul className="mt-3 space-y-1">
        {items.slice(0, VISIBLE_ROWS).map((item) => (
          <li key={item.runId}>
            <Link
              href={`/jobs/${item.jobId}`}
              className="flex items-center gap-3 rounded-[var(--radius)] px-2 py-2 transition-colors hover:bg-surface-2"
            >
              <AgentMark identity={item.productId} className="h-5 w-5 shrink-0" />
              <span className="min-w-0 flex-1 truncate text-xs">
                <span className="text-fg">{clientName(item.clientId)}</span>
                <span className="text-muted"> · {item.productId}</span>
              </span>
              <span className="shrink-0 text-[11px] text-muted">{relativeTime(item.updatedAt)}</span>
              {/*
                Stated per row rather than summarised, because the two cases
                are not degrees of one thing: one has a clock and one does not.
                `title` sits on the wrapper — `Badge` takes only `tone`.
              */}
              {item.ifIgnored === "auto_approve" ? (
                <span title={`Ships on its own after ${item.timeoutDuration ?? "its window"} with no decision`} className="shrink-0">
                  <Badge tone="info">auto in {item.timeoutDuration ?? "?"}</Badge>
                </span>
              ) : item.ifIgnored === "hold" ? (
                <span title="Nothing happens until a person decides" className="shrink-0">
                  <Badge tone="warning">needs you</Badge>
                </span>
              ) : null}
            </Link>
          </li>
        ))}
      </ul>

      {items.length > VISIBLE_ROWS && (
        <p className="mt-2 px-2 text-xs text-muted">
          and {items.length - VISIBLE_ROWS} more ·{" "}
          <Link href="/jobs" className="text-neon hover:underline">
            see all jobs
          </Link>
        </p>
      )}
    </Card>
  );
}

/** Enough to act on without the card taking over the page; the rest are a line of text. */
const VISIBLE_ROWS = 6;
