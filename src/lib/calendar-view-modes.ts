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
export type CalendarViewMode = "day" | "week" | "month" | "archive";

/** The `?view=` values that name a real view - anything else is ignored. Week is the default. */
export const CALENDAR_VIEW_MODES: readonly CalendarViewMode[] = [
  "day",
  "week",
  "month",
  "archive",
] as const;
