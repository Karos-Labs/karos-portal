import { describe, expect, it } from "vitest";
import { publishHoldMessage } from "@/lib/asset-status-copy";
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

/**
 * The other thing `publishError` holds.
 *
 * The publish cron writes its benign ORDERING HOLD into the same field as a
 * platform exception, so every held post was classified "failed" — a red
 * "Failed to publish" chip on the client's calendar and a "Publish failed"
 * heading over a body that said the post was waiting its turn.
 *
 * Every case below is built from ONE fixture shape (a due, dated, scheduled
 * post) with only the stored string changing, so a pass cannot come from a
 * fixture that never reached the branch.
 */
describe("postKind and the ordering hold", () => {
  /** Due and dated: what the cron was looking at when it wrote the field. */
  const due = { status: "scheduled", scheduledAt: 1000 } as const;

  /**
   * The real sentence, from the module that composes it — not a paraphrase.
   * Retyping it here would let the two drift and leave this suite green while
   * the shipped message stopped being recognised.
   */
  const HOLD = publishHoldMessage(
    { title: "Part 1 of 3", status: "approved" },
    { clientCanSeeBlocker: true },
  );

  it("classifies a held post as held, and a genuinely failed one still as failed", () => {
    expect(postKind({ ...due, publishError: HOLD })).toBe("held");
    expect(postKind({ ...due, publishError: "Rate limited by LinkedIn" })).toBe("failed");
  });

  it("keeps a held post ON the calendar — it is waiting, not withdrawn", () => {
    // The neighbouring case for the assertion above: "not failed" would also be
    // satisfied by dropping the post off the grid entirely, which would hide a
    // dated post the client is expecting.
    expect(postKind({ ...due, publishError: HOLD })).not.toBeNull();
  });

  it("recognises the hold by its own distinctive opener, not by a generic one", () => {
    // The loosening this forbids is replacing the shared prefix with a two-word
    // generic opener ("Waiting for"), which could equally be the first words of
    // an upstream SDK exception. Under it BOTH lines flip: the real message
    // stops matching and is called a failure, and this hand-rolled string —
    // the pre-fix inline wording, spaced hyphen and all — starts being waved
    // through as benign.
    expect(postKind({ ...due, publishError: HOLD })).toBe("held");
    expect(
      postKind({ ...due, publishError: `Waiting for "Part 1 of 3" - it comes earlier.` }),
    ).toBe("failed");
  });

  it("does not call a published post held on the strength of a stale hold", () => {
    // Same exclusion the "failed" branch has always had, and it has to survive
    // the new branch: the post went out, whatever the field still says.
    expect(
      postKind({ status: "published", scheduledAt: 1000, publishedAt: 2000, publishError: HOLD }),
    ).toBe("published");
  });
});
