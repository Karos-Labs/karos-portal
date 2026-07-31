import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * No source file may contain a literal NUL byte.
 *
 * WHY THIS IS A TEST AND NOT A LINT NOTE. A single 0x00 anywhere in a file makes
 * every standard tool treat the whole file as binary: `file` reports "data",
 * `grep` prints nothing and exits 1 — not an error, just silence — and `git`
 * refuses to diff it. Nothing fails; the file simply stops answering questions.
 *
 * That is expensive here specifically. This campaign's recon is grep-based: every
 * "is this rule written twice", "who else reads this field", "was that the only
 * instance" sweep is a grep over src/. A file grep cannot read is a file that
 * silently drops out of all of them, and it drops out looking clean.
 *
 * It has now happened twice, both times in a brand-new file, both times as a
 * deliberate sentinel:
 *   1. a dedupe key joined its parts with NUL, so the key would be unambiguous;
 *   2. `const INTERPOLATED = "\x00"` in the client-copy tripwire, as the stand-in
 *      that must not be a space.
 * Both were reasonable instincts. The rule is not "never use an unusual code
 * point" — it is WRITE IT AS AN ESCAPE, never as a literal byte. `"\uFFFC"` costs
 * nothing and keeps the file readable; `"\x00"` typed literally costs the file's
 * visibility to every future sweep.
 *
 * `src/lib/seo-geo.ts` is the one pre-existing offender (2 NULs, inherited), and it
 * is allowlisted BY COUNT rather than by path: if it gains a third, or loses one,
 * this test speaks up. Ledger guard zone 12 is about that file, and the reason the
 * hazard is documented at all.
 */

const SRC = join(process.cwd(), "src");

/** Inherited offenders, pinned by count so the number cannot drift unnoticed. */
const KNOWN: Record<string, number> = {
  "lib/seo-geo.ts": 2,
};

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(?:ts|tsx|css|json|md)$/.test(full)) out.push(full);
  }
  return out;
}

describe("every source file stays greppable", () => {
  const files = walk(SRC);

  it("finds the tree at all", () => {
    // Non-vacuity: an empty walk would make the sweep below pass by finding
    // nothing, which is the failure mode this whole test exists to name.
    expect(files.length).toBeGreaterThan(200);
  });

  it("contains no literal NUL byte outside the inherited allowlist", () => {
    const counts: Record<string, number> = {};
    for (const abs of files) {
      const n = readFileSync(abs).filter((b) => b === 0).length;
      if (n > 0) counts[relative(SRC, abs).split("\\").join("/")] = n;
    }
    expect(
      counts,
      "a literal NUL makes this file invisible to grep — write the sentinel as an escape (\\uFFFC), not as a byte",
    ).toEqual(KNOWN);
  });

  it("would notice a new one", () => {
    // The scan's teeth, checked rather than assumed: the same read applied to a
    // buffer that does contain a NUL must see it. If this ever stops working the
    // sweep above reports clean over a tree it cannot actually inspect.
    expect(Buffer.from("const X = \0;").filter((b) => b === 0).length).toBe(1);
    expect(Buffer.from('const X = "\\u0000";').filter((b) => b === 0).length).toBe(0);
  });
});
