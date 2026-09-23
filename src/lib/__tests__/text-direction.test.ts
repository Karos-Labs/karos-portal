import { describe, expect, it } from "vitest";
import { textDirection } from "@/lib/text-direction";

/**
 * The case `dir="auto"` gets wrong, which is the case this product produces.
 *
 * `auto` takes the direction from the first strong character. A Hebrew post
 * that opens with a Latin brand name, product or metric therefore lays out
 * left-to-right — and the audit found Latin words embedded inside Hebrew in
 * six of eleven sampled deliverables, so that is the ordinary shape here.
 */
describe("textDirection", () => {
  it("calls a Hebrew post right-to-left even when it opens with a Latin brand name", () => {
    // The exact failure `dir="auto"` has: the first strong character is `K`.
    expect(textDirection("Karos Labs מציגה את הדוח החדש שלנו על שיווק בינה מלאכותית")).toBe("rtl");
  });

  it("is not swayed by digits or punctuation, which carry no direction", () => {
    // "SEO 30 · GEO readiness 19" is the opening line of every seo-geo report.
    expect(textDirection("30 · 19 — 2026")).toBe("auto");
    expect(textDirection("הציון שלנו הוא 30 · 19 מתוך 100")).toBe("rtl");
  });

  it("leaves an English post that quotes one Hebrew word alone", () => {
    // A majority, not "any RTL character at all".
    expect(textDirection("The Hebrew word for marketing is שיווק, which founders rarely search for.")).toBe("auto");
  });

  it("returns auto rather than ltr, so the browser keeps its own judgement", () => {
    // There is no case where forcing `ltr` beats `auto`: for left-to-right
    // text they behave identically, and `auto` still handles anything this
    // function did not anticipate.
    expect(textDirection("A plain English sentence.")).toBe("auto");
    expect(textDirection("")).toBe("auto");
    expect(textDirection(null)).toBe("auto");
    expect(textDirection(undefined)).toBe("auto");
  });

  it("handles a post that is entirely Hebrew, emoji and hashtags", () => {
    expect(textDirection("שלוש דרכים לשפר את הנוכחות הדיגיטלית 🚀 #שיווק #דיגיטל")).toBe("rtl");
  });

  it("does not count emoji or whitespace as direction", () => {
    expect(textDirection("🚀 🎯 💡")).toBe("auto");
  });
});
