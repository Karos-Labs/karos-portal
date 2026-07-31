/**
 * "How far does this string literal reach" — the one home for the primitive
 * every source-text tripwire in this directory needs before it can count a
 * brace, split a statement or read an object's keys.
 *
 * NOT A TEST FILE (no `.test.` in the name, so vitest does not collect it), and
 * not reachable by the sweeps that read it: every walker in `src/lib/__tests__`
 * filters `__tests__` out, which is what lets this file spell the delimiters and
 * the words those sweeps forbid.
 *
 * WHY IT EXISTS. Four scans across the two asset-status suites had their own copy
 * of "skip a quoted string so a brace/semicolon inside one cannot unbalance the
 * walk", and three of the four knew about `'` and `"` only. To a backtick-blind
 * scanner an apostrophe inside template TEXT OPENS a string that runs to the next
 * apostrophe — swallowing whatever braces, semicolons and leaks lie between. A
 * scan that silently swallows a region and reports green is worse than no scan, so
 * the rule lives once, here, and every caller asks it.
 *
 * Not an academic gap: the two files those scans actually read both carry one.
 * `app/api/clients/[id]/chat/route.ts` and `components/asset-detail-modal.tsx`
 * each have an apostrophe inside a template literal's text, so both suites were
 * already walking corrupted ranges before this module existed. NO COUNT is given
 * here on purpose — the first draft of this note claimed a file total measured with
 * a scanner that had the very flaw being fixed, and got it wrong by four. Open
 * either file named above instead; that is a claim a reader can check.
 */

/** The three delimiters a JS/TS string literal can open with. */
export function isStringDelimiter(ch: string | undefined): boolean {
  return ch === '"' || ch === "'" || ch === "`";
}

/**
 * The index of the delimiter that CLOSES the string literal opening at `open`.
 *
 * Returns `open` itself when there is no literal here to skip — either the
 * character is not a delimiter at all, or it is a stray one for which no closing
 * partner is found. Callers advance past the returned index, so `open` means
 * "treat this as one ordinary character", which is what guarantees forward
 * progress.
 *
 * WHAT COUNTS AS "NO PARTNER FOUND" DIFFERS BY DELIMITER, so it is stated per
 * delimiter. Not pedantry: the two rules below pull in OPPOSITE directions, and
 * both scans sharing this helper depend on which one they are getting.
 *
 * `'` and `"` — BOUNDED BY THE LINE. A raw newline ends the search and yields
 * `open`. This contract used to claim something stronger — that returning `open`
 * "keeps the damage of a stray delimiter to the one character". It does not,
 * whenever a second copy of that delimiter sits later on the SAME line — and a
 * stray `'` is an everyday thing, because JSX TEXT survives comment-stripping and
 * `<p>Don't</p>` is neither a comment nor a literal. In
 * `<p>Don't stop, it's here</p>` the skip runs from the apostrophe in "Don't" to
 * the one in "it's" and swallows the words between, because from here that pair
 * is indistinguishable from a literal. What does hold is the line, and it is the
 * property the callers need: a bogus range that cannot cross a line cannot
 * swallow anything on a LATER line, so a block's closing brace is only ever at
 * risk from a stray quote sharing its line. A real single- or double-quoted
 * literal cannot contain a raw newline, so the line bound never truncates a
 * legitimate one (a backslash line-continuation is consumed as an escape, below,
 * and is the one way a `'` range crosses a line).
 *
 * `` ` `` — NOT BOUNDED BY THE LINE. A template literal legitimately spans
 * lines, so its newlines are consumed rather than read as a terminator. That is
 * required, not incidental: `staffOnlyRanges` in the surfaces suite ends a
 * brace-less statement at a newline and would cut a multi-line template in half
 * without it — and this tree writes multi-line templates by the page (open
 * `lib/ai/prompts/proactive-assistant.ts` for a file that is mostly them). The
 * cost is the mirror image of the quote rule — A STRAY BACKTICK IS NOT
 * LINE-LOCAL. The search runs to the next backtick outside any interpolation
 * ANYWHERE later in the file and returns that index, yielding `open` only when
 * the rest of the file holds none, so one unpaired backtick can open a bogus
 * range that spans hundreds of lines and eats every brace, `;` and leak inside
 * it. NO CALLER MAY TREAT A BACKTICK RANGE AS LINE-BOUNDED, and this is the one
 * shape whose damage this helper does not contain.
 *
 * STATED HOLE, because the stray backtick is reachable in this repo and not only
 * in theory: a caller that pre-processes source with the naive comment strip
 * (`.replace(/\/\/.*$/gm, "")`, which nearly every source-text scan in this
 * directory carries its own copy of) truncates any template literal holding a
 * `//` — a URL — at the `//`,
 * DELETING its closing backtick and manufacturing exactly this stray. Live
 * example to check rather than a count to trust: `components/li-drafts-review.tsx`
 * returns a `https://www.linkedin.com/feed/...` share link from a template
 * literal, and in the stripped text of that file the line reads `return ` + one
 * unpaired backtick + `https:`. That backtick then takes a LATER template's
 * opening backtick as its closer, which leaves that template's real closer
 * unpaired in turn — so every pairing below the URL is shifted, and the mis-pairing
 * is what a walk built on this helper is really exposed to. Containing it belongs
 * to the strip, not here — a strip that skips string literals cannot produce it —
 * and that is one change across all of the copies, not a change to one caller.
 *
 * Backticks are also the case the four copies got wrong, and they cannot be
 * skipped by scanning for the next backtick from `open`: a `${…}` interpolation
 * holds CODE, which may contain quotes, braces and further template literals. So
 * the interpolation is brace-matched, with this function called back on any
 * literal inside it.
 */
export function skipStringLiteral(src: string, open: number): number {
  const quote = src[open];
  if (!isStringDelimiter(quote)) return open;
  for (let i = open + 1; i < src.length; i++) {
    const ch = src[i]!;
    if (ch === "\\") {
      i++;
      continue;
    }
    if (ch === quote) return i;
    if (quote === "`") {
      if (ch === "$" && src[i + 1] === "{") {
        i = skipInterpolation(src, i + 1);
        continue;
      }
      continue;
    }
    if (ch === "\n") return open;
  }
  return open;
}

/**
 * The index of the `}` closing the `${` whose `{` sits at `open`, or the last
 * index scanned if it never closes.
 *
 * Unterminated returns `src.length - 1` rather than `open`: an interpolation is
 * only ever entered from inside a template literal that already opened, so there
 * is no "treat it as an ordinary character" reading to fall back to, and the
 * caller's loop must not re-enter it.
 */
function skipInterpolation(src: string, open: number): number {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const ch = src[i]!;
    if (isStringDelimiter(ch)) {
      i = skipStringLiteral(src, i);
      continue;
    }
    if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) return i;
  }
  return src.length - 1;
}
