import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ClientAnalytics } from "@/components/client-analytics";
import { contentStatusHref, statusFilterFromParam } from "@/lib/content-status-links";
import { ALL_ASSET_STATUSES, isClientStateFor } from "@/lib/client-state-domain";
import type { Asset } from "@/lib/types";

/**
 * "CONTENT BY STATUS" IS A SET OF LINKS, AND `?status=` HAS A PRODUCER AGAIN.
 *
 * This file exists because archive-view.tsx asked for it by name. That
 * component carried a `?status=` reader until 2026-07-31 and deleted it with a
 * long note whose argument was NOT "deep links are bad" but "this reader
 * outlived its producer": the one link that fed it (a `status=draft` href on
 * the dashboard) had been re-pointed a week earlier, leaving re-read logic no
 * test had ever exercised. The note's closing instruction is verbatim
 * "reintroduce it WITH its producer and a test."
 *
 * The producer is `contentStatusHref`, called by the "Content by status" chart
 * and by the KPI card's published-content cell. The readers are AssetsView's
 * and ArchiveView's `initialStatus`, seeded by their pages from the URL. This
 * file pins BOTH ENDS, because either half alone is the exact shape that rotted
 * last time: a link nothing reads, or a reader nothing writes.
 *
 * WHAT IS ASSERTED, and why each half is here:
 *
 *  1. THE CHART RENDERS LINKS AT ALL. A render, not a call of the helper — the
 *     helper could be right and unwired, which is how the 2026-07 producer
 *     disappeared without a red test.
 *  2. THE TWO READERS DIFFER BY VIEWER. Staff land on the Library they approve
 *     from; a client lands on their own Archive tab. A single destination would
 *     put a client on a staff route that redirects them straight back.
 *  3. A CLIENT GETS NO LINK TO A STATE THEIR ARCHIVE CANNOT HOLD. The chart's
 *     rows admit "draft" for a client by a deliberate 2026-08 reversal while
 *     `isInClientArchive` still rejects one, so a Draft bar is a real number
 *     whose only candidate destination provably excludes every row behind it
 *     (F97 × F149). Derived from `client-state-domain`, so widening either
 *     projection moves this expectation rather than breaking it.
 *  4. THE PARAM THE PRODUCER WRITES IS THE PARAM THE READER PARSES. Asserted by
 *     round-tripping the emitted href through the reader's own parser, so a
 *     rename of the param on one side is red rather than silently inert.
 *  5. THE PAGES ACTUALLY PASS IT. Source-level, because a page that stops
 *     threading `searchParams` into the view leaves both ends above correct and
 *     the feature dead.
 */

const SRC = join(process.cwd(), "src");
const read = (rel: string) => readFileSync(join(SRC, rel), "utf8");
/** Source with comments stripped — a param named only in a comment is not wiring. */
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

const NOW = 1_760_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

function asset(status: Asset["status"], id: string): Asset {
  return {
    id,
    clientId: "c1",
    title: `Post ${id}`,
    content: "Body",
    createdBy: "staff-1",
    createdAt: NOW - 5 * DAY,
    updatedAt: NOW - 2 * DAY,
    status,
    type: "social_post",
  };
}

/** One asset in every status the union has, so every possible bar is drawn. */
const EVERY_STATUS: Asset[] = ALL_ASSET_STATUSES.map((s, i) => asset(s, `a${i}`));

function chart(viewerIsClient: boolean, assets: Asset[] = EVERY_STATUS): string {
  return renderToStaticMarkup(
    createElement(ClientAnalytics, {
      clientId: "c1",
      assets,
      jobs: [],
      integrations: [],
      viewerIsClient,
      hideStats: true,
    }),
  );
}

describe("the Content by status chart links into the filtered list", () => {
  it("renders a real href per status for staff, into this client's Library", () => {
    const html = chart(false);
    // Non-vacuity first: every negative below is worthless over a chart that
    // never drew a bar.
    expect(html, "the chart never rendered").toContain("Content by status");
    for (const status of ALL_ASSET_STATUSES) {
      expect(html, `no link for "${status}"`).toContain(
        `href="/clients/c1/assets?status=${status}"`,
      );
    }
  });

  it("sends a client to their own calendar archive instead of the staff Library", () => {
    const html = chart(true);
    expect(html, "the chart never rendered").toContain("Content by status");
    // The calendar's archive view since portal feedback round 2 (2026-09) —
    // "Archive does not need to be in settings, it's in the calendar". The
    // flat route, because it scopes itself to the viewer's own client and this
    // branch is only ever taken for a real CLIENT_USER.
    expect(html).toContain("href=\"/calendar?view=archive&amp;status=published\"");
    // The staff route redirects a CLIENT_USER straight back to their dashboard,
    // so landing them on it is a round trip to nowhere.
    expect(html, "a client was linked into the staff Library").not.toContain(
      "/clients/c1/assets?status=",
    );
  });

  it("draws the Draft bar for a client but does not link it", () => {
    // The bar is legitimate — `assetsInClientState("performance", …)` admits
    // drafts for a client by the 2026-08 reversal — and it is precisely the row
    // whose destination cannot hold it.
    expect(isClientStateFor("archive", "draft"), "the premise moved").toBe(false);
    const html = chart(true);
    expect(html, "the Draft row vanished, so the negative below proves nothing").toContain(
      "Draft",
    );
    expect(html, "a client was linked to a list that excludes every draft").not.toContain(
      "status=draft",
    );
  });
});

describe("contentStatusHref, the one spelling both producers use", () => {
  it("gives staff a link for every status, including the ones a client cannot see", () => {
    for (const status of ALL_ASSET_STATUSES) {
      expect(contentStatusHref(status, "c1", false)).toBe(
        `/clients/c1/assets?status=${status}`,
      );
    }
  });

  it("declines exactly the statuses a client's archive rejects", () => {
    for (const status of ALL_ASSET_STATUSES) {
      const href = contentStatusHref(status, "c1", true);
      // Derived from the projection rather than from a typed list, so this
      // tracks a widening of `isInClientArchive` instead of contradicting it.
      expect(href === null, `client link for "${status}" disagrees with the archive`).toBe(
        !isClientStateFor("archive", status),
      );
    }
  });
});

describe("the param the producer writes is the param the reader parses", () => {
  it("round-trips every staff link back into a live filter value", () => {
    for (const status of ALL_ASSET_STATUSES) {
      const href = contentStatusHref(status, "c1", false)!;
      const param = new URL(href, "https://example.test").searchParams.get("status");
      expect(param, `no status param in ${href}`).not.toBeNull();
      // The reader's own parser, not a re-implementation of it.
      expect(statusFilterFromParam(param ?? undefined)).toBe(status);
    }
  });

  it("falls open, not closed, on a param this list cannot honour", () => {
    // A stale or typo'd deep link must not empty the library: "no content"
    // is the worst available answer to a bad parameter.
    expect(statusFilterFromParam("nonsense")).toBe("all");
    expect(statusFilterFromParam(undefined)).toBe("all");
    expect(statusFilterFromParam("")).toBe("all");
  });
});

describe("the pages thread the param through", () => {
  it("seeds the staff Library from searchParams", () => {
    const src = code(read("app/(app)/clients/[id]/assets/page.tsx"));
    expect(src).toMatch(/searchParams/);
    expect(src).toMatch(/initialStatus=\{statusFilterFromParam\(/);
  });

  it("seeds the cross-client Library too, on both of its mounts", () => {
    const src = code(read("app/(app)/assets/page.tsx"));
    expect(src).toMatch(/statusFilterFromParam\(/);
    // Two <AssetsView/> mounts on that page (one client's library, and the
    // cross-client grid) — a fix applied to one of them is half a fix.
    expect(src.match(/initialStatus=\{initialStatus\}/g)?.length ?? 0).toBe(2);
  });

  it("seeds the calendar's archive view, narrowed by what that archive can hold", () => {
    // The reader moved with the surface (portal feedback round 2, 2026-09):
    // Account Center gave up its Archive tab, so `?status=` is now parsed
    // beside `?view=` on the calendar. Both calendar routes thread the params
    // into the one body that validates them.
    for (const rel of ["app/(app)/calendar/page.tsx", "app/(app)/clients/[id]/calendar/page.tsx"]) {
      const page = code(read(rel));
      expect(page, rel).toMatch(/searchParams/);
      expect(page, rel).toMatch(/status \? \{ status \} : \{\}/);
    }
    const src = code(read("app/(app)/calendar/calendar-body.tsx"));
    // Narrowed through the archive's OWN offer list rather than trusted: a
    // hand-crafted `?status=draft` must degrade to the unfiltered list, not to
    // an empty one. This is the reader-side half of the rule the chart applies
    // when it declines to emit that link at all.
    expect(src).toMatch(/offeredStatesFor\(\s*"archive"/);
    expect(src).toMatch(/initialArchiveStatus \? \{ initialArchiveStatus \} : \{\}/);
    // …and the calendar hands it to the same ArchiveView prop the settings tab
    // used to seed, so the param still means one thing end to end.
    expect(code(read("components/run-calendar.tsx"))).toMatch(
      /initialStatus=\{initialArchiveStatus \?\? "all"\}/,
    );
  });

  it("leaves no producer pointing at the retired settings archive tab", () => {
    // The old URL is a redirect now, not a destination — a link that still
    // writes it works but arrives one hop late, and this is the file that
    // pinned the pair of them together.
    expect(code(read("lib/content-status-links.ts"))).not.toContain("tab=archive");
    expect(code(read("lib/agent-intake-links.ts"))).not.toContain("tab=archive");
    expect(code(read("lib/action-list.ts"))).not.toContain("tab=archive");
  });
});
