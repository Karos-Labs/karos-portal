import { describe, expect, it } from "vitest";

import {
  ALL_CALENDAR_FILTER_KEYS,
  type CalendarAssetKind,
  calendarFilterLabel,
  postKindLabel,
} from "@/lib/calendar-kind";
import { jobStatusLabel } from "@/lib/job-status-copy";

/**
 * TWO REGISTERS OVER ONE KEY DOMAIN, AND THE THREE PLACES THEY DIVERGE ON PURPOSE.
 *
 * The calendar legend needs SHORT words — its chip tooltip reads "Show <label>
 * items" — while the chip and the detail panel need the full sentence. So
 * `CALENDAR_FILTER_LABEL` and `POST_KIND_LABEL` are deliberately not the same
 * map. That is a defensible split, and it is also exactly the shape this campaign
 * calls a second answer to one question, so it needs pinning rather than prose.
 *
 * WHY BY NAME AND NOT BY COUNT. The register's docstring used to say "four of the
 * six agree and three deliberately do not" — wrong (three agree), impossible over
 * six, and it listed only two of the three, omitting `scheduled`. A number in a
 * comment is a claim the file cannot verify. This file is the verification: the
 * divergence set is fixed and each entry carries its reason, so CLOSING one of
 * these three silently, or opening a FOURTH, is a failure here.
 *
 * The assertions read the accessors rather than the private maps, so they also
 * cover the viewer-aware override and the fallback path.
 */

/** The kinds both registers name. `review` is a JobStatus, not a post kind. */
const SHARED: CalendarAssetKind[] = ALL_CALENDAR_FILTER_KEYS.filter(
  (k): k is CalendarAssetKind => k !== "review",
);

/**
 * legend word → chip word, for the three that differ, with why.
 *
 * Written as the EXPECTED PAIR rather than as "these keys differ", so a change
 * that swaps one divergence for another cannot pass by keeping the count.
 */
const DELIBERATE_DIVERGENCE: Record<string, { legend: string; chip: string; why: string }> = {
  scheduled: {
    legend: "Scheduled",
    chip: "Scheduled post",
    why: '"Show scheduled post items" does not read; the legend filters dates, the chip names a thing',
  },
  failed: {
    legend: "Failed",
    chip: "Failed to publish",
    why: "the chip has to say what failed; the filter only has to be pressable",
  },
  held: {
    legend: "Waiting",
    chip: "Waiting its turn",
    why: "PUBLISH_HOLD_HEADING is the client explanation, too long for a chip",
  },
};

describe("the legend register diverges from the chip register in exactly three places", () => {
  it("finds the shared key domain it is about to check", () => {
    // Without this the loops below pass by looking at nothing.
    expect(SHARED.length).toBeGreaterThanOrEqual(6);
  });

  for (const kind of SHARED) {
    const expected = DELIBERATE_DIVERGENCE[kind];
    if (expected) {
      it(`${kind} diverges — ${expected.why}`, () => {
        expect(calendarFilterLabel(kind, false)).toBe(expected.legend);
        expect(postKindLabel(kind, false)).toBe(expected.chip);
      });
    } else {
      it(`${kind} agrees, and must keep agreeing`, () => {
        // An UNDOCUMENTED divergence appearing here is the drift the split invites:
        // two words for one state with no reason written down anywhere.
        expect(calendarFilterLabel(kind, false)).toBe(postKindLabel(kind, false));
      });
    }
  }

  it("adds no fourth divergence and drops none of the three", () => {
    const diverging = SHARED.filter(
      (k) => calendarFilterLabel(k, false) !== postKindLabel(k, false),
    ).sort();
    expect(diverging).toEqual(Object.keys(DELIBERATE_DIVERGENCE).sort());
  });
});

describe("the legend never invents a word for a state another register owns", () => {
  /**
   * #97. The legend read "Pending review" while the run card three lines of
   * scroll below, on the same screen, read "In review" from JOB_STATUS_META.
   * `review` is a JobStatus — the filter matches `r.jobStatus === "review"` — so
   * the legend has no business naming it.
   */
  it("takes review from the run-state register, both viewers", () => {
    expect(calendarFilterLabel("review", false)).toBe(jobStatusLabel("review"));
    expect(calendarFilterLabel("review", true)).toBe(jobStatusLabel("review"));
  });

  it("does not say 'Pending review' anywhere in the legend", () => {
    const words = ALL_CALENDAR_FILTER_KEYS.flatMap((k) => [
      calendarFilterLabel(k, false),
      calendarFilterLabel(k, true),
    ]);
    expect(words).not.toContain("Pending review");
  });
});

describe("the viewer override is asked once, in the accessor", () => {
  /**
   * `published` had its client/staff override written twice — in `postKindLabel`
   * and again at the render site. Asking the accessor for both viewers is what
   * proves the override still lives inside it rather than back at a caller.
   */
  it("answers published per viewer through the accessor", () => {
    const staff = calendarFilterLabel("published", false);
    const client = calendarFilterLabel("published", true);
    expect(staff).toBeTruthy();
    expect(client).toBeTruthy();
    // Not asserting they differ — that is the register's call, not this test's.
    // Asserting only that the question reaches the accessor for both.
    expect(postKindLabel("published", true)).toBe(client);
    expect(postKindLabel("published", false)).toBe(staff);
  });

  it("renders no raw enum for any key, either viewer", () => {
    for (const key of ALL_CALENDAR_FILTER_KEYS) {
      for (const viewerIsClient of [true, false]) {
        const label = calendarFilterLabel(key, viewerIsClient);
        expect(label).not.toMatch(/_/);
        expect(label[0]).toBe(label[0]!.toUpperCase());
      }
    }
  });
});
