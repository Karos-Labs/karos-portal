/**
 * Which way a piece of agent- or human-written text should be laid out.
 *
 * ## Why this exists when `dir="auto"` is already applied everywhere
 *
 * `dir="auto"` asks the browser to take the direction from the FIRST STRONG
 * CHARACTER. That is right most of the time and wrong in the exact case this
 * codebase produces constantly: a Hebrew post that opens with a Latin brand
 * name, a product, or a metric — `"Karos Labs מציגה..."`, `"SEO 30 · GEO
 * readiness 19"` — resolves to left-to-right and lays the Hebrew out
 * backwards. The audit found Latin words embedded inside Hebrew in six of
 * eleven sampled deliverables, so this is the common shape here, not an edge.
 *
 * So where the caller actually holds the string, it should ask. Where it does
 * not — a child expression, a `dangerouslySetInnerHTML` body — `dir="auto"`
 * remains the right fallback and is strictly better than nothing.
 *
 * ## The rule
 *
 * Count strong right-to-left letters against strong left-to-right ones and let
 * the majority decide. Digits, punctuation, whitespace and emoji are neutral
 * and are not counted at all: `"SEO 30 · GEO readiness 19"` must not be pushed
 * either way by its numbers, and a Hebrew paragraph must not be pulled
 * left-to-right by the four Latin characters in a product name.
 *
 * A majority rather than "any RTL character at all", because an English post
 * quoting one Hebrew word is an English post.
 */

/** Hebrew, Arabic, Syriac, Thaana, N'Ko, Samaritan — the strong RTL blocks, plus the Hebrew/Arabic presentation forms. */
const RTL_LETTER = /[֐-׿؀-ۿ܀-ݏހ-޿߀-߿ࠀ-࠿יִ-﷿ﹰ-﻿]/;

/** Latin, Greek and Cyrillic letters — the strong LTR ones this product actually produces. */
const LTR_LETTER = /[A-Za-zÀ-ɏͰ-ϿЀ-ӿ]/;

/**
 * `"rtl"` when the text is predominantly right-to-left, otherwise `"auto"`.
 *
 * Never `"ltr"`: for left-to-right text `auto` behaves identically and keeps
 * the browser's own judgement for anything this function did not anticipate.
 */
export function textDirection(text: string | null | undefined): "rtl" | "auto" {
  if (!text) return "auto";
  let rtl = 0;
  let ltr = 0;
  for (const ch of text) {
    if (RTL_LETTER.test(ch)) rtl += 1;
    else if (LTR_LETTER.test(ch)) ltr += 1;
  }
  return rtl > ltr ? "rtl" : "auto";
}
