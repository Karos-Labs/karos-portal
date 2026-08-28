"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

/**
 * Re-fetches the current server component on an interval. Mount it only while a
 * job is in progress so the run log / deliverables appear without a manual
 * reload; it unmounts (and stops) once the server renders a terminal status.
 *
 * SCRUM-265 item 1 — "a narrow status route instead of a full router.refresh()
 * on six pages." Every tick used to call `router.refresh()` directly, which
 * re-renders the ENTIRE route segment tree (every layout, every Suspense
 * boundary, every data fetch on the page) — expensive to pay every 4 seconds
 * for the common case where nothing has actually changed yet.
 *
 * `statusUrl`, when given, changes the mechanism: each tick hits that narrow
 * JSON endpoint (`{ inProgress: boolean }`) instead — one small Firestore
 * read — and calls the expensive `router.refresh()` only once, on the single
 * tick where it flips to `false`. After that this component's own parent will
 * stop rendering it (the same `inProgress` gate every call site already
 * uses), so the interval is cleared rather than left polling a route that no
 * longer needs it.
 *
 * Omitting `statusUrl` keeps the exact previous behavior (full refresh every
 * tick) — this is deliberate, not a placeholder: the other AutoRefresh call
 * sites (jobs list, pending queue, calendar, client-agent runs) track
 * different, non-job-shaped in-flight signals with no single narrow endpoint
 * of their own yet, and converting them is out of this ticket's scope.
 */
export function AutoRefresh({
  intervalMs = 4000,
  statusUrl,
}: {
  intervalMs?: number;
  /** A narrow endpoint returning `{ inProgress: boolean }` for this page's subject. */
  statusUrl?: string;
}) {
  const router = useRouter();

  useEffect(() => {
    if (!statusUrl) {
      const t = setInterval(() => router.refresh(), intervalMs);
      return () => clearInterval(t);
    }

    let cancelled = false;
    const t = setInterval(async () => {
      try {
        const res = await fetch(statusUrl, { cache: "no-store" });
        if (!res.ok) return; // transient — try again next tick
        const data = (await res.json()) as { inProgress?: boolean };
        if (cancelled) return;
        if (data.inProgress === false) {
          clearInterval(t);
          router.refresh();
        }
      } catch {
        // Network hiccup — same as a non-OK response, just wait for the next tick.
      }
    }, intervalMs);

    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [router, statusUrl, intervalMs]);

  return null;
}
