import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * HOME'S KPI CARD LINKS PER CELL, AND PROMISES NOTHING AT CARD LEVEL
 * (portal feedback round 5, 2026-09).
 *
 * "There should not be a button on the right that says See more / Full report
 * when it will not show more about the posts published. All the KPIs should be
 * interactive and clickable, bringing them to the report."
 *
 * Two failure modes are worth a guard rather than a code review, because both
 * come back the moment somebody adds a fourth KPI:
 *
 *  1. A CARD-LEVEL "more" CONTROL. It is one line to add, it looks tidy in the
 *     header, and it can only ever be honest about ONE of the numbers under it.
 *     That is exactly the control this round deleted.
 *  2. A CELL THAT IS NOT A LINK. The card reads as a row of equals, so one dead
 *     cell among three live ones is worse than none of them navigating: the
 *     reader learns the row is clickable from the first cell and then gets
 *     nothing from the third.
 *
 * Source-scanned rather than rendered, deliberately: this is a statement about
 * the SHAPE of the component (its shell requires an href, its header holds no
 * link), and a render test would pass on a card whose next cell is a plain div.
 */

const ROOT = join(__dirname, "..", "..", "..");
const KPIS = readFileSync(join(ROOT, "src/components/home-kpis.tsx"), "utf8");
const CLIENT_PAGE = readFileSync(join(ROOT, "src/app/(app)/clients/[id]/page.tsx"), "utf8");
const SETTINGS_PAGE = readFileSync(
  join(ROOT, "src/app/(app)/clients/[id]/settings/page.tsx"),
  "utf8",
);

/**
 * Source with its comments taken out. Load-bearing for the header check below:
 * this component's own docstrings QUOTE the deleted control by name (that is
 * what stops it being re-added by somebody who never read this test), so a scan
 * of the raw file would fail on the explanation of why it must pass.
 */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/** Everything between `<Cell` and the `>` that ends its opening tag. */
function cellTags(source: string): string[] {
  return source.match(/<Cell\b[^>]*>/g) ?? [];
}

describe("the KPI card's own header", () => {
  it("carries no card-level 'more' control", () => {
    // The strings the deleted control used, and the ones a replacement would
    // most likely spell itself with.
    const rendered = withoutComments(KPIS);
    for (const promise of ["Full report", "See more", "See the breakdown", "View report"]) {
      expect(
        rendered,
        `"${promise}" is a card-level promise about three different numbers`,
      ).not.toContain(promise);
    }
  });
});

describe("every KPI cell", () => {
  it("has a destination, because the shell cannot be built without one", () => {
    // Optional would make the next dead cell a typo rather than a decision.
    expect(KPIS).toMatch(/\n\s*href: string;/);
    expect(KPIS).not.toMatch(/\n\s*href\?: string;/);
  });

  it("is passed one at every call site", () => {
    const tags = cellTags(KPIS);
    // Three cells today: followers, published content, visibility.
    expect(tags.length).toBeGreaterThanOrEqual(3);
    for (const tag of tags) expect(tag, `a <Cell> with no href: ${tag}`).toContain("href=");
  });
});

describe("where the client page sends each cell", () => {
  it("gives every cell it mounts a destination of its own", () => {
    // The point of the round: "more about THIS number" is a different screen
    // per number, so one shared href would be the old broken promise again.
    //
    // TWO CELLS, NOT THREE, since the review wave (2026-09): the followers cell
    // has never rendered (nothing writes `clientFollowerSnapshots`) and the page
    // stopped reading a collection to feed it, so `audienceHref` is not passed
    // at all. The rule is about the cells that mount — a cell with nowhere to go
    // is what this file exists to catch, and an absent cell has no reader to
    // disappoint.
    const props = ["contentHref", "visibilityHref"];
    for (const prop of props) expect(CLIENT_PAGE).toContain(`${prop}=`);
    const values = props.map((prop) => CLIENT_PAGE.match(new RegExp(`${prop}=\\{([^}]+)\\}`))?.[1]);
    expect(values.every(Boolean)).toBe(true);
    expect(new Set(values).size).toBe(props.length);
  });

  it("counts the published cell's link on a list that holds everything it counted", () => {
    // `contentThroughput` counts `published` AND `delivered`, so a
    // `?status=published` destination is narrower than the number above it: six
    // counted, four listed, nothing on either screen explaining the gap (review
    // wave, 2026-09). The cell links to the unfiltered list instead.
    const contentHref = CLIENT_PAGE.match(/contentHref=\{([a-zA-Z]+)\}/)?.[1];
    expect(contentHref).toBe("throughputHref");
    const value = CLIENT_PAGE.match(/const throughputHref = ([^;]+);/)?.[1] ?? "";
    expect(value, "the published cell went back to a status filter").not.toContain("status=");
  });

  it("anchors the visibility cell at a section the Reporting tab really renders", () => {
    const hash = CLIENT_PAGE.match(/`\$\{reportHref\}#([a-z-]+)`/)?.[1];
    expect(hash, "the visibility cell no longer carries an anchor").toBeTruthy();
    expect(SETTINGS_PAGE, `nothing on the Reporting tab has id="${hash}"`).toContain(
      `id="${hash}"`,
    );
  });

  it("drops the anchor when there is no snapshot for the section to render", () => {
    // settings/page.tsx writes `id="visibility-scores"` INSIDE its `seoGeo ? …`
    // branch, so on an unmeasured account the fragment names nothing. The tab
    // itself always renders (the panel's own empty state), so the cell keeps a
    // destination and drops the hash rather than losing its link.
    expect(CLIENT_PAGE).toMatch(
      /const visibilityHref = seoGeo \? `\$\{reportHref\}#[a-z-]+` : reportHref;/,
    );
    expect(SETTINGS_PAGE).toMatch(/const reportingSection = seoGeo \? \(/);
  });

  it("mounts the widget once, so staff context and the client portal cannot diverge", () => {
    // Both branches of this page render the SAME `kpis` element; a second
    // <HomeKpisWidget> is how they start disagreeing.
    expect(CLIENT_PAGE.match(/<HomeKpisWidget/g) ?? []).toHaveLength(1);
    expect(CLIENT_PAGE.match(/\{kpis\}/g) ?? []).toHaveLength(2);
  });
});
