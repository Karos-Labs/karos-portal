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

import { readFileSync } from "node:fs";

/**
 * Read a source file for a sweep, normalizing CRLF to LF first.
 *
 * `.gitattributes` now pins `eol=lf` for `*.ts`/`*.tsx`, so a fresh checkout
 * should never hand a sweep a CRLF file — but `core.autocrlf=true` checkouts
 * that existed before that pin, or any tool that rewrites a file with `\r\n`
 * afterward, still can. A sweep that regex-matches on a literal `\n` (a
 * `;\n`-anchored capture, a planted-string byte-offset comparison) silently
 * stops matching on such a file — not a parse error, just a quietly wrong
 * answer. Every source-sweeping test should read through this rather than a
 * bare `readFileSync(path, "utf8")`.
 */
export function readSource(path: string): string {
  return readFileSync(path, "utf8").replace(/\r\n/g, "\n");
}

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

/**
 * Source with its comments removed, WITHOUT walking into string literals.
 *
 * The naive strip (`.replace(/\/\/.*$/gm, "")`) that nearly every scan in this
 * directory carries its own copy of is the exact hazard named at the top of this
 * file: it truncates any template literal holding a `//` — a URL — at the `//`,
 * DELETING its closing backtick and manufacturing the one stray-backtick shape
 * this module cannot contain. Written here, once, so a caller that needs
 * comment-free text does not have to choose between reading comments as code and
 * corrupting the ranges it then walks.
 *
 * WHAT IT DOES NOT HANDLE, stated because a scan that silently swallows a region
 * and reports green is worse than no scan: a REGEX LITERAL containing a quote
 * (`/['"]/`) is indistinguishable from a string open to this function, and one
 * would open a bogus range that eats to the next matching quote. Callers must
 * therefore keep their own non-vacuity check — plant the shape you are looking
 * for into the very text you scanned and assert it is reported (see
 * intake-save-funnel.test.ts, which does that per file). Line comments become a
 * newline so line numbers and statement boundaries survive; block comments are
 * dropped whole.
 */
export function stripComments(src: string): string {
  let out = "";
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (isStringDelimiter(ch)) {
      const end = skipStringLiteral(src, i);
      out += src.slice(i, end + 1);
      i = end;
      continue;
    }
    if (ch === "/" && src[i + 1] === "/") {
      while (i < src.length && src[i] !== "\n") i++;
      out += "\n";
      continue;
    }
    if (ch === "/" && src[i + 1] === "*") {
      const close = src.indexOf("*/", i + 2);
      i = close === -1 ? src.length : close + 1;
      continue;
    }
    out += ch;
  }
  return out;
}

/**
 * The index of the `}` that closes the `{` at `open`, or -1.
 *
 * The one home for "how far does this block reach", asked by every sweep in this
 * directory that has to know whether a line sits INSIDE something. "Is there an X
 * before Y" is not the question; "is Y inside an X that is still open" is.
 *
 * EVERY string literal is skipped whole — backticks included — through the shared
 * primitive above, so a brace inside one cannot unbalance the walk and an
 * apostrophe inside template TEXT cannot open a bogus region that eats source. It
 * had to become so: the copy this replaces knew `'` and `"` only, and both files
 * the surfaces suite walks with it carry an apostrophe inside a template literal,
 * so its try-guard was already walking corrupted ranges and reporting green.
 *
 * Skipping a template whole hides nothing its callers ask for. None of them
 * enumerates braces; they all ask "is this index still inside that range", and
 * anything they classify inside an interpolation is found by scanning separately.
 */
export function matchingBrace(src: string, open: number): number {
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
  return -1;
}

/**
 * The index of the `)` that closes the `(` at `open`, or -1.
 *
 * The parenthesis sibling of `matchingBrace`, for the scans that need to know how
 * far a CALL reaches rather than how far a block does — "is this expression
 * inside that call's arguments" is the same question as "is this line inside that
 * block", asked of a different delimiter. Shares the one string-literal skip, so
 * a parenthesis inside a literal cannot unbalance it and the stray-delimiter
 * contract above applies here unchanged.
 */
export function matchingParen(src: string, open: number): number {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const ch = src[i]!;
    if (isStringDelimiter(ch)) {
      i = skipStringLiteral(src, i);
      continue;
    }
    if (ch === "(") depth++;
    else if (ch === ")" && --depth === 0) return i;
  }
  return -1;
}

/**
 * The character ranges an `if (!viewerIsClient)` guard governs: its braced block,
 * or — with no braces — the single statement that follows, which ends at the first
 * `;` or line break outside anything it opened. A string literal counts as
 * something it opened, via the shared skip, so the newline inside a multi-line
 * template literal does not end the statement early.
 *
 * THE STATEMENT FORM ONLY. A JSX `{!viewerIsClient && …}` conditional is a
 * different shape and gets its own function below, deliberately not folded in
 * here: widening what counts as a guard WIDENS every exempted range at every
 * caller, and a range that grows makes a leak read as guarded — failing OPEN,
 * which is the direction a green tick hides. Each caller asks for exactly the
 * shapes it means to honour.
 */
export function staffOnlyIfRanges(s: string): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const g of s.matchAll(/if\s*\(\s*!\s*(?:\w+\.)?viewerIsClient\s*\)/g)) {
    let from = g.index! + g[0].length;
    while (from < s.length && /\s/.test(s[from]!)) from++;
    if (s[from] === "{") {
      const close = matchingBrace(s, from);
      if (close > from) out.push([from, close]);
      continue;
    }
    let depth = 0;
    let to = from;
    for (; to < s.length; to++) {
      const ch = s[to]!;
      if (isStringDelimiter(ch)) {
        to = skipStringLiteral(s, to);
        continue;
      }
      if (ch === "(" || ch === "{" || ch === "[") depth++;
      else if (ch === ")" || ch === "}" || ch === "]") depth--;
      else if (depth === 0 && (ch === ";" || ch === "\n")) break;
    }
    out.push([from, to]);
  }
  return out;
}

/**
 * The ranges a JSX short-circuit gate governs — `{!viewerIsClient && <X/>}` and
 * `{isStaff && <X/>}` — from the opening `{` to the brace that closes it.
 *
 * THE SHAPE, NOT A LOCATION, which is what makes this usable as an exemption: it
 * says the guarded thing is inside THIS gate's own braces, so moving the JSX,
 * renaming the component or adding siblings cannot loosen it. Move the render out
 * from between the braces and it stops being exempt, immediately.
 *
 * TWO SPELLINGS, and they are not synonyms — `!viewerIsClient` is a per-render
 * viewer test and `isStaff` a per-page role test. Both are honoured because both
 * are used as this repo's staff gate in JSX (clip-gallery's status badge uses the
 * first; the agent page's Control Room mount uses the second), and both are
 * MECHANICAL: a boolean in a brace with the render inside it, rather than a
 * sentence in a comment claiming a route is staff-only.
 *
 * What this does NOT read is a gate spelled any other way — a ternary, a variable
 * holding the negation, a guard clause returning early. Those are not exempt and
 * will be reported, which is the fail-CLOSED direction.
 */
export function staffOnlyJsxRanges(s: string): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const g of s.matchAll(/\{\s*(?:!\s*(?:\w+\.)?viewerIsClient|(?:\w+\.)?isStaff)\s*&&/g)) {
    const open = g.index!;
    const close = matchingBrace(s, open);
    if (close > open) out.push([open, close]);
  }
  return out;
}

/** Does `at` sit inside a range one of those guards still has open? */
export function insideAnyRange(ranges: Array<[number, number]>, at: number): boolean {
  return ranges.some(([from, to]) => at > from && at < to);
}
