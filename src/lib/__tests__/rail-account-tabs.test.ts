import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The rail's Account Center rows and the Account Center's own tabs are one list
 * written in two files, so they are held together here.
 *
 * Account Center was not on the client's desktop rail at all (SCRUM-419): the
 * only signposted ways in were the avatar dropdown and whatever a Home widget
 * linked to, which is what made the metrics widgets the entry point. Adding the
 * rows created a second copy of the section list — the settings page builds the
 * real tabs, the rail links to them by `?tab=` — and a `?tab=` that names no tab
 * silently falls back to the first section, which is the same "navigation
 * pointing at something that is not there" this whole epic is about.
 *
 * READ FROM SOURCE, NOT IMPORTED. Both files are `"use client"` modules whose
 * imports pull `next/link` and `next/navigation`; the ids are plain literals, so
 * reading them is enough and costs the suite no module graph.
 */

const SRC = join(process.cwd(), "src");
const SETTINGS_PAGE = join(SRC, "app/(app)/clients/[id]/settings/page.tsx");
const RAIL_NAV = join(SRC, "components/client-rail-account-nav.tsx");

const read = (path: string) => readFileSync(path, "utf8");

/**
 * Comments stripped. Same reason every other sweep here does it: the docstring
 * that explains why this file does NOT use `useSearchParams` names it, and run
 * against raw text the cheap way to keep the rule green would be deleting the
 * explanation.
 */
const code = (path: string) =>
  read(path).replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

/**
 * The settings page's real tabs. Matched on the full row shape — `group:` is
 * what makes it a tab-list entry rather than any other object with an `id`.
 */
function pageTabs(): { id: string; label: string }[] {
  const pattern = /\{\s*id:\s*"([^"]+)",\s*label:\s*"([^"]+)"[^}]*group:\s*"[^"]+"/g;
  return [...read(SETTINGS_PAGE).matchAll(pattern)].map((m) => ({ id: m[1]!, label: m[2]! }));
}

/** The rail's section rows, from its exported constant. */
function railSections(): { id: string; label: string }[] {
  const block = read(RAIL_NAV).match(
    /ACCOUNT_CENTER_SECTIONS[\s\S]*?=\s*\[([\s\S]*?)\n\];/,
  );
  if (!block) return [];
  const pattern = /\{\s*id:\s*"([^"]+)",\s*label:\s*"([^"]+)"/g;
  return [...block[1]!.matchAll(pattern)].map((m) => ({ id: m[1]!, label: m[2]! }));
}

describe("Account Center in the client rail", () => {
  it("found both lists", () => {
    // Non-vacuity: either extractor breaking would make every rule below hold
    // over nothing, which is the failure mode a rename would produce.
    expect(pageTabs().length, "no tabs matched in the settings page").toBeGreaterThan(3);
    expect(railSections().length, "no sections matched in the rail nav").toBeGreaterThan(3);
  });

  it("links only to tabs the page actually serves", () => {
    const served = new Set(pageTabs().map((t) => t.id));
    const dangling = railSections()
      .filter((s) => !served.has(s.id))
      .map((s) => `?tab=${s.id}`);
    // A `?tab=` the page does not know falls back to its first section, so the
    // row would open Profile while claiming to be Credits.
    expect(dangling, "these open the wrong section").toEqual([]);
  });

  it("offers every tab, so the rail is not a partial mirror", () => {
    // The report named four sections and the page has five ("competitor
    // reporting" is one phrase over two tabs). A four-item guess would be a
    // navigation that describes a surface it does not mirror.
    const listed = new Set(railSections().map((s) => s.id));
    const missing = pageTabs()
      .filter((t) => !listed.has(t.id))
      .map((t) => t.id);
    expect(missing, "unreachable from the rail").toEqual([]);
  });

  it("calls each section what the page calls it", () => {
    const byId = new Map(pageTabs().map((t) => [t.id, t.label]));
    const renamed = railSections()
      .filter((s) => byId.has(s.id) && byId.get(s.id) !== s.label)
      .map((s) => `${s.id}: rail says "${s.label}", page says "${byId.get(s.id)}"`);
    expect(renamed, "one section, two names").toEqual([]);
  });

  it("is mounted on the desktop rail, in both shells, and nowhere else offers it", () => {
    // The rows existing is not the fix; the fix is that they render. The rail
    // built its `settingsItem` for months while never placing it.
    const rail = read(join(SRC, "components/client-rail.tsx"));
    expect(rail).toMatch(/<ClientRailAccountNav\s+home=\{home\}\s*\/>/);
    // The staff shell's client-context arm mounts the same group (parity), so
    // the avatar menu could stop repeating the destination (2026-09-11).
    const sidebar = read(join(SRC, "components/sidebar.tsx"));
    expect(sidebar).toMatch(/<ClientRailAccountNav\s+home=\{clientHome!\}\s*\/>/);
    const menu = code(join(SRC, "components/account-menu.tsx"));
    expect(menu).not.toContain("Account Center");
    expect(menu).not.toContain("settingsHref");
  });

  it("does not share the gear with its own Settings section", () => {
    const nav = code(RAIL_NAV);
    const icon = nav.match(/ACCOUNT_CENTER_ICON = "([^"]+)"/)?.[1];
    expect(icon, "no exported icon").toBeTruthy();
    expect(icon).not.toBe("Settings");
    // The mobile sheets draw the same glyph from the same constant.
    for (const rel of ["components/client-rail.tsx", "components/sidebar.tsx"]) {
      expect(code(join(SRC, rel)), `${rel} spells its own Account Center icon`).toContain(
        "ACCOUNT_CENTER_ICON",
      );
    }
  });

  it("marks no section row as current", () => {
    // SettingsTabs moves between sections with history.replaceState, which
    // useSearchParams does not observe — a `?tab=`-derived active row would keep
    // pointing at the section the reader arrived on. Only the parent row, which
    // is route-derived, may claim to be current.
    const nav = code(RAIL_NAV);
    expect(nav).not.toContain("useSearchParams");
    // Exactly one aria-current in the file, on the parent.
    expect([...nav.matchAll(/aria-current/g)]).toHaveLength(1);
  });
});
