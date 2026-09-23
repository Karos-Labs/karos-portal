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
 * `watchUrl` is the second mechanism, for the call sites `statusUrl` could not
 * serve. Those pages each watch a DIFFERENT in-flight signal — the calendar
 * asks whether a job belonging to a rendered row is queued or running, the
 * agents page also counts launch state and an active template run — and those
 * predicates are correct, computed from data the page already holds. Moving
 * them into a route would copy page logic somewhere the two can drift.
 *
 * So `watchUrl` does not answer "is it in flight". It answers "did anything
 * MOVE" (`{ changedAt: number }`), and the page keeps its own predicate for
 * whether to watch at all. A tick that returns the same number costs one
 * document read; the expensive `router.refresh()` happens on the tick where
 * the number changes, which is the tick where there is something new to draw.
 *
 * Omitting both keeps the original behaviour — a full refresh every tick.
 */
export function AutoRefresh({
  intervalMs = 4000,
  statusUrl,
  watchUrl,
}: {
  intervalMs?: number;
  /** A narrow endpoint returning `{ inProgress: boolean }` for this page's subject. */
  statusUrl?: string;
  /** A narrow endpoint returning `{ changedAt: number }` — refresh only when it moves. */
  watchUrl?: string;
}) {
  const router = useRouter();

  useEffect(() => {
    if (!statusUrl && watchUrl) {
      let cancelled = false;
      // Seeded from the first response rather than from 0, so mounting does not
      // itself count as a change and cost a refresh nobody asked for.
      let seen: number | undefined;
      const t = setInterval(async () => {
        try {
          const res = await fetch(watchUrl, { cache: "no-store" });
          if (!res.ok || cancelled) return;
          const { changedAt } = (await res.json()) as { changedAt?: number };
          if (cancelled || typeof changedAt !== "number") return;
          if (seen === undefined) {
            seen = changedAt;
            return;
          }
          if (changedAt > seen) {
            seen = changedAt;
            router.refresh();
          }
        } catch {
          // A hiccup is not a change. Wait for the next tick.
        }
      }, intervalMs);
      return () => {
        cancelled = true;
        clearInterval(t);
      };
    }

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
  }, [router, statusUrl, watchUrl, intervalMs]);

  return null;
}
