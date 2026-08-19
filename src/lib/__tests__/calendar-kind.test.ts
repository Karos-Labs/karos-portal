import { describe, expect, it } from "vitest";
import { publishHoldMessage } from "@/lib/asset-status-copy";
import {
  ALL_CALENDAR_FILTER_KEYS,
  calendarFilterKeyMatchable,
  isClientCalendarStatus,
  postKind,
  type CalendarAssetKind,
  type CalendarFilterKey,
  type CalendarKindInput,
} from "@/lib/calendar-kind";
import { pastRunStatuses } from "@/lib/calendar-past-runs";

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

/**
 * Which legend chips a viewer is offered — DERIVED here rather than read back.
 *
 * The legend is also the filter, so a chip a viewer's calendar can never hold is
 * a control that can never dim anything. `calendarFilterKeyMatchable` answers
 * that, and its list of unmatchable keys is a hand-written claim; this is what
 * makes the claim honest. The grid below runs `postKind` over every field it
 * reads and collects the kinds a CLIENT-visible asset can produce, so a change
 * to either the classifier or the client status filter fails HERE instead of
 * silently withholding a filter a client needed.
 *
 * The grid is an UPPER bound, deliberately: it ignores the RSC redaction
 * (redactLockedAsset drops publishError from a locked post, and every publishMode
 * except "placeholder"),
 * which can only remove shapes. So a key is withheld only when no shape at all
 * could match it — the safe direction.
 */
describe("the legend's per-viewer chips", () => {
  const HOLD = publishHoldMessage(
    { title: "Part 1 of 3", status: "approved" },
    { clientCanSeeBlocker: true },
  );

  const STATUSES: CalendarKindInput["status"][] = [
    "draft",
    "approved",
    "scheduled",
    "published",
    "delivered",
  ];

  /**
   * Every shape `postKind` can distinguish: the five statuses crossed with the
   * four other fields it reads. Hand-built, so the assertion below checks the
   * grid's own reach — if a branch is ever keyed on a field this grid does not
   * vary, the coverage assertion fails rather than this suite quietly narrowing.
   */
  function grid(): CalendarKindInput[] {
    const out: CalendarKindInput[] = [];
    for (const status of STATUSES) {
      for (const publishError of [undefined, HOLD, "Rate limited by LinkedIn"]) {
        for (const publishMode of [undefined, "placeholder"]) {
          for (const scheduledAt of [undefined, 1000]) {
            for (const publishedAt of [undefined, 2000]) {
              out.push({
                status,
                ...(publishError ? { publishError } : {}),
                ...(publishMode ? { publishMode } : {}),
                ...(scheduledAt ? { scheduledAt } : {}),
                ...(publishedAt ? { publishedAt } : {}),
              });
            }
          }
        }
      }
    }
    return out;
  }

  const kindsFrom = (assets: CalendarKindInput[]): Set<CalendarAssetKind> => {
    const out = new Set<CalendarAssetKind>();
    for (const a of assets) {
      const kind = postKind(a);
      if (kind) out.add(kind);
    }
    return out;
  };

  it("probes every kind the calendar has, so the derivation below is not narrow", () => {
    // Non-vacuity for the whole describe: the grid must reach EVERY chip kind,
    // or "a client cannot match this one" could be an artefact of a grid that
    // never built the shape. "review" and "suggested" are the two keys that
    // are not asset kinds at all — a run state and a Task-Map proposal
    // (lib/calendar-suggestion-placement.ts) respectively, neither derivable
    // from a `CalendarKindInput` shape — so both are excluded here and asked
    // of their own tables below.
    const everyKind = kindsFrom(grid());
    expect([...everyKind].sort()).toEqual(
      ALL_CALENDAR_FILTER_KEYS.filter((k) => k !== "review" && k !== "suggested").sort(),
    );
  });

  it("offers a client every chip their calendar can hold — drafts included, by reversal", () => {
    const clientKinds = kindsFrom(grid().filter((a) => isClientCalendarStatus(a.status)));
    // "review" comes off the run-visibility table, not off postKind — one home
    // each, and read here rather than restated. "suggested" is simpler still:
    // a Task-Map suggestion has never been staff-only (its grid placement in
    // run-calendar.tsx has always rendered for a client's own calendar), so it
    // is matchable for every viewer, unconditionally — the same answer
    // `calendarFilterKeyMatchable` gives by NOT listing it in
    // CLIENT_UNMATCHABLE_FILTER_KEYS.
    const clientCanMatch = (key: CalendarFilterKey): boolean =>
      key === "review"
        ? pastRunStatuses({ isClient: true }).has("review")
        : key === "suggested"
          ? true
          : clientKinds.has(key);

    for (const key of ALL_CALENDAR_FILTER_KEYS) {
      expect(calendarFilterKeyMatchable(key, true), `client chip: ${key}`).toBe(
        clientCanMatch(key),
      );
    }

    // The answer that derivation produces today, pinned so a change to it is a
    // decision someone takes rather than a diff nobody reads. "draft" used to be
    // withheld (a client's calendar was never built from it); the product
    // decision behind `isClientCalendarStatus` reversed that, so every OTHER key
    // is matchable for a client, same as staff. "review" is pinned the other way
    // now (2026-08, locked: "In review is removed") — the one key a client's
    // calendar can never hold at all, reversing what this same loop asserted
    // before that decision landed.
    for (const key of ALL_CALENDAR_FILTER_KEYS) {
      expect(calendarFilterKeyMatchable(key, true), `client chip: ${key}`).toBe(key !== "review");
    }
  });

  it("offers staff every chip — unchanged by the client-side reversal", () => {
    // The neighbouring case: staff always saw internal drafts on their calendar
    // and filtered by them, before and after the reversal above.
    for (const key of ALL_CALENDAR_FILTER_KEYS) {
      expect(calendarFilterKeyMatchable(key, false), `staff chip: ${key}`).toBe(true);
    }
    // `isClientCalendarStatus` always returns `true` now — see its docstring —
    // so every status, draft included, passes for both viewers.
    for (const status of STATUSES) {
      expect(isClientCalendarStatus(status), status).toBe(true);
    }
  });
});
