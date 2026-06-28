/** Shared analytics constants — no server-only dependency, safe for both client and server. */

export const RANGE_OPTIONS = [
  { value: "24h",   label: "Last 24h" },
  { value: "7d",    label: "Last 7 days" },
  { value: "30d",   label: "Last 30 days" },
  { value: "month", label: "This month" },
] as const;

export type RangeKey = (typeof RANGE_OPTIONS)[number]["value"];

export function isValidRange(v: unknown): v is RangeKey {
  return RANGE_OPTIONS.some((o) => o.value === v);
}

/** Convert a range key to an epoch-millis lower bound. */
export function rangeToSince(range: RangeKey | string): number {
  const now = Date.now();
  switch (range) {
    case "24h":   return now - 24 * 3_600_000;
    case "7d":    return now - 7  * 86_400_000;
    case "30d":   return now - 30 * 86_400_000;
    case "month": {
      const d = new Date();
      return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
    }
    default: return 0;
  }
}
