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
 * Returns `open` itself when there is no literal there to skip — either the
 * character is not a delimiter at all, or it is a STRAY one (an unpaired
 * apostrophe in JSX text, `<p>Don't</p>`, which is neither a comment nor a
 * literal and so survives comment-stripping). Callers advance past the returned
 * index, so `open` means "treat this as one ordinary character": it both
 * guarantees forward progress and keeps the damage of a stray delimiter to the
 * one character, instead of opening a region that eats source.
 *
 * `'` and `"` therefore END AT A LINE BREAK. A real single- or double-quoted
 * literal cannot contain a raw newline, so this never truncates a legitimate one
 * (a backslash line-continuation is consumed as an escape, below) — and it is
 * the whole reason a stray apostrophe stays bounded.
 *
 * Backticks are the case the copies got wrong, and they cannot be skipped by
 * scanning for the next backtick: a `${…}` interpolation holds CODE, which may
 * contain quotes, braces and further template literals. So the interpolation is
 * brace-matched with this function called back on any literal inside it, and a
 * template literal's own newlines are legal and are not a terminator.
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
