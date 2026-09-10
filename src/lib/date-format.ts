/**
 * Deterministic date/time strings for SSR'd client components.
 *
 * toLocaleTimeString/toLocaleDateString output depends on the ICU locale of
 * whichever runtime renders it — the Node server and the browser routinely
 * disagree ("11:00" vs "11:00 AM"), which breaks React hydration. These
 * helpers always emit the same text for a given local wall-clock time.
 *
 * They still read the runtime's local timezone: any element whose text can
 * differ between the server's and the browser's timezone must also set
 * suppressHydrationWarning so the client value wins without an error.
 */
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "09:05", "14:00" — 24h wall-clock time. */
export function formatTimeHM(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** "Tuesday 14 Jul" */
export function formatDayLong(ms: number): string {
  const d = new Date(ms);
  return `${WEEKDAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}`;
}

/** "14 Jul" */
export function formatDayShort(ms: number): string {
  const d = new Date(ms);
  return `${d.getDate()} ${MONTHS[d.getMonth()]}`;
}
