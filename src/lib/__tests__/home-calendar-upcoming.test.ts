import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { CalendarPreviewWidget } from "@/components/home-calendar-preview";
import { isUpcomingPost, postKind, type CalendarAssetKind } from "@/lib/calendar-kind";
import type { Asset } from "@/lib/types";

/**
 * HOME'S CALENDAR WIDGET AND THE CALENDAR PAGE MUST AGREE ON "UPCOMING".
 *
 * ── THE PRODUCTION BUG ───────────────────────────────────────────────────
 *
 * Reported 2026-09: XO Digital's dashboard read "Nothing scheduled yet" while
 * their Calendar page showed thirteen upcoming posts. `scripts/diagnose-home-
 * calendar-preview.ts` against `(default)` found the cause in their data — 22
 * assets, 21 `approved` and 1 `draft`, NOT ONE `scheduled`:
 *
 *   2026-09-02 15:00  approved  kind=placeholder  home=n  cal=Y  mode=placeholder
 *   2026-09-03 06:00  approved  kind=placeholder  home=n  cal=Y  mode=placeholder
 *   … 13 rows, every one of them home=n
 *
 * The page filtered with a local `a.status === "scheduled" && scheduledAt > now`
 * while the calendar filtered with `postKind`, which admits `approved` + dated
 * and `draft` + dated as well. Approval is what arms auto-publish, so a client's
 * post can go draft → approved → posted without ever holding the one status the
 * widget asked for.
 *
 * ── WHAT THIS FILE PINS ──────────────────────────────────────────────────
 *
 *  1. THE EXACT PRODUCTION SHAPE renders a row. A fixture copied from the
 *     diagnostic's own output, so the regression is described by the data that
 *     produced it rather than by a paraphrase of it.
 *  2. `isUpcomingPost` AGREES WITH `postKind` over every status × mode
 *     combination, derived by enumerating them rather than by listing the
 *     answers — so a future widening of `postKind` cannot leave this widget
 *     behind again, which is the whole failure mode.
 *  3. THE PAGE ASKS THE SHARED PREDICATE. Source-level: both halves above can
 *     be correct while the page keeps its own local spelling, which is exactly
 *     the state the bug was reported in.
 */

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_760_000_000_000;

/**
 * XO Digital's row, field for field as the production diagnostic printed it:
 * `approved`, dated in the future, `publishMode: "placeholder"`, bulk-uploaded.
 */
function xoDigitalRow(overrides: Partial<Asset> = {}): Asset {
  return {
    id: "xo-1",
    clientId: "E19TT5yiWxpvbetkhxGt",
    title: "Clip",
    content: "",
    createdBy: "staff-1",
    createdAt: NOW - 3 * DAY,
    updatedAt: NOW - 3 * DAY,
    status: "approved",
    scheduledAt: NOW + 1 * DAY,
    publishMode: "placeholder",
    type: "social_post",
    channels: ["tiktok"],
    meta: { bulkUpload: true, taskType: "social_post" },
    ...overrides,
  };
}

function widget(upcoming: Asset[], viewerIsClient = true): string {
  return renderToStaticMarkup(
    createElement(CalendarPreviewWidget, { upcoming, viewerIsClient }),
  );
}

describe("the shape that emptied a client's calendar widget", () => {
  it("counts as upcoming", () => {
    const row = xoDigitalRow();
    // The premise, stated: this row is on the calendar. If postKind ever stops
    // classifying it the assertion below would pass for the wrong reason.
    expect(postKind(row), "the production row fell off the calendar too").toBe("placeholder");
    expect(isUpcomingPost(row, NOW)).toBe(true);
  });

  it("is exactly what the OLD predicate rejected", () => {
    // The deleted spelling, reproduced here and nowhere else in src/. This is
    // the assertion that makes the fix a fix rather than a refactor: the row
    // has to be one the old test failed and the new one passes.
    const row = xoDigitalRow();
    const oldPredicate = (a: Asset) => a.status === "scheduled" && (a.scheduledAt ?? 0) > NOW;
    expect(oldPredicate(row), "the fixture no longer reproduces the bug").toBe(false);
    expect(isUpcomingPost(row, NOW)).toBe(true);
  });

  it("renders a dated row on the widget, not the empty state", () => {
    const html = widget([xoDigitalRow()]);
    expect(html, "the widget still shows its empty state").not.toContain("Nothing scheduled yet");
    expect(html).toContain("Social post");
  });

  it("names a placeholder as one rather than presenting it as a booked post", () => {
    // Thirteen rows reading "Social post" with nothing distinguishing them from
    // slots Karos will publish would be a different wrong answer: a placeholder
    // is content the client posts. Same word the calendar chips it with.
    expect(widget([xoDigitalRow()])).toContain("Placeholder");
    // …and a genuinely booked post gets no chip, because that is what the card
    // is already about.
    const booked = xoDigitalRow({ status: "scheduled", publishMode: "auto" });
    expect(postKind(booked), "the control row is not a plain scheduled post").toBe("scheduled");
    expect(widget([booked])).not.toContain("Placeholder");
  });
});

describe("isUpcomingPost agrees with the calendar over every shape", () => {
  const STATUSES: Asset["status"][] = ["draft", "approved", "scheduled", "published", "delivered"];
  const MODES = [undefined, "auto", "manual", "placeholder"] as const;

  /** The kinds a future-dated post may legitimately be, per UPCOMING_KINDS. */
  const FORWARD: ReadonlySet<CalendarAssetKind> = new Set<CalendarAssetKind>([
    "scheduled",
    "placeholder",
    "draft",
  ]);

  it("admits a future-dated post exactly when the calendar chips it forward-looking", () => {
    let admitted = 0;
    for (const status of STATUSES) {
      for (const publishMode of MODES) {
        const row = xoDigitalRow({
          status,
          ...(publishMode ? { publishMode } : { publishMode: undefined }),
        });
        const kind = postKind(row);
        const expected = kind != null && FORWARD.has(kind);
        expect(
          isUpcomingPost(row, NOW),
          `status=${status} mode=${publishMode ?? "(none)"} kind=${kind}`,
        ).toBe(expected);
        if (expected) admitted += 1;
      }
    }
    // Non-vacuity: the sweep found real members on both sides, so a bug that
    // made the predicate constantly false (or true) is still red here.
    expect(admitted).toBeGreaterThan(0);
    expect(admitted).toBeLessThan(STATUSES.length * MODES.length);
  });

  it("rejects anything not in the future, whatever the calendar says of it", () => {
    // A past-due placeholder is on the calendar (as a chip on its own day) and
    // is not "upcoming" — the date test, not the kind, is what says so.
    const past = xoDigitalRow({ scheduledAt: NOW - DAY });
    expect(postKind(past)).toBe("placeholder");
    expect(isUpcomingPost(past, NOW)).toBe(false);
    // Undated: nothing to be upcoming on.
    expect(isUpcomingPost(xoDigitalRow({ scheduledAt: undefined }), NOW)).toBe(false);
    // Exactly now is not the future.
    expect(isUpcomingPost(xoDigitalRow({ scheduledAt: NOW }), NOW)).toBe(false);
  });

  it("never admits a published post, even one dated ahead", () => {
    // A publishedAt in the past with a scheduledAt ahead is contradictory
    // stored data; the widget must not put it in the "coming up" list.
    const row = xoDigitalRow({ status: "published", publishedAt: NOW - DAY });
    expect(postKind(row)).toBe("published");
    expect(isUpcomingPost(row, NOW)).toBe(false);
  });
});

describe("the dashboard asks the shared predicate", () => {
  const page = readFileSync(
    join(process.cwd(), "src", "app", "(app)", "clients", "[id]", "page.tsx"),
    "utf8",
  );
  /** Comments stripped: the old spelling survives in a comment, deliberately. */
  const code = page.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

  it("imports and calls isUpcomingPost", () => {
    expect(code).toMatch(/isUpcomingPost/);
    expect(code).toMatch(/const isUpcoming = \(a: Asset\) => isUpcomingPost\(a, now\)/);
  });

  it("keeps no local status-equality spelling of the same question", () => {
    // The regression this whole file is about: a second, quieter definition of
    // "upcoming" living at the render site.
    expect(
      code,
      "the page grew back its own definition of upcoming",
    ).not.toMatch(/status === "scheduled"\s*&&\s*\(?a\.scheduledAt/);
  });
});
