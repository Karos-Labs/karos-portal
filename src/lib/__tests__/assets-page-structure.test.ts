import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { ASSET_TYPE_LABEL } from "@/lib/asset-type-copy";
import { GENERATED_TODAY_TITLE, generatedToday } from "@/lib/generated-today";
import { stripComments } from "./source-scan";

/**
 * SCRUM-423: the Assets page answers "what just happened" before "what do we
 * have", and shows the shape of the collection instead of hiding it.
 *
 * WHAT LOLA REPORTED. "Assets page is a mess, very overwhelming. Generations
 * should land in the assets page and there should be clear indication of that
 * upon generating. The page should be split up... Instead of the dropdown menu
 * for each type of output, they should all be in that top bar and you click on
 * them to select only that type."
 *
 * THE INTERESTING FINDING. There was no type dropdown to move. The page had a
 * STATUS select and a CHANNEL select and no way at all to filter by what a
 * deliverable IS. So the tabs are NEW rather than relocated, and that is the
 * substance of "jumbled mess": a dropdown hides the shape of a collection, and
 * one that does not exist hides it completely.
 *
 * THE DATE-ORDER HALF WAS ALREADY FIXED, in the same wave that landed
 * `deliverableStamp` - the list sorts by the stamp the card prints, which is
 * what "even the dates are not in order" was. This file does not re-assert it;
 * `content-status-deeplink.test.ts` and archive-view's own tests own that rule.
 */

const SRC = path.resolve(__dirname, "../..");
const code = (rel: string) => stripComments(readFileSync(path.join(SRC, rel), "utf8"));

const view = code("components/assets-view.tsx");

/* ────────────────────── the two surfaces agree on "today" ───────────────── */

describe("one selector, two surfaces", () => {
  it("the Assets page asks the same function Home's widget asks", () => {
    // Two hand-rolled date filters is how one page says three things were made
    // today and the other says four.
    expect(view).toContain("generatedToday(matching, now)");
    expect(view).toContain('from "@/lib/generated-today"');
    expect(code("components/client-home-overview.tsx")).toContain(
      'from "@/lib/generated-today"',
    );
  });

  it("takes the moment from the SERVER, not from the browser", () => {
    // assets-view is "use client". A Date.now() inside it would let the
    // reader's timezone decide which day "today" is, while runDayKey - the
    // helper the selector uses - is documented as a server-local calendar day.
    expect(view).toContain("const now = nowProp;");
    expect(view).not.toContain("Date.now()");
    for (const page of ["app/(app)/assets/page.tsx", "app/(app)/clients/[id]/assets/page.tsx"]) {
      const src = code(page);
      expect(src, `${page} does not pass a clock`).toContain("now={now}");
      expect(src, `${page} does not read one`).toContain("const now = Date.now();");
    }
  });

  it("shares the heading too, so the two sections cannot be named differently", () => {
    expect(view).toContain("GENERATED_TODAY_TITLE");
    expect(GENERATED_TODAY_TITLE).toBe("Generated today");
  });
});

/* ──────────────────────────── today is lifted out ────────────────────────── */

describe("the today section", () => {
  it("is lifted out of the status groups rather than copied into a second list", () => {
    // A card in both places would double every count on the page.
    expect(view).toContain("const lifted = new Set(todayAssets.map((asset) => asset.id));");
    expect(view).toContain("const rest = matching.filter((asset) => !lifted.has(asset.id));");
    // The groups build from `rest`, which is what makes the lift real.
    expect(view).toMatch(/rest\.filter\(\(asset\) => asset\.status === groupStatus\)/);
  });

  it("respects the filters above it, because it is a section and not a second list", () => {
    // Filtering to Drafts and finding a Today section full of published posts
    // would be the page disagreeing with its own control. `matching` is the
    // filtered set; the selector reads that, not `assets`.
    expect(view).not.toContain("generatedToday(assets");
  });

  it("hides nothing by lifting: every row keeps its own status card", () => {
    // A draft made this morning is still visibly a draft, just promoted. Both
    // sections render the same AssetCard.
    const todaySection = view.slice(view.indexOf("todayAssets.length > 0 &&"));
    expect(todaySection).toContain("<AssetCard");
    expect(todaySection).toContain("canApprove={canApprove}");
  });

  it("does not render at all on a day with no output", () => {
    expect(view).toContain("{todayAssets.length > 0 && (");
    // And the empty state has to account for BOTH sections being empty, or a
    // day whose only matches were lifted would show "No matching assets" over
    // a full Today section.
    expect(view).toContain("groupedAssets.length === 0 && todayAssets.length === 0");
  });
});

/* ────────────────────────────── the type tabs ────────────────────────────── */

describe("the type tabs", () => {
  it("are in the top bar, one press per type, replacing no dropdown", () => {
    expect(view).toContain('role="tablist"');
    expect(view).toContain('role="tab"');
    expect(view).toContain("aria-selected={selected}");
    expect(view).toContain("setType(option)");
  });

  it("take their labels and their order from the one register", () => {
    // Derived, never listed again: a sixth AssetType gets a tab the day it is
    // added, with the label the rest of the app already prints.
    expect(view).toContain("const TYPE_ORDER = Object.keys(ASSET_TYPE_LABEL)");
    expect(view).toContain("ASSET_TYPE_LABEL[option]");
    for (const label of Object.values(ASSET_TYPE_LABEL)) {
      expect(view, `the tabs spell "${label}" themselves`).not.toContain(`"${label}"`);
    }
  });

  it("offer only the types this list actually holds", () => {
    // A tab that always finds nothing is a worse lie than no tab.
    expect(view).toContain("TYPE_ORDER.filter((t) => assets.some((asset) => asset.type === t))");
  });

  it("do not render when there is no choice to make", () => {
    // One tab beside "All" is a control with nothing in it.
    expect(view).toContain("{typesPresent.length > 1 && (");
  });

  it("filter the list, which is the whole point", () => {
    expect(view).toMatch(/\.filter\(\(asset\) => type === "all" \|\| asset\.type === type\)/);
  });
});

/* ───────────────────────── the order the chip claims ─────────────────────── */

describe("the sort chip", () => {
  it("describes the rule both sections follow", () => {
    // It said "Newest first" over a list grouped by STATUS, which claimed an
    // order the page does not have (the sections run in lifecycle order). The
    // honest version had to change again once a second section existed.
    expect(view).toContain("Newest first in each section");
    expect(view).not.toContain("Newest first in each status");
    expect(view).not.toMatch(/>Newest first</);
  });
});

/* ────────────────────────── the selector, driven ────────────────────────── */

describe("lifting the day, on real values", () => {
  const at = (d: number, h = 12) => new Date(2026, 8, d, h, 0, 0).getTime();
  const now = at(9, 15);

  it("splits the filtered set into today and the rest, losing nothing", () => {
    const matching = [
      { id: "a", createdAt: at(9, 9) },
      { id: "b", createdAt: at(8, 9) },
      { id: "c", createdAt: at(9, 14) },
      { id: "d", createdAt: at(1, 9) },
    ];
    const today = generatedToday(matching, now);
    const lifted = new Set(today.map((r) => r.id));
    const rest = matching.filter((r) => !lifted.has(r.id));
    expect(today.map((r) => r.id)).toEqual(["c", "a"]);
    expect(rest.map((r) => r.id)).toEqual(["b", "d"]);
    // The two halves are a partition: nothing dropped, nothing counted twice.
    expect(today.length + rest.length).toBe(matching.length);
  });
});
