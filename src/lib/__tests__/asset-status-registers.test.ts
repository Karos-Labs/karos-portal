import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

import {
  CLIENT_ASSET_STATUS_LABEL,
  STAFF_ASSET_STATUS_LABEL,
  assetStatusLabel,
  clientAssetStatusLabel,
} from "@/lib/asset-status-copy";
import { ALL_CALENDAR_FILTER_KEYS } from "@/lib/calendar-kind";
import { JOB_STATUS_META } from "@/lib/job-status-copy";
import type { Asset } from "@/lib/types";
import { isStringDelimiter, skipStringLiteral } from "./source-scan";

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

/**
 * The asset-status union, HAND-TYPED — and that is the honest word for it, unlike
 * the two lists further down.
 *
 * `Asset["status"][]` constrains every MEMBER to the union; it does not make the
 * list TOTAL, so tsc would accept this with a status missing. What closes that is
 * not the annotation but the assertion in "names every status the type allows":
 * `Object.keys(CLIENT_ASSET_STATUS_LABEL)` must equal this list, and that register
 * is a `Record<Asset["status"], string>`, which tsc DOES keep total. So a new
 * status added to the type fails there — at the register — and this list is held to
 * it. Transitive, one hop, and worth spelling out rather than calling this derived.
 */
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
 * skipped whole through the one shared primitive, so braces inside them cannot
 * unbalance the scan — including the braces of a `${…}` interpolation, which its
 * own copy of the skip could not see past.
 */
function objectLiterals(src: string): Literal[] {
  const out: Literal[] = [];
  const stack: Array<Literal & { body: string }> = [];

  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;

    // A STRAY delimiter (the skip returns its own index) is not a literal and is
    // not recorded as one — it falls through to the plain character append below,
    // so `<p>Don't</p>` contributes no phantom value and opens no region.
    const closes = isStringDelimiter(ch) ? skipStringLiteral(src, i) : i;
    if (closes > i) {
      const value = src.slice(i + 1, closes);
      for (const frame of stack) frame.strings.push(value);
      if (stack.length > 0) stack[stack.length - 1]!.body += '""';
      i = closes;
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
 * Both operand orders count, `!==` counts, and a chain that wraps onto the next
 * line counts (the window is plain text, and it cannot cross another `?` or
 * another literal, so `a ?? "Fallback"` is not one of these).
 *
 * ALL THREE QUOTES, on both the yield and the comparison. A chain yielding
 * BACKTICKED labels — `s === "failed" ? \`Failed\` : …` — used to escape this sweep
 * entirely, which made the name of the test it backs ("the only asset-status label
 * CHAINS in src/") promise a syntax it never looked at; planted into
 * calendar-past-runs.ts, it was green. The residual limit, stated rather than
 * implied: a yield that is not a LITERAL at all (an identifier, a concatenation, a
 * multi-line template) is not a shape this sweep reads, which is the same bound the
 * object sweep carries and the reason the file docstring above disclaims being an
 * inventory.
 *
 * NO DOMAIN EXEMPTION LIST, unlike the object sweep. A literal map can be
 * recognised as belonging to another key domain by its keys (`placeholder`,
 * `failed` ⇒ `CalendarAssetKind`); a chain has no keys to read. It needs no list
 * either: each domain has one accessor, so a chain over these words is a second
 * answer whichever domain it meant.
 *
 * THE WORD LIST IS THE THREE UNIONS. Every word of `Asset["status"]`, of
 * `JobStatus` and of `CalendarFilterKey` — so a new status in any of the three is
 * covered here without anyone remembering to widen a string, which is what the
 * previous version asked for and could not have got, being a literal.
 *
 * TWO of the three are DERIVED and the third is not, which is a distinction this
 * note used to flatten into "derived and not typed out". `JOB_STATUS_META` is a
 * `Record<JobStatus, …>` and `ALL_CALENDAR_FILTER_KEYS` a total array, both kept
 * total by tsc, so reading their keys IS the union. `ASSET_STATUSES` above is
 * hand-typed and only its MEMBERS are constrained by the type; its totality is
 * held one hop away, by the register-keys assertion further down (see its own
 * note). Same coverage, different mechanism, and saying so is the difference
 * between a guarantee and a slogan.
 *
 * `failed` and `cancelled` used to be OUT, with the hole stated: a chain written
 * entirely in those two words escaped. They are in now. The reason they were out
 * was that adding them turned two legitimate files red, and the reason they can
 * be in is that the sweep no longer asks the question that made those files look
 * guilty. It counted every status-comparing yield in a WHOLE FILE, so two
 * unrelated one-branch ternaries added up to a "vocabulary":
 *  - components/copy-caption-button.tsx — `state === "copied" ? "Copied" :
 *    state === "failed" ? "Press and hold to copy" : "Copy caption"` on one line
 *    and the matching icon chain on the next, over a LOCAL
 *    `"idle" | "copied" | "failed"` button state with no job in sight. Only ONE
 *    link in each chain even mentions a status word, and it is `failed`.
 *  - app/api/agent-service/webhook/route.ts — a `"Job cancelled"` event message
 *    in one statement and `status === "cancelled" ? "cancelled" : status ===
 *    "failed" ? "failed" : "success"` (a translation between two machine
 *    vocabularies, no label in it) in another, far apart in the same file.
 * Neither is a status vocabulary, and a sweep that cries wolf on them teaches the
 * next person to widen an allowlist, which is how a guard dies.
 *
 * SCOPE, and it is the price of the two words. The unit is now ONE STATEMENT (or
 * one `{…}` expression container) rather than a file, which is what the two-link
 * rule below always claimed to be about — "one binary sentence is not a
 * vocabulary" is a statement about one chain. So a vocabulary spelled as SEPARATE
 * statements over the same discriminant no longer accumulates into a flag. If
 * that shape ever turns up, the fix is to group links by the expression being
 * compared rather than to go back to counting per file: `state` and `job.status`
 * are different domains, and the discriminant is what says so.
 */
const STATUS_WORDS = [
  ...new Set<string>([
    ...ASSET_STATUSES,
    ...Object.keys(JOB_STATUS_META),
    ...ALL_CALENDAR_FILTER_KEYS,
  ]),
].join("|");
const COMPARISON = "===|==|!==|!=";
/** Any of the three delimiters, and a window that cannot cross one or a `?`. */
const QUOTE = "[\"'`]";
const NOT_PAST_A_LITERAL = "[^?\"'`]*$";
const TERNARY_YIELDING_LITERAL = /\?\s*(?:(["'])([^"'\n]*)\1|`([^`\n]*)`)/g;
const COMPARED_TO_STATUS = new RegExp(
  `(?:${COMPARISON})\\s*${QUOTE}(?:${STATUS_WORDS})${QUOTE}${NOT_PAST_A_LITERAL}`,
);
const STATUS_COMPARED_TO = new RegExp(
  `${QUOTE}(?:${STATUS_WORDS})${QUOTE}\\s*(?:${COMPARISON})${NOT_PAST_A_LITERAL}`,
);

/**
 * One chain's worth of source: split at `;` and at either brace, which are the
 * boundaries a ternary chain cannot cross.
 *
 * Strings are skipped whole so a `;` or `{` inside one cannot split a chain —
 * BACKTICKS INCLUDED, through the one shared primitive, which its own copy of the
 * skip did not do. Wherever a template literal's TEXT holds an apostrophe (which is
 * ordinary in this repo — see `app/(app)/calendar/calendar-body.tsx`'s "hasn't"
 * lines), the `'` opened a bogus string that ran to the next apostrophe and ate the
 * `;`/`{`/`}` in between. Units MERGED, restoring the per-file accumulation this
 * sweep was rewritten to stop — and with it exactly the false positives that were
 * the stated reason `failed`/`cancelled` had to be left out of the word list. One
 * apostrophe-bearing template above copy-caption-button.tsx's two chains was
 * enough to bring them back; planted, and it did.
 *
 * A template literal is skipped whole, so a chain written INSIDE an interpolation
 * is no longer split out into its own unit at the `${` brace — it now travels with
 * the statement that contains it, which is the same unit its discriminant lives in
 * and so still the right granularity for the two-link rule.
 */
function chainUnits(src: string): string[] {
  const out: string[] = [];
  let cur = "";
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    const closes = isStringDelimiter(ch) ? skipStringLiteral(src, i) : i;
    if (closes > i) {
      cur += src.slice(i, closes + 1);
      i = closes;
      continue;
    }
    if (ch === ";" || ch === "{" || ch === "}") {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out;
}

/** Every label a status-comparing ternary yields in one chain-sized unit. */
function statusTernaryLabels(unit: string): string[] {
  const out: string[] = [];
  for (const m of unit.matchAll(TERNARY_YIELDING_LITERAL)) {
    const before = unit.slice(0, m.index);
    if (COMPARED_TO_STATUS.test(before) || STATUS_COMPARED_TO.test(before)) {
      out.push((m[2] ?? m[3])!);
    }
  }
  return out;
}

/**
 * Is this source a status→label map written as a ternary chain?
 *
 * TWO links IN ONE CHAIN, because one `status === "published" ? "Posted" : "Not
 * posted"` is a binary sentence rather than a vocabulary, and a single yielded
 * word is where legitimate code lives (a class name, a field name, an aria
 * string). And at least one yield has to read as a LABEL: capitalised, and not
 * one of the non-prose tokens the object sweep already knows how to recognise.
 */
function isStatusLabelTernary(src: string): boolean {
  return chainUnits(src).some((unit) => {
    const labels = statusTernaryLabels(unit);
    return labels.length >= 2 && labels.some((l) => /^[A-Z]/.test(l) && !isNonProse(l));
  });
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

  it("takes every word of all three unions", () => {
    // The word list's own teeth. A literal list was the hole: it held eight of the
    // twelve words and nothing made it grow with the unions. Now it is built from
    // the three unions themselves, so this asserts the build ran rather than
    // re-typing what it should contain.
    //
    // Two of the three sources are total by tsc (`JOB_STATUS_META` is a Record over
    // `JobStatus`; `ALL_CALENDAR_FILTER_KEYS` over `CalendarFilterKey`), so looping
    // them here cannot miss a word. `ASSET_STATUSES` is hand-typed, and this loop
    // over it proves only that the list it holds reached the word list — its
    // TOTALITY is the register-keys assertion's job, one describe down.
    const words = new Set(STATUS_WORDS.split("|"));
    for (const w of Object.keys(JOB_STATUS_META)) expect(words, `JobStatus ${w}`).toContain(w);
    for (const w of ALL_CALENDAR_FILTER_KEYS) expect(words, `calendar ${w}`).toContain(w);
    for (const w of ASSET_STATUSES) expect(words, `asset ${w}`).toContain(w);
    // The two that were deliberately out, named so a silent narrowing shows up
    // here rather than as a chain nobody scans.
    expect(words).toContain("failed");
    expect(words).toContain("cancelled");
  });

  it("catches the THIRD domain's chain, including the two words that used to be out", () => {
    // The gap the docstring above used to hide behind "both domains". `JobStatus`
    // has its own accessor (`jobStatusLabel`) and shares "approved"/"delivered"
    // with the asset words, so a run-state vocabulary spelled as a chain is the
    // same defect in a domain this sweep was not scanning.
    const chain = (src: string) => isStatusLabelTernary(src);

    // A planted job-status chain, in the words that were added first.
    expect(
      chain(`const l = j.status === "review" ? "In review" : j.status === "running" ? "Running" : "Queued";`),
    ).toBe(true);
    expect(
      chain(`const l = j.status === "queued" ? "Waiting" : j.status === "approved" ? "Signed off" : "-";`),
    ).toBe(true);

    // THE HOLE THAT WAS STATED: a chain written ENTIRELY in `failed`/`cancelled`
    // used to walk past this sweep, because those two words were not in the list.
    expect(
      chain(`const l = j.status === "failed" ? "Failed" : j.status === "cancelled" ? "Cancelled" : "Running";`),
    ).toBe(true);
    // Including the calendar kind that shares neither list.
    expect(
      chain(`const l = k === "held" ? "Waiting its turn" : k === "placeholder" ? "Nothing planned" : "-";`),
    ).toBe(true);

    // And the two REAL files those two words would have flagged, verbatim in
    // shape. They are spared for their own reasons now, not by a hole in the word
    // list: the button chain has ONE link over a status word (`copied` is not a
    // status in any domain), and the webhook's chain yields machine enum values
    // with no label among them.
    expect(
      chain(`const label = state === "copied" ? "Copied" : state === "failed" ? "Press and hold to copy" : "Copy caption";`),
    ).toBe(false);
    expect(
      chain(`const icon = state === "copied" ? "Check" : state === "failed" ? "TriangleAlert" : "Copy";`),
    ).toBe(false);
    expect(
      chain(`const usageStatus: "success" | "failed" | "cancelled" =
        status === "cancelled" ? "cancelled" : status === "failed" ? "failed" : "success";`),
    ).toBe(false);
    expect(
      chain(`events.push({ at: now, level: "error", message: payload.status === "cancelled" ? "Job cancelled" : \`Job \${payload.status}\` });`),
    ).toBe(false);
    // The two of them TOGETHER in one file, which is what the per-file count used
    // to add up: still no flag, because neither statement is a vocabulary.
    expect(
      chain(`const label = state === "copied" ? "Copied" : state === "failed" ? "Press and hold to copy" : "Copy caption";
        const icon = state === "copied" ? "Check" : state === "failed" ? "TriangleAlert" : "Copy";`),
    ).toBe(false);
  });

  it("catches a chain that yields BACKTICKED labels", () => {
    // The whole quote form that escaped: `TERNARY_YIELDING_LITERAL` read `'` and
    // `"` only, so this shape was invisible to a test named for catching CHAINS.
    // Planted into calendar-past-runs.ts and the suite stayed green.
    const chain = (src: string) => isStatusLabelTernary(src);

    expect(
      chain("const l = s === \"failed\" ? `Failed` : s === \"cancelled\" ? `Cancelled` : `Running`;"),
    ).toBe(true);
    // Mixed delimiters across the links, and the comparison itself backticked.
    expect(chain("const l = s === `published` ? `Posted` : s === \"draft\" ? 'Draft' : \"-\";")).toBe(
      true,
    );

    // And the boundary, so widening the delimiters did not widen the verdict: a
    // backticked class fragment and a backticked field name are still non-prose.
    expect(
      chain("const c = s === \"published\" ? `bg-success/15` : s === \"draft\" ? `bg-warning/15` : ``;"),
    ).toBe(false);
    expect(
      chain(
        "const at = k === \"published\" ? `publishedAt` : k === \"draft\" ? `createdAt` : `scheduledAt`;",
      ),
    ).toBe(false);
  });

  it("keeps one statement one unit when a template literal holds an apostrophe", () => {
    // The regression the backtick-blind unit splitter caused, which is the reason
    // `failed`/`cancelled` could be added to the word list at all. A `'` inside
    // template TEXT opened a bogus string that ran to the next apostrophe, eating
    // the `;` between two statements — so copy-caption-button's two one-link
    // ternaries MERGED into a single unit and read as a two-link vocabulary. The
    // shape is ordinary in this repo, not contrived: calendar-body.tsx writes
    // "hasn't" inside a template literal today.
    const chain = (src: string) => isStatusLabelTernary(src);

    const merged = [
      "const hint = `press and hold if it doesn't copy`;",
      'const label = state === "copied" ? "Copied" : state === "failed" ? "Press and hold to copy" : "Copy caption";',
      'const icon = state === "copied" ? "Check" : state === "failed" ? "TriangleAlert" : "Copy";',
    ].join("\n");
    expect(chain(merged), "two one-link statements accumulated into a vocabulary").toBe(false);

    // Non-vacuity for that negative: the same file with a REAL two-link chain in it
    // still flags, so "false" above is the splitter working and not the sweep
    // having gone blind to everything after the apostrophe.
    expect(
      chain(
        `${merged}\nconst l = j.status === "failed" ? "Failed" : j.status === "cancelled" ? "Cancelled" : "-";`,
      ),
    ).toBe(true);
  });

  it("does not let punctuation inside a backticked label split the chain in half", () => {
    // The half of the backtick fix that ONLY backtick-awareness closes, isolated:
    // the `;` here is TEXT inside a label, and to a splitter that walks into
    // template text it is a statement boundary. Split there, each half holds ONE
    // link, the two-link rule is not met, and a real vocabulary goes unflagged —
    // fail OPEN, in the direction a green tick hides. Bounding the quote skip to
    // its line (the other half of the fix) does nothing for this one.
    const chain = (src: string) => isStatusLabelTernary(src);

    expect(
      chain(
        "const l = j.status === \"failed\" ? `Failed; try again` : j.status === \"cancelled\" ? `Cancelled` : `-`;",
      ),
    ).toBe(true);
    // The brace form of the same thing: prose inside a label, not a block.
    expect(
      chain(
        "const l = j.status === \"failed\" ? `Failed {see logs}` : j.status === \"cancelled\" ? `Cancelled` : `-`;",
      ),
    ).toBe(true);
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
    //
    // AND it is what makes `ASSET_STATUSES` total. Both registers are
    // `Record<Asset["status"], string>`, which tsc will not let be short a key, so
    // the key-equality assertions at the end of this test pin the hand-typed list
    // to the union: add a status to the type and this fails until the list grows.
    // Every scan keyed on `STATUS_KEYS` — the object sweep, the chain sweep's word
    // list — inherits its coverage from here rather than from an annotation.
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
