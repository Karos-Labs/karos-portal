import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { stripComments } from "./source-scan";

/**
 * BRANDINGMODAL COMMITS TWO HALVES, AND NEITHER OF THEM MAY EAT THE OTHER.
 *
 * Flow audit 2026-09, R14 split one "Save guidelines" into a palette/typography
 * Save and a voice/guidelines Save. Each Save still sends the ENTIRE document:
 * its own half live, the other half taken from `saved`, this dialog's record of
 * what the server holds.
 *
 * NOT BECAUSE FIRESTORE WOULD BLANK THE OTHER HALF (review wave, 2026-09) —
 * the reason first given here was wrong, and a wrong reason is how the wrong
 * thing gets "simplified" later. `updateClient` is `set(data, { merge: true })`
 * and a merge write DEEP-merges maps, so a payload carrying only the voice
 * fields would leave the stored palette exactly where it is. What a half
 * payload WOULD truncate is the two context documents:
 * `saveBrandingGuidelinesAction` rebuilds `branding-guidelines` and
 * `brand-voice` from the payload alone (`brandingToContextDocContent`,
 * `buildBrandVoiceSection`) with no read-merge, so the agents' own copy of the
 * brand would come out missing whichever half was not being saved.
 *
 * That makes `saved` load-bearing, and it is where the split's one real hazard
 * lives — a DATA-LOSS bug the alignment review caught before it shipped:
 *
 *   "Generate with AI" is not a proposal. `generateBrandingAction` ->
 *   `applyBrandingForClient` ends with `updateClient(clientId, {
 *   brandingGuidelines: fullGuidelines })` plus two context-doc upserts, so the
 *   generated tone keywords and guidelines markdown are IN FIRESTORE before the
 *   promise resolves. The first implementation copied only the colours into the
 *   form and never advanced `saved`; the next "Save palette & typography" then
 *   sent the pre-generation voice as its other half, silently reverting a
 *   document the client had just paid a model call for.
 *
 * The second half of the file covers the close path, which had the same shape of
 * defect for the same reason: this dialog is mounted unconditionally by
 * client-context-sections.tsx, so it never unmounts and nothing is ever
 * discarded for it.
 *
 * Source-level: `vitest.config.ts` runs `environment: "node"`, and this
 * component imports server actions. The producer half — that the generator
 * actually reports what it wrote — is a real type/return check below.
 */

const REPO = join(__dirname, "..", "..", "..");
const read = (rel: string) => readFileSync(join(REPO, rel), "utf8");
const code = (rel: string) => stripComments(read(rel));

const MODAL = "src/components/branding-modal.tsx";
const BRANDING = "src/lib/branding.ts";

describe("the generator reports everything it wrote", () => {
  it("persists the whole profile, not just a palette", () => {
    // The premise. If this stops being a write, the modal's handling of it
    // should change too — and this is the line that says so.
    expect(code(BRANDING)).toMatch(/updateClient\(clientId, \{ brandingGuidelines: fullGuidelines \}\)/);
  });

  it("names the voice fields on its result type, so a caller can show them", () => {
    const src = code(BRANDING);
    const type = src.slice(src.indexOf("export type BrandingGenResult"), src.indexOf("};", src.indexOf("export type BrandingGenResult")));
    for (const field of ["fontHeading", "fontBody", "toneKeywords", "guidelines"]) {
      expect(type, `BrandingGenResult hides ${field}, which the run just wrote`).toContain(field);
    }
  });

  it("actually returns them", () => {
    const src = code(BRANDING);
    for (const field of ["fontHeading", "fontBody", "toneKeywords", "guidelines"]) {
      expect(src).toContain(`${field}: fullGuidelines.${field}`);
    }
  });
});

describe("a generation advances what the dialog believes the server holds", () => {
  const generate = () => {
    const src = code(MODAL);
    const at = src.indexOf("async function generateFromWebsite()");
    expect(at, "generateFromWebsite is gone").toBeGreaterThan(-1);
    return src.slice(at, src.indexOf("function addToken()", at));
  };

  it("writes the generated voice into the form AND into `saved`", () => {
    const body = generate();
    // Both, or the next Save of the other half reverts the document.
    expect(body).toMatch(/setForm\(/);
    expect(body, "`saved` is never advanced — the next Save will revert the generated voice").toMatch(
      /setSaved\(/,
    );
    for (const field of ["toneKeywords", "guidelines", "fontHeading", "fontBody"]) {
      const uses = body.split(`result.${field}`).length - 1;
      expect(uses, `result.${field} reaches fewer than both of form and saved`).toBeGreaterThanOrEqual(2);
    }
  });

  it("leaves a field the generator did not return alone rather than blanking it", () => {
    const body = generate();
    for (const field of ["toneKeywords", "guidelines", "fontHeading", "fontBody"]) {
      expect(body, `result.${field} is written unguarded — a generator that omits it would clear it`).toMatch(
        new RegExp(`result\\.${field} \\?\\?`),
      );
    }
  });

  it("does not tell the client their generated profile is unsaved", () => {
    // It is saved. The banner said the opposite, which is how a client closes
    // the dialog believing nothing happened, or edits on top of what they think
    // is a draft.
    // Comments stripped: the note explaining why that sentence was wrong
    // quotes it, and a comment is not what the client reads.
    const src = code(MODAL);
    expect(src, "the banner still claims nothing was saved").not.toContain("Nothing is saved yet");
    expect(src).toContain("This profile is already saved");
  });
});

describe("closing a dialog that never unmounts", () => {
  const requestClose = () => {
    const src = code(MODAL);
    const at = src.indexOf("function requestClose()");
    expect(at, "requestClose is gone").toBeGreaterThan(-1);
    return src.slice(at, src.indexOf("}", src.indexOf("onClose();", at)));
  };

  it("does not fall through on a second Escape", () => {
    // It used to read `if (anyDirty && !confirmDiscard)`, so the second gesture
    // sailed past the question it had just asked and discarded everything.
    const body = requestClose();
    expect(body).toMatch(/if \(anyDirty\) \{/);
    expect(body, "a second close gesture still bypasses the confirm").not.toMatch(
      /anyDirty && !confirmDiscard/,
    );
  });

  it("re-seeds the form on discard, because React will not", () => {
    const src = code(MODAL);
    // The opener renders <BrandingModal open={…}/> unconditionally, so a close
    // is a prop change, not an unmount: without this the discarded edits (and
    // the discard banner) are still there next time the pencil is pressed.
    expect(code("src/components/client-context-sections.tsx")).toMatch(/<BrandingModal\s+open=\{/);
    const at = src.indexOf("function discardAndClose()");
    expect(at, "there is no discard path that resets anything").toBeGreaterThan(-1);
    const body = src.slice(at, src.indexOf("function requestClose()", at));
    for (const setter of ["setColors(", "setForm(", "setConfirmDiscard(false)", "onClose()"]) {
      expect(body, `discardAndClose does not call ${setter}`).toContain(setter);
    }
    // …and the button is wired to it, not to the bare onClose.
    expect(src).toMatch(/onClick=\{discardAndClose\}/);
  });
});
