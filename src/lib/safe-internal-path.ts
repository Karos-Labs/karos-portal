/**
 * Is this URL-ish string safe to hand to a `<Link href>` as a RETURN PATH?
 *
 * Pure and client-safe, because the check has to be the same wherever a route
 * takes "where I came from" off the query string (review wave, 2026-09).
 *
 * The bug this exists to stop: `from.startsWith("/")` reads like "a path on our
 * own site" and is not. `//evil.com` is a protocol-relative URL, so the browser
 * resolves it against the current scheme and navigates OFF the portal, and
 * `/\evil.com` is treated the same way by every major engine, which normalises
 * the backslash to a slash before parsing. Both start with a slash, so both
 * used to sail through as a "Back" link on the transcript page.
 *
 * So: exactly one leading slash, and the character after it may be neither a
 * second slash nor a backslash. Whitespace and control characters are refused
 * outright rather than trimmed, because a browser STRIPS tab, newline and
 * carriage return from a URL before parsing it: "/<tab>/evil.com" would resolve
 * as "//evil.com", and a check that ran on the untouched string would not see
 * it.
 */
export function isSafeInternalPath(value: string | null | undefined): value is string {
  if (!value) return false;
  if (/\s/.test(value)) return false;
  // Below the printable range (and DEL). Compared rather than matched with a
  // regex escape so the guard itself carries no control characters.
  for (const ch of value) {
    if (ch < " " || ch === String.fromCharCode(127)) return false;
  }
  if (value[0] !== "/") return false;
  const second = value[1];
  return second !== "/" && second !== "\\";
}
