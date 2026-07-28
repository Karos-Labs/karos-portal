/**
 * The grain a client is told their run history at.
 *
 * Pure and client-safe, so the surfaces that build run rows on the server can
 * be driven by a test that never touches Firestore.
 *
 * A3/A4: one fire produces a week of drafts, so a per-run list prints several
 * rows carrying the same date — which states outright that the week came out of
 * one minute. Every client-facing telling of run history therefore collapses to
 * ONE row per calendar day, stamped at that day's last fire. The Workspace
 * timeline reached the same shape first (clientEventsFromJobs, per agent per
 * day); this is that rule for the surfaces that already scope themselves to one
 * agent, so the day alone is the key.
 *
 * Failures are exempt. A run that could not finish is a distinct event with its
 * own message, and collapsing it into the day's successful fire would hide the
 * one row the client may need to ask about.
 */

/** Server-local calendar day. */
export function runDayKey(at: number): string {
  const d = new Date(at);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

/**
 * One row per calendar day, newest kept — plus every failure.
 *
 * @param runs newest first. Order is preserved, so the caller's slice still
 *   takes the most recent rows.
 */
export function collapseRunsPerDay<T extends { status: string; createdAt: number }>(
  runs: readonly T[],
): T[] {
  const kept: T[] = [];
  const seenDays = new Set<string>();
  for (const run of runs) {
    if (run.status === "failed") {
      kept.push(run);
      continue;
    }
    const key = runDayKey(run.createdAt);
    if (seenDays.has(key)) continue;
    seenDays.add(key);
    kept.push(run);
  }
  return kept;
}
