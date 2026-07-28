import { readFileSync } from "fs";
import path from "path";
import { describe, expect, it } from "vitest";
import { MOBILE_TAB_BAR_H, MOBILE_TAB_BAR_OFFSET_CLASS } from "@/lib/constants";

/**
 * The copilot dock has to line up with chrome that lives in two other files —
 * the width of each shell's left nav column, and the height of the narrow
 * viewport bottom bar. Nothing but CSS enforces that agreement, and when it
 * drifted the dock hung 54px off the bottom of the staff shell with page
 * content showing underneath and started 32px right of the sidebar (CD-G8).
 *
 * These assertions read the source text on purpose: the components are
 * "use client" modules whose import graph reaches the Admin SDK, so they
 * cannot be imported into a node test run.
 */

const src = (rel: string) => readFileSync(path.resolve(__dirname, "../..", rel), "utf8");

const dock = src("components/copilot-dock.tsx");

/** Pulls one SHELL_ANCHOR entry, resolving the one constant it interpolates. */
const anchorFor = (shell: string) =>
  (new RegExp(`${shell}:\\s*\`([^\`]+)\``).exec(dock)?.[1] ?? "").replace(
    "${MOBILE_TAB_BAR_OFFSET_CLASS}",
    MOBILE_TAB_BAR_OFFSET_CLASS,
  );

const clientAnchor = anchorFor("client");
const staffAnchor = anchorFor("staff");

describe("narrow-viewport shell chrome", () => {
  it("keeps the bottom-bar offset class in step with the bar's height", () => {
    // Hand-synced because Tailwind extracts class names by scanning source
    // text and emits nothing for an interpolated bottom-[${n}px].
    expect(MOBILE_TAB_BAR_OFFSET_CLASS).toBe(`bottom-[${MOBILE_TAB_BAR_H}px]`);
  });

  it("anchors the copilot strip to the right edge and the bottom in both shells", () => {
    for (const anchor of [clientAnchor, staffAnchor]) {
      expect(anchor).not.toBe("");
      // Full width to the RIGHT edge, at every width.
      expect(anchor).toContain("right-0");
      // Pinned to the bottom: above the tab bar below md, on the edge from md up.
      expect(anchor).toContain(MOBILE_TAB_BAR_OFFSET_CLASS);
      expect(anchor).toContain("md:bottom-0");
      // Never a mid-flow float — the strip is only ever positioned, never static.
      expect(anchor).not.toMatch(/\bstatic\b|\brelative\b/);
    }
  });

  it("starts each shell's strip at the right edge of that shell's nav column", () => {
    // ClientRail's desktop aside and the client anchor must name the same width.
    expect(src("components/client-rail.tsx")).toMatch(/aside className="[^"]*\bw-72\b/);
    expect(clientAnchor).toContain("md:left-72");

    // The staff Sidebar's is narrower — this is the pair that had drifted.
    expect(src("components/sidebar.tsx")).toMatch(/aside className="[^"]*\bw-64\b/);
    expect(staffAnchor).toContain("md:left-64");

    expect(clientAnchor).not.toBe(staffAnchor);
  });

  it("scopes outside-click dismissal to the overlay, never the lg+ side rail", () => {
    // CD-G9b ruling: Albert described the pop-up. The persistent 380px rail
    // owns a column of the layout, so collapsing it on a stray page click would
    // reflow the page and then persist that through DOCK_STATE_KEY. It keeps
    // its explicit handle as the only way to collapse.
    const effect = /addEventListener\("mousedown"[\s\S]{0,80}?\n/.exec(dock);
    expect(effect).not.toBeNull();

    // The handler that runs on an outside click may close the sheet and nothing
    // else — reaching setCollapsed from there is the regression.
    const handler = /function handleOutside\([\s\S]*?\n    \}/.exec(dock)?.[0] ?? "";
    expect(handler).toContain("setSheetOpen(false)");
    expect(handler).not.toContain("setCollapsed");

    // And the rail must not be wired for containment testing at all.
    expect(dock).not.toContain("railRef");
  });

  it("gives the expanded sheet a height cap rather than a fixed box", () => {
    // A fixed 70dvh box left dead air between sparse content and the input row.
    expect(dock).toContain("max-h-[70dvh]");
    expect(dock).not.toMatch(/(?<!max-)h-\[70dvh\]/);
  });
});
