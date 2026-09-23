import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * A placeholder whose job is to stop the layout jumping was itself the jump.
 *
 * One skeleton served all thirty-three routes, and it was the DASHBOARD's: four
 * KPI tiles over two wide panels. So every list page flashed a grid of tiles
 * and then re-laid itself out as a table, every detail page flashed the same
 * tiles and became a column, and the calendar flashed them and became a grid.
 *
 * Three shapes, because three is what the app has. Not one per route — a
 * skeleton is a silhouette, and a silhouette that tracks every page exactly is
 * a second copy of the layout to keep in step.
 *
 * What these guard is the thing that goes wrong next: a route added later gets
 * a `loading.tsx` copied from a neighbour, and the neighbour was the wrong
 * shape. So the default is asserted to be the rarest of the three, and every
 * route that keeps it has to be one that genuinely looks like a dashboard.
 */

const APP = join(process.cwd(), "src/app");

function loadingFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...loadingFiles(full));
    else if (entry === "loading.tsx") out.push(relative(APP, dir).split(sep).join("/"));
  }
  return out;
}

function shapeOf(route: string): string {
  const text = readFileSync(join(APP, route, "loading.tsx"), "utf8");
  if (!text.includes("PageSkeleton")) return "custom";
  return /shape="(\w+)"/.exec(text)?.[1] ?? "dashboard";
}

/**
 * The routes that really are dashboards — a header, a row of figures, panels.
 *
 * Named rather than counted, because "how many are left on the default" is a
 * number that drifts down as routes are added and tells nobody anything. This
 * list is short enough to read and each entry is checkable by opening the page.
 */
const GENUINELY_DASHBOARDS = new Set([
  "(app)/dashboard",
  "(app)/calendar",
  "(app)/clients/[id]/agents",
  "(app)/clients/[id]/calendar",
  "(app)/admin/analytics",
  "(app)/admin/ops",
  "(app)/admin/agents/control-plane",
]);

describe("a loading skeleton is the shape of the page behind it", () => {
  it("finds the route tree, so an empty walk cannot pass", () => {
    expect(loadingFiles(APP).length).toBeGreaterThan(25);
  });

  it("leaves the dashboard shape only on routes that are dashboards", () => {
    const wrong = loadingFiles(APP)
      .filter((route) => shapeOf(route) === "dashboard")
      .filter((route) => !GENUINELY_DASHBOARDS.has(route));

    expect(
      wrong,
      "these still use the dashboard skeleton — four KPI tiles over two panels.\n" +
        "Pass shape=\"list\" or shape=\"detail\", or add the route to GENUINELY_DASHBOARDS:\n  " +
        wrong.join("\n  "),
    ).toEqual([]);
  });

  it("keeps the dashboard list honest — every entry still has a loading file", () => {
    const routes = new Set(loadingFiles(APP));
    const stale = [...GENUINELY_DASHBOARDS].filter((route) => !routes.has(route));
    expect(stale, `these are in GENUINELY_DASHBOARDS with no loading.tsx:\n  ${stale.join("\n  ")}`).toEqual([]);
  });

  it("uses only shapes the component actually implements", () => {
    const component = readFileSync(join(process.cwd(), "src/components/page-skeleton.tsx"), "utf8");
    const implemented = new Set(["dashboard", "list", "detail", "custom"]);
    // The union in the component is the source of truth; a typo in a route's
    // prop would be a silent fall-through to the default.
    expect(component).toMatch(/export type PageShape = "dashboard" \| "list" \| "detail"/);
    for (const route of loadingFiles(APP)) {
      expect(implemented.has(shapeOf(route)), `${route} asks for "${shapeOf(route)}"`).toBe(true);
    }
  });
});
