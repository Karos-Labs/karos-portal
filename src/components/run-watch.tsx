"use client";

/**
 * The runs this browser tab is watching, and the one poller that watches them.
 *
 * WHY IT IS NOT IN THE MODAL (SCRUM-416). Lola's question was "how do I know
 * where it goes, if it worked" - and a reader who has just been told a run
 * takes thirty minutes will close the dialog and go and do something else.
 * Progress that lives only inside that dialog answers her question for the
 * thirty seconds she is looking at it and then stops existing. So the watch
 * lives above the pages: the dialog REGISTERS a run, and the dock mounted in
 * the app shell keeps showing it across every navigation until the reader
 * dismisses it.
 *
 * WHY AN EXTERNAL STORE. Two readers (the dialog and the dock) need one answer,
 * the poller writes from outside React's tree, and the initial value comes from
 * `sessionStorage` - which the server render cannot see. That is the shape
 * `useSyncExternalStore` exists for, and it is what keeps the first paint from
 * being a hydration mismatch: the server snapshot is empty, the client reads
 * storage after hydration, and React re-renders once.
 *
 * WHY `sessionStorage` AND NOT STATE ALONE. A hard navigation, or the reader
 * hitting reload while waiting, would otherwise drop the watch and leave them
 * exactly where they started. Per TAB, deliberately: two tabs watching one run
 * is correct, and a watch surviving into next week is not - by then the run is
 * in Jobs or the archive, which is where a finished run belongs. Every access is
 * wrapped, because `sessionStorage` throws outright in some embedded contexts
 * and a progress widget must never be the thing that breaks a page.
 *
 * ONE POLLER PER RUN, owned here. The dialog and the dock both READ; when the
 * dialog polled for itself, a reader who left it open behind the dock had two
 * intervals on one job.
 *
 * IT NEVER DECIDES WHETHER A RUN IS FINISHED. Both the status word and
 * `inProgress` come from the server, through the same mapping the staff Job page
 * uses (see the progress route). This file stops polling when told to and does
 * no arithmetic on statuses of its own.
 */

import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";

import {
  runOutcome,
  runProgressUrl,
  type RunOutcome,
  type RunProgressView,
} from "@/lib/run-progress";

/** What the dock needs in order to name a run the reader started. */
export interface WatchedRun {
  jobId: string;
  /** The agent's own name, as the dialog titled it. */
  agentName: string;
  /** What it is making, in the client's words ("post", "reply"). */
  noun: string;
  /**
   * Where the output can be seen, resolved by whoever started the run.
   *
   * OPTIONAL, because for some readers the honest answer is "nowhere yet": a
   * client has no surface that shows a deliverable still in review, so a link
   * for them would be the phantom-destination defect again. A watch with no
   * href renders the sentence and no link.
   */
  href?: string;
  /** Set once the poller has an answer; absent until the first tick lands. */
  status?: string;
  /**
   * Some view on the page is showing this run right now (the in-page run form
   * turned into its progress, or an agent page's run banner), so the dock
   * skips it. Held only while that view is MOUNTED (`useShowRunInPage`): it
   * used to be the page address the run started on, which kept hiding the run
   * after "Start another" or a trip away and back — when nothing else on the
   * page could show it. Never persisted.
   */
  shownInPage?: boolean;
  /** What the agent is doing now (RunProgressView.headline). Not persisted: the next tick refills it. */
  headline?: string;
  /** The agent's part is done and the run is parked (RunProgressView.agentDone). */
  agentDone?: boolean;
}

const KEY = "karos.watchedRuns.v1";
/** The same 4s the rest of the app polls at - see AutoRefresh's default. */
const TICK_MS = 4000;
/**
 * Three at once. Not a performance limit but a READING limit: a dock that can
 * grow without bound stops being a status widget and becomes a second Jobs
 * list, which is the page these runs are already on their way to.
 */
const MAX_WATCHED = 3;

const EMPTY: WatchedRun[] = [];

function load(): WatchedRun[] {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (!raw) return EMPTY;
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return EMPTY;
    // Shape-CHECKED, not trusted: this string survives a reload, so a stale or
    // hand-edited value must not reach a render as `undefined.href`.
    const rows = parsed.filter(
      (r): r is WatchedRun =>
        !!r &&
        typeof r === "object" &&
        typeof (r as WatchedRun).jobId === "string" &&
        typeof (r as WatchedRun).agentName === "string" &&
        typeof (r as WatchedRun).noun === "string" &&
        // Parenthesised: `&&` binds tighter than `||`, so without these the
        // whole guard collapses to "or it has a string href" and every other
        // field stops being checked.
        ((r as WatchedRun).href === undefined || typeof (r as WatchedRun).href === "string"),
    );
    return rows.length === 0
      ? EMPTY
      : rows.slice(0, MAX_WATCHED).map(({ headline: _h, shownInPage: _s, ...rest }) => rest);
  } catch {
    return EMPTY;
  }
}

function persist(runs: WatchedRun[]) {
  try {
    sessionStorage.setItem(KEY, JSON.stringify(runs));
  } catch {
    // A tab with storage blocked still gets the watch for as long as it stays
    // on the page. Losing it on reload is a worse experience, not a broken one.
  }
}

/* ───────────────────────────────── the store ───────────────────────────────── */

let current: WatchedRun[] | null = null;
const listeners = new Set<() => void>();

/**
 * The snapshot, and it must return the SAME array until something changes -
 * a fresh array on every call is an infinite re-render, not a stale read.
 */
function getSnapshot(): WatchedRun[] {
  if (current === null) current = typeof window === "undefined" ? EMPTY : load();
  return current;
}

/** The server has no sessionStorage, so it has no watches. */
function getServerSnapshot(): WatchedRun[] {
  return EMPTY;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function commit(next: WatchedRun[]) {
  current = next;
  persist(next);
  for (const listener of listeners) listener();
}

function setShownInPage(jobId: string, on: boolean) {
  const runs = getSnapshot();
  const next = runs.map((r) =>
    r.jobId === jobId && Boolean(r.shownInPage) !== on ? { ...r, shownInPage: on } : r,
  );
  if (next.some((r, i) => r !== runs[i])) commit(next);
}

/**
 * Mark a run as on screen in this component for as long as it is mounted, so
 * the dock does not show it a second time. Null claims nothing.
 */
export function useShowRunInPage(jobId: string | null | undefined) {
  useEffect(() => {
    if (!jobId) return;
    setShownInPage(jobId, true);
    return () => setShownInPage(jobId, false);
  }, [jobId]);
}

/** Start watching a run. A run already watched is left as it is, not restarted. */
function addWatch(run: Omit<WatchedRun, "status">) {
  const runs = getSnapshot();
  if (runs.some((r) => r.jobId === run.jobId)) return;
  // Newest first, and the OLDEST falls off rather than the newest being
  // refused: the run the reader just started is the one they are asking about.
  commit([run, ...runs].slice(0, MAX_WATCHED));
}

function dropWatch(jobId: string) {
  const runs = getSnapshot();
  const next = runs.filter((r) => r.jobId !== jobId);
  if (next.length !== runs.length) commit(next.length === 0 ? EMPTY : next);
}

/**
 * Which runs still need asking about: everything not yet landed or stopped by
 * its STATUS. A run parked at a gate (`agentDone`) is shown as done but still
 * asked about — a rejection there turns into "stopped", and a watch that had
 * stopped asking would keep saying "Done" about a run that produced nothing.
 */
const stillWorking = (runs: WatchedRun[]) =>
  runs.filter((r) => r.status === undefined || runOutcome(r.status) === "working");

/* ───────────────────────────────── the poller ──────────────────────────────── */

let timer: ReturnType<typeof setInterval> | null = null;

async function pollOnce() {
  const ids = stillWorking(getSnapshot()).map((r) => r.jobId);
  if (ids.length === 0) {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    return;
  }
  const answers = await Promise.all(
    ids.map(async (jobId) => {
      try {
        const res = await fetch(runProgressUrl(jobId), { cache: "no-store" });
        // 404 is the progress route's ONE answer for "no such job" and "not
        // yours". Either way there is nothing to show, so the watch is dropped
        // rather than retried forever.
        if (res.status === 404) return { jobId, gone: true as const };
        if (!res.ok) return null; // transient - ask again next tick
        const data = (await res.json()) as RunProgressView;
        return { jobId, status: data.status, headline: data.headline, agentDone: data.agentDone === true };
      } catch {
        return null; // network hiccup, same as a non-OK response
      }
    }),
  );
  const answered = answers.filter((a): a is NonNullable<typeof a> => a !== null);
  if (answered.length === 0) return;

  const runs = getSnapshot();
  const next = runs
    .filter((r) => !answered.some((a) => a.jobId === r.jobId && "gone" in a))
    .map((r) => {
      const hit = answered.find((a) => a.jobId === r.jobId && "status" in a);
      if (!hit || !("status" in hit)) return r;
      // The headline changes while the status stays `running` (writing, then
      // visuals), so it counts as a change too.
      if (hit.status === r.status && hit.headline === r.headline && hit.agentDone === Boolean(r.agentDone)) {
        return r;
      }
      const { headline: _h, agentDone: _d, ...base } = r;
      return {
        ...base,
        status: hit.status,
        ...(hit.headline ? { headline: hit.headline } : {}),
        ...(hit.agentDone ? { agentDone: true } : {}),
      };
    });
  // Reference equality is what stops a tick that learned nothing from
  // re-rendering every reader.
  const changed =
    next.length !== runs.length || next.some((r, i) => r !== runs[i]);
  if (changed) commit(next.length === 0 ? EMPTY : next);
}

function ensurePolling() {
  if (timer !== null) return;
  if (stillWorking(getSnapshot()).length === 0) return;
  void pollOnce(); // answer immediately, then on the interval
  timer = setInterval(() => void pollOnce(), TICK_MS);
}

/* ────────────────────────────────── the hook ───────────────────────────────── */

export interface RunWatchApi {
  runs: WatchedRun[];
  watch: (run: Omit<WatchedRun, "status">) => void;
  forget: (jobId: string) => void;
  outcomeOf: (jobId: string) => RunOutcome | undefined;
}

/**
 * The watch, for any caller in the client bundle.
 *
 * No provider and no context: the store is module state, so the dock and the
 * dialog reach the same one without the dialog's three mount sites each having
 * to be wrapped. That also keeps the dialog testable on its own - a hook that
 * required a provider would make the provider a hidden requirement of every
 * mount and every test.
 */
export function useRunWatch(): RunWatchApi {
  const runs = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  const watch = useCallback((run: Omit<WatchedRun, "status">) => {
    addWatch(run);
    ensurePolling();
  }, []);

  const forget = useCallback((jobId: string) => dropWatch(jobId), []);

  return useMemo(
    () => ({
      runs,
      watch,
      forget,
      outcomeOf: (jobId) => {
        const run = runs.find((r) => r.jobId === jobId);
        if (run?.agentDone) return "landed";
        return run?.status === undefined ? undefined : runOutcome(run.status);
      },
    }),
    [runs, watch, forget],
  );
}

/**
 * Restart polling for watches restored from storage.
 *
 * Mounted once, by the dock. A reader who reloaded mid-run has watches in
 * `sessionStorage` and no interval, and `watch()` - the only other thing that
 * starts one - is not called again on that path.
 */
export function useRestoreRunPolling(watchedCount: number) {
  const needed = watchedCount > 0;
  useEffect(() => {
    if (needed) ensurePolling();
  }, [needed]);
}
