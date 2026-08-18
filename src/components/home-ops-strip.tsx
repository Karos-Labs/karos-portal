import Link from "next/link";
import { Icon } from "@/components/icon";
import { cn } from "@/lib/utils";

export interface OpsStat {
  label: string;
  value: number;
  /** Small caption under the number — a timestamp, a qualifier. Optional. */
  hint?: string;
  /** Where the number goes when pressed. Optional; a stat with no destination is plain text. */
  href?: string;
  /** Draws the number in the warning ink when it is non-zero — for queues, not for totals. */
  warnWhenNonZero?: boolean;
}

/**
 * The staff Home's pipeline counters, as ONE line (2026-08).
 *
 * They used to be five `StatCard` tiles across the top of the dashboard —
 * Published / Scheduled / Channels / Deliverables / Agent runs — each a bordered
 * box with a 30px number in it, and together they were the first full screen a
 * staff member scrolled past to reach anything they could act on. The product
 * owner's read of that screen: "a lot of non-informative information that
 * doesn't help."
 *
 * The counts themselves are not the problem — an operator does want to know
 * there are sixteen drafts waiting — so they are kept and de-emphasized rather
 * than deleted: one thin strip, mono numerals, the queue-shaped ones linked to
 * where the queue is worked and tinted when they are non-zero. What was
 * genuinely redundant is gone: "Channels" was a bare integer whose interesting
 * half (is any of them broken?) the KPI card now answers properly.
 *
 * STAFF ONLY, and that is inherited rather than re-decided here. A client's
 * dashboard lost this row in the portal revamp on the churn rule — "Agent runs
 * 42 · Last run 4d ago" reports the cadence of our machinery, and a batch
 * timestamp beside a full calendar tells a client the whole week already
 * exists. Nothing in this component re-litigates that; it is simply never
 * mounted on the client branch.
 */
export function HomeOpsStrip({ stats }: { stats: OpsStat[] }) {
  return (
    <div className="flex flex-wrap items-stretch divide-x divide-border overflow-hidden rounded-lg border border-border bg-surface">
      {stats.map((s) => {
        const warn = s.warnWhenNonZero && s.value > 0;
        const body = (
          <>
            <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-2">
              {s.label}
            </p>
            <p className="mt-0.5 flex items-baseline gap-1.5">
              <span
                className={cn(
                  "font-mono text-lg font-semibold leading-none",
                  warn ? "text-warning" : "text-foreground",
                )}
              >
                {s.value.toLocaleString()}
              </span>
              {s.href && (
                <Icon
                  name="ArrowUpRight"
                  className="h-3 w-3 shrink-0 text-muted-2 opacity-0 transition-opacity group-hover:opacity-100"
                />
              )}
            </p>
            {s.hint && <p className="mt-0.5 truncate text-[10px] text-muted-2">{s.hint}</p>}
          </>
        );
        // `flex-1` with a floor: five stats share the row on a wide screen and
        // wrap to two rows on a narrow one, rather than each shrinking until
        // its label is three lines tall.
        const cls = "group min-w-[7.5rem] flex-1 px-3.5 py-2.5";
        return s.href ? (
          <Link key={s.label} href={s.href} className={cn(cls, "transition-colors hover:bg-surface-2")}>
            {body}
          </Link>
        ) : (
          <div key={s.label} className={cls}>
            {body}
          </div>
        );
      })}
    </div>
  );
}
