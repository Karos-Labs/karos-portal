import path from "node:path";
import { describe, expect, it } from "vitest";
import { readSource, stripComments } from "./source-scan";

/**
 * round 6: ONE INTERACTION LOGIC, PINNED AT THE PRIMITIVES.
 *
 * The product owner's finding was that he could not tell what on a screen was
 * clickable: static cards answered a passing mouse, the SEO cells sat in the KPI
 * cell's exact shell and did nothing, and a keyboard reader could not see which
 * field they were in. Almost all of that came from four components in `ui.tsx`
 * plus one missing utility, which is why the fix is small and why an accidental
 * revert would be invisible in review.
 *
 * SOURCE-SCANNED, like every other rendering rule in this directory: this suite
 * runs with no DOM, and what a later edit would silently undo is a class string,
 * not a behaviour a click could catch. The rules pinned here are the ones with a
 * blast radius (52 files use `Card`, 79 use `Button`), stated as the docs state
 * them:
 *
 *  · rule 5 — one `.focus-ring`, one `--focus` token, on every interactive
 *    element including inputs.
 *  · rule 6 — a `Card` is a container and never hovers.
 *  · rule 2 — a button's hover is a colour change and nothing else.
 *  · rule 7 — Home's orange is the ladder's button, the progress fill,
 *    `row-lift` hovers and the bell badge. Not icon chips, not meter fills, not
 *    a sparkline, not an info band.
 */

const SRC = path.resolve(__dirname, "../..");
const file = (rel: string) => readSource(path.join(SRC, rel));
/** JSX and class strings only: the notes above these rules quote the very
 *  classes the rules forbid, which is what stops them coming back. */
const code = (rel: string) => stripComments(file(rel));

const UI = code("components/ui.tsx");
const CSS = file("app/globals.css");

describe("rule 5 · one focus ring, defined once and applied by the primitives", () => {
  it("defines the token and the utility in globals.css", () => {
    // Ink, not orange: --neon is 2.84:1 on paper, so an orange ring fails WCAG
    // 1.4.11 in light mode. Written as a var reference so it reverses with the
    // mode without a second declaration in `.light`.
    expect(CSS).toContain("--focus: var(--foreground);");
    expect(CSS).toMatch(/\.focus-ring:focus-visible\s*\{/);
    const rule = CSS.slice(CSS.indexOf(".focus-ring:focus-visible"));
    expect(rule.slice(0, rule.indexOf("}"))).toContain("outline: 2px solid var(--focus)");
  });

  it("is applied by Button, Input, Textarea, Select and TabButton", () => {
    // Five primitives, five occurrences plus nothing else needed: anything built
    // out of these inherits the ring rather than inventing a recipe.
    const applications = [...UI.matchAll(/focus-ring/g)];
    expect(applications.length).toBeGreaterThanOrEqual(5);
    for (const anchor of ["<button", "<input", "<textarea", "<select"]) {
      const at = UI.indexOf(anchor);
      expect(at, `${anchor} is gone from ui.tsx`).toBeGreaterThan(-1);
    }
  });

  it("leaves no ring recipe of its own in ui.tsx, and no bare outline-none", () => {
    // The two shapes the seven old recipes took. `outline-none` without a ring
    // is the bug rule 5 names by that word.
    expect(UI).not.toContain("focus-visible:ring");
    expect(UI).not.toContain("outline-none");
  });

  it("gives the leaves A owns the shared class instead of their own", () => {
    for (const rel of [
      "components/home-kpis.tsx",
      "components/home-standing.tsx",
      "components/home-calendar-preview.tsx",
      "components/client-home-overview.tsx",
      "components/rail-nav-link.tsx",
      "components/seo-geo-panel.tsx",
      "components/seo-geo/disclosure.tsx",
      "components/seo-geo/flag-button.tsx",
      "components/seo-geo/gap-list.tsx",
      "components/seo-geo/score-popover.tsx",
      "components/client-agents/agent-archive-rows.tsx",
      "components/modal.tsx",
    ]) {
      const c = code(rel);
      expect(c, `${rel} carries focus styles nothing else in the app has`).not.toContain(
        "focus-visible:ring",
      );
      expect(c, `${rel} has no focus style at all`).toContain("focus-ring");
    }
  });
});

describe("rule 6 · a Card is a container and never hovers", () => {
  it("has no hover treatment in the primitive itself", () => {
    const at = UI.indexOf("export function Card(");
    expect(at).toBeGreaterThan(-1);
    const body = UI.slice(at, UI.indexOf("export function CardTitle"));
    // Both halves of the treatment 52 files inherited.
    expect(body).not.toContain("hover:border-border-strong");
    expect(body).not.toContain("hover:shadow");
    // A card that IS the whole target of a link asks for its own hover on its
    // className (clients-grid.tsx), which is the escape hatch this leaves open.
    expect(code("components/clients-grid.tsx")).toContain(
      '<Card className="h-full hover:border-border-strong">',
    );
  });
});

describe("rule 2 · a button's hover is a colour change and nothing else", () => {
  it("does not move or bloom", () => {
    // round 6 (integration): the two maps were lifted out of the component to
    // module scope so `buttonClass` can serve the "a Link wearing the button
    // voice" call sites from ONE copy of the recipe. Same strings, new names -
    // the fact this pins is unchanged.
    const at = UI.indexOf("const BUTTON_VARIANTS");
    expect(at, "Button's variant map was renamed or moved").toBeGreaterThan(-1);
    // BOTH ends asserted (round 6 fix pass): a missing end anchor makes
    // `indexOf` return -1, and `slice(at, -1)` silently keeps slicing — so the
    // `not.toContain` pins below would have passed over the wrong text.
    const end = UI.indexOf("const BUTTON_SIZES");
    expect(end, "Button's size map was renamed or moved").toBeGreaterThan(at);
    const variants = UI.slice(at, end);
    expect(variants.length, "the sliced variant map is empty").toBeGreaterThan(0);
    expect(variants).not.toContain("-translate-y");
    expect(variants).not.toContain("hover:shadow");
    // accent to --neon-bright, primary to 90% of its own fill.
    expect(variants).toContain("hover:bg-neon-bright");
    expect(variants).toContain("hover:bg-primary/90");
  });
});

describe("rule 7 · Home's orange is the one CTA, the progress fill and the hovers", () => {
  it("spends none of it on icon chips, meter fills, a sparkline or an info band", () => {
    // The eleven orange things on one screen that stopped the ladder's single
    // orange button from reading as the one. Comments stripped: each file's own
    // note names the class it used to carry.
    for (const rel of [
      "components/home-kpis.tsx",
      "components/home-standing.tsx",
      "components/home-calendar-preview.tsx",
      "components/client-home-overview.tsx",
      "components/client-rail.tsx",
      "components/rail-nav-link.tsx",
    ]) {
      expect(code(rel), `${rel} still paints something orange`).not.toMatch(/\bneon\b/);
    }
  });

  it("keeps the sanctioned uses, which live in globals.css rather than in a component", () => {
    // `row-lift`'s hairline is the hover rule 1 asks for, and the marker, the
    // live pulse and the highlight are §6's own list. Removing these would be a
    // brand change, not a sweep.
    expect(CSS).toContain(".row-lift:hover");
    expect(CSS.slice(CSS.indexOf(".row-lift:hover"))).toContain("var(--neon)");
  });
});

describe("rule 1 · a link ends in one static chevron, and a static box is not a link", () => {
  it("makes both SEO cells whole-cell links to the section that shows the working", () => {
    const standing = code("components/home-standing.tsx");
    // It was a `div` in the KPI cell's shell. Now: one Link, `row-lift`, one
    // chevron, and an href per cell.
    expect(standing).toMatch(/function ShareMeter\(/);
    const at = standing.indexOf("function ShareMeter(");
    const body = standing.slice(at, standing.indexOf("function", at + 10));
    expect(body).toContain("<Link");
    expect(body).toContain("row-lift");
    expect(body.match(/name="ChevronRight"/g) ?? []).toHaveLength(1);
    // The two anchors, and the panel that writes them.
    expect(standing).toContain("#presence");
    expect(standing).toContain("#share");
    const panel = code("components/seo-geo-panel.tsx");
    expect(panel).toContain('id="presence"');
    expect(panel).toContain('id="share"');
  });

  it("does not slide the chevron on the KPI cells", () => {
    const kpis = code("components/home-kpis.tsx");
    expect(kpis).not.toContain("group-hover:translate-x");
  });

  it("takes the link's shell off the rows that open nothing", () => {
    // A client's run rows have no destination (/jobs/[id] is staff-only), and
    // the rows two sections up on the same page DO open — in the same border +
    // surface-2 box. The inert one sits on a divider now.
    const history = code("components/client-agents/client-agent-run-history.tsx");
    expect(history).not.toContain("bg-surface-2");
    expect(history).not.toContain("row-lift");
    expect(history).toContain("border-b border-border");
  });

  it("puts no glyph after a button label on the surfaces A owns", () => {
    for (const rel of [
      "components/home-kpis.tsx",
      "components/home-standing.tsx",
      "components/home-calendar-preview.tsx",
      "components/client-home-overview.tsx",
      "components/client-agents/archetype-cards.tsx",
    ]) {
      expect(code(rel), `${rel} still ends a control in an arrow`).not.toContain(
        'name="ArrowRight"',
      );
    }
  });
});

describe("reduced motion covers transitions, not only the seven keyframes", () => {
  it("kills transition-duration as well", () => {
    const at = CSS.lastIndexOf("prefers-reduced-motion");
    const block = CSS.slice(at);
    expect(block).toContain("transition-duration: 0.01ms !important");
    // …and the keyframes it already covered stay covered.
    expect(block).toContain(".animate-pulse-ring");
  });
});

/* ── round 6 review (E13): numbers are sans ──────────────────────────── */

/**
 * globals.css's own header states the rule: numerals live in the sans face
 * with `.stat-number` / `.tabular`, and the mono keeps only the jobs where
 * monospacing is the point (an id you might copy, a code block, a short
 * uppercase label). Two client-facing FIGURES had stayed mono, so the same kind
 * of number at the same size disagreed with Home about what a number looks
 * like — which is the exact defect that changed the rule in 2026-09.
 *
 * Scoped to the two figures rather than banning `font-mono` from the files:
 * both still use it legitimately for uppercase eyebrows and for the staff
 * library's skill-directory paths.
 */
describe("a client-facing figure is set in the sans face", () => {
  it("defines the helper the figures use", () => {
    const at = CSS.indexOf(".stat-number {");
    expect(at, ".stat-number is gone from globals.css").toBeGreaterThan(-1);
    const block = CSS.slice(at, at + 200);
    expect(block).toContain("font-family: var(--font-sans)");
    expect(block).toContain("font-variant-numeric: tabular-nums");
  });

  it("sets the visibility score's headline in it", () => {
    const src = code("components/seo-geo/score-popover.tsx");
    const at = src.indexOf("focus-ring inline-flex min-h-6");
    expect(at, "the score trigger's class list moved").toBeGreaterThan(-1);
    const line = src.slice(at - 40, at + 200);
    expect(line).toContain("stat-number");
    expect(line, "the score is mono again").not.toContain("font-mono");
    // Size and weight are the rule's business no more than the colour is.
    expect(line).toContain("text-2xl");
    expect(line).toContain("font-medium");
  });

  it("sets the pace modal's weekly price in it", () => {
    const src = code("components/custom-agents.tsx");
    const at = src.indexOf("Estimated weekly cost");
    expect(at, "the weekly-cost row moved").toBeGreaterThan(-1);
    const row = src.slice(at, at + 300);
    expect(row).toContain("stat-number");
    expect(row, "the price is mono again").not.toContain("font-mono");
  });
});
