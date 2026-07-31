import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

import {
  CLIENT_ASSET_STATUS_LABEL,
  STAFF_ASSET_STATUS_LABEL,
  assetStatusLabel,
  clientAssetStatusLabel,
} from "@/lib/asset-status-copy";
import type { Asset } from "@/lib/types";

/**
 * Two registers for an asset status, and nowhere else to write a third.
 *
 * There were three maps. archive-view's was the client's, assets-view's was
 * staff's, and client-analytics' STATUS_META was read by BOTH from a single
 * mount — so the "Content by status" chart printed "Published" to the same
 * client whose archive, one tab away, said "Posted". Its own comment already
 * conceded it was "the same class as archive-view's STATUS_LABEL".
 *
 * The count is the thing that has to hold. A third map is not a bug that
 * announces itself: it renders perfectly, in the wrong vocabulary, on a surface
 * nobody re-reads. So the closure below scans for the SHAPE (a literal keyed by
 * asset statuses whose values carry words) rather than naming files, and the
 * pin above it makes changing a staff word a deliberate act.
 */

const SRC = join(process.cwd(), "src");
const HOME = join(SRC, "lib", "asset-status-copy.ts");

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(full)) out.push(full);
  }
  return out;
}

const FILES = walk(SRC).filter((f) => !f.includes("__tests__") && f !== HOME);

/**
 * Source with comments removed. The docstrings that explain this rule quote the
 * very labels it forbids elsewhere — run against raw text, the honest way to
 * keep this green would be deleting the explanations.
 */
function code(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

const ASSET_STATUSES: Asset["status"][] = [
  "draft",
  "approved",
  "scheduled",
  "published",
  "delivered",
];
const STATUS_KEYS = new Set<string>(ASSET_STATUSES);

/**
 * Keys that prove a literal is keyed over something ELSE that happens to share
 * words with the status union — today that is `CalendarPost["kind"]`
 * (run-calendar's POST_CHIP_CLASS / POST_KIND_LABEL), where "placeholder" and
 * "failed" are not statuses at all. A different key domain is a different
 * vocabulary, not a drifted copy of this one — and asset-status-copy.ts's
 * docstring lists the calendar tooltip's "Published" among the words this test
 * does NOT claim, rather than letting the green tick imply it does.
 *
 * Deliberately keyed on the DOMAIN, not on a file path: allowlisting
 * run-calendar.tsx wholesale would have let a real status label map be added to
 * that file, and an unrecognised extra key (`pending: "Pending"`) still trips the
 * scan instead of escaping it.
 */
const OTHER_DOMAIN_KEYS = new Set(["placeholder", "failed"]);

interface Literal {
  /** Keys written at this literal's own level. */
  keys: string[];
  /** Every string inside it, nested included: `{ label: "Draft" }` still counts. */
  strings: string[];
}

/**
 * Every brace-balanced object literal in a source file.
 *
 * Hand-rolled rather than parsed because a tripwire that needs a compiler in the
 * test run is a tripwire someone deletes. Strings and template literals are
 * skipped whole, so braces inside them cannot unbalance the scan.
 */
function objectLiterals(src: string): Literal[] {
  const out: Literal[] = [];
  const stack: Array<Literal & { body: string }> = [];

  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;

    if (ch === '"' || ch === "'" || ch === "`") {
      let j = i + 1;
      while (j < src.length && src[j] !== ch) j += src[j] === "\\" ? 2 : 1;
      const value = src.slice(i + 1, j);
      for (const frame of stack) frame.strings.push(value);
      if (stack.length > 0) stack[stack.length - 1]!.body += '""';
      i = j;
      continue;
    }

    if (ch === "{") {
      stack.push({ keys: [], strings: [], body: "" });
      continue;
    }

    if (ch === "}") {
      const frame = stack.pop();
      if (!frame) continue;
      for (const m of frame.body.matchAll(
        /(?:^|[,;{\n])\s*(?:"([\w-]+)"|'([\w-]+)'|([A-Za-z_$][\w$]*))\s*:/g,
      )) {
        frame.keys.push(m[1] ?? m[2] ?? m[3]!);
      }
      out.push({ keys: frame.keys, strings: frame.strings });
      continue;
    }

    if (stack.length > 0) stack[stack.length - 1]!.body += ch;
  }

  return out;
}

/**
 * Tone words are a closed set, which is what makes a single lowercase value
 * decidable. "warning" is a tone; "live" is a label wearing a tone's clothes.
 */
const TONE_WORDS = new Set([
  "warning",
  "success",
  "info",
  "neutral",
  "danger",
  "error",
  "muted",
  "accent",
  "primary",
  "secondary",
  "default",
]);

/**
 * A value that carries no reader: a tone from the closed set above, a CSS var,
 * a hex colour, or a class fragment (hyphen or slash, never a space).
 */
function isNonProse(s: string): boolean {
  if (s === "") return true;
  if (/^var\(--/.test(s)) return true;
  if (/^#[0-9a-fA-F]{3,8}$/.test(s)) return true;
  if (TONE_WORDS.has(s)) return true;
  return /^[a-z0-9:[\]/_.-]+$/.test(s) && /[-/]/.test(s);
}

/**
 * Is this literal an asset-status→LABEL map?
 *
 * Three or more distinct status keys (two is a coincidence — job statuses share
 * "approved" and "delivered"), no key from another domain, and at least one value
 * that carries a reader.
 *
 * The reader test is INVERTED on purpose: flag unless every value is a
 * recognisable non-prose token. The first version of this scan required a value
 * to start capitalised, and the verify lens broke it by planting
 * `{ draft: "in review", published: "live" }` — a lowercase label map, which is
 * not hypothetical here, because client-home-overview.tsx already renders a
 * lowercase status through CSS `capitalize`. Requiring capitals asks what a
 * label looks like; asking what a tone/colour/class looks like is a closed
 * question, and closed questions are the ones a tripwire can answer.
 */
function isStatusLabelMap(lit: Literal): boolean {
  const statuses = new Set(lit.keys.filter((k) => STATUS_KEYS.has(k)));
  if (statuses.size < 3) return false;
  if (lit.keys.some((k) => OTHER_DOMAIN_KEYS.has(k))) return false;
  if (lit.strings.length === 0) return false;
  return !lit.strings.every(isNonProse);
}

describe("the asset-status registers", () => {
  it("are the only asset-status label maps in src/", () => {
    const offenders: string[] = [];
    for (const file of FILES) {
      for (const lit of objectLiterals(code(readFileSync(file, "utf8")))) {
        if (isStatusLabelMap(lit)) {
          offenders.push(`${relative(SRC, file)} → { ${lit.keys.join(", ")} }`);
        }
      }
    }

    expect(offenders, "these are a fourth vocabulary; import a register instead").toEqual([]);
  });

  it("catches the shape it claims to catch", () => {
    // The scan is the guarantee, so its own teeth are checked here rather than
    // trusted: a tripwire nobody has seen fire is a comment.
    const flagged = (src: string) => objectLiterals(src).some(isStatusLabelMap);

    // The map that was actually there, verbatim in shape.
    expect(
      flagged(`const M: Record<string, { label: string }> = {
        draft: { label: "Draft" },
        scheduled: { label: "Scheduled" },
        published: { label: "Published" },
      };`),
    ).toBe(true);
    // The flat form, and the form that adds a key to slip the "all keys are
    // statuses" test a stricter scan would have used.
    expect(flagged(`const M = { draft: "Draft", approved: "Approved", published: "Posted" };`)).toBe(
      true,
    );
    expect(
      flagged(`const M = { draft: "Draft", approved: "Approved", published: "Posted", pending: "Pending" };`),
    ).toBe(true);

    // What must stay legal: tones, colours, classes, and a map over another key
    // domain.
    expect(
      flagged(`const T = { draft: "warning", approved: "success", published: "success" };`),
    ).toBe(false);
    expect(
      flagged(`const C = { draft: "var(--warning)", scheduled: "var(--info)", published: "var(--success)" };`),
    ).toBe(false);
    expect(
      flagged(`const K = { draft: "Draft", scheduled: "Scheduled post", published: "Published", placeholder: "Placeholder", failed: "Failed to publish" };`),
    ).toBe(false);
    // Tailwind class fragments read as non-prose even though they are lowercase
    // words with punctuation.
    expect(
      flagged(`const S = { draft: "bg-warning/15", scheduled: "bg-info/15", published: "bg-success/15" };`),
    ).toBe(false);
  });

  it("catches a lowercase label map, which the capitalisation heuristic missed", () => {
    // The verify lens broke the first version of this scan with exactly these
    // two literals. Kept as tests rather than as a note, because a heuristic
    // that has been evaded once should carry the evasion in its own suite.
    const flagged = (src: string) => objectLiterals(src).some(isStatusLabelMap);

    // Lowercase prose: a multi-word value can never be a tone, colour or class.
    expect(
      flagged(`const M = { draft: "in review", scheduled: "going out soon", published: "live" };`),
    ).toBe(true);
    // A single lowercase word that is not in the closed tone set is still a
    // label — this is the case a "starts with a capital" rule waved through.
    expect(flagged(`const M = { draft: "drafting", approved: "ready", published: "live" };`)).toBe(
      true,
    );
    // And the boundary: swap those words for real tones and it goes quiet again,
    // so the closed set is doing the work rather than the value's case.
    expect(flagged(`const M = { draft: "warning", approved: "info", published: "success" };`)).toBe(
      false,
    );
  });
});

describe("the staff register", () => {
  it("still reads exactly as assets-view wrote it", () => {
    // Lifting a map is only behaviour-preserving if the words are identical, and
    // "identical" is not something a reviewer can eyeball across a file move.
    // This is the pin: changing a staff word now fails here, which is the point
    // at which it becomes a copy decision someone has to make on purpose.
    expect(STAFF_ASSET_STATUS_LABEL).toEqual({
      draft: "Awaiting review",
      approved: "Approved",
      scheduled: "Scheduled",
      delivered: "Delivered",
      published: "Published",
    });
  });

  it("says 'Awaiting review' where the client register says 'Draft'", () => {
    // The reason two registers exist rather than one: for staff the status names
    // the work they owe, for the client it names where their post is.
    expect(assetStatusLabel("draft", false)).toBe("Awaiting review");
    expect(assetStatusLabel("draft", true)).toBe("Draft");
  });
});

describe("the client register", () => {
  it("says 'Posted', because the client is the one who posts", () => {
    // The correction this module exists for: the analytics chart said
    // "Published" to a client whose archive said "Posted".
    expect(clientAssetStatusLabel("published")).toBe("Posted");
    expect(assetStatusLabel("published", true)).toBe("Posted");
    expect(assetStatusLabel("published", false)).toBe("Published");
  });

  it("names every status the type allows, in both registers", () => {
    // A register with a hole renders the raw Firestore enum on a client's
    // screen — the defect the hold message had, one layer down.
    for (const status of ASSET_STATUSES) {
      for (const viewerIsClient of [true, false]) {
        const label = assetStatusLabel(status, viewerIsClient);
        expect(label, `${status} has no label for ${viewerIsClient ? "client" : "staff"}`).not.toBe(
          status,
        );
        expect(label).toMatch(/^[A-Z]/);
      }
    }
    expect(Object.keys(CLIENT_ASSET_STATUS_LABEL).sort()).toEqual([...ASSET_STATUSES].sort());
    expect(Object.keys(STAFF_ASSET_STATUS_LABEL).sort()).toEqual([...ASSET_STATUSES].sort());
  });

  it("falls back to the stored value for a status the union has never heard of", () => {
    // The analytics chart derives its rows from stored data, so a legacy or
    // hand-written status reaches the label lookup. Better a bare word than an
    // empty bar with no name.
    expect(assetStatusLabel("archived", true)).toBe("archived");
    expect(assetStatusLabel("archived", false)).toBe("archived");
  });
});
