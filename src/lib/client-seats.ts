/**
 * Resolving a batch-note account heading back to a seat — the one piece of
 * matching every seat-agent write path needs, extracted so LinkedIn and X
 * (which write the identical "# Account N · <name>" heading convention, see
 * docs/x-agent-portal.md) share one implementation instead of two copies
 * drifting apart.
 */

import { listClientSeats } from "@/lib/data";
import type { ClientSeat } from "@/lib/types";

/**
 * The pure half of the match, split out so a caller that already has the
 * client's seat roster in hand (e.g. filtering every option in a day's batch)
 * can match many titles without a Firestore read per title.
 *
 * `accountTitle` is the batch's raw section heading. "Company page" in the
 * title (case-insensitive) means the client's own account; otherwise it's
 * matched against `seats`, longest name first so e.g. "Daniel Herbert" wins
 * over a seat named "Dan" when both are substrings of the heading. No match
 * at all falls back to "company" — the same fail-open default the LinkedIn
 * feedback action already relied on, kept here rather than surfacing a
 * resolution error mid-pick.
 */
export function matchAccountTitleToSeat(
  seats: readonly ClientSeat[],
  accountTitle: string,
): "company" | string {
  const title = accountTitle.toLowerCase();
  if (title.includes("company page")) return "company";
  const sorted = [...seats].sort((a, b) => b.name.length - a.name.length);
  return sorted.find((s) => title.includes(s.name.toLowerCase()))?.id ?? "company";
}

export async function resolveAccountTitleToSeat(
  clientId: string,
  accountTitle: string,
): Promise<"company" | string> {
  const title = accountTitle.toLowerCase();
  if (title.includes("company page")) return "company";
  const seats = await listClientSeats(clientId);
  return matchAccountTitleToSeat(seats, accountTitle);
}
