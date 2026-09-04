import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { isSafeInternalPath } from "@/lib/safe-internal-path";

/**
 * THE OPEN REDIRECT THIS CLOSES (review wave, 2026-09).
 *
 * The transcript page takes "where I came from" off the query string and hands
 * it to a `<Link>` labelled "Back". The test was `from.startsWith("/")`, which
 * reads like "a path on our own site" and admits two strings that are not:
 * `//evil.com` (protocol-relative: the browser resolves it against the current
 * scheme and leaves the portal) and `/\evil.com` (every major engine normalises
 * the backslash to a slash first). A signed-in reader following a "Back" link
 * onto an attacker's page is a phishing hop out of a product that had just
 * authenticated them.
 */
describe("isSafeInternalPath", () => {
  it("accepts an ordinary in-app path, with query and hash", () => {
    expect(isSafeInternalPath("/transcripts")).toBe(true);
    expect(isSafeInternalPath("/clients/abc-123/settings?tab=settings#meetings")).toBe(true);
    expect(isSafeInternalPath("/clients/a_b.c~d/calendar?view=archive&status=draft")).toBe(true);
  });

  it("refuses a protocol-relative URL, however it is spelled", () => {
    expect(isSafeInternalPath("//evil.com")).toBe(false);
    expect(isSafeInternalPath("//evil.com/clients/1/settings")).toBe(false);
    expect(isSafeInternalPath("/\\evil.com")).toBe(false);
    expect(isSafeInternalPath("/\\\\evil.com")).toBe(false);
  });

  it("refuses anything a browser would strip before parsing", () => {
    // A URL parser drops tab, newline and carriage return, so "/<tab>/evil.com"
    // becomes "//evil.com" AFTER a naive check has already passed it.
    expect(isSafeInternalPath("/\t/evil.com")).toBe(false);
    expect(isSafeInternalPath("/\n/evil.com")).toBe(false);
    expect(isSafeInternalPath("/\r/evil.com")).toBe(false);
    expect(isSafeInternalPath("/ /evil.com")).toBe(false);
  });

  it("refuses an absolute URL and anything that is not a path", () => {
    expect(isSafeInternalPath("https://evil.com")).toBe(false);
    expect(isSafeInternalPath("javascript:alert(1)")).toBe(false);
    expect(isSafeInternalPath("evil.com")).toBe(false);
    expect(isSafeInternalPath("")).toBe(false);
    expect(isSafeInternalPath(undefined)).toBe(false);
    expect(isSafeInternalPath(null)).toBe(false);
  });
});

describe("the transcript page's back link uses it", () => {
  it("no longer decides on a bare leading slash", () => {
    const page = readFileSync(
      join(__dirname, "..", "..", "app", "(app)", "transcripts", "[id]", "page.tsx"),
      "utf8",
    );
    expect(page).toContain("isSafeInternalPath(from)");
    expect(page, "the leading-slash check is back").not.toContain('from.startsWith("/")');
  });
});
