import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ClientAnalytics, ClientAnalyticsStats } from "@/components/client-analytics";
import {
  CLIENT_ASSET_STATUS_LABEL,
  STAFF_ASSET_STATUS_LABEL,
  assetStatusLabel,
} from "@/lib/asset-status-copy";
import { getClientArchiveAssets } from "@/lib/asset-visibility";
import {
  ALL_CALENDAR_FILTER_KEYS,
  calendarFilterKeyMatchable,
  isClientCalendarStatus,
} from "@/lib/calendar-kind";
import {
  ALL_ASSET_STATUSES,
  ALL_CLIENT_STATE_SURFACES,
  assetsInClientState,
  isClientStateFor,
  offeredStatesFor,
} from "@/lib/client-state-domain";
import type { Asset, ClientIntegration, Job } from "@/lib/types";
import { stripComments } from "./source-scan";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * A CLIENT CONTROL MAY ONLY OFFER A STATE THEIR OWN DATA CAN BE IN.
 *
 * THREE SURFACES ONCE HAD THE SAME DEFECT, reported separately (which is why two
 * got fixed before the third did) and later PARTIALLY REVERSED on purpose:
 *
 *  • the Workspace archive's status filter offered "Draft", on a list whose
 *    server-side projection rejects drafts — a control that could only ever
 *    empty the page. STILL TRUE: the archive is unaffected by the reversal below.
 *  • the calendar legend offered a client a "Draft" chip (A3), and
 *  • the Performance tab's chart drew a "Draft n" ROW and the "Deliverables"
 *    tile counted the same set (A4).
 *
 *  A3 and A4 were both DELIBERATELY REVERSED afterward: a client's calendar and
 *  dashboard now show the same pending work staff see, drafts included — see
 *  `isClientCalendarStatus`'s docstring in calendar-kind.ts for the decision. The
 *  tests below assert the CURRENT rule for each surface, which is no longer one
 *  shape for all three: `archive` still withholds "draft"; `performance` (the
 *  calendar's dashboard-facing sibling) no longer does.
 *
 * ASKED OF THE PROJECTION, which is the whole point of this file — a change to
 * either rule moves the control with it rather than going stale against a
 * hand-typed list. Every assertion below computes the answer by RUNNING the
 * projection the surface renders from (`getClientArchiveAssets` over one asset
 * per status; `isClientCalendarStatus` for the calendar/dashboard half) and
 * requires the control to match it.
 *
 * WHY IT IS NOT VACUOUS even though the source now derives its own answer. The
 * module derives from the per-asset PREDICATE (`isInClientArchive`); this file
 * derives from the LIST PROJECTION (`getClientArchiveAssets`) and from the
 * rendered MARKUP. Those are different code paths to the same rule, which is what
 * makes agreement between them evidence rather than a tautology — and the render
 * assertions are not derivable from either.
 *
 * THE HONEST BOUND: this is a registry, so it covers the surfaces that register.
 * `ALL_CLIENT_STATE_SURFACES` is derived from the module's own map, so a further
 * surface is covered the moment it is added there — but a client-facing filter
 * that never registers is not something a test in this file can see. The repo-wide
 * sweep that would see it was measured and rejected in status-render-sweep.ts
 * ("does not try to police status GROUPINGS repo-wide, and says why"): seventeen
 * files write a literal status grouping and nearly all are legitimate, so a sweep
 * over that shape teaches the next person to widen an allowlist.
 */

const SRC = join(process.cwd(), "src");
const NOW = 1_700_000_000_000;

function asset(overrides: Partial<Asset> = {}): Asset {
  return {
    id: "asset-1",
    clientId: "client-1",
    title: "Launch teaser",
    content: "Body",
    createdBy: "staff-1",
    createdAt: NOW,
    updatedAt: NOW,
    status: "published",
    type: "social_post",
    ...overrides,
  } as Asset;
}

/** One asset per status, identical in every other respect. */
const ONE_OF_EACH: Asset[] = ALL_ASSET_STATUSES.map((status) =>
  asset({ id: `asset-${status}`, status }),
);

/**
 * What each surface's own projection admits — derived HERE, independently of the
 * module under test, by running the real projection over the fixture above.
 *
 * `archive` is the list projection itself. `performance` is the union of the two
 * projections that define what content a client has at all: the archive, plus the
 * calendar's status filter for the forward-looking half (an approved post dated
 * next month is theirs and is not in the archive yet).
 */
function admittedByProjection(surface: string): Asset["status"][] {
  const inArchive = new Set(
    getClientArchiveAssets(ONE_OF_EACH, { now: NOW }).map((a) => a.status),
  );
  if (surface === "archive") return ALL_ASSET_STATUSES.filter((s) => inArchive.has(s));
  if (surface === "performance") {
    return ALL_ASSET_STATUSES.filter((s) => inArchive.has(s) || isClientCalendarStatus(s));
  }
  throw new Error(`no projection registered in this test for surface "${surface}"`);
}

describe("a client control offers only states their own data can hold", () => {
  it("offers each surface exactly what its own projection admits", () => {
    // THE ONE ASSERTION. Every registered surface, both viewers, derived from the
    // projection rather than from a list — so a fourth surface is covered by
    // registering it, and a projection change moves the control with it.
    expect(ALL_CLIENT_STATE_SURFACES.length, "no surface is registered at all").toBeGreaterThan(1);
    for (const surface of ALL_CLIENT_STATE_SURFACES) {
      const admitted = admittedByProjection(surface);

      expect(
        offeredStatesFor(surface, true),
        `the ${surface} surface offers a client a state its projection rejects`,
      ).toEqual(admitted);

      // NON-VACUITY, per surface, but the two surfaces no longer share one shape.
      // `archive` still must be a PROPER, non-empty subset — `isInClientArchive`
      // still rejects a draft outright, and if it ever admitted everything that
      // would itself be a regression worth catching. `performance` is, BY THE
      // REVERSAL recorded on `isClientCalendarStatus`, now a deliberate
      // pass-through: a client's dashboard shows every status staff see. Asserting
      // the old "proper subset" shape on it would just re-fail the thing that was
      // reversed on purpose.
      expect(admitted.length, `${surface} admits nothing`).toBeGreaterThan(0);
      if (surface === "archive") {
        expect(
          admitted.length,
          `${surface} withholds nothing from a client — the derivation is a pass-through`,
        ).toBeLessThan(ALL_ASSET_STATUSES.length);
      } else {
        expect(admitted, `${surface} no longer matches staff — check the reversal is intact`).toEqual(
          ALL_ASSET_STATUSES,
        );
      }

      // The neighbouring case, which is what makes this a VIEWER rule rather than
      // a deletion: staff still get the whole union on the same surface.
      expect(offeredStatesFor(surface, false)).toEqual(ALL_ASSET_STATUSES);
    }
  });

  it("still withholds draft from the archive; the calendar/dashboard reversal does not touch it", () => {
    // `archive` keeps the original A4-era rule — `isInClientArchive` never
    // admitted a draft, and nothing about the calendar/dashboard reversal changes
    // that predicate.
    expect(offeredStatesFor("archive", true), "archive offers a client Draft").not.toContain(
      "draft",
    );
    expect(isClientStateFor("archive", "draft")).toBe(false);
    expect(offeredStatesFor("archive", false)).toContain("draft");
  });

  it("shows draft to a client on the dashboard, by the deliberate reversal — matching staff", () => {
    // The opposite pin from the one this suite used to hold: `performance` USED
    // to withhold "draft" (directive A4); the product decision behind
    // `isClientCalendarStatus` reversed that, so a client's dashboard now shows
    // exactly what staff see, draft included.
    expect(offeredStatesFor("performance", true), "performance still hides Draft from a client").toContain(
      "draft",
    );
    expect(isClientStateFor("performance", "draft")).toBe(true);
    expect(offeredStatesFor("performance", true)).toEqual(offeredStatesFor("performance", false));
  });

  it("refuses a status the union has never heard of, rather than printing it", () => {
    // FAILS CLOSED on stored data. `assetStatusLabel` falls back to the stored
    // value, so admitting an unrecognised status would put a raw database enum on
    // a client's chart — the defect status-render-sweep exists for, arriving
    // through the data instead of through the JSX.
    for (const surface of ALL_CLIENT_STATE_SURFACES) {
      expect(isClientStateFor(surface, "teleported")).toBe(false);
      // Non-vacuity: a real one is still admitted, so the above is a filter and
      // not a constant.
      expect(isClientStateFor(surface, "published")).toBe(true);
    }
    // Staff are not narrowed at all, unknown status included — they are the ones
    // who have to go and look at it.
    expect(
      assetsInClientState("performance", [asset({ status: "teleported" as Asset["status"] })], false),
    ).toHaveLength(1);
    expect(
      assetsInClientState("performance", [asset({ status: "teleported" as Asset["status"] })], true),
    ).toHaveLength(0);
  });

  it("keeps the calendar legend's status chips answering the same question", () => {
    // The third surface, in its own key domain. A calendar filter key that is
    // also an asset status must be offered a client exactly when the calendar's
    // own status projection admits it. Post-reversal that admits every status,
    // "Draft" included — the keys that are NOT statuses (placeholder, failed,
    // held, review) are chip kinds and run states, derived from postKind and the
    // past-run table in calendar-kind.test.ts; this does not restate them.
    const statusKeys = ALL_CALENDAR_FILTER_KEYS.filter((k) =>
      Object.hasOwn(CLIENT_ASSET_STATUS_LABEL, k),
    );
    expect(statusKeys, "no filter key is an asset status any more — check this is intended")
      .not.toEqual([]);
    for (const key of statusKeys) {
      expect(
        calendarFilterKeyMatchable(key, true),
        `legend chip "${key}" disagrees with the calendar's own client filter`,
      ).toBe(isClientCalendarStatus(key as Asset["status"]));
      // Staff keep every chip.
      expect(calendarFilterKeyMatchable(key, false)).toBe(true);
    }
    // Non-vacuity, the other direction now: the reversal means NONE of the status
    // keys are withheld from a client any more — a client's calendar legend
    // matches staff's, key for key.
    expect(statusKeys.filter((k) => !calendarFilterKeyMatchable(k, true))).toEqual([]);
  });
});

/* ─────────── the archive filter, read off the control it renders ─────────── */

describe("the archive's status filter", () => {
  // SOURCE, not markup, and the reason was checked rather than assumed:
  // ArchiveView mounts AssetDetailModal unconditionally, which imports
  // `publishAssetNowAction` from lib/actions — a "use server" module that reaches
  // the Admin-SDK data layer — so the component cannot be imported in this
  // environment at all. The behavioural half of this rule is asserted on
  // ClientAnalytics below, which can be.
  const view = stripComments(
    readFileSync(join(SRC, "components/archive-view.tsx"), "utf8"),
  ).replace(/\s+/g, " ");

  it("takes its options from the derivation, keyed to the argument it passes", () => {
    // EXTRACTED AND READ, not matched as a substring: `toContain("offeredStatesFor")`
    // is satisfied by the import line for ever, and `toContain("viewerIsClient")`
    // by any of the several threads in this file. So the call is pulled out and
    // its arguments are asserted by equality — which also catches a hard-coded
    // `true`/`false` and a locally derived alias, the shapes a blocklist misses.
    const calls = [...view.matchAll(/offeredStatesFor\(\s*([^)]*?)\s*\)/g)].map((m) => m[1]!);
    expect(calls, "the filter no longer asks the derivation for its options").toHaveLength(1);
    expect(calls[0]).toBe('"archive", viewerIsClient');
    // And the hand-typed list it replaced is gone, so this cannot pass beside a
    // revived copy that the `<option>` map quietly goes back to.
    expect(view).not.toContain("STATUS_ORDER");
  });

  it("has no default viewer left to fall back to", () => {
    // A defaulted `viewerIsClient = false` gave a mount that forgot the prop the
    // STAFF answer silently — staff copy, the generation stamp, and every status
    // option. Mechanical now: tsc refuses the omission.
    expect(view).not.toContain("viewerIsClient = false");
    expect(view).toContain("viewerIsClient: boolean;");
  });
});

/* ─────────── the performance tab, read off what it actually renders ──────── */

const INTEGRATIONS: ClientIntegration[] = [];
const JOBS: Job[] = [];

function performanceHtml(viewerIsClient: boolean): string {
  return renderToStaticMarkup(
    createElement(ClientAnalytics, {
      clientId: "client-1",
      assets: ONE_OF_EACH,
      jobs: JOBS,
      integrations: INTEGRATIONS,
      viewerIsClient,
    }),
  );
}

describe("the Performance tab's content-by-status chart", () => {
  it("draws a client every row now, draft included — the A4 reversal", () => {
    const html = performanceHtml(true);

    // Non-vacuity first: the chart rendered, with the rows a client DOES get.
    expect(html, "the chart did not render").toContain("Content by status");
    for (const status of offeredStatesFor("performance", true)) {
      expect(html, `the client lost the ${status} row`).toContain(
        assetStatusLabel(status, true),
      );
    }

    // Reversed from the A4-era assertion: the client now gets the draft row too,
    // in the client register's wording ("Draft") — never the staff word
    // ("Awaiting review"), because this is still a client-facing render.
    expect(html, "the client draft row is missing").toContain(CLIENT_ASSET_STATUS_LABEL.draft);
    expect(html, "the client draft row leaked staff wording").not.toContain(
      STAFF_ASSET_STATUS_LABEL.draft,
    );
  });

  it("still draws staff every row, off the same fixture", () => {
    // Staff read the operator register regardless of the client-side reversal.
    const html = performanceHtml(false);
    expect(html).toContain(STAFF_ASSET_STATUS_LABEL.draft);
    for (const status of ALL_ASSET_STATUSES) {
      expect(html, `staff lost the ${status} row`).toContain(assetStatusLabel(status, false));
    }
  });
});

describe("the Deliverables tile", () => {
  function tiles(viewerIsClient: boolean): string {
    return renderToStaticMarkup(
      createElement(ClientAnalyticsStats, {
        assets: ONE_OF_EACH,
        jobs: JOBS,
        integrations: INTEGRATIONS,
        viewerIsClient,
      }),
    );
  }

  it("counts a client the same total as staff now — the A4 reversal", () => {
    // THE OTHER HALF OF THE SAME RULE: a chart whose legend shows Draft while the
    // total does not count it would have moved the disclosure gap from a label to
    // a number in the other direction. Five statuses in, five countable now — the
    // reversal is a pass-through, not a partial one.
    const expected = offeredStatesFor("performance", true).length;
    expect(expected, "performance stopped matching staff — check the reversal is intact").toBe(
      ONE_OF_EACH.length,
    );

    const html = tiles(true);
    expect(html, "the row did not render").toContain("Deliverables");
    expect(html).toMatch(new RegExp(`>\\s*${expected}\\s*<`));
  });

  it("still counts staff the whole set", () => {
    const html = tiles(false);
    expect(html).toMatch(new RegExp(`>\\s*${ONE_OF_EACH.length}\\s*<`));
  });
});
