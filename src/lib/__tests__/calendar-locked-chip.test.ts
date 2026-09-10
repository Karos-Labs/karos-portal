import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { publishHoldMessage } from "@/lib/asset-status-copy";
import { postKind, type CalendarAssetKind, type CalendarKindInput } from "@/lib/calendar-kind";
import { isAssetContentVisibleToClient, redactLockedAsset } from "@/lib/asset-visibility";
import { stripComments, matchingBrace, matchingParen } from "./source-scan";
import type { Asset } from "@/lib/types";

/**
 * TWO THINGS THE CALENDAR TELLS A CLIENT ABOUT A WEEK THEY CANNOT SEE YET.
 *
 * 1. THE CHIP ON A LOCKED DAY. A client's future-dated posts cross the RSC
 *    boundary as whitelist-redacted copies (`redactLockedAsset`), and the
 *    calendar's classifier (`postKind`) runs on those copies. So every field
 *    the classifier reads that the redaction does not carry is a field it is
 *    BLIND TO for exactly the posts a client cannot see — and the answer it
 *    reaches while blind is the chip the client reads until the day arrives.
 *    `publishMode` was dropped, so a roadmap entry the tier's own promise says
 *    Karos never posts was painted "Scheduled post" and flipped to
 *    "Placeholder" on its own day.
 *
 * 2. WHAT HAPPENS WHEN THEY PAUSE. The calendar is built from ACTIVE schedules
 *    only, so a pause removes the row from the page's data and unmounts the
 *    card that performed it — taking with it the reassurance the card printed
 *    and leaving no control anywhere on the surface that could undo it.
 *
 * ── HOW MUCH OF THIS IS DERIVED, AND WHAT IS NOT ────────────────────────────
 * The question worth asking of (1) is closed: every field a client-side
 * predicate reads must survive redaction. BOTH SIDES OF IT ARE DERIVED HERE —
 * the read set by instrumenting `postKind` itself with a Proxy, the carried set
 * by running `redactLockedAsset` — so neither is a list typed out and trusted.
 * What is NOT derived, and cannot be:
 *
 *   · THE PREDICATE. This asks it of `postKind`, by name, and `postKind` alone.
 *     There is no property of a module that says "this function runs on a
 *     redacted asset", so the set of them cannot be enumerated mechanically and
 *     THIS SUITE DOES NOT CLAIM TO COVER IT. A redacted asset also reaches
 *     `AssetDetailModal` and `assetImages` (RunCalendar is handed the projected
 *     assets whole) and MarkPostedRow — and MarkPostedRow shows why the gap is
 *     not closable by trying harder: its rule is an inline `eligible`
 *     expression, not a function, so nothing can instrument it. Its own lock
 *     behaviour is pinned separately, in mark-posted-lock.test.ts.
 *   · THE VALUES. A field name does not imply what is worth putting in it, so
 *     `FIELD_VALUES` below is written by hand — but not trusted: its keys must
 *     EQUAL the fields `postKind` actually reads, so a classifier that starts
 *     reading a new one turns this red rather than going quietly uncovered.
 *   · ONE FIELD GENUINELY CANNOT CROSS. `publishError` holds the platform SDK's
 *     own exception. That residual is asserted, not assumed away, and asserted
 *     in a form that goes red if it ever stops being one.
 */

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 6, 15, 12, 0, 0);
const FUTURE = NOW + 5 * DAY;
const PAST = NOW - 5 * DAY;

/** The real sentence, from the module that composes it — never a paraphrase. */
const HOLD = publishHoldMessage({ title: "Part 1 of 3", status: "approved" }, { clientCanSeeBlocker: true });
const SDK_EXCEPTION = "Rate limited by LinkedIn";

/**
 * Candidate values per classifier field.
 *
 * Typed, because nothing can invent a meaningful value from a field's name —
 * and checked, by `readsExactlyTheseFields` below, so the typing is a starting
 * point rather than the scope of the sweep.
 */
const FIELD_VALUES = {
  status: ["draft", "approved", "scheduled", "delivered", "published"],
  scheduledAt: [undefined, FUTURE, PAST],
  publishedAt: [undefined, PAST],
  publishMode: [undefined, "auto", "manual", "placeholder"],
  publishError: [undefined, HOLD, SDK_EXCEPTION],
} satisfies Record<string, unknown[]>;

type Shape = Partial<Record<keyof typeof FIELD_VALUES, unknown>>;

/** The full cartesian product of the values above. */
function grid(): Shape[] {
  let out: Shape[] = [{}];
  for (const [field, values] of Object.entries(FIELD_VALUES)) {
    out = out.flatMap((base) =>
      values.map((value) => (value === undefined ? base : { ...base, [field]: value })),
    );
  }
  // De-duplicate: an `undefined` candidate produces the same shape as its
  // siblings' absence, so the product carries repeats. Cosmetic, but it keeps
  // the non-vacuity counts below meaning what they say.
  const seen = new Map<string, Shape>();
  for (const shape of out) seen.set(JSON.stringify(shape), shape);
  return [...seen.values()];
}

/** A complete Asset carrying one grid shape — every field the redaction judges. */
function assetFrom(shape: Shape): Asset {
  return {
    id: "asset-1",
    clientId: "client-1",
    jobId: "job-1",
    agentId: "agent-1",
    type: "social_post",
    title: "Secret campaign reveal",
    content: "Top secret body",
    meta: { source: "lab-import" },
    imageUrl: "https://cdn/secret.png",
    videoUrl: null,
    mimeType: "image/png",
    channels: ["instagram"],
    scheduledPlatform: "instagram",
    recommendedAt: FUTURE,
    recommendedReason: "peaks on Tuesdays",
    orderKey: "2026-07-10#01",
    templateKey: "by-the-numbers",
    templateName: "By The Numbers",
    createdBy: "staff-1",
    createdAt: PAST,
    updatedAt: PAST,
    ...(shape as Partial<Asset>),
    status: (shape.status as Asset["status"]) ?? "scheduled",
  };
}

/**
 * The shapes that actually take the redaction path — asked of the real gate
 * (`isAssetContentVisibleToClient`) rather than reasoned about from the dates.
 */
function lockedShapes(): Shape[] {
  return grid().filter((shape) => !isAssetContentVisibleToClient(assetFrom(shape), NOW));
}

/** The fields `postKind` actually touches, recorded off the function itself. */
function fieldsReadBy(shape: Shape): string[] {
  const seen = new Set<string>();
  const spy = new Proxy(shape as CalendarKindInput, {
    get(target, prop, receiver) {
      if (typeof prop === "string") seen.add(prop);
      return Reflect.get(target, prop, receiver);
    },
  });
  postKind(spy);
  return [...seen];
}

/**
 * `PausedRunNotice`'s BODY.
 *
 * The brace after the function NAME opens the destructured parameter list, not
 * the body — slicing from there yields `{ run, onDone }` and every assertion
 * over it reads almost nothing. Walk past the parameter parens first.
 */
function noticeBody(src: string): string {
  const at = src.indexOf("function PausedRunNotice");
  if (at < 0) throw new Error("PausedRunNotice not found — it moved or was renamed");
  const closeParen = matchingParen(src, src.indexOf("(", at));
  const open = src.indexOf("{", closeParen);
  return src.slice(open, matchingBrace(src, open) + 1);
}

describe("what the classifier reads and what the redaction carries", () => {
  it("reads exactly the fields this sweep varies, so nothing goes uncovered", () => {
    // The union across the whole grid, not one call: `postKind` short-circuits
    // on `publishError`, so a probe carrying one returns before the later
    // branches are reached and reports a read set that is missing whatever those
    // branches ask for.
    const read = new Set<string>();
    for (const shape of grid()) for (const field of fieldsReadBy(shape)) read.add(field);

    expect([...read].sort()).toEqual(Object.keys(FIELD_VALUES).sort());
  });

  it("hands a locked post's classifier every field that can change its answer", () => {
    // THE CLOSED QUESTION, and every side of it derived: the read set off the
    // function, the carried set off the redaction, and DECISIVENESS off the
    // classifier again. Not a list of field names typed here and compared to
    // itself, and not a written exemption either.
    const read = new Set<string>();
    for (const shape of grid()) for (const field of fieldsReadBy(shape)) read.add(field);

    // Asked of a placeholder, because that is the value the redaction carries —
    // the value scoping is pinned in its own test below.
    const carried = new Set(
      Object.keys(redactLockedAsset(assetFrom({ status: "scheduled", scheduledAt: FUTURE, publishMode: "placeholder" }))),
    );
    const blind = [...read].filter((field) => !carried.has(field)).sort();
    expect(blind, "nothing the classifier reads is withheld — re-read this suite's premise").not.toEqual([]);

    // BLINDNESS IS NOT THE DEFECT; DECISIVE BLINDNESS IS. `publishedAt` is
    // withheld and read, and costs nothing: the same gate that triggers the
    // redaction (`isAssetContentVisibleToClient`) returns true the moment that
    // field is set, so it cannot be present on a post that takes this path —
    // which the sweep below establishes by deleting it and finding the answer
    // unchanged, rather than by asserting it here in prose.
    const decisive = blind.filter((field) =>
      lockedShapes().some((shape) => {
        const without = { ...shape };
        delete without[field as keyof Shape];
        return postKind(shape as CalendarKindInput) !== postKind(without as CalendarKindInput);
      }),
    );
    expect(
      decisive,
      "the calendar's classifier is missing a field it decides on, for every post a client cannot see yet",
    ).toEqual(["publishError"]);
  });

  it("carries the placeholder marker and nothing else about how a post goes out", () => {
    // The value scoping, stated as the equivalence the classifier depends on:
    // on a redacted asset, `publishMode === "placeholder"` holds exactly when
    // the real asset is one.
    //
    // BOTH DIRECTIONS RED, and they are different failures. Narrowing it back to
    // nothing is the defect that shipped — the behavioural sweep below reddens
    // with it. Widening it to carry "auto"/"manual" as well keeps the chip
    // correct and this test still fails, deliberately: what crosses a redaction
    // boundary is a disclosure decision, and it gets taken here rather than in a
    // diff. (Measured: the widening also reddens mark-posted-lock.test.ts, which
    // pins that a locked card cannot key off this field.)
    const locked = { status: "scheduled" as const, scheduledAt: FUTURE };
    for (const mode of [undefined, "auto", "manual"] as const) {
      expect(
        redactLockedAsset(assetFrom({ ...locked, publishMode: mode })).publishMode,
        `publishMode ${String(mode)}`,
      ).toBeUndefined();
    }
    expect(redactLockedAsset(assetFrom({ ...locked, publishMode: "placeholder" })).publishMode).toBe(
      "placeholder",
    );
  });

  it("states the one field it cannot carry, and shows the residual is real", () => {
    // NOT "this is fine" written in a comment. The exclusion is asserted (the
    // exception string is what the field holds, and it may not reach a client
    // — publish-error-boundary.test.ts owns that rule), and so is its cost: the
    // loss genuinely changes the answer, which is why the behavioural sweep
    // below skips these shapes instead of pretending they agree.
    //
    // If `publishError` ever starts crossing, the first assertion here goes red
    // and the skip below has to be deleted with it.
    const failed = assetFrom({ status: "scheduled", scheduledAt: FUTURE, publishError: SDK_EXCEPTION });
    expect(redactLockedAsset(failed).publishError).toBeUndefined();
    expect(postKind(failed)).toBe("failed");
    expect(postKind(redactLockedAsset(failed))).toBe("scheduled");
  });
});

describe("the chip on a day the client cannot see yet", () => {
  it("is the same chip the post will carry once it unlocks", () => {
    const chips = new Set<CalendarAssetKind>();
    let compared = 0;
    for (const shape of lockedShapes()) {
      // The stated residual, and the only skip in this sweep.
      if (shape.publishError !== undefined) continue;
      const asset = assetFrom(shape);
      const locked = postKind(redactLockedAsset(asset));
      compared += 1;
      if (locked) chips.add(locked);
      expect(locked, `locked chip differs from the unlocked one: ${JSON.stringify(shape)}`).toBe(
        postKind(asset),
      );
    }

    // NON-VACUITY, and specifically for the branch that shipped the defect: a
    // sweep that never built a locked placeholder would pass on the broken code.
    // Every chip a locked post can carry has to have been produced. (Some locked
    // shapes classify to nothing at all — a dated "delivered" asset has no chip —
    // and those are not a kind this list should name.)
    expect(compared, "no locked shape was compared — the lock gate rejected the whole grid").toBeGreaterThan(0);
    expect([...chips].sort(), "the sweep never reached every chip a locked post can carry").toEqual([
      "draft",
      "placeholder",
      "scheduled",
    ]);
  });

  it("neither invents a chip nor loses one when the post is still locked", () => {
    // THE NEIGHBOURING CASES for the equality above, which "same answer either
    // side" satisfies in two useless ways as well as the right one: returning
    // null for every locked post empties a client's calendar, and returning a
    // chip for a post that has none fills it with entries nothing will honour.
    // Both are asked here as values rather than as "they agree".
    const roadmap = assetFrom({ status: "scheduled", scheduledAt: FUTURE, publishMode: "placeholder" });
    expect(postKind(redactLockedAsset(roadmap))).toBe("placeholder");

    const delivered = assetFrom({ status: "delivered", scheduledAt: FUTURE });
    expect(postKind(delivered), "the fixture is not the no-chip case it is meant to be").toBeNull();
    expect(postKind(redactLockedAsset(delivered))).toBeNull();
  });
});

/* ────────────────── pause: the acknowledgement and the way back ───────────── */

/**
 * SOURCE, not markup. `components/run-calendar.tsx` imports the planned-run
 * server actions, which reach the Admin-SDK data layer, so vitest cannot load
 * the module at all — the same reason status-render-sweep.test.ts reads this
 * file as text. What a source guard proves is that the structure is WRITTEN;
 * that it renders is not a claim made here.
 *
 * The structural question is the whole finding: the acknowledgement and the
 * resume must not live inside the component that the pause unmounts. So both
 * are asked as "is this index inside ScheduledRunCard's own body", off the same
 * brace walk the rest of this directory uses — never as "does the file contain
 * this string", which was true of the broken version too.
 */
describe("pausing a schedule from the calendar", () => {
  const RUN_CALENDAR = join(process.cwd(), "src", "components", "run-calendar.tsx");
  // stripComments, like both sibling files in this diff: a scan over RAW text is
  // satisfied by PROSE describing the thing it looks for, and these three
  // assertions were — deleting the acknowledgement from the UI and leaving it
  // as a JSX comment kept them green.
  const src = stripComments(readFileSync(RUN_CALENDAR, "utf8"));
  const flat = src.replace(/\s+/g, " ");

  /** The character range of `ScheduledRunCard`'s function body. */
  function cardBody(): [number, number] {
    const decl = src.indexOf("function ScheduledRunCard(");
    expect(decl, "ScheduledRunCard is gone or renamed — this sweep is measuring nothing").toBeGreaterThan(-1);
    const closeParen = matchingParen(src, src.indexOf("(", decl));
    expect(closeParen, "could not find the end of the parameter list").toBeGreaterThan(decl);
    const open = src.indexOf("{", closeParen);
    const close = matchingBrace(src, open);
    expect(close, "could not find the end of the component body").toBeGreaterThan(open);
    return [open, close];
  }

  const inside = (at: number, [open, close]: [number, number]) => at > open && at < close;

  /**
   * The single offset of `needle`, or a failure if the file holds none or more
   * than one.
   *
   * "Where is it" is only answerable when there IS one — the trap this campaign
   * keeps paying for is `indexOf` on a needle that occurs twice, which reports
   * whichever copy happens to come first in the file and calls the other one
   * absent. Measured while writing this: moving the acknowledgement back onto
   * the card WITHOUT deleting the notice's copy leaves two, and the verdict
   * would then depend purely on declaration order.
   */
  function onlyIndexOf(needle: string, what: string): number {
    const hits = [...src.matchAll(new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"))];
    expect(hits.length, `${what}: expected exactly one occurrence, found ${hits.length}`).toBe(1);
    return hits[0]!.index!;
  }

  it("finds the card's own body, so 'outside it' is a real verdict", () => {
    // Non-vacuity for both negatives below, in the positive direction: two
    // things that are unambiguously the card's — its delete control and the
    // pause call itself — must be found inside the range the walk returned.
    const body = cardBody();
    const del = onlyIndexOf("Delete schedule", "the card's delete control");
    expect(inside(del, body), "the brace walk did not enclose the card's own controls").toBe(true);

    const pauseCall = onlyIndexOf(
      'setPlannedRunStatusAction(run.id, "paused")',
      "the pause call",
    );
    expect(inside(pauseCall, body), "the pause is no longer performed by the card").toBe(true);
  });

  it("keeps the acknowledgement off the card the pause is about to unmount", () => {
    // THE DEFECT: the sentence existed, on the card, behind a local flag — and
    // the card leaves the tree on the refresh the pause triggers, because the
    // calendar is built from active schedules only. So the client watched their
    // schedule vanish and read nothing at all.
    const body = cardBody();
    const ack = onlyIndexOf(
      "won&apos;t run again until you resume it",
      "the sentence telling the client what happened to their schedule",
    );
    expect(
      inside(ack, body),
      "the acknowledgement is inside ScheduledRunCard again — it unmounts with the pause",
    ).toBe(false);
  });

  it("offers a resume, and offers it somewhere a paused schedule can still be reached", () => {
    // `canManage` rendered Pause and there was no resume branch anywhere on this
    // surface — and a paused schedule is not on this surface to grow one, since
    // the page filters to active schedules. Both halves are asked: the call
    // exists, and it is not inside the component that disappears.
    const body = cardBody();
    const resumeCall = onlyIndexOf(
      'setPlannedRunStatusAction(run.id, "active")',
      "the resume call — the calendar can pause a schedule and cannot resume one",
    );
    expect(
      inside(resumeCall, body),
      "the resume is inside ScheduledRunCard, which is not rendered for a paused schedule",
    ).toBe(false);

    // …and it is wired to a control the client can actually press. Asserted as
    // the ELEMENT — handler and label together — rather than as two loose
    // substrings that could belong to different buttons.
    expect(flat, "the resume call is not behind a labelled control").toContain(
      "onClick={resume} loading={busy}> Resume </Button>",
    );
  });

  it("threads the pause back up to the calendar from the one mount that raises it", () => {
    // Asked of the MOUNT, not of the file: `onPaused={` anywhere in the source
    // would be satisfied by the prop's own declaration. Bounded the same way
    // status-render-sweep bounds this element, including the precondition that
    // makes the lazy match safe.
    expect(
      flat,
      "a ScheduledRunCard mount with children appeared — the extraction below reads a self-closing element",
    ).not.toContain("</ScheduledRunCard>");
    const mounts = [...flat.matchAll(/<ScheduledRunCard\b[\s\S]*?\/>/g)].map((m) => m[0]);
    expect(mounts.length, "not exactly one self-closing ScheduledRunCard mount").toBe(1);
    expect(
      mounts[0],
      "the card can pause but cannot tell the calendar it did — the notice never appears",
    ).toContain("onPaused={");
  });
});

describe("a paused schedule always has a way back", () => {
  /**
   * #94's REAL close, and the seam that nearly re-created it.
   *
   * `PausedRunNotice` dies with the component's state, and the first version of
   * it told the client to resume "on the AI Agents page". That page's row comes
   * from `toScheduleRows`, and `weeklyFireDays` returns null for cadence
   * "monthly" and "once" — so for those two the schedule was on NO surface after
   * a reload, which is the one-way door this finding is about, re-created by its
   * own fix and pointed at by its own copy.
   *
   * So the durable answer is rendered from DATA: `calendar-body` passes paused
   * rows separately (never projected onto days) and the strip lists them.
   */
  const RUN_CALENDAR = join(process.cwd(), "src", "components", "run-calendar.tsx");
  const src = stripComments(readFileSync(RUN_CALENDAR, "utf8"));
  const body = stripComments(
    readFileSync(join(process.cwd(), "src/app/(app)/calendar/calendar-body.tsx"), "utf8"),
  );

  it("renders the strip from a prop, not from component state", () => {
    // `canDelete` rides alongside `schedules` now (the staff-only permanent
    // Stop control) — not anchored past it, so the strip stays keyed to data.
    expect(src).toMatch(/<PausedScheduleStrip\s+schedules=\{pausedSchedules\}[\s\S]{0,60}\/>/);
    expect(src).toMatch(/pausedSchedules\??\s*:\s*readonly PausedScheduleView\[\]/);
  });

  it("is fed every paused schedule by the server, whatever its cadence", () => {
    // Keyed to the FILTER, so narrowing it back to one cadence fails here.
    // `isAgentLiveForClient` is allowed alongside it — that guard excludes a
    // disabled/unassigned agent's row, not any particular cadence.
    expect(body).toMatch(
      /scheduledRuns\s*\.filter\(\(r\) => r\.status === "paused" && isAgentLiveForClient\(r\)\)/,
    );
    expect(body).toMatch(/pausedSchedules=\{pausedSchedules\}/);
  });

  it("projects no days for a paused schedule", () => {
    // The grid must still exclude them: painting days a paused schedule will not
    // run is the same class of lie. The strip is identity only.
    expect(body).toMatch(
      /scheduledEntries[\s\S]{0,120}filter\(\(r\) => r\.status === "active" && isAgentLiveForClient\(r\)\)/,
    );
  });

  it("promises no surface that cannot show every cadence", () => {
    // The false-promise regression, asked as a closed question: the notice may
    // not name the AI Agents page, because that page drops monthly and one-off.
    const notice = noticeBody(src);
    expect(notice, "the notice points at a page that cannot show every cadence").not.toMatch(
      /AI Agents page/i,
    );
  });

  it("tells a keyboard or screen-reader client that anything happened", () => {
    // Pausing unmounts the button's own card, so focus falls to <body> and the
    // notice renders a full calendar above the viewport. Without a live region
    // it is announced to nobody.
    const notice = noticeBody(src);
    expect(notice).toMatch(/role="status"/);
    expect(notice).toMatch(/aria-live="polite"/);
  });
});
