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

    // THE STAFF SIDEBAR HAS TWO WIDTHS NOW (parity pass 2026-09, rulings
    // D1/D2/D22). Its aside is `w-64` in the agency workspace and `w-72` in
    // client context, because in client context it IS the client's rail — same
    // width, same sections, same footer.
    const sidebar = src("components/sidebar.tsx");
    expect(sidebar).toMatch(/clientCtx \? "relative z-30 w-72" : "w-64"/);
    // The dock only ever anchors to the SECOND of those: StaffCopilotDock
    // returns null unless a client context is active, so the staff shell the
    // strip is painted in is always the `w-72` one. `md:left-64` was the width
    // of a shell this dock is never mounted in, and it left 32px of page
    // showing under the rail's right edge.
    expect(src("components/staff-chatbot-widget.tsx")).toMatch(/if\s*\(!activeClient\)\s*return null/);
    expect(staffAnchor).toContain("md:left-72");

    // IDENTICAL, and that is the assertion — not an oversight. The two anchors
    // used to be pinned APART on the reasoning that the shells have different
    // nav widths; they do, but only one of each shell's widths ever hosts this
    // dock, and those two are the same number.
    expect(clientAnchor).toBe(staffAnchor);
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

  it("counts a click inside a portaled dialog as inside the sheet", () => {
    // The Strategy War Room opens from the sheet but renders through Modal,
    // which portals to document.body — so a ref containment test alone reads
    // every click in the dialog as "outside" and closes the copilot behind it.
    // Below lg that made the copilot vanish the moment you touched the dialog.
    const handler = /function handleOutside\([\s\S]*?\n    \}/.exec(dock)?.[0] ?? "";
    expect(handler).toContain("data-overlay-root");

    // The escape has to come BEFORE the dismissal, or it escapes nothing.
    expect(handler.indexOf("data-overlay-root")).toBeLessThan(
      handler.indexOf("setSheetOpen(false)"),
    );

    // The attribute is only meaningful if the portal root actually carries it.
    const modal = src("components/modal.tsx");
    expect(modal).toContain("createPortal(");
    expect(modal).toContain("document.body");
    expect(modal).toMatch(/data-overlay-root/);

    // Attribute, not a class-name match: class names get restyled, and this
    // has to hold for every overlay that portals through Modal.
    expect(handler).not.toMatch(/closest\(["'`]\./);
  });

  it("keeps the collapsed rail a paint clip, never a scroll container", () => {
    // QA 2026-09: the collapsed strip showed the right edge of the chat.
    // `overflow-hidden` is still a scroll container, and the chat's own
    // scrollIntoView()/focus() scrolled it ~330px sideways, carrying the
    // `absolute` overlay off-screen with the content. `overflow-clip` cannot
    // be scrolled by anything; `inert` stops the focus half at the source.
    const frame = /<div className="relative h-full overflow-(\w+)">/.exec(dock);
    expect(frame?.[1]).toBe("clip");
    // In a class attribute - the comment explaining the bug names the old value.
    expect(dock).not.toMatch(/className="[^"]*\boverflow-hidden\b/);
    expect(dock).toContain("inert={collapsed}");

    // The strip is a real control (click anywhere to expand), rendered only
    // while collapsed so it can never sit over the open chat, and pinned at
    // the strip's own width so it does not slide during the width transition.
    const overlay = /\{collapsed && \(\s*<button[\s\S]*?className="([^"]+)"/.exec(dock);
    expect(overlay).not.toBeNull();
    expect(overlay?.[1]).toContain("absolute inset-y-0 left-0");
    expect(overlay?.[1]).toContain("w-12");
    expect(overlay?.[1]).not.toContain("inset-0");
  });

  it("gives the expanded sheet a height cap rather than a fixed box", () => {
    // A fixed 70dvh box left dead air between sparse content and the input row.
    expect(dock).toContain("max-h-[70dvh]");
    expect(dock).not.toMatch(/(?<!max-)h-\[70dvh\]/);
  });
});
