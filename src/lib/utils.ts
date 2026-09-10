import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
import type { Client } from "@/lib/types";

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

/**
 * "2d ago", falling back to the date past 30 days.
 *
 * `now` IS OPTIONAL AND EXISTS FOR SERVER COMPONENTS (round 6 review, E1). A
 * server-rendered surface resolves one clock for the whole render and every
 * answer on the page has to age against it — a stamp that read `Date.now()`
 * itself would be a second instant beside the status word next to it. Omitted,
 * it reads the clock, which is right inside the client components that own most
 * of these stamps.
 *
 * `lib/client-agent-rows.ts` carried a second copy of this ladder
 * (`rosterRelativeStamp`) for exactly that reason. One argument replaced it.
 */
export function relativeTime(value?: number | string | Date | null, now?: number) {
  if (!value) return "-";
  const d = new Date(value).getTime();
  if (Number.isNaN(d)) return "-";
  const diff = (now ?? Date.now()) - d;
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
 * WHAT A CLIENT'S CATEGORY IS, asked once for the whole app.
 *
 * `category` and `industry` were the same fact wearing two field names, with two
 * editors and two audiences: the client typed a category into the chip's pencil,
 * staff typed an industry into the Clients-page dialog, and the copilot and the
 * intel pipeline read only the second one — so a client who set their own
 * category watched their agents brief themselves on a value they could not see
 * or change. They are ONE field now. `category` is it; `industry` is the legacy
 * spelling, still stored on documents written before this and read ONLY here.
 *
 * A READ-TIME FALLBACK RATHER THAN A MIGRATION, which is how this codebase
 * carries a renamed field: nothing rewrites the old documents, and nothing
 * deletes `industry` either, because it is what this function falls back TO.
 *
 * THE CAP FOLLOWS FROM THAT, and is worth stating before somebody reads it as a
 * bug. Everything written from here on is clamped to CLIENT_CATEGORY_MAX_LENGTH
 * (28), but a legacy `industry` was typed with no ceiling at all. A longer one
 * keeps coming back from here whole and keeps rendering — `clientCategoryLabel`
 * is what shortens it for the chip — until somebody opens either editor, at
 * which point it is saved into `category` clamped. That convergence-on-edit is
 * the intended behaviour: no document is rewritten on our schedule, and no
 * value is lost before a person has chosen a shorter one.
 *
 * Blank counts as absent — a document may carry `category: ""` from a cleared
 * input, and an empty string must not shadow a legacy value that says something.
 */
export function clientCategoryValue(
  client: Pick<Client, "category" | "industry">,
): string | null {
  return client.category?.trim() || client.industry?.trim() || null;
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
