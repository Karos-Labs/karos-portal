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
 * nobody re-reads. So the sweeps below scan for SHAPES rather than naming files,
 * and the pin between them makes changing a staff word a deliberate act.
 *
 * TWO SHAPES, and the second is here because the first was not enough. A
 * status→label map can be written as an object literal, which `objectLiterals`
 * finds — or as a ternary chain, which has no literal and no keys and sailed
 * straight through. That is not hypothetical: a chain ending `: "Placeholder"`
 * is exactly what this campaign deleted from run-calendar's PostCard, so the fix
 * could have been undone in a form this file's own suite could not see. Neither
 * sweep is an inventory of every way to name a status; each one is the shape it
 * says it is.
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

/**
 * The chain form: `s === "published" ? "Live now" : s === "draft" ? "Started" : …`
 *
 * Found by looking at every ternary that YIELDS a string literal and asking
 * whether the test immediately before it compared something to a status word.
 * Both operand orders count; a chain that wraps onto the next line counts (the
 * window is plain text, and `[^?"']*` cannot cross another `?` or another
 * literal, so `a ?? "Fallback"` is not one of these).
 *
 * NO DOMAIN EXEMPTION, unlike the object sweep. A literal map can be recognised
 * as belonging to another key domain by its keys (`placeholder`, `failed` ⇒
 * `CalendarAssetKind`); a chain has no keys to read. It needs none either: each
 * domain has one accessor, so a chain over these words is a second answer
 * whichever domain it meant.
 *
 * THREE DOMAINS, not two. The previous note here said "both domains now have one
 * accessor each" and named `assetStatusLabel` and `postKindLabel`. There is a
 * third with its own live accessor — `jobStatusLabel` / `JOB_STATUS_META` over
 * `JobStatus` — and it overlaps the word list, sharing "approved" and
 * "delivered". A planted job-status chain confined to the words this sweep did
 * not scan escaped it entirely.
 *
 * SCOPE OF THE WORD LIST, established by running the widening rather than
 * reasoning about it. `queued`, `running` and `review` are in: adding them keeps
 * the whole suite green, so they cost nothing and close most of the gap.
 *
 * `failed` and `cancelled` are deliberately OUT, and this is the honest part —
 * they are generic English UI states, not just job statuses, so scanning for them
 * flags code that is doing nothing wrong. Adding both turned two files red:
 *  - components/copy-caption-button.tsx — `state === "copied" ? "Copied" :
 *    state === "failed" ? "Press and hold to copy" : "Copy caption"`, over a
 *    LOCAL `"idle" | "copied" | "failed"` button state with no job in sight;
 *  - app/api/agent-service/webhook/route.ts — `status === "cancelled" ?
 *    "cancelled" : status === "failed" ? "failed" : "success"`, mapping a run
 *    outcome onto the usage-log's own enum, which is a translation between two
 *    machine vocabularies and not a label at all.
 * Both are legitimate. A sweep that cries wolf on them teaches the next person to
 * widen the allowlist, which is how the guard dies.
 *
 * So what this sweep catches is a status-label chain that touches at least one of
 * the words below. A chain written ENTIRELY in `failed`/`cancelled` gets past it.
 * That is a stated hole, not a covered one — if a fourth domain arrives, run the
 * widening before writing the claim.
 */
const STATUS_WORDS = "draft|approved|scheduled|published|delivered|queued|running|review";
const TERNARY_YIELDING_LITERAL = /\?\s*(["'])([^"'\n]*)\1/g;
const COMPARED_TO_STATUS = new RegExp(`(?:===|==)\\s*["'](?:${STATUS_WORDS})["'][^?"']*$`);
const STATUS_COMPARED_TO = new RegExp(`["'](?:${STATUS_WORDS})["']\\s*(?:===|==)[^?"']*$`);

/** Every label a status-comparing ternary yields in this source. */
function statusTernaryLabels(src: string): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(TERNARY_YIELDING_LITERAL)) {
    const before = src.slice(Math.max(0, m.index - 160), m.index);
    if (COMPARED_TO_STATUS.test(before) || STATUS_COMPARED_TO.test(before)) out.push(m[2]!);
  }
  return out;
}

/**
 * Is this source a status→label map written as a ternary chain?
 *
 * TWO links, because one `status === "published" ? "Posted" : "Not posted"` is a
 * binary sentence rather than a vocabulary, and a single yielded word is where
 * legitimate code lives (a class name, a field name, an aria string). And at
 * least one yield has to read as a LABEL: capitalised, and not one of the
 * non-prose tokens the object sweep already knows how to recognise.
 */
function isStatusLabelTernary(src: string): boolean {
  const labels = statusTernaryLabels(src);
  return labels.length >= 2 && labels.some((l) => /^[A-Z]/.test(l) && !isNonProse(l));
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

  it("are also the only asset-status label CHAINS in src/", () => {
    // The companion sweep. A map and a chain are the same defect in two
    // syntaxes, and this one is the syntax the campaign actually had to delete.
    const offenders: string[] = [];
    for (const file of FILES) {
      if (isStatusLabelTernary(code(readFileSync(file, "utf8")))) {
        offenders.push(relative(SRC, file));
      }
    }

    expect(
      offenders,
      "these spell a status vocabulary as a ternary chain; ask an accessor instead",
    ).toEqual([]);
  });

  it("catches the chain shape, and leaves the code that legitimately branches alone", () => {
    // Teeth, checked rather than trusted — and the boundary checked with them,
    // because a sweep broad enough to flag real branching would be deleted by the
    // next person it blocked.
    const chain = (src: string) => isStatusLabelTernary(src);

    // The shape this campaign deleted from run-calendar's PostCard, ending on a
    // fallthrough default.
    expect(
      chain(`const label =
        post.kind === "published" ? "Posted"
        : post.kind === "scheduled" ? "Scheduled post"
        : "Placeholder";`),
    ).toBe(true);
    // One line, and the operands the other way round.
    expect(
      chain(`const l = "published" === s ? "Live now" : "draft" === s ? "In progress" : "-";`),
    ).toBe(true);

    // What must stay legal. A field or key chosen by status — no reader in it.
    expect(
      chain(`const at = kind === "published" ? "publishedAt" : kind === "draft" ? "createdAt" : "scheduledAt";`),
    ).toBe(false);
    // Tones and classes, the same closed set the object sweep recognises.
    expect(
      chain(`const tone = s === "published" ? "success" : s === "draft" ? "warning" : "neutral";`),
    ).toBe(false);
    expect(
      chain(`const c = s === "published" ? "bg-success/15" : s === "draft" ? "bg-warning/15" : "";`),
    ).toBe(false);
    // A single branch is a sentence, not a vocabulary.
    expect(chain(`const l = s === "published" ? "Posted" : label;`)).toBe(false);
    // A nullish fallback is not a ternary at all, however capital its default.
    expect(chain(`const a = x ?? "Untitled"; const b = y ?? "Draft";`)).toBe(false);
    // And the live code that DOES branch on a status: the register lookup itself.
    expect(
      chain(`const register = viewerIsClient ? CLIENT_ASSET_STATUS_LABEL : STAFF_ASSET_STATUS_LABEL;
        if (a.status === "published") return "x";`),
    ).toBe(false);
  });

  it("catches the THIRD domain's chain too, and still spares its generic words", () => {
    // The gap the docstring above used to hide behind "both domains". `JobStatus`
    // has its own accessor (`jobStatusLabel`) and shares "approved"/"delivered"
    // with the asset words, so a run-state vocabulary spelled as a chain is the
    // same defect in a domain this sweep was not scanning.
    const chain = (src: string) => isStatusLabelTernary(src);

    // A planted job-status chain, in the words that were added.
    expect(
      chain(`const l = j.status === "review" ? "In review" : j.status === "running" ? "Running" : "Queued";`),
    ).toBe(true);
    expect(
      chain(`const l = j.status === "queued" ? "Waiting" : j.status === "approved" ? "Signed off" : "-";`),
    ).toBe(true);

    // And the two REAL files that adding "failed"/"cancelled" would have flagged,
    // verbatim in shape. They are why those two words are out; if a later change
    // makes these pass as false, the word list can be widened.
    expect(
      chain(`const label = state === "copied" ? "Copied" : state === "failed" ? "Press and hold to copy" : "Copy caption";`),
    ).toBe(false);
    expect(
      chain(`const usageStatus: "success" | "failed" | "cancelled" =
        status === "cancelled" ? "cancelled" : status === "failed" ? "failed" : "success";`),
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
