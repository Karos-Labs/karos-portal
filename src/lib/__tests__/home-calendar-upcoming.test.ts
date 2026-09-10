import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

/**
 * The widget mounts `AssetDetailModal` now (flow audit 2026-09, R8 — its rows
 * were inert while the same posts opened from the calendar's own chips), and
 * that modal's import graph reaches the server actions barrel, which imports
 * `server-only` and cannot be loaded in a node run at all. Stubbed here — every
 * assertion in this file is about which ROWS the widget renders and what they
 * say, and none of them opens the modal (closed, it renders null either way).
 *
 * The mount is not left unguarded by the stub: `asset-status-surfaces.test.ts`
 * enumerates every file in src/ that opens the one deliverable reader and
 * checks each hands it a viewer, and this widget is on that list.
 */
vi.mock("@/components/asset-detail-modal", () => ({
  AssetDetailModal: () => null,
}));

import {
  CalendarPreviewWidget,
  type CalendarPreviewRow,
} from "@/components/home-calendar-preview";
import { isUpcomingPost, postKind, type CalendarAssetKind } from "@/lib/calendar-kind";
import {
  resolveContentIdentity,
  type ClientAgentIdentity,
} from "@/lib/agent-identity-map";
import { redactLockedAsset } from "@/lib/asset-visibility";
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

/**
 * The widget takes ROWS now, not bare assets (portal feedback round 4,
 * 2026-09): each carries the producing agent's identity, resolved on the page
 * because resolving one needs the client's umbrella agents and their jobs.
 * These helpers keep the assertions below about the assets, which is what this
 * file is for — an identity is passed only where a test is about one.
 */
function widget(upcoming: CalendarPreviewRow[], viewerIsClient = true): string {
  return renderToStaticMarkup(
    createElement(CalendarPreviewWidget, { upcoming, viewerIsClient }),
  );
}

const previewRow = (asset: Asset, agent?: Omit<CalendarPreviewRow, "asset">): CalendarPreviewRow => ({
  asset,
  ...agent,
});

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
    const html = widget([previewRow(xoDigitalRow())]);
    expect(html, "the widget still shows its empty state").not.toContain("Nothing scheduled yet");
    expect(html).toContain("Clip");
  });

  it("names a placeholder as one rather than presenting it as a booked post", () => {
    // Thirteen rows reading "Social post" with nothing distinguishing them from
    // slots Karos will publish would be a different wrong answer: a placeholder
    // is content the client posts. Same word the calendar chips it with.
    expect(widget([previewRow(xoDigitalRow())])).toContain("Placeholder");
    // …and a genuinely booked post is chipped as one. It used to get NO chip, on
    // the reasoning that a scheduled post is what the card is already about,
    // which left it visually identical to a draft (portal feedback round 4).
    const booked = xoDigitalRow({ status: "scheduled", publishMode: "auto" });
    expect(postKind(booked), "the control row is not a plain scheduled post").toBe("scheduled");
    const html = widget([previewRow(booked)]);
    expect(html).not.toContain("Placeholder");
    expect(html).toContain("Scheduled post");
  });
});

/**
 * WHAT A ROW SAYS IT IS (portal feedback round 4, 2026-09).
 *
 * *"What is 'Social post' here? We should see the logos of which agents."* Every
 * row printed one type name, so a client with an Instagram agent, an X agent and
 * a TikTok agent read three identical lines. Pinned here because the redaction
 * rule and the identity rule meet on this row: the noun is what a LOCKED row
 * prints INSTEAD of a title, so a regression in one is a regression in the other.
 */
describe("each row carries the identity of the post it stands for", () => {
  it("names the platform rather than the generic type", () => {
    // The production fixture declares `channels: ["tiktok"]` and no booked
    // platform — the second rung of the shared resolver.
    const html = widget([previewRow(xoDigitalRow({ locked: true, title: "Upcoming post" }))]);
    expect(html).toContain("TikTok post");
    expect(html, "the generic noun survived a resolvable platform").not.toContain("Social post");
  });

  it("falls back to the producing agent when the asset names no platform", () => {
    const bare = xoDigitalRow({ channels: undefined, locked: true, title: "Upcoming post" });
    const html = widget([previewRow(bare, { agentLabel: "Instagram Agent", agentPlatform: "instagram" })]);
    expect(html).toContain("Instagram post");
    // …and says whose it is, which is the half of the feedback the noun alone
    // does not answer.
    expect(html).toContain("Instagram Agent");
  });

  it("keeps the type register as the last fallback, not a guessed platform", () => {
    // Nothing here names a platform: no booked channel, no declared channel, no
    // agent identity, and a type that claims none. A logo would be an invention.
    const bare = xoDigitalRow({
      type: "note",
      channels: undefined,
      meta: {},
      locked: true,
      title: "Upcoming post",
    });
    const html = widget([previewRow(bare)]);
    expect(html).toContain("Note");
    expect(html, "a row with no recorded platform still drew a mark").not.toContain("<svg viewBox=\"0 0 24 24\"");
  });

  it("never prints a LOCKED row's title, only the noun", () => {
    // The whole redaction contract on this widget. `redactLockedAsset` replaces
    // a client's future title with a template name, and even that stand-in is
    // not what a client is owed here.
    const locked = xoDigitalRow({ locked: true, title: "By The Numbers" });
    const html = widget([previewRow(locked)]);
    expect(html, "a locked row printed its title").not.toContain("By The Numbers");
    expect(html).toContain("TikTok post");
  });

  it("prints the real title when the asset is not locked for this viewer", () => {
    // Staff read the unredacted set, and so does a client whose post has
    // unlocked; either way the title is the most useful thing the row can say.
    expect(widget([previewRow(xoDigitalRow({ title: "Clip" }))], false)).toContain("Clip");
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

/**
 * WHOSE POST IS THIS, WHEN THE ROW IS REDACTED (review wave, 2026-09).
 *
 * `redactLockedAsset` nulls `jobId` and replaces `meta` with `{ locked: true }`,
 * so an identity resolved FROM THE REDACTED COPY skips every strong rung of
 * `resolveContentIdentity` and falls to "the live umbrella that owns this
 * content family" — which, for a client with two live umbrellas in one family,
 * is whichever one `find` reaches first. Every upcoming row then carried the
 * wrong caption and the wrong logo, stated with no hedge.
 *
 * The page resolves from the ORIGINAL asset and threads the answer on. These
 * pin both halves: the resolver really does answer differently either side of
 * the redaction, and the page really does look the original up.
 */
describe("a locked row's identity is resolved before the redaction, not after", () => {
  const umbrellas: ClientAgentIdentity[] = [
    {
      id: "u-ig",
      agentKey: "karos-instagram-tiktok-content-agent",
      customAgentId: "ca-ig",
      displayName: "Instagram Agent",
      platform: "instagram",
      chainFamily: "social",
      launchState: "live",
    },
    {
      id: "u-x",
      agentKey: "karos-x-agent-v2",
      customAgentId: "ca-x",
      displayName: "X Agent",
      platform: "x",
      chainFamily: "social",
      launchState: "live",
    },
  ];

  /** The X agent's post: linked to its umbrella through the job that made it. */
  const original = xoDigitalRow({ id: "post-1", jobId: "job-1", channels: undefined });
  const job = { id: "job-1", clientAgentId: "u-x", agentName: "karos-x-agent-v2" };

  it("names the wrong agent when it is asked of the redacted copy", () => {
    // The premise of the bug, stated: this is what the page used to do.
    const redacted = redactLockedAsset(original);
    expect(redacted.jobId).toBeNull();
    const wrong = resolveContentIdentity({ asset: redacted, job: null }, umbrellas);
    expect(wrong.clientAgentId, "the fixture no longer reproduces the bug").toBe("u-ig");
  });

  it("names the right one when it is asked of the original", () => {
    const right = resolveContentIdentity({ asset: original, job }, umbrellas);
    expect(right.clientAgentId).toBe("u-x");
    expect(right.label).toBe("X Agent");
  });

  it("renders whatever identity it is handed, and no lab repo key crosses", () => {
    const redacted = redactLockedAsset(original);
    const html = widget([previewRow(redacted, { agentLabel: "X Agent", agentPlatform: "x" })]);
    expect(html).toContain("X post");
    expect(html).toContain("X Agent");
    // The row shape no longer carries `agentKey` at all: the page runs that rung
    // itself and sends the resolved token. Comments stripped — the module's own
    // note names the deleted field, which is what stops it coming back.
    const source = readFileSync(
      join(process.cwd(), "src", "components", "home-calendar-preview.tsx"),
      "utf8",
    )
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1");
    expect(source, "the lab repo key is back on the wire").not.toContain("agentKey");
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

  it("resolves an identity for the rows it will SHOW, not for every future post", () => {
    // The widget shows five dates and sorts what it is given; the page used to
    // resolve an identity per upcoming post — thirteen for the account above,
    // unbounded in general — and hand the lot over for most of it to be thrown
    // away (review wave, 2026-09). Same cap, named once.
    expect(code).toContain("CALENDAR_PREVIEW_ROWS");
    expect(code).toMatch(/\.slice\(0, CALENDAR_PREVIEW_ROWS\)[\s\S]{0,400}toCalendarRow/);
  });

  it("resolves that identity from the unredacted asset", () => {
    // See the redaction block above for what reading it off the redacted copy
    // costs a client with two live umbrellas in one family.
    expect(code).toContain("const assetById = new Map(assets.map((asset) => [asset.id, asset]))");
    expect(code).toMatch(/const source = assetById\.get\(a\.id\) \?\? a;/);
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
