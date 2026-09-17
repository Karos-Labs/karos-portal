import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

import { deliverableStamp } from "@/lib/asset-visibility";
import type { Asset } from "@/lib/types";

/**
 * One rule for which instant a deliverable row prints, and one place it lives.
 *
 * `deliverableStamp(asset, viewerIsClient)` already existed, exported and
 * documented ("The stamp a deliverable row prints for this viewer"), and four
 * surfaces re-derived it by hand instead of calling it. Three of the four
 * agreed. The fourth did not: `assets-view` sorted by `updatedAt ?? createdAt`
 * while `AssetCard` prints `relativeTime(asset.createdAt)`, so a deliverable
 * edited today but generated last month sat at the top of the list reading
 * "1 month ago". That is the reported defect — "even the dates are not in
 * order" — and it is what a hand-rolled copy of a rule looks like from the
 * outside.
 *
 * archive-view had already written the reason down in its own comment:
 * "ordering by `createdAt` while printing the delivery time would also leave
 * the tiles visibly out of sequence with their own timestamps". The rule was
 * never in doubt; only its reach was.
 *
 * So the sweep forbids the SHAPE rather than the outcome. A surface asking
 * `viewerIsClient ? clientDeliveryStamp(a) : …` is deciding this for itself,
 * and the next one to do it will pick a fifth instant.
 */

const SRC = join(process.cwd(), "src");

/**
 * Files allowed to write the ternary, each for a stated reason.
 *
 * `asset-visibility.ts` IS the rule — it is what everything else must call.
 * `client-home-overview.tsx` is a real exception rather than an
 * oversight: its staff branch is `updatedAt ?? createdAt`, it SORTS AND PRINTS
 * the same stamp (so nothing there is out of sequence), and its own docstring
 * argues for that choice at length. Aligning it would change the order of a
 * staff member's Home feed, which is a product question and belongs to the
 * open ticket about what that widget is for — not to a refactor. Recorded here
 * rather than left to be rediscovered.
 */
const MAY_DERIVE_IT = new Set(["lib/asset-visibility.ts", "components/client-home-overview.tsx"]);

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(full)) out.push(full);
  }
  return out;
}

const FILES = walk(SRC).filter((f) => !f.includes("__tests__"));

/** Comments stripped, so the docstrings that explain the rule do not trip it. */
function code(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

/** The hand-rolled form: a viewer branch straight onto clientDeliveryStamp. */
const DERIVES_IT = /viewerIsClient\s*\?\s*clientDeliveryStamp\s*\(/;

/**
 * The three stamp fields are set ONLY when a case names them: the rule reads
 * `publishedAt ?? updatedAt ?? createdAt`, so a fixture that helpfully defaults
 * `updatedAt: 0` would answer 0 for every "absent" case and pass for the wrong
 * reason.
 */
function asset(stamps: Pick<Asset, "createdAt"> & Partial<Pick<Asset, "updatedAt" | "publishedAt">>): Asset {
  return {
    id: "a",
    clientId: "c",
    type: "social_post",
    status: "draft",
    title: "t",
    content: "",
    ...stamps,
  } as Asset;
}

describe("which instant a deliverable row prints", () => {
  it("no surface derives it by hand", () => {
    let scanned = 0;
    const offenders: string[] = [];
    for (const file of FILES) {
      const rel = relative(SRC, file);
      scanned += 1;
      if (MAY_DERIVE_IT.has(rel)) continue;
      if (DERIVES_IT.test(code(readFileSync(file, "utf8")))) offenders.push(rel);
    }
    // A sweep over nothing would pass and mean nothing.
    expect(scanned).toBeGreaterThan(100);
    expect(offenders, "call deliverableStamp(asset, viewerIsClient) instead").toEqual([]);
  });

  it("every allowance still exists, so the list cannot rot", () => {
    const all = new Set(FILES.map((f) => relative(SRC, f)));
    for (const allowed of MAY_DERIVE_IT) {
      expect(all.has(allowed), `${allowed} is allowed but no longer exists`).toBe(true);
    }
  });

  it("a staff row is stamped at generation, not at last edit", () => {
    // The exact disagreement that produced the defect: a row edited long after
    // it was generated must not outrank a newer one for a staff viewer, because
    // the card prints the generation instant.
    const oldButEdited = asset({ createdAt: 1_000, updatedAt: 9_999 });
    const newlyMade = asset({ createdAt: 5_000, updatedAt: 5_000 });

    expect(deliverableStamp(oldButEdited, false)).toBe(1_000);
    expect(deliverableStamp(newlyMade, false)).toBe(5_000);
    expect([oldButEdited, newlyMade].sort((a, b) => deliverableStamp(b, false) - deliverableStamp(a, false))[0]).toBe(
      newlyMade,
    );
  });

  it("a client row is stamped when the work reached them", () => {
    expect(deliverableStamp(asset({ createdAt: 1, updatedAt: 2, publishedAt: 3 }), true)).toBe(3);
    expect(deliverableStamp(asset({ createdAt: 1, updatedAt: 2 }), true)).toBe(2);
    expect(deliverableStamp(asset({ createdAt: 1 }), true)).toBe(1);
  });
});
