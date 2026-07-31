import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  ALL_RUN_STATES,
  pastRunBadgesReview,
  pastRunHasNoDeliverables,
  pastRunHasReviewTarget,
  pastRunStatuses,
  projectPastRuns,
  showsPastRunReviewControl,
} from "@/lib/calendar-past-runs";
import type { JobStatus } from "@/lib/types";

/**
 * F80 — the past-run card that told a client its batch run produced nothing.
 *
 * The card read "Instagram Agent · Delivered · Ran 3:14 PM" with "No
 * client-facing assets from this run." underneath, while dashed slot chips for
 * that same run sat on the following days of the grid. Three separate lies came
 * out of the one card, and all three are decided by lib/calendar-past-runs now,
 * so they are CALLED here rather than asserted from source:
 *
 *   1. A run whose every client-visible deliverable is still locked gets no
 *      client card at all — a client's calendar speaks in posts and slots, and a
 *      run that has given them nothing yet is not an event in their world.
 *   2. A client card can never badge "In review" with nowhere to review. That is
 *      the churn/lying-state guarantee, so it is pinned as an invariant over the
 *      whole input space below, not as a handful of cases.
 *   3. A staff-cancelled run is not a client event, whatever it produced.
 *
 * Staff keep every run in every state — the calendar is their operational
 * history, and each test that removes something from a client asserts the staff
 * answer in the same breath.
 */

function job(status: JobStatus, id = "job-1"): { id: string; status: JobStatus } {
  return { id, status };
}

/** What this module needs of an Asset, plus an id to identify one by. */
type TestAsset = { id: string; locked?: boolean };

/** Locked = a future-dated post the client may not be shown yet. */
function asset(id: string, locked = false): TestAsset {
  return locked ? { id, locked: true } : { id };
}

const byJob = (jobId: string, assets: TestAsset[]) => new Map([[jobId, assets]]);

/**
 * A run with no assets at all. Typed rather than a bare `new Map()` so `A` is
 * inferred from the map's values and not from the parameter's constraint.
 */
const noAssets = () => new Map<string, TestAsset[]>();

/**
 * Stands in for calendar-body's RunAssetView: the card's view of one
 * deliverable. Passed as `project` because the projection maps the list itself
 * — the array it guarantees non-empty for a client IS the array the card gets,
 * so there is no caller-side map for a later `filter` to hide in.
 */
const view = (a: TestAsset) => ({ id: a.id, painted: `view:${a.id}` });

const forClient = { isClient: true, project: view };
const forStaff = { isClient: false, project: view };

describe("which past runs reach a client's calendar", () => {
  it("drops the card for a run whose every deliverable is still locked, and keeps staff's whole", () => {
    const j = job("delivered");
    const week = [
      asset("mon", true),
      asset("tue", true),
      asset("wed", true),
      asset("thu", true),
      asset("fri", true),
      asset("sat", true),
      asset("sun", true),
    ];

    // The real client-side input. redactLockedAsset nulls a locked placeholder's
    // jobId, so a client's future posts never join their run in the first place
    // and the run arrives here with no assets at all.
    expect(projectPastRuns([j], noAssets(), forClient)).toEqual([]);

    // Belt-and-braces: handed the locked placeholders still keyed to the run,
    // the answer is the same.
    expect(projectPastRuns([j], byJob(j.id, week), forClient)).toEqual([]);

    // Staff see the run, with all seven deliverables — this is the fire that
    // produced the client's whole week.
    const staff = projectPastRuns([j], byJob(j.id, week), forStaff);
    expect(staff).toHaveLength(1);
    expect(staff[0].job).toBe(j);
    expect(staff[0].deliveredAssets.map((a) => a.id)).toEqual([
      "mon",
      "tue",
      "wed",
      "thu",
      "fri",
      "sat",
      "sun",
    ]);
  });

  it("keeps the card when the client HAS been given something, carrying only that", () => {
    const j = job("delivered");
    const week = [asset("today"), asset("tue", true), asset("wed", true), asset("thu", true)];

    const client = projectPastRuns([j], byJob(j.id, week), forClient);
    expect(client).toHaveLength(1);
    // Only today's post. Counting the locked slots in is what printed "4 posts ·
    // Ran 3:14 PM" (A3/A4) — and the scope of that, stated so this test is not
    // read as more: what a client is told about a run is held to what they have
    // been given AT THIS MOMENT. Tomorrow "tue" unlocks and rejoins the same run,
    // so this card's count climbs. Fixing that means changing what the card
    // counts, which is not this rule's job (see rule 2 in calendar-past-runs).
    expect(client[0].deliveredAssets.map((a) => a.id)).toEqual(["today"]);

    expect(
      projectPastRuns([j], byJob(j.id, week), forStaff)[0].deliveredAssets,
    ).toHaveLength(4);
  });

  it("never carries a cancelled or failed run to a client, even when that run delivered something", () => {
    const clientStates = pastRunStatuses({ isClient: true });
    // The closed question: exactly which states can reach a client's calendar.
    expect([...clientStates].sort()).toEqual([
      "approved",
      "delivered",
      "queued",
      "review",
      "running",
    ]);

    const staffStates = pastRunStatuses({ isClient: false });
    expect(staffStates.has("cancelled")).toBe(true);
    expect(staffStates.has("failed")).toBe(true);
    // A client can never be shown a state staff are not.
    expect([...clientStates].filter((s) => !staffStates.has(s))).toEqual([]);

    // Asked through the projection with an UNLOCKED deliverable present, so the
    // "nothing delivered" rule cannot be what is doing the work: the state alone
    // has to keep these two off a client's calendar.
    for (const status of ["cancelled", "failed"] as const) {
      const j = job(status);
      const delivered = byJob(j.id, [asset("a1")]);
      expect(projectPastRuns([j], delivered, forClient)).toEqual([]);
      expect(projectPastRuns([j], delivered, forStaff)).toHaveLength(1);
    }
  });

  it("keeps every run in every state for staff, including the ones that produced nothing", () => {
    const jobs = ALL_RUN_STATES.map((s, i) => job(s, `job-${i}`));
    const staff = projectPastRuns(jobs, noAssets(), forStaff);
    expect(staff.map((e) => e.job.status)).toEqual([...ALL_RUN_STATES]);
    expect(staff.every((e) => e.deliveredAssets.length === 0)).toBe(true);
  });
});

/**
 * The invariant, over the whole input space rather than a chosen case: for every
 * run state and every mix of locked/unlocked deliverables, a client entry that
 * badges "In review" has somewhere to send them.
 *
 * Quantified over BOTH values of canOpenJob on purpose. A client viewer gets
 * canOpenJob = false (their calendar is built with canSchedule off, and
 * /jobs/[id] is staff-guarded), and the false leg is the one that used to fail —
 * but the invariant holds either way once a client entry always carries a
 * deliverable, so the test does not have to take that prop on trust.
 */
const DELIVERABLE_MIXES: { label: string; assets: TestAsset[] }[] = [
  { label: "no assets at all", assets: [] },
  { label: "one locked", assets: [asset("a1", true)] },
  { label: "a locked week", assets: [asset("a1", true), asset("a2", true), asset("a3", true)] },
  { label: "one unlocked", assets: [asset("a1")] },
  { label: "unlocked + locked", assets: [asset("a1"), asset("a2", true)] },
  { label: "all unlocked", assets: [asset("a1"), asset("a2")] },
];

describe("a client's past-run card cannot name a review it does not offer", () => {
  it("holds for every run state × deliverable mix, and the space really contains review cards", () => {
    const namesAReview: string[] = [];
    const violations: string[] = [];
    const emptyClientCards: string[] = [];

    for (const status of ALL_RUN_STATES) {
      for (const mix of DELIVERABLE_MIXES) {
        const j = job(status);
        const entries = projectPastRuns([j], byJob(j.id, mix.assets), forClient);
        for (const entry of entries) {
          const where = `${status} / ${mix.label}`;
          if (entry.deliveredAssets.length === 0) emptyClientCards.push(where);
          // The card the component receives. `assets` is the projection's own
          // array, not a re-map of it — calendar-body passes its RunAssetView
          // builder as `project` and ships the result straight through, so what
          // the rule guarantees and what the card reads are one list.
          const card = { jobStatus: entry.job.status, assets: entry.deliveredAssets };
          for (const canOpenJob of [false, true]) {
            if (!pastRunBadgesReview(card)) continue;
            namesAReview.push(`${where} / canOpenJob=${canOpenJob}`);
            if (!pastRunHasReviewTarget(card, { canOpenJob })) violations.push(where);
            // The control the card actually renders is the conjunction, so the
            // badge and the control move together.
            expect(showsPastRunReviewControl(card, { canOpenJob })).toBe(true);
          }
        }
      }
    }

    expect(violations).toEqual([]);
    // Not vacuous: the matrix produced client cards badging "In review", and
    // none of them was empty.
    expect(namesAReview.length).toBeGreaterThan(0);
    expect(emptyClientCards).toEqual([]);
  });

  it("staff keep the review control on a run with nothing to show, because their target is the run itself", () => {
    const card = { jobStatus: "review" as JobStatus, assets: [] };
    expect(showsPastRunReviewControl(card, { canOpenJob: true })).toBe(true);
    expect(showsPastRunReviewControl(card, { canOpenJob: false })).toBe(false);
  });

  it("offers no review control for any other state", () => {
    for (const status of ALL_RUN_STATES.filter((s) => s !== "review")) {
      const card = { jobStatus: status, assets: [{ id: "a1" }] };
      expect(showsPastRunReviewControl(card, { canOpenJob: true })).toBe(false);
      expect(showsPastRunReviewControl(card, { canOpenJob: false })).toBe(false);
    }
  });
});

/**
 * The boundary the two rules meet at. `projectPastRuns` guarantees a client
 * entry is non-empty; `pastRunHasNoDeliverables` and `showsPastRunReviewControl`
 * ask the card's `assets`. Those are the same list only if nothing sits between
 * the guarantee and the card — which is why the projection does the mapping.
 *
 * Asked closed: is the returned array the mapper's output, one element per
 * deliverable this viewer may be shown? A projection that narrowed its own
 * mapped list — "only assets with a preview" — would put a client card with
 * `assets: []` back under a "Delivered" badge, and these lengths are what fails
 * when it does.
 */
describe("the list the non-empty rule guarantees is the list the card receives", () => {
  it("returns one mapped view per shown deliverable, for both viewers, with no filter after the map", () => {
    for (const status of ALL_RUN_STATES) {
      for (const mix of DELIVERABLE_MIXES) {
        const where = `${status} / ${mix.label}`;
        const j = job(status);
        const unlocked = mix.assets.filter((a) => !a.locked);

        for (const [opts, expected] of [
          [forClient, unlocked],
          [forStaff, mix.assets],
        ] as const) {
          const entries = projectPastRuns([j], byJob(j.id, mix.assets), opts);
          if (entries.length === 0) continue;
          expect(entries[0].deliveredAssets, where).toHaveLength(expected.length);
          // Mapped, not passed through: `painted` exists only on the view.
          expect(entries[0].deliveredAssets, where).toEqual(expected.map(view));
        }
      }
    }
  });

  it("hands the card that same list bare, with nothing filtered out on the way", () => {
    // The mapper closes half of this. It makes a narrowing MAPPER structurally
    // impossible — one V per A — but the CALLER still owns the row's `assets:`
    // field, and that is where the forbidden filter can still go. The verify
    // lens proved it: `assets: views.filter((v) => v.images.length > 0 || ...)`
    // passed the whole suite while reproducing both original lies, because
    // `outputSummary` is computed from the unfiltered list, so the card said
    // "1 post" and "produced no assets" at once again.
    //
    // Asked closed: is `assets:` assigned the bare name, and is that the same
    // name outputSummary counts? Anything between the name and the comma —
    // .filter, .slice, .map — fails here.
    const src = readFileSync(
      resolve(__dirname, "../../app/(app)/calendar/calendar-body.tsx"),
      "utf8",
    ).replace(/\s+/g, " ");
    const assigned = src.match(/assets:\s*([A-Za-z_$][\w$]*)\s*,/);
    expect(assigned, "assets: must be assigned a bare identifier, not an expression").not.toBeNull();
    expect(src).toContain(`describeRunOutput(${assigned![1]})`);
  });
});

describe("what the card may say about output", () => {
  it("calls a run empty only when it delivered nothing — not when it delivered something unpaintable", () => {
    // A clip with no caption: one delivered asset, nothing either the image
    // gallery or the text list can render inline. Announcing "no assets" for it
    // contradicted the card's own "1 post" summary one line above.
    expect(pastRunHasNoDeliverables({ assets: [{ id: "clip" }] })).toBe(false);
    expect(pastRunHasNoDeliverables({ assets: [] })).toBe(true);
    expect(pastRunHasNoDeliverables({})).toBe(true);
  });
});
