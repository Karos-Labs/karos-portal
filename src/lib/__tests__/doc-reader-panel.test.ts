import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { stripComments } from "./source-scan";

/**
 * THE DOCUMENT READER IS A PANEL, AND THE ONLY DIALOG LEFT IS A REAL ONE.
 *
 * Flow audit 2026-09, R13. Documents went page -> tab -> slide-over -> modal:
 * four levels of disclosure, with the reader failing three of Whitenton's four
 * "use a page, not an overlay" tests outright (its own scrolling, its own table
 * of contents, its own export menu — a second navigation system inside an
 * overlay). And the innermost commit closed BOTH layers, dropping the client on
 * the list with no diff after a billable AI rewrite.
 *
 * Flattening it took three things away that the slide-over had been providing
 * for free, which is the half this file exists for: the correction dialog was a
 * hand-rolled portal with no `role="dialog"`, no focus trap and no scroll lock,
 * and it only got away with that while it was stacked on a layer that locked
 * the body itself. It goes through components/modal.tsx now.
 */

const REPO = join(__dirname, "..", "..", "..");
const read = (rel: string) => readFileSync(join(REPO, rel), "utf8");
const code = (rel: string) => stripComments(read(rel));

const DOCS = "src/components/client-documents.tsx";
const CORRECT = "src/components/correct-info-modal.tsx";
const MODAL = "src/components/modal.tsx";

describe("the reader is a panel on the tab, not an overlay over it", () => {
  it("renders in place of the list, with a named way back", () => {
    const src = code(DOCS);
    expect(src).toMatch(/function DocPanel\(/);
    expect(src, "DocOverlay is back").not.toMatch(/function DocOverlay\(/);
    // Scoped to the reader's own body: RegenerateModal, further down the file,
    // is a dialog and legitimately still portals.
    const at = src.indexOf("function DocPanel(");
    const body = src.slice(at, src.indexOf("function RegenerateModal(", at));
    expect(body, "the reader is still portaled over the page").not.toContain("createPortal");
    expect(body, "the reader still locks the page behind it").not.toContain(
      "document.body.style.overflow",
    );
    expect(read(DOCS)).toContain("All documents");
  });

  it("keeps the document open after a correction and says what was asked for", () => {
    const src = code(DOCS);
    // It used to `setCorrecting(false); onClose();` — both layers, no diff.
    const at = src.indexOf("onSuccess={(correction)");
    expect(at, "the correction no longer reports what it corrected").toBeGreaterThan(-1);
    const body = src.slice(at, at + 400);
    expect(body).toContain("setApplied(");
    expect(body, "success still closes the document").not.toMatch(/onClose\(\)/);
  });

  it("announces the result, which arrives without the reader moving", () => {
    expect(code(DOCS)).toMatch(/\{applied && \([\s\S]{0,120}role="status"/);
  });

  it("re-reads the document from fresh props rather than a snapshot", () => {
    // The panel stays open across the correction, and a correction rewrites the
    // document — so holding the object would leave it rendering the
    // pre-correction copy after router.refresh() delivered the new one.
    const src = code(DOCS);
    expect(src).toMatch(/const \[openDocType, setOpenDocType\]/);
    expect(src).toMatch(/available\.find\(\(i\) => i\.docType === openDocType\)/);
  });

  it("moves focus to the panel's heading on the swap", () => {
    // The pressed row is gone from the DOM, so focus would otherwise fall to
    // <body>: nothing announced, and the next Tab restarts at the top of the
    // page.
    const src = code(DOCS);
    expect(src).toMatch(/headingRef/);
    expect(src).toMatch(/headingRef\.current\?\.focus\(\{ preventScroll: true \}\)/);
  });

  it("keeps its header reachable at any scroll depth", () => {
    // On a phone the panel is the whole screen; a header that scrolls away
    // takes the way back and Correct Info with it.
    expect(code(DOCS)).toMatch(/className="sticky top-0 z-10 flex shrink-0/);
  });
});

describe("the one dialog left is a real dialog", () => {
  it("goes through the shared shell instead of a hand-rolled portal", () => {
    const src = code(CORRECT);
    expect(src).toContain('import { Modal } from "@/components/modal"');
    expect(src).toMatch(/<Modal\b/);
    expect(src, "still portals its own overlay").not.toContain("createPortal");
  });

  it("gets the three things the slide-over used to provide", () => {
    // Asserted on the shell, so this stays true of every dialog that adopts it.
    const shell = code(MODAL);
    expect(shell).toContain('role="dialog"');
    expect(shell).toContain('aria-modal="true"');
    expect(shell).toMatch(/document\.body\.style\.overflow = "hidden"/);
    expect(shell, "no focus trap").toMatch(/e\.key !== "Tab"/);
  });

  it("still refuses to be dismissed mid-charge", () => {
    // The credits are spent and the model call is running: dismissing would
    // only hide the outcome.
    const src = code(CORRECT);
    expect(src).toMatch(/const close = pending \? \(\) => \{\} : onClose;/);
    expect(src).toMatch(/closeOnBackdrop=\{!pending\}/);
  });
});
