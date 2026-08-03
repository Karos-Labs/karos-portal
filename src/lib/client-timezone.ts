/**
 * WHOSE DAY IT IS — the client's own IANA zone, read safely.
 *
 * `lib/scheduling.ts` says the cost of not having this out loud: "'Local' here
 * is THE RUNTIME'S OWN ZONE… A day boundary is therefore the boundary of
 * whichever machine asked, never the client's own", and names the fix as giving
 * `Client` a zone. `Client.timeZone` is that field, and this is the one place it
 * is read.
 *
 * THROUGH A RESOLVER, NEVER OFF THE RECORD. A stored id is typed by a person and
 * reaches `Intl.DateTimeFormat`, which THROWS on an unknown zone — inside a cron
 * that is mailing several clients in one pass, so one bad string would take the
 * whole sweep down and not just its own client's mail. `isValidTimeZone` is the
 * existing guard for exactly that, and the fallback is the runtime's zone, which
 * is the behaviour every other surface already has.
 *
 * CLIENT-SAFE: no firebase-admin, no data.ts.
 */

import type { Client } from "@/lib/types";
import { isValidTimeZone, localYMD, runtimeTimeZone, zonedWallToUtc } from "@/lib/run-cadence";

/** The zone this client's calendar day is read in. Falls back to the runtime's. */
export function clientTimeZone(client: Pick<Client, "timeZone">): string {
  return isValidTimeZone(client.timeZone) ? client.timeZone : runtimeTimeZone();
}

/** One local calendar day, as the half-open UTC window `[startMs, endMs)`. */
export interface LocalDay {
  /** `YYYY-MM-DD` in the zone — the stable key an idempotence marker can be read back against. */
  dateKey: string;
  /** Local midnight, in epoch millis. */
  startMs: number;
  /** The FOLLOWING local midnight, in epoch millis. Exclusive. */
  endMs: number;
  /** Hour of day (0..23) `atUtcMs` falls on in this zone. */
  hour: number;
}

const pad = (n: number) => String(n).padStart(2, "0");

/**
 * The local day an instant falls on in `timeZone`, plus that instant's local
 * hour.
 *
 * Both boundaries come from `zonedWallToUtc`, so a DST day is a real 23 or 25
 * hours long rather than a fixed 86,400,000 added to midnight — which is what
 * would put an 11:00 slot outside its own day twice a year.
 */
export function localDayIn(timeZone: string, atUtcMs: number): LocalDay {
  const { y, mo, d } = localYMD(timeZone, atUtcMs);
  const startMs = zonedWallToUtc(y, mo, d, 0, 0, timeZone);
  // The next calendar date, taken through UTC arithmetic on the plain Y/M/D so
  // month and year ends carry correctly, then read back as a wall clock.
  const next = new Date(Date.UTC(y, mo - 1, d) + 24 * 60 * 60 * 1000);
  const endMs = zonedWallToUtc(
    next.getUTCFullYear(),
    next.getUTCMonth() + 1,
    next.getUTCDate(),
    0,
    0,
    timeZone,
  );
  return {
    dateKey: `${y}-${pad(mo)}-${pad(d)}`,
    startMs,
    endMs,
    // Derived from the day's own start rather than from a second Intl call, so
    // the hour and the window can never disagree about which day they are on.
    hour: Math.floor((atUtcMs - startMs) / (60 * 60 * 1000)),
  };
}
