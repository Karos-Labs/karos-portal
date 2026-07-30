import { describe, expect, it } from "vitest";
import { postKind, type CalendarKindInput } from "@/lib/calendar-kind";

/**
 * Covers the deterministic "does a generated content plan actually reach the
 * calendar" chain: a chain-planned draft (scheduledAt set, no publishError)
 * must be visible as "draft", then reclassify correctly at each stage of its
 * real lifecycle — approval, publish, and a publish failure that (per
 * src/app/api/publish/route.ts) leaves status at "scheduled" with only
 * `publishError` set.
 */
function candidate(overrides: Partial<CalendarKindInput> = {}): CalendarKindInput {
  return { status: "draft", ...overrides };
}

describe("postKind", () => {
  it("classifies a chain-planned draft with a scheduledAt as draft", () => {
    const a = candidate({ status: "draft", scheduledAt: 1000 });
    expect(postKind(a)).toBe("draft");
  });

  it("does not put an undated draft on the calendar at all", () => {
    const a = candidate({ status: "draft" });
    expect(postKind(a)).toBeNull();
  });

  it("classifies an approved/scheduled asset as scheduled once dated", () => {
    const a = candidate({ status: "scheduled", scheduledAt: 1000 });
    expect(postKind(a)).toBe("scheduled");
  });

  it("classifies an approved asset (pre-cron) the same as scheduled", () => {
    const a = candidate({ status: "approved", scheduledAt: 1000 });
    expect(postKind(a)).toBe("scheduled");
  });

  it("classifies a placeholder-mode scheduled asset as placeholder", () => {
    const a = candidate({ status: "scheduled", scheduledAt: 1000, publishMode: "placeholder" });
    expect(postKind(a)).toBe("placeholder");
  });

  it("classifies a published asset as published", () => {
    const a = candidate({ status: "published", scheduledAt: 1000, publishedAt: 2000 });
    expect(postKind(a)).toBe("published");
  });

  it("classifies a scheduled asset with a publishError as failed, even though status stays 'scheduled'", () => {
    // Mirrors the publish cron's failure branch: it never flips status away
    // from "scheduled" on failure, so publishError is the only signal.
    const a = candidate({ status: "scheduled", scheduledAt: 1000, publishError: "Rate limited by LinkedIn" });
    expect(postKind(a)).toBe("failed");
  });

  it("does not classify a successfully published asset as failed even if a stale publishError lingers", () => {
    const a = candidate({ status: "published", scheduledAt: 1000, publishedAt: 2000, publishError: "old error" });
    expect(postKind(a)).toBe("published");
  });
});
