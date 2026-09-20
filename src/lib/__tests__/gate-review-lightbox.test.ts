import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { readSource } from "./source-scan";

/**
 * A reviewer at a gate must be able to OPEN a slide.
 *
 * The gate-review surface used to draw a carousel as four `<img>` tiles two
 * inches wide with no handler on them — enough to see that pictures exist and
 * not enough to judge one, which is the same "approving something you have not
 * seen" the component's own header says it exists to stop. A source scan rather
 * than a render because both files portal through `createPortal`, which has no
 * `renderToStaticMarkup` output to assert on (the rule stated in
 * `asset-status-surfaces.test.ts`).
 *
 * WHAT IS PINNED IS THE MECHANISM, not the copy: a real button on the tile, one
 * shared viewer rather than a second overlay, and the four dialog guarantees a
 * portalled overlay owes the keyboard. Class names and labels are free to move.
 */
const SRC = join(process.cwd(), "src");
const src = (rel: string) => readSource(join(SRC, rel));

const LIGHTBOX = src("components/image-lightbox.tsx");
const GATE = src("components/agent-engine-gate-approval.tsx");

describe("the gate reviewer can open a slide full size", () => {
  it("scanned the files it claims to have scanned", () => {
    // The premise. A typo'd path reading "" passes every `not.toContain` below.
    expect(LIGHTBOX.length).toBeGreaterThan(2000);
    expect(GATE.length).toBeGreaterThan(2000);
    expect(LIGHTBOX).toContain("export function ImageLightbox");
    expect(GATE).toContain("export function AgentEngineGateApproval");
  });

  it("makes the slide tile a button that opens the viewer", () => {
    // A div with an onClick is not reachable by keyboard and announces as
    // nothing; the trigger has to be a real button.
    expect(GATE).toContain("setLightboxIndex");
    const trigger = /<button[\s\S]{0,400}?onClick=\{\(\) => setLightboxIndex\(/.exec(GATE);
    expect(trigger, "no <button> opens the viewer").not.toBeNull();

    // Both surfaces that draw a slide: the grid AND the thumbnail beside the
    // per-slide copy editor (the reviewer rewriting a slide is exactly the
    // reader who needs to see it).
    const openers = GATE.match(/onClick=\{\(\) => setLightboxIndex\(/g) ?? [];
    expect(openers.length).toBeGreaterThanOrEqual(2);

    // The trigger is focusable-and-visible-when-focused by the app's one ring
    // recipe, not a recipe of its own (interaction-primitives rule 5).
    expect(GATE).not.toContain("focus-visible:ring");
    expect(GATE).toContain("focus-ring");
  });

  it("reuses the one viewer instead of growing a second overlay", () => {
    expect(GATE).toContain('from "@/components/image-lightbox"');
    expect(GATE).toContain("<ImageLightbox");
    // No hand-rolled portal, backdrop or dialog of its own in the gate panel.
    expect(GATE).not.toContain("createPortal");
    expect(GATE).not.toContain('role="dialog"');
  });

  it("indexes the viewer by position, never by slide number", () => {
    // The viewer pages with `(i + delta + count) % count`. A carousel whose
    // middle slide came back unsigned is shorter than its highest slide
    // number, so `n` as the index pages onto a picture that is not there.
    expect(GATE).toContain("lightboxIndexByN");
    expect(GATE).toMatch(/openableSlides\s*=\s*loadableImages/);
  });

  it("gives the viewer the four things a portalled dialog owes the keyboard", () => {
    // 1. It is announced as a dialog.
    expect(LIGHTBOX).toContain('role="dialog"');
    expect(LIGHTBOX).toContain('aria-modal="true"');

    // 2. Tab cannot walk out of it, on the SAME rule Modal traps with — one
    // definition of "focusable", not two drifting copies.
    expect(LIGHTBOX).toContain('import { getFocusable } from "@/components/modal"');
    expect(LIGHTBOX).toContain("getFocusable(panel)");
    expect(LIGHTBOX).toContain('e.key !== "Tab"');

    // 3. Focus moves in on open and is handed back on close.
    expect(LIGHTBOX).toContain("opener?.focus({ preventScroll: true })");

    // 4. The page underneath does not scroll behind it.
    expect(LIGHTBOX).toContain('document.body.style.overflow = "hidden"');

    // Three ways out, all of them: Escape, the ✕, and the backdrop.
    expect(LIGHTBOX).toContain('e.key === "Escape"');
    expect(LIGHTBOX).toMatch(/aria-label="Close"/);
    const backdrop = /aria-hidden="true"[\s\S]{0,120}?onClick=\{onClose\}/.exec(LIGHTBOX);
    expect(backdrop, "the backdrop does not close the viewer").not.toBeNull();

    // …and the backdrop is actually REACHABLE. The dialog is a full-viewport
    // flex column drawn over it, so without the pointer-events pairing the
    // backdrop handler above exists and can never fire — a close route that
    // reads as present in the source and does nothing on screen.
    expect(LIGHTBOX).toContain("pointer-events-none relative z-10");
    const reenabled = LIGHTBOX.match(/pointer-events-auto/g) ?? [];
    expect(reenabled.length, "controls left unclickable by the pairing").toBeGreaterThanOrEqual(5);

    // And the outside-click escape hatch every portalled overlay needs, or the
    // copilot dock dismisses itself behind this one (shell-chrome's rule).
    expect(LIGHTBOX).toContain("data-overlay-root");
  });

  it("still pages and counts", () => {
    expect(LIGHTBOX).toContain('e.key === "ArrowRight"');
    expect(LIGHTBOX).toContain('e.key === "ArrowLeft"');
    expect(LIGHTBOX).toMatch(/\$\{index \+ 1\} \/ \$\{count\}/);
  });
});
