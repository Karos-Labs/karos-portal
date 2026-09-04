/**
 * The four calendar views, and the `?view=` values that name one.
 *
 * A PLAIN MODULE ON PURPOSE (portal feedback round 2, 2026-09). These used
 * to live in components/run-calendar.tsx, which is a "use client" module -
 * and a server component that imports a non-component export from a client
 * module does not get the value, it gets a client REFERENCE proxy. So
 * calendar-body.tsx (a server component) called `CALENDAR_VIEW_MODES.find`
 * on a proxy and every /calendar render threw "find is not a function"
 * (digest 2600905030 on localhost). tsc cannot see that boundary; only the
 * runtime can. Anything both a server page and the client calendar need to
 * agree on lives here, where neither side is special.
 */

// The legend's own keys, for `?hidden=` below. calendar-kind.ts is as plain as
// this module is, so importing it costs neither side a client boundary.
import { ALL_CALENDAR_FILTER_KEYS, type CalendarFilterKey } from "@/lib/calendar-kind";

export type CalendarViewMode = "day" | "week" | "month" | "archive";

/** The `?view=` values that name a real view - anything else is ignored. Week is the default. */
export const CALENDAR_VIEW_MODES: readonly CalendarViewMode[] = [
  "day",
  "week",
  "month",
  "archive",
] as const;

/**
 * The three TIME views, in the order the header's segmented control renders
 * them (flow audit 2026-09, R6).
 *
 * Archive was the fourth member of that control and is not a fourth time
 * range: it has no grid, no dates, and entering it hides the prev/next
 * arrows. It is offered as its own labelled control beside this one now, so
 * this list is what "day | week | month" means in exactly one place — the
 * header, the tests, and anything that later needs "which views take an
 * anchor date" all read it here rather than re-typing three strings.
 */
export const CALENDAR_TIME_VIEW_MODES: readonly Exclude<CalendarViewMode, "archive">[] = [
  "day",
  "week",
  "month",
] as const;

/**
 * The query keys the calendar owns (flow audit 2026-09, R5).
 *
 * The calendar wrote NOTHING to the URL: view mode, the week/month anchor and
 * the archive's own filters were all local state, so Back left the page
 * instead of undoing the last move and no week or filtered archive could be
 * shared. These are the names both halves agree on — the two page.tsx files
 * that read them off `searchParams`, and run-calendar.tsx/archive-view.tsx
 * that write them back — so a rename is one edit rather than six string
 * literals that can drift.
 *
 * `q` and not `search`: it rides beside `status`/`agent` in a URL a client may
 * paste to their Karos team, and short is kinder there.
 */
export const CALENDAR_QUERY_KEYS = {
  view: "view",
  /** The anchor day of the active time view, `YYYY-MM-DD` (local). */
  date: "date",
  /** Archive only — its status / agent / title-search filters. */
  status: "status",
  agent: "agent",
  search: "q",
  /**
   * The legend chips the reader has dimmed, comma-separated (review wave,
   * 2026-09). They filter what the grid PAINTS, exactly as `status` filters
   * what the archive lists, so a week sent to someone with "drafts hidden"
   * has to arrive that way or the link is describing a different screen.
   */
  hidden: "hidden",
} as const;

/**
 * One local day as `YYYY-MM-DD`.
 *
 * LOCAL, deliberately: every anchor in this calendar is a local-midnight
 * `Date` (startOfWeek/startOfDay in run-calendar.tsx), and `toISOString()`
 * would shift a UTC-negative reader's Monday back to the Sunday before it.
 */
export function formatCalendarDate(d: Date): string {
  const m = `${d.getMonth() + 1}`.padStart(2, "0");
  const day = `${d.getDate()}`.padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

/**
 * `?date=YYYY-MM-DD` → local midnight of that day, or null.
 *
 * Null for anything else, including a well-formed-but-impossible day
 * ("2026-02-31"): the same "fail open" rule `?view=` and `?status=` follow —
 * a stale or hand-typed link opens today's calendar rather than an empty or
 * nonsensical one. Rejecting the roll-over is why the parts are compared back
 * out of the constructed Date instead of trusting the regex alone.
 */
export function parseCalendarDate(raw: string | undefined): Date | null {
  if (!raw) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw.trim());
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]) - 1;
  const day = Number(m[3]);
  const d = new Date(year, month, day);
  if (d.getFullYear() !== year || d.getMonth() !== month || d.getDate() !== day) return null;
  return d;
}

/**
 * `?hidden=draft,failed` → the legend chips this reader has dimmed.
 *
 * Same fail-open rule as every other param here: an unknown key is dropped
 * rather than refused, so a stale link opens the calendar with the chips it
 * CAN honour rather than nothing at all. Emitted (and read back) in
 * `ALL_CALENDAR_FILTER_KEYS` order so the same set always spells the same URL —
 * a link that changes character with the order the reader pressed the chips in
 * is one nobody can diff.
 */
export function parseCalendarHidden(raw: string | undefined): CalendarFilterKey[] {
  if (!raw) return [];
  const asked = new Set(raw.split(",").map((part) => part.trim()));
  return ALL_CALENDAR_FILTER_KEYS.filter((key) => asked.has(key));
}

/** The `?hidden=` value for a set of dimmed chips, or null when nothing is dimmed. */
export function formatCalendarHidden(keys: Iterable<CalendarFilterKey>): string | null {
  const set = new Set(keys);
  const out = ALL_CALENDAR_FILTER_KEYS.filter((key) => set.has(key));
  return out.length > 0 ? out.join(",") : null;
}

/** Everything the calendar keeps in its query, read back out of one. */
export interface CalendarUrlState {
  view: CalendarViewMode;
  /** The anchor day, or null when the URL named none (which means "today"). */
  date: Date | null;
  /** The archive's three filters, in their "unfiltered" spellings when absent. */
  status: string;
  agent: string;
  search: string;
  hidden: CalendarFilterKey[];
}

/**
 * A query string → the whole calendar state it describes (review wave, 2026-09).
 *
 * PURE, and here rather than inside the component, because it is the half of
 * Back/Forward that can actually be tested: the calendar's `popstate` handler
 * used to re-read and re-validate each param inline, which meant the restore
 * path could only ever be asserted by matching source text. Every value is
 * validated the same way the pages validate their `searchParams`, so an entry
 * written by an older build (or hand-edited) restores the ordinary calendar
 * instead of a broken one.
 *
 * `status`/`agent`/`search` come back RAW: which statuses an archive may hold
 * depends on who is reading it (offeredStatesFor), and that question belongs to
 * the surface, not to the URL.
 */
export function calendarStateFromQuery(search: string): CalendarUrlState {
  const params = new URLSearchParams(search);
  const get = (key: keyof typeof CALENDAR_QUERY_KEYS) =>
    params.get(CALENDAR_QUERY_KEYS[key]) ?? undefined;
  return {
    view: CALENDAR_VIEW_MODES.find((mode) => mode === get("view")) ?? "week",
    date: parseCalendarDate(get("date")),
    status: get("status") ?? "all",
    agent: get("agent") ?? "all",
    search: get("search") ?? "",
    hidden: parseCalendarHidden(get("hidden")),
  };
}

/**
 * Follow Back and Forward: calls `onRestore` with the state of whatever history
 * entry the reader lands on, and returns the unsubscribe.
 *
 * The history stack is an external system and this is a subscription to it —
 * the seed props cannot answer for it, because the anchor and the filters are
 * written with `replaceState`, which deliberately does not re-render the server
 * component. Kept out of the component so the behaviour is reachable by a test
 * that dispatches a real `popstate` (see calendar-url-state.test.ts).
 */
export function subscribeToCalendarUrl(
  onRestore: (state: CalendarUrlState) => void,
): () => void {
  const handler = () => onRestore(calendarStateFromQuery(window.location.search));
  window.addEventListener("popstate", handler);
  return () => window.removeEventListener("popstate", handler);
}
