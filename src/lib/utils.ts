import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatDate(value?: number | string | Date | null) {
  if (!value) return "-";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "-";
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export function formatDateTime(value?: number | string | Date | null) {
  if (!value) return "-";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "-";
  return d.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function relativeTime(value?: number | string | Date | null) {
  if (!value) return "-";
  const d = new Date(value).getTime();
  if (Number.isNaN(d)) return "-";
  const diff = Date.now() - d;
  const mins = Math.round(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  if (days < 30) return `${days}d ago`;
  return formatDate(value);
}

export function initials(name?: string | null) {
  if (!name) return "?";
  return name
    .split(" ")
    .map((p) => p[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase();
}

export function domainFromEmail(email?: string | null) {
  if (!email) return null;
  const at = email.split("@")[1];
  return at ? at.toLowerCase().trim() : null;
}

/**
 * HOW LONG A CLIENT'S CATEGORY MAY BE — the ceiling on the FIELD, because the
 * chip that shows it has no room to move (CD-L P3).
 *
 * The company panel's tag chip used to answer a long category by truncating the
 * text mid-word at a fixed 9rem, so "Global Startup Pitch Competition" read as
 * "Global Startup Pit…" on a client's own profile. A chip that shortens what it
 * is showing is the wrong end of the problem: the value should be short enough
 * to print, and the person typing it should be told so while they type.
 *
 * 28 IS MEASURED, not chosen. The narrowest of the two mounts is the staff
 * sidebar (`w-64` = 256px): minus its 1px border and the body's `px-4` leaves
 * 223px, minus the panel's own `px-1` leaves 215px, minus the chip's 2px border,
 * `px-2`, 14px mark and `gap-1.5` leaves 177px for text. Rendered in the app's
 * own font at `text-xs` (Hanken Grotesk 12px, in a browser), the widest
 * title-case category of 28 characters measures 176.7px and fits; at 29 it
 * measures 183.7px and does not. The client rail is `w-72` and has 32px more, so
 * a value that fits the sidebar fits both.
 *
 * RESIDUAL, stated rather than discovered: the measurement is title case, which
 * is how categories are written. A 28-character category in ALL CAPS runs to
 * ~300px and would still overflow — the chip keeps a `max-w-full` truncation as
 * the valve for that, which is the only case that can still show an ellipsis.
 */
export const CLIENT_CATEGORY_MAX_LENGTH = 28;

/**
 * What may be STORED. A hard ceiling and no ellipsis: the input's `maxLength`
 * already stops a person typing past it, and this is the server's own copy of
 * the rule for a request that did not come from that input.
 */
export function clampClientCategoryValue(value?: string | null): string {
  return (value ?? "").trim().slice(0, CLIENT_CATEGORY_MAX_LENGTH).trim();
}

/**
 * What is PRINTED on the chip.
 *
 * Identical to the stored value for anything saved under the cap, which is the
 * point: the chip shows the category WHOLE. Values already in Firestore predate
 * the cap, so an over-long legacy one is shortened here and is the only case
 * that shows an ellipsis. The chip carries the full text in `title` either way.
 */
export function clientCategoryLabel(value?: string | null): string {
  const v = (value ?? "").trim();
  if (v.length <= CLIENT_CATEGORY_MAX_LENGTH) return v;
  return `${v.slice(0, CLIENT_CATEGORY_MAX_LENGTH - 1).trimEnd()}…`;
}
