import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ClientAnalyticsStats } from "@/components/client-analytics";
import { ManagedJobProgress } from "@/components/managed-job-progress";
import { CLIENT_ASSET_STATUS_LABEL, STAFF_ASSET_STATUS_LABEL } from "@/lib/asset-status-copy";
import {
  ALL_CALENDAR_FILTER_KEYS,
  calendarFilterKeyMatchable,
  calendarFilterLabel,
  postKindLabel,
  type CalendarAssetKind,
} from "@/lib/calendar-kind";
import { TASK_STATUS_LABEL } from "@/lib/task-status-copy";
import {
  ALL_JOB_BUCKETS,
  jobBucketLabel,
  jobBucketOf,
  jobBucketTone,
  jobInBucket,
  statusesInBucket,
} from "@/lib/job-list-buckets";
import { JOB_STATUS_META, jobStatusLabel, jobStatusMeta } from "@/lib/job-status-copy";
import type { Asset, ClientIntegration, Job, JobStatus } from "@/lib/types";
import {
  insideAnyRange,
  isStringDelimiter,
  skipStringLiteral,
  staffOnlyIfRanges,
  staffOnlyJsxRanges,
  stripComments,
} from "./source-scan";

/**
 * NOBODY MAY PRINT A STORED STATUS. The sweep for it, and the three narrower pins
 * that cover the shapes a sweep over rendered expressions cannot see.
 *
 * WHAT WENT WRONG, because it is what the shapes are chosen from. One published
 * post read three different words on three of a client's own screens: the
 * dashboard's Recent activity row printed the database enum verbatim (CSS
 * `capitalize` turning it into "Published"), the Archive tile said "Posted", the
 * Performance chart said "Published". A delivered-but-unposted item read
 * "Approved" everywhere — so the divergence landed exactly on the state the client
 * is asked to ACT on. The registers already existed. What did not exist was
 * anything that noticed a surface not asking them.
 *
 * FOUR SHAPES, and they are four because the defect was written four ways. Saying
 * so beats one test named as though it caught everything:
 *
 *  1. A raw status RENDERED — `{asset.status}` in JSX text. The sweep below.
 *  2. A second NAME hard-coded for a status a register already names — the
 *     calendar legend's "Pending review" against `JOB_STATUS_META.review`'s "In
 *     review", three lines of scroll apart on one screen.
 *  3. A BUCKET grouping states under a word one of its members contradicts —
 *     "Completed 14" over fourteen rows badged "In review".
 *  4. A client surface publishing the GENERATION RUN rather than their content —
 *     "Agent runs 47 · Last run 6 hours ago", directive A3.
 *
 * Shape 1 is swept from the FILESYSTEM: every `.ts`/`.tsx` under src/, no list of
 * files anywhere in this module. Shapes 2 to 4 are pinned against the modules that
 * own the rules, with their key sets DERIVED from the unions rather than typed out,
 * so a new status or a new filter key is covered without anyone remembering.
 *
 * The register suites are the neighbours, not the overlap:
 * asset-status-registers.test.ts asks whether a second label MAP or CHAIN exists;
 * this file asks whether the maps that do exist are the only thing anyone RENDERS.
 * A file can pass that one and fail this one by printing the enum directly, which
 * is exactly what four files were doing.
 */

const SRC = join(process.cwd(), "src");

/** `relative(SRC, …)`, normalized to forward slashes so literals stay portable. */
function relToSrc(file: string): string {
  return relative(SRC, file).split(sep).join("/");
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(full)) out.push(full);
  }
  return out;
}

const FILES = walk(SRC).filter((f) => !f.includes("__tests__"));

/**
 * Source with comments removed, so the docstrings that explain this rule — which
 * necessarily quote the shapes it forbids — are not themselves offenders.
 *
 * THE STATED HOLE IS CLOSED. This used to be a local
 * `.replace(/\/\/.*$/gm, "")`, and its own note said so at length: `//` is a
 * comment opener to that regex wherever it appears, INCLUDING inside a string, so
 * a template literal holding a URL was truncated at the `//` and lost its closing
 * backtick — the one stray `skipStringLiteral` cannot bound to a line, which
 * mis-pairs every literal below it and lets the brace walks in this file read
 * bogus ranges. Both failure modes were FAIL-OPEN (a swallowed region hides a raw
 * render; an over-long guard range exempts one), which is the direction a green
 * tick hides.
 *
 * `stripComments` skips string literals whole, so it cannot manufacture that. It
 * is the same strip the task-status suite already uses, and this file now shares
 * it rather than carrying the third copy of a rule with a known hole — which
 * matters more since the run-state sweep below is a scan for WORDS, and prose is
 * exactly what a raw-source scan would be satisfied by.
 */
function code(s: string): string {
  return stripComments(s);
}

/* ─────────────────────── shape 1: a raw status, rendered ─────────────────── */

/**
 * The union words, DERIVED from the two registers and the run-state map rather
 * than typed here.
 *
 * `CLIENT_ASSET_STATUS_LABEL` is a `Record<Asset["status"], string>` and
 * `JOB_STATUS_META` a `Record<JobStatus, …>`, both of which tsc keeps total, so
 * reading their keys IS the two unions. A status added to either type reaches this
 * set with nobody editing this file — the property a hand-written list cannot have,
 * and the one this sweep's domain test depends on.
 */
const SANCTIONED_STATUS_WORDS = new Set<string>([
  ...Object.keys(CLIENT_ASSET_STATUS_LABEL),
  ...Object.keys(JOB_STATUS_META),
]);

/**
 * A JSX TEXT interpolation of a bare member expression ending in `.status` or
 * `.jobStatus` — `>{asset.status}<`, `}{run.jobStatus}` and their whitespace
 * variants.
 *
 * TEXT, not props. `<JobStatusBadge status={r.status} />` passes a status to
 * something whose whole job is to look it up, and flagging that would flag the
 * fix. What this asks is whether a stored value becomes CHARACTERS ON A SCREEN
 * without passing through a register — so the interpolation has to be the member
 * expression and nothing else. `{assetStatusLabel(asset.status, viewerIsClient)}`
 * is a call, does not match, and is the shape being required.
 *
 * The leading `[>}]` is what makes it a text position rather than an attribute
 * value: a prop is preceded by `=`. The residual is stated rather than implied — a
 * render written some other way (a variable assigned the status and then
 * interpolated, a template literal, `String(asset.status)`) is not a shape this
 * regex reads. It is the shape all five real offenders were written in, and the
 * shape a reverted fix would land back in.
 */
const RAW_STATUS_RENDER = /[>}]\s*\{\s*([A-Za-z_$][\w$.]*\.(?:status|jobStatus))\s*\}/g;

/**
 * Every string literal this file compares that exact expression to.
 *
 * THE DOMAIN QUESTION, asked of the ARGUMENT rather than of a filename. `.status`
 * is a field on at least eight types in this repo — a Client's is
 * `active|paused|archived`, a lab-import candidate's is `ready|imported|…` — and
 * neither has a register here, so neither is this sweep's business. Guessing by
 * identifier name (`a.status` vs `c.status`) would key the exemption to a variable
 * someone is free to rename; asking what values the expression is TESTED against
 * keys it to what the expression actually holds.
 *
 * Same device as asset-status-registers.test.ts's `OTHER_DOMAIN_KEYS`, which
 * recognises the calendar's chip map by `placeholder`/`failed` being nobody's
 * status. Precedent, not invention.
 */
function comparedLiterals(src: string, expr: string): Set<string> {
  const esc = expr.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const out = new Set<string>();
  for (const m of src.matchAll(new RegExp(`${esc}\\s*[!=]==?\\s*["'\`]([^"'\`]+)["'\`]`, "g"))) {
    out.add(m[1]!);
  }
  for (const m of src.matchAll(new RegExp(`["'\`]([^"'\`]+)["'\`]\\s*[!=]==?\\s*${esc}`, "g"))) {
    out.add(m[1]!);
  }
  return out;
}

/**
 * Is this render in one of the two domains that HAVE a register?
 *
 * FAILS CLOSED on silence. An expression compared to nothing at all is IN scope:
 * that is the case where the file gives no evidence either way, and the safe
 * reading of no evidence is "this might be a deliverable's status". Both of the
 * staff surfaces this sweep first turned red — asset-card's badge and outputs-hub's
 * — were exactly that shape, and both really were asset statuses.
 *
 * Out of scope needs positive evidence in BOTH directions: at least one compared
 * literal that no sanctioned union contains, and none that any of them does.
 */
function inSanctionedDomain(lits: Set<string>): boolean {
  if (lits.size === 0) return true;
  return [...lits].some((l) => SANCTIONED_STATUS_WORDS.has(l));
}

interface Offender {
  file: string;
  line: number;
  expr: string;
}

/**
 * Every unguarded raw status render in src/, and separately the ones ruled another
 * domain — returned rather than asserted so both lists can be checked, including
 * the second one for having stopped being empty of surprises.
 */
function sweep(): { offenders: Offender[]; otherDomain: Offender[]; gated: Offender[] } {
  const offenders: Offender[] = [];
  const otherDomain: Offender[] = [];
  const gated: Offender[] = [];
  for (const file of FILES) {
    const src = code(readFileSync(file, "utf8"));
    if (!/\.status|\.jobStatus/.test(src)) continue;
    // Both mechanical gate shapes, per file, computed once.
    const guards = [...staffOnlyIfRanges(src), ...staffOnlyJsxRanges(src)];
    for (const m of src.matchAll(RAW_STATUS_RENDER)) {
      const expr = m[1]!;
      const at = m.index!;
      const entry = { file: relToSrc(file), line: src.slice(0, at).split("\n").length, expr };
      if (!inSanctionedDomain(comparedLiterals(src, expr))) {
        otherDomain.push(entry);
        continue;
      }
      // The exemption, and the only one: the render sits inside a gate's own
      // braces. Keyed to the ARGUMENT (is this index between them) rather than to
      // a distance, a line number or a folder, so moving the JSX out from between
      // the braces revokes it immediately.
      if (insideAnyRange(guards, at)) {
        gated.push(entry);
        continue;
      }
      offenders.push(entry);
    }
  }
  return { offenders, otherDomain, gated };
}

describe("no surface renders a stored status", () => {
  it("prints no raw asset or run status anywhere in src/", () => {
    const { offenders } = sweep();
    expect(
      offenders.map((o) => `${o.file}:${o.line} → {${o.expr}}`),
      "these print the database enum; ask assetStatusLabel / jobStatusLabel instead",
    ).toEqual([]);
  });

  it("still finds the renders it is judging, so an empty list is not an empty walk", () => {
    // Non-vacuity, and the thing that would silently kill this sweep: a walk that
    // stops matching (a strip change, a regex typo, a moved directory) reports zero
    // offenders and looks like success. So the sweep must still SEE renders — the
    // ones it rules another domain — and the walk must still cover the tree.
    const { otherDomain, gated } = sweep();
    expect(FILES.length, "the walk found almost nothing; src/ moved").toBeGreaterThan(100);
    // ANCHORED ON THE GATED RENDERS, not on `otherDomain`. This used to require
    // `otherDomain.length > 0`, and that list held exactly two entries —
    // clients-grid's `{c.status}` and custom-agents' `{c.status}` — BOTH of which
    // are raw-enum renders someone is likely to route through a label next. The
    // moment either was fixed, this assertion would have failed with "the regex or
    // the strip is broken": a false diagnosis, sending the next reader to debug a
    // scanner that was working perfectly.
    //
    // A gated render is the intended steady state rather than a pending fix — the
    // design is that staff MAY read the raw enum inside a `!viewerIsClient` gate —
    // so it stays true as the offender and other-domain lists empty out. It also
    // proves more: the walk, the regex, the comment strip AND the gate-range
    // machinery all still work, which is the whole pipeline this sweep depends on.
    expect(
      gated.length,
      "the sweep matched no gated status render, so the walk, the regex, the strip or the " +
        "gate-range machinery is broken — this is the liveness check, not a finding",
    ).toBeGreaterThan(0);
    // Kept as a SECOND signal rather than the only one: if both lists empty at
    // once, that is worth a look even though it is a legitimate end state.
    expect(otherDomain.length + gated.length).toBeGreaterThan(0);
  });

  it("records the renders it rules another domain, rather than covering them silently", () => {
    // The exemption's own inventory. These are `.status` fields with no register in
    // this repo, and the point of printing them here is that the list is DERIVED:
    // if one of them ever starts being compared to a sanctioned status word, it
    // moves into the offender list above on its own.
    const { otherDomain } = sweep();
    for (const o of otherDomain) {
      const src = code(readFileSync(join(SRC, o.file), "utf8"));
      const lits = comparedLiterals(src, o.expr);
      expect(lits.size, `${o.file}:${o.line} was exempted with no evidence at all`).toBeGreaterThan(
        0,
      );
      for (const l of lits) {
        expect(
          SANCTIONED_STATUS_WORDS.has(l),
          `${o.file}:${o.line} compares ${o.expr} to "${l}", which IS a sanctioned status`,
        ).toBe(false);
      }
    }
  });

  it("catches the five shapes that were really there, and the reverts of each fix", () => {
    // Teeth, checked rather than trusted. Each string below is a real render this
    // campaign removed, or the revert of one.
    const flagged = (src: string) => {
      const guards = [...staffOnlyIfRanges(src), ...staffOnlyJsxRanges(src)];
      return [...src.matchAll(RAW_STATUS_RENDER)].some(
        (m) =>
          inSanctionedDomain(comparedLiterals(src, m[1]!)) && !insideAnyRange(guards, m.index!),
      );
    };

    // The dashboard's Recent activity badge, verbatim in shape — the one that
    // reached a client through CSS `capitalize`.
    expect(flagged('<Badge tone={TONE[a.status]}>{a.status}</Badge>')).toBe(true);
    // The detail modal's badge: the lowercase enum, on the only deliverable viewer
    // a client can reach.
    expect(flagged("<Badge tone={statusTone(asset.status)}>{asset.status}</Badge>")).toBe(true);
    // Staff's deliverable card and the outputs hub, both unconditional.
    expect(flagged('<Badge tone={statusTone(asset.status)} className="shrink-0">\n{asset.status}\n</Badge>')).toBe(
      true,
    );
    expect(flagged('<Badge tone="neutral" className="capitalize">\n{asset.status}\n</Badge>')).toBe(true);
    // A run state, the other domain this sweep covers.
    expect(flagged("<span>{run.jobStatus}</span>")).toBe(true);

    // And what the fixes look like, so this cannot be satisfied by deleting the
    // badge instead of routing it.
    expect(flagged("<Badge tone={t}>{assetStatusLabel(a.status, viewerIsClient)}</Badge>")).toBe(false);
    expect(flagged("<Badge tone={t}>{assetStatusLabel(asset.status, false)}</Badge>")).toBe(false);
    expect(flagged("<span>{jobStatusLabel(run.jobStatus)}</span>")).toBe(false);
  });

  it("reads a status handed to a component as a prop as the fix it is", () => {
    // The boundary that keeps this sweep usable. Three intake surfaces pass
    // `status={r.status}` to JobStatusBadge, which exists to do the lookup — a
    // sweep that flagged them would be teaching the next person to widen an
    // exemption, which is how a guard dies.
    const flagged = (src: string) =>
      [...src.matchAll(RAW_STATUS_RENDER)].some((m) =>
        inSanctionedDomain(comparedLiterals(src, m[1]!)),
      );

    expect(flagged("<JobStatusBadge status={r.status} />")).toBe(false);
    expect(flagged("<AssetDetailModal asset={a} viewerIsClient={v} />")).toBe(false);
    // A status used as a KEY or in a test, not rendered.
    expect(flagged('const n = assets.filter((a) => a.status === "draft").length;')).toBe(false);
  });

  it("exempts a render inside a JSX staff gate, and revokes it the moment it moves out", () => {
    // The one exemption, both directions — because an exemption only tested in the
    // permissive direction is a hole with a passing test over it.
    const flagged = (src: string) => {
      const guards = [...staffOnlyIfRanges(src), ...staffOnlyJsxRanges(src)];
      return [...src.matchAll(RAW_STATUS_RENDER)].some(
        (m) =>
          inSanctionedDomain(comparedLiterals(src, m[1]!)) && !insideAnyRange(guards, m.index!),
      );
    };

    // clip-gallery's live shape: inside the gate's braces.
    expect(flagged('{!viewerIsClient && <Badge tone="neutral">{asset.status}</Badge>}')).toBe(false);
    // The `isStaff` spelling, which the Control Room mount uses.
    expect(flagged('{isStaff && <Badge tone="neutral">{asset.status}</Badge>}')).toBe(false);
    // MOVED OUT: the gate is still in the file, one line above, and the render is
    // no longer inside it. This is the case a sweep keyed to "is there a guard in
    // this file" would wave through, and the reason the range walk exists.
    expect(
      flagged('{!viewerIsClient && <Badge tone="neutral">ok</Badge>}\n<Badge>{asset.status}</Badge>'),
    ).toBe(true);
    // The INVERTED gate: a client-only branch is not a staff gate, however similar
    // it looks.
    expect(flagged('{viewerIsClient && <Badge tone="neutral">{asset.status}</Badge>}')).toBe(true);
    // A ternary is not one of the two shapes, and is deliberately not exempt.
    expect(flagged("{viewerIsClient ? null : <Badge>{asset.status}</Badge>}")).toBe(true);
  });

  it("leaves another domain's status alone, and stops doing so when it becomes ours", () => {
    // The domain test, both directions, on the two real shapes it spares.
    const inScope = (src: string) =>
      [...src.matchAll(RAW_STATUS_RENDER)].map((m) =>
        inSanctionedDomain(comparedLiterals(src, m[1]!)),
      );

    // A Client's status: `active` is nobody's asset or run state.
    expect(
      inScope('<Badge tone={c.status === "active" ? "neon" : "neutral"}>{c.status}</Badge>'),
    ).toEqual([false]);
    // A lab-import candidate's.
    expect(
      inScope('const r = list.filter((c) => c.status === "ready");\n<Badge>{c.status}</Badge>'),
    ).toEqual([false]);
    // The same expression compared to a REAL status is ours again, even with an
    // other-domain word beside it — the OR is deliberate: one sanctioned word is
    // enough to claim it.
    expect(
      inScope('const r = list.filter((c) => c.status === "ready" || c.status === "delivered");\n<Badge>{c.status}</Badge>'),
    ).toEqual([true]);
    // Silence is ours: no evidence means in scope, which is the fail-closed
    // direction.
    expect(inScope("<Badge>{thing.status}</Badge>")).toEqual([true]);
  });

  it("takes its status words from the unions, so a new state is covered unasked", () => {
    // The word list's own teeth: derived, not typed. Both sources are Records over
    // their unions and tsc keeps them total, so this asserts the derivation ran
    // rather than re-listing what it should contain.
    for (const w of Object.keys(CLIENT_ASSET_STATUS_LABEL)) {
      expect(SANCTIONED_STATUS_WORDS, `asset status ${w}`).toContain(w);
    }
    for (const w of Object.keys(JOB_STATUS_META)) {
      expect(SANCTIONED_STATUS_WORDS, `run state ${w}`).toContain(w);
    }
    // And the staff register keys the same union, so no status has a client word
    // and no staff word.
    expect(Object.keys(STAFF_ASSET_STATUS_LABEL).sort()).toEqual(
      Object.keys(CLIENT_ASSET_STATUS_LABEL).sort(),
    );
  });
});

/* ────────── shape 1b: one fallback for an unrecognised run state ─────────── */

describe("an unrecognised run state has one answer", () => {
  it("is spelled once, so no second `??` over the map can disagree", () => {
    // The defect: THREE sites read `JOB_STATUS_META` with their own `??`. Two
    // agreed on `queued` and the third — the calendar's past-run card — said
    // "Done", so one stored value read two ways. Agreement is what made the
    // duplicate look harmless.
    //
    // Swept by SHAPE over src/, not by naming the three files, because the next
    // copy will be in a fourth.
    const offenders: string[] = [];
    for (const file of FILES) {
      const src = code(readFileSync(file, "utf8"));
      if (!src.includes("JOB_STATUS_META")) continue;
      if (/JOB_STATUS_META\s*\[[^\]]*\]\s*(?:\?\.\w+\s*)?\?\?/.test(src)) {
        offenders.push(relToSrc(file));
      }
    }
    expect(
      offenders,
      "these fall back over the run-state map themselves; ask jobStatusMeta",
    ).toEqual(["lib/job-status-copy.ts"]);
  });

  it("resolves an unknown state the same way for a label and for a badge", () => {
    expect(jobStatusMeta("teleported")).toEqual(JOB_STATUS_META.queued);
    expect(jobStatusLabel("teleported")).toBe(JOB_STATUS_META.queued.label);
    // Non-vacuity: a real state still resolves to itself, so the above is a
    // fallback and not a constant.
    expect(jobStatusLabel("review")).toBe("In review");
  });

  it("keeps the ABSENCE of a run state a different question from an unknown one", () => {
    // A past-run card with no `jobStatus` reads "Done", and that is not a second
    // name for a state: it is the answer when there is nothing to look up. Pinned
    // here so folding it into the register — which would make a fired run read
    // "Queued" — is a deliberate act.
    const cal = code(readFileSync(join(SRC, "components/run-calendar.tsx"), "utf8"));
    expect(cal.replace(/\s+/g, " ")).toContain(
      "run.jobStatus ? jobStatusMeta(run.jobStatus) : NO_RUN_STATUS",
    );
    expect(Object.values(JOB_STATUS_META).map((m) => m.label)).not.toContain("Done");
  });
});

/* ──────── shape 1c: a SECOND vocabulary for the run states, anywhere ─────── */

/**
 * The words that belong to the RUN-STATE register and to nothing else — derived
 * by subtracting every other sanctioned register's words from its own.
 *
 * WHY SUBTRACT. The subtraction is over rendered VALUES, so a word another
 * register also produces drops out however it got there: "Approved" and
 * "Delivered" are the asset register's too, "Failed" is the calendar legend's,
 * and "In review" is the calendar's `review` label — which is that word only
 * because the entry CALLS `jobStatusLabel`, but a scan over text cannot tell a
 * call from a copy once the label exists. A file spelling one of those has not
 * necessarily said anything about a run. What is left is spoken by the run
 * register alone, so a file writing TWO of them is naming run states in its own
 * words — which is the shape, not the instance.
 *
 * DERIVED, not typed: every list below is read off a `Record` tsc keeps total or
 * off an accessor, so renaming any register's word moves this set on its own. The
 * price of the subtraction is stated rather than hidden — a second vocabulary
 * written ENTIRELY in shared words ("Approved"/"Delivered"/"Failed") is not a
 * shape this reads, and neither is one that invents words sharing none of the
 * register's. The behavioural pin below covers the surface this was found on;
 * this covers the next file.
 */
const OTHER_REGISTER_WORDS = new Set<string>([
  ...Object.values(CLIENT_ASSET_STATUS_LABEL),
  ...Object.values(STAFF_ASSET_STATUS_LABEL),
  ...Object.values(TASK_STATUS_LABEL),
  ...ALL_CALENDAR_FILTER_KEYS.flatMap((k) => [
    calendarFilterLabel(k, true),
    calendarFilterLabel(k, false),
  ]),
  // `postKindLabel` is typed over `CalendarAssetKind`, not the wider
  // `CalendarFilterKey` — "review" (a JobStatus) and "suggested" (a Task-Map
  // proposal, 2026-08) are both filter keys with no asset status behind them,
  // so both are excluded here rather than cast through with `as`.
  ...ALL_CALENDAR_FILTER_KEYS.filter(
    (k): k is CalendarAssetKind => k !== "review" && k !== "suggested",
  ).flatMap((k) => [postKindLabel(k, true), postKindLabel(k, false)]),
]);

const RUN_STATE_ONLY_WORDS = Object.values(JOB_STATUS_META)
  .map((m) => m.label)
  .filter((w) => !OTHER_REGISTER_WORDS.has(w));

/**
 * Does this source spell that word as a rendered string — a literal in any of the
 * three quotes, or JSX text between tags?
 *
 * WHOLE VALUE, not a substring: `"Running"` is asked with its quotes so
 * `"Running Agent"` (a real removed label, in the task domain) is not counted as
 * this word, and `>Cancelled<` is anchored on both tags so a longer sentence
 * containing it is not either. A prefix match here would be the campaign's own
 * `toContain`-on-a-prefix trap, and this scan exists to be trusted.
 */
function spellsWord(src: string, word: string): boolean {
  const esc = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(["'\`])${esc}\\1|>\\s*${esc}\\s*<`).test(src);
}

/**
 * TWO is a vocabulary; one is a coincidence of English.
 *
 * The threshold lives here rather than inline at the sweep so the planted
 * before/after texts below run through the SAME rule the repo walk does —
 * otherwise raising it to three would leave every plant green while the real
 * sweep stopped catching the defect it was written for.
 */
function isSecondVocabulary(words: string[]): boolean {
  return words.length >= 2;
}

/** Files, and how many run-state-only words each one spells for itself. */
function runStateSpellers(): Array<{ file: string; words: string[] }> {
  const out: Array<{ file: string; words: string[] }> = [];
  for (const file of FILES) {
    if (file === join(SRC, "lib", "job-status-copy.ts")) continue;
    const src = code(readFileSync(file, "utf8"));
    const words = RUN_STATE_ONLY_WORDS.filter((w) => spellsWord(src, w));
    if (words.length > 0) out.push({ file: relToSrc(file), words });
  }
  return out;
}

describe("nobody writes a second vocabulary for the run states", () => {
  it("finds no file outside the register spelling two of its own words", () => {
    // THE DEFECT. components/managed-job-progress.tsx keyed a three-step strip by
    // JobStatus and wrote its own words for them — "Queued / Agent working /
    // Ready for review" against the register's "Queued / Running / In review",
    // plus "Run failed" for `failed`. It is mounted on a client's agent page by
    // legacy-agent-panel, a scroll away from the same run's JobStatusBadge, so
    // one run state read two ways on one screen.
    //
    // Swept by SHAPE, because the finding named one file and the question is
    // which OTHER file is doing it.
    const offenders = runStateSpellers().filter((f) => isSecondVocabulary(f.words));
    expect(
      offenders.map((o) => `${o.file} → ${o.words.join(", ")}`),
      "these name run states in their own words; ask jobStatusLabel",
    ).toEqual([]);
  });

  it("is still looking at something, and at words it derived", () => {
    // Non-vacuity in both halves, because this sweep's green is otherwise
    // indistinguishable from a subtraction that emptied the word list or a walk
    // that stopped matching.
    expect(
      RUN_STATE_ONLY_WORDS.length,
      "every run-state word is now shared with another register — the subtraction ate the sweep",
    ).toBeGreaterThan(1);
    // Derived, not typed: these come off JOB_STATUS_META, so this asserts the
    // derivation ran rather than re-listing what it produced.
    for (const w of RUN_STATE_ONLY_WORDS) {
      expect(Object.values(JOB_STATUS_META).map((m) => m.label)).toContain(w);
      expect(OTHER_REGISTER_WORDS.has(w)).toBe(false);
    }
    // And the walk still SEES files spelling exactly one — the steady state, not
    // a pending fix: lib/agent-detail-sections.ts says "Running" of a SCHEDULE
    // and lib/job-error-taxonomy.ts says "Cancelled" of a failure reason, neither
    // of which is a run state. One word is a coincidence; two is a vocabulary.
    expect(
      runStateSpellers().length,
      "the sweep matched nothing at all, so the walk, the strip or the word scan is broken",
    ).toBeGreaterThan(0);
  });

  it("catches the strip that was really there, and passes the strip that replaced it", () => {
    // Teeth, planted rather than trusted — both directions, and through the SAME
    // scanner AND the same threshold the repo walk uses.
    const words = (src: string) => RUN_STATE_ONLY_WORDS.filter((w) => spellsWord(code(src), w));
    const flagged = (src: string) => isSecondVocabulary(words(src));

    // The pre-fix STEPS table, verbatim in shape.
    expect(
      flagged(`const STEPS = [
        { key: "queued", label: "Queued", icon: "Clock" },
        { key: "running", label: "Agent working", icon: "Bot" },
        { key: "review", label: "Ready for review", icon: "CircleCheckBig" },
      ] as const;
      const out = failedHere ? "Run failed" : cancelledHere ? "Cancelled" : step.label;`),
    ).toBe(true);

    // The shipped shape: states as keys, words from the register.
    expect(
      flagged(`const STEPS = [
        { key: "queued", icon: "Clock" },
        { key: "running", icon: "Bot" },
        { key: "review", icon: "CircleCheckBig" },
      ] as const;
      const out = failedHere ? jobStatusLabel("failed") : jobStatusLabel(step.key);`),
    ).toBe(false);

    // A keyed map, the other form the same defect is written in.
    expect(
      flagged(`const M = { queued: "Queued", running: "Running", cancelled: "Cancelled" };`),
    ).toBe(true);
    // And JSX text, which a scan for quoted literals alone would miss.
    expect(flagged(`<p>Queued</p><p>Running</p>`)).toBe(true);

    // PROSE MUST NOT SATISFY IT — the trap this campaign keeps paying for. The
    // same two words in a comment are not a vocabulary, and `code()` is what makes
    // that true.
    expect(flagged(`// the register says "Queued" and "Running"\n/* and "Cancelled" */`)).toBe(
      false,
    );
    // Nor is a LONGER string that merely contains one: whole value, not prefix.
    expect(flagged(`const s = "Running Agent"; const t = "Queued up soon";`)).toBe(false);
    // Nor is ONE word on its own, which is the near-miss two real files sit at.
    expect(flagged(`const s = args.schedule.active ? "Running" : "Paused";`)).toBe(false);
  });
});

/* ── shape 1d: the progress strip, asked of what it actually renders ──────── */

describe("the managed-run progress strip", () => {
  /** Every word the strip paints, in order — its three step captions. */
  function captions(status: JobStatus): string[] {
    const html = renderToStaticMarkup(createElement(ManagedJobProgress, { status }));
    return [...html.matchAll(/<p[^>]*>([^<]*)<\/p>/g)].map((m) => m[1]!.trim());
  }

  it("paints no word that is not the register's, in any run state", () => {
    // BEHAVIOURAL, and total over the union — the half a source sweep cannot give
    // you. The strip renders exactly three captions, so "every caption is a
    // register word" is a closed question about this component rather than a
    // sample of it, and it holds for an invented word that shares nothing with
    // the register (which the text sweep above cannot see).
    const sanctioned = new Set(Object.values(JOB_STATUS_META).map((m) => m.label));
    for (const status of Object.keys(JOB_STATUS_META) as JobStatus[]) {
      const painted = captions(status);
      expect(painted.length, `${status} did not render three steps`).toBe(3);
      for (const word of painted) {
        expect(sanctioned, `${status} paints "${word}", which no run state is called`).toContain(
          word,
        );
      }
    }
  });

  it("still says which state it is in, and marks the two that end a run", () => {
    // RULE 6: the words came from the register, and the strip must not have lost
    // what it was saying. The ladder is unchanged…
    expect(captions("queued")).toEqual([
      jobStatusLabel("queued"),
      jobStatusLabel("running"),
      jobStatusLabel("review"),
    ]);
    // …and the two outcome states still REPLACE the caption of the step they
    // stopped on (the working step, which is index 1), rather than being dropped.
    expect(captions("failed")[1]).toBe(jobStatusLabel("failed"));
    expect(captions("cancelled")[1]).toBe(jobStatusLabel("cancelled"));
    // Neighbouring case for those two: the steps around them are untouched, so
    // the outcome is a substitution and not a whole-strip takeover.
    expect(captions("failed")[0]).toBe(jobStatusLabel("queued"));
    expect(captions("cancelled")[2]).toBe(jobStatusLabel("review"));
    // And the four words it used to invent are gone by name, so a revert is
    // caught here too rather than only by the shape sweep.
    const everyWord = (Object.keys(JOB_STATUS_META) as JobStatus[]).flatMap(captions);
    for (const gone of ["Agent working", "Ready for review", "Run failed"]) {
      expect(everyWord, `"${gone}" is back`).not.toContain(gone);
    }
  });
});

/* ────────── shape 2: a second name hard-coded for a named status ─────────── */

describe("the calendar legend names no state twice", () => {
  it("takes every key that is also a run state from the run-state register", () => {
    // DERIVED, and this is the whole assertion: intersect the filter keys with the
    // JobStatus union and require the legend's word to be that union's word. The
    // finding was `review` — the legend said "Pending review" while the run card
    // below it said "In review", one state and two names on one screen. A new
    // filter key that collides with a run state is covered without this test being
    // edited.
    const shared = ALL_CALENDAR_FILTER_KEYS.filter((k) =>
      Object.hasOwn(JOB_STATUS_META, k),
    );
    expect(shared, "no filter key is a run state any more — check this is intended").not.toEqual([]);
    for (const key of shared) {
      for (const viewerIsClient of [true, false]) {
        expect(
          calendarFilterLabel(key, viewerIsClient),
          `legend key "${key}" invents a word for a run state`,
        ).toBe(jobStatusLabel(key as JobStatus));
      }
    }
  });

  it("gives a viewer-dependent word only where the asset register is the question", () => {
    // THE CONSOLIDATION IS NOT TRUE AT EVERY SITE, and this is the test that says
    // so instead of forcing it. Three filter keys are also asset statuses —
    // `published`, `scheduled`, `draft` — and only ONE of them is asking the
    // register's question:
    //
    //  • `published` is. It names the same fact the tile and the modal name, so a
    //    client reads "Posted" here exactly as they do there. Viewer-dependent, and
    //    routed.
    //  • `scheduled` agrees with the register by coincidence of English ("Scheduled"
    //    in all three), so nothing distinguishes routing it from not.
    //  • `draft` does NOT. The register's staff word is "Awaiting review" — the name
    //    of WORK STAFF OWE on a deliverable — and this legend is naming a CHIP ON A
    //    DATE GRID: a draft-status asset that carries a `scheduledAt`. "Show
    //    awaiting review items" is not what that filter does. It stays the
    //    calendar's own word ("Draft") for both viewers — reachable for a client
    //    now that the calendar/dashboard draft-hiding rule was reversed, but still
    //    never the register's staff word.
    //
    // So the closed question is not "does every shared key match the register" but
    // "does any key have a viewer-dependent word that the register did not give it".
    // A third answer for one viewer is the defect; a calendar word of its own is not.
    for (const key of ALL_CALENDAR_FILTER_KEYS) {
      const forClient = calendarFilterLabel(key, true);
      const forStaff = calendarFilterLabel(key, false);
      if (forClient === forStaff) continue;
      expect(
        Object.hasOwn(CLIENT_ASSET_STATUS_LABEL, key),
        `legend key "${key}" differs by viewer but is not an asset status`,
      ).toBe(true);
      expect(forClient).toBe(CLIENT_ASSET_STATUS_LABEL[key as Asset["status"]]);
      expect(forStaff).toBe(STAFF_ASSET_STATUS_LABEL[key as Asset["status"]]);
    }
    // Non-vacuity: one key really is viewer-dependent, so the loop above has a body
    // that runs. If `published` ever stops differing, the register changed and this
    // suite should be re-read rather than quietly passing.
    expect(calendarFilterLabel("published", true)).not.toBe(
      calendarFilterLabel("published", false),
    );
  });

  it("pins the one deliberate divergence, so it cannot change unnoticed", () => {
    // `draft` is the exception the test above explains. Pinned by value: turning the
    // legend's word into the register's — or the register's into the legend's — is a
    // copy decision someone has to make on purpose, not a drift.
    expect(calendarFilterLabel("draft", false)).toBe("Draft");
    expect(STAFF_ASSET_STATUS_LABEL.draft).toBe("Awaiting review");
    // The divergence is reachable for a client too now — the calendar/dashboard
    // draft-hiding rule was deliberately reversed (see `isClientCalendarStatus`'s
    // docstring), so a client's own legend uses "Draft" the same as staff's does
    // (the words already agreed; only reachability changed).
    expect(calendarFilterKeyMatchable("draft", true)).toBe(true);
    expect(calendarFilterKeyMatchable("draft", false)).toBe(true);
  });

  it("names every key, and says something for each", () => {
    // Totality where the words now live. The map is a Record over the union so tsc
    // keeps it total; this checks the accessor actually returns each entry rather
    // than falling through for some key.
    for (const key of ALL_CALENDAR_FILTER_KEYS) {
      for (const viewerIsClient of [true, false]) {
        const label = calendarFilterLabel(key, viewerIsClient);
        expect(label, `legend key "${key}" has no word`).toBeTruthy();
        expect(label, `legend key "${key}" prints its own enum`).not.toBe(key);
        expect(label).toMatch(/^[A-Z]/);
      }
    }
  });

  it("keeps the viewer override in one place", () => {
    // The other half of the finding: `published`'s per-viewer word was written both
    // in the label module and again at the render site as a ternary. One rule, two
    // spellings, both live. Swept by shape so the next copy is caught too.
    const offenders = FILES.filter((f) => {
      const src = code(readFileSync(f, "utf8")).replace(/\s+/g, " ");
      return /key === "published" \? assetStatusLabel/.test(src);
    }).map((f) => relToSrc(f));
    expect(offenders, "the published override belongs to calendarFilterLabel").toEqual([]);
  });
});

/* ──────────────── shape 3: a bucket that contradicts its members ─────────── */

describe("the jobs list's summary buckets", () => {
  it("places every run state, so none can silently land in the wrong chip", () => {
    // The tripwire, and the reason the Set became a Record. A `Set<JobStatus>`
    // named COMPLETED_STATUSES said nothing about the states it left out, which is
    // how `review` was dropped into the only bucket that had room. Keyed over the
    // union, every state has to be placed by hand and a new one is a compile error.
    //
    // Derived from JOB_STATUS_META's keys, which tsc keeps total over JobStatus.
    for (const status of Object.keys(JOB_STATUS_META) as JobStatus[]) {
      const bucket = jobBucketOf(status);
      const buckets = ALL_JOB_BUCKETS.filter((b) => jobInBucket(status, b));
      // At most one bucket, ever: a state counted twice inflates two chips.
      expect(buckets.length, `${status} is in ${buckets.length} buckets`).toBeLessThanOrEqual(1);
      if (bucket === null) {
        expect(buckets, `${status} maps to no bucket but matches one`).toEqual([]);
      } else {
        expect(buckets, `${status} maps to ${bucket} but matches ${buckets.join()}`).toEqual([
          bucket,
        ]);
      }
    }
  });

  it("does not count a state under review as completed", () => {
    // The finding itself, stated as the behaviour rather than as the code: a staff
    // member reading "Completed 14" to decide whether the review queue is clear was
    // being told the opposite of the truth.
    expect(jobBucketOf("review")).toBe("review");
    expect(jobInBucket("review", "completed")).toBe(false);
    expect(statusesInBucket("completed").sort()).toEqual(["approved", "delivered"]);
    expect(statusesInBucket("review")).toEqual(["review"]);
  });

  it("names a single-state bucket with that state's own word", () => {
    // Shape 2 again, in the place it would next be written. A bucket holding one
    // state must not invent a second name for it — which is exactly what the
    // calendar legend did.
    for (const bucket of ALL_JOB_BUCKETS) {
      const only = statusesInBucket(bucket);
      if (only.length === 1) {
        expect(jobBucketLabel(bucket), `bucket "${bucket}" renames ${only[0]}`).toBe(
          jobStatusLabel(only[0]!),
        );
      }
    }
    // Non-vacuity: at least one bucket IS single-state, so the loop above has a
    // body to run. Two are today (review, failed).
    expect(ALL_JOB_BUCKETS.filter((b) => statusesInBucket(b).length === 1)).not.toEqual([]);
    expect(jobBucketLabel("review")).toBe("In review");
  });

  it("gives a composite bucket a word that is no single state's name", () => {
    // The other direction: "Active" and "Completed" cover two states each, so they
    // must not be confusable with any one state's label — otherwise a chip reads
    // like a status filter and counts more than it says.
    const stateLabels = new Set(Object.values(JOB_STATUS_META).map((m) => m.label));
    for (const bucket of ALL_JOB_BUCKETS) {
      if (statusesInBucket(bucket).length > 1) {
        expect(stateLabels, `bucket "${bucket}" is named after one state`).not.toContain(
          jobBucketLabel(bucket),
        );
      }
    }
  });

  it("tones a single-state chip the way that state's own badge is toned", () => {
    for (const bucket of ALL_JOB_BUCKETS) {
      const only = statusesInBucket(bucket);
      if (only.length === 1 && jobStatusMeta(only[0]!).tone !== "neutral") {
        expect(jobBucketTone(bucket)).toBe(jobStatusMeta(only[0]!).tone);
      }
    }
    expect(jobBucketTone("review")).toBe("warning");
  });

  it("is what the list itself renders, rather than a second copy of the grouping", () => {
    // A pure module nobody imports is a comment. The three sites that had to agree
    // and did not — the chip's WORD, the chip's COUNT and the list's FILTER — are
    // each pinned at the call, not by asking whether the module's name appears
    // somewhere in the file.
    //
    // THAT WEAKER FORM WAS WRITTEN FIRST AND WAS TESTED AND FOUND USELESS: it read
    // `expect(list).toContain("jobBucketLabel")`, and an import line satisfies that
    // for ever. Replanting the exact defect — `label={"Completed"}` at the chip, and
    // `["review","approved","delivered"].includes(job.status)` back in the filter —
    // left it green both times. Substring-anywhere is not a closed question; the
    // call is.
    const list = code(readFileSync(join(SRC, "components/jobs-list.tsx"), "utf8")).replace(
      /\s+/g,
      " ",
    );
    // The word.
    expect(list, "the chip's label is not the module's").toContain("label={jobBucketLabel(bucket)}");
    // The filter…
    expect(list, "the filter groups statuses itself").toContain(
      "jobInBucket(job.status, filter as JobBucket)",
    );
    // …and the count, off the same predicate, which is what makes a chip's number
    // and the rows behind it the same question.
    expect(list, "the count groups statuses itself").toContain(
      "jobInBucket(job.status, bucket)",
    );
    // And no revival of the Set this replaced.
    expect(list).not.toContain("COMPLETED_STATUSES");
    // The dropdown beside the chips reads the register too, rather than the raw
    // enum it used to print or a hand-typed copy of the union.
    expect(list).toContain("Object.keys(JOB_STATUS_META) as JobStatus[]");
    expect(list).toContain("{jobStatusLabel(value)}");
  });

  it("does not try to police status GROUPINGS repo-wide, and says why", () => {
    // SCOPE, stated rather than implied. The obvious generalisation of the test
    // above — sweep src/ for any literal grouping two or more status words — was
    // measured before being rejected: seventeen files write one, and almost all are
    // legitimate (Firestore query filters in lib/data.ts, the three agent-context
    // builders, the MCP tool schemas, archive-view's and assets-view's filter
    // orders). A sweep that flags those teaches the next person to widen an
    // allowlist, which is how a guard dies — the same argument
    // asset-status-registers.test.ts makes about its own two spared files.
    //
    // So the grouping rule is pinned at ONE surface, the one where a wrong grouping
    // is read as a number by a human making a decision. This test exists to keep
    // that limit visible: it asserts the groupings really are widespread, so nobody
    // later reads the narrow pin as a repo-wide guarantee.
    const grouped = FILES.filter((f) => {
      const src = code(readFileSync(f, "utf8"));
      return [...src.matchAll(/\[\s*("[a-z_]+"(?:\s*,\s*"[a-z_]+")+)\s*,?\s*\]/g)].some((m) => {
        const items = m[1]!.split(",").map((x) => x.trim().replace(/"/g, ""));
        return items.filter((i) => SANCTIONED_STATUS_WORDS.has(i)).length >= 2;
      });
    });
    expect(
      grouped.length,
      "status groupings are no longer widespread — the narrow pin above may now be generalisable",
    ).toBeGreaterThan(5);
  });
});

/* ─────────── shape 4: a client surface publishing the generation run ─────── */

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.now();

function job(overrides: Partial<Job> = {}): Job {
  return {
    id: "job-1",
    clientId: "client-1",
    agentId: "agent-service",
    agentName: "Social",
    title: "Weekly batch",
    status: "delivered",
    createdAt: NOW - 6 * 60 * 60 * 1000,
    updatedAt: NOW - 6 * 60 * 60 * 1000,
    ...overrides,
  } as Job;
}

function asset(overrides: Partial<Asset> = {}): Asset {
  return {
    id: "asset-1",
    clientId: "client-1",
    title: "Launch teaser",
    content: "Body",
    createdBy: "staff-1",
    createdAt: NOW - 10 * DAY,
    updatedAt: NOW - 2 * DAY,
    status: "published",
    type: "social_post",
    ...overrides,
  } as Asset;
}

/** Seven jobs one batch apart — the shape a weekly fire actually writes. */
const BATCH: Job[] = Array.from({ length: 7 }, (_, i) =>
  job({ id: `job-${i}`, createdAt: NOW - 6 * 60 * 60 * 1000 - i * DAY }),
);

const INTEGRATIONS: ClientIntegration[] = [];

function statsRow(viewerIsClient: boolean): string {
  return renderToStaticMarkup(
    createElement(ClientAnalyticsStats, {
      assets: [asset(), asset({ id: "asset-2", status: "scheduled" })],
      jobs: BATCH,
      integrations: INTEGRATIONS,
      viewerIsClient,
    }),
  );
}

describe("the client dashboard's counter row", () => {
  it("publishes neither the run count nor the batch timestamp", () => {
    const html = statsRow(true);

    // Non-vacuity first: the row rendered at all, and the tiles about THEIR
    // content are present. Every negative below is worthless over empty markup.
    expect(html, "the row did not render").toContain("Deliverables");
    expect(html).toContain("Published");
    expect(html).toContain("Channels");

    // A3: no count of our runs…
    expect(html, "the run counter reached a client").not.toContain("Agent runs");
    // …and no time since the batch fired, which is the half that lets a client
    // conclude the whole week already exists.
    expect(html, "a run stamp reached a client").not.toContain("Last run");
    expect(html, "the no-runs variant is still a statement about runs").not.toContain("No runs yet");
    // The literal count, too — seven jobs, and the number must appear nowhere.
    expect(html).not.toMatch(/>\s*7\s*</);
  });

  it("still gives staff the count and the stamp, off the same fixture", () => {
    // The neighbouring case, which is what makes the negatives above a viewer rule
    // rather than a deletion. Staff debug with exactly this.
    const html = statsRow(false);

    expect(html).toContain("Agent runs");
    expect(html).toContain("Last run");
    expect(html).toMatch(/>\s*7\s*</);
  });

  it("says 'No runs yet' to staff and nothing at all to a client", () => {
    const empty = (viewerIsClient: boolean) =>
      renderToStaticMarkup(
        createElement(ClientAnalyticsStats, {
          assets: [],
          jobs: [],
          integrations: INTEGRATIONS,
          viewerIsClient,
        }),
      );
    expect(empty(false)).toContain("No runs yet");
    expect(empty(true)).not.toContain("No runs yet");
  });

  it("is handed a viewer at every mount in src/, not a default", () => {
    // The prop is required, so omitting one is a compile error — but a required prop
    // does not stop a mount from hard-coding `true`/`false`, and the failure mode
    // here is a directive breach rather than a wrong word. Swept from the
    // filesystem so a second mount added anywhere is covered.
    const mounts: string[] = [];
    for (const file of FILES) {
      const src = code(readFileSync(file, "utf8")).replace(/\s+/g, " ");
      for (const m of src.matchAll(/<ClientAnalyticsStats\b[\s\S]*?\/>/g)) {
        mounts.push(`${relToSrc(file)} → ${m[0]}`);
      }
    }
    expect(mounts.length, "no mount found — the sweep or the component name moved").toBeGreaterThan(
      0,
    );
    for (const mount of mounts) {
      expect(mount, "this mount assumes a viewer").toMatch(/viewerIsClient=\{(?!true\}|false\})/);
    }
  });
});

describe("the calendar's scheduled-run card", () => {
  // SOURCE, not markup, and the reason was CHECKED rather than assumed by analogy
  // with the detail modal: importing components/run-calendar.tsx in vitest throws
  // `Cannot find package 'server-only' imported from src/lib/data.ts` — it reaches
  // the Admin-SDK data layer through its planned-run server actions, so the module
  // cannot be loaded in this environment at all, let alone rendered. Same reason
  // asset-visibility.test.ts and publish-error-boundary.test.ts assert against text.
  //
  // What a source guard proves is that the gate is WRITTEN. That the gate produces
  // the right markup is not something this file claims.
  //
  // AND A SOURCE PIN PROVES IT OF WHICHEVER LINE MATCHES FIRST — the failure this
  // block was caught by. `expect(cal).toContain("viewerIsClient={viewerIsClient}")`
  // stood in for "the ScheduledRunCard mount threads the viewer", but that string
  // occurs FIVE times in run-calendar.tsx (two PostChips, the PostCard, the
  // AssetDetailModal, the mount), four of them older than the rule — so the mount's
  // own thread could be replaced with `viewerIsClient={!canSchedule}` and every
  // assertion stayed green.
  //
  // MEASURED ACROSS THIS WHOLE FILE rather than fixed only where it was reported:
  // all thirteen `toContain`/`not.toContain` needles this suite aims at source text
  // (run-calendar.tsx, jobs-list.tsx, calendar-body.tsx) were counted in their
  // comment-stripped, whitespace-collapsed target. Exactly one was non-unique —
  // that one, at 5 — and the twelve others occur once each, so none of them can
  // currently pass on a line other than the one it means. Re-measure with the same
  // recipe before adding a pin, and pick the shape by what the pin is standing in
  // for:
  //   · IDENTITY of a site ("THIS mount", "THIS gate") → EXTRACT the element and
  //     read the argument off it, as the ClientAnalyticsStats sweep above does and
  //     as the disclosure test below now does. Uniqueness of a substring is not the
  //     same claim and cannot be made to be.
  //   · MULTIPLICITY being the danger ("the fire instant may be printed once") →
  //     COUNT the matches, which is a question no gate assertion answers.
  // A blanket "every pin must match exactly once" was considered and rejected: two
  // legitimate call sites asking the same register is not a defect, and a guard that
  // reddens for that gets loosened, which is how this file lost its teeth the first
  // time.
  const cal = code(readFileSync(join(SRC, "components/run-calendar.tsx"), "utf8")).replace(
    /\s+/g,
    " ",
  );

  it("shows a client no 'Ran <n> ago' for a schedule that has fired", () => {
    // THE SECOND INSTANCE OF THE DASHBOARD TILE'S DEFECT, found by grepping for the
    // shape rather than by reading the finding. This card is a future projection a
    // client opens from their own calendar, and it printed "Last fire — Ran 6 hours
    // ago" directly beside its cadence label and a grid of upcoming days: the batch
    // timestamp, on a client surface, exactly as the "Agent runs · Last run …" tile
    // was carrying it.
    expect(cal).toContain("{!viewerIsClient && !run.lastError && run.lastRunAt && (");
    // And ONCE, which is the half a gate cannot give you: a second dated render
    // added anywhere in this file — inside the client branch below, in a tooltip,
    // in an aria-label — would satisfy every gate assertion here while putting the
    // instant back on a client's screen. Counted rather than gated, because
    // "how many are there" is the question a gate never answers.
    expect(
      [...cal.matchAll(/relativeTime\(run\.lastRunAt\)/g)].length,
      "the schedule's fire instant is rendered more than once; only the staff-gated line may print it",
    ).toBe(1);
  });

  it("still shows a client the REFUSAL, so the fix did not take the remedy with it", () => {
    // The half that must survive. `lastError` is the only thing that can explain a
    // fire refused before a job existed, and calendar-body paraphrases it through
    // clientSafeRefusal for this exact reader — gating the whole panel on staff
    // would have re-opened the silent-refusal gap that treatment closed.
    //
    // ASKED AS A RANGE, not as a substring, and that is not a stylistic choice: the
    // substring form was written first and TESTED, by planting
    // `{!viewerIsClient && run.lastError ? (`. It stayed green, because
    // `"run.lastError ? ("` is a substring of the gated spelling too. "Is the guard's
    // text present" is the wrong question; "is this render inside a staff-only
    // range" is the right one, and the walk that answers it is the same one this
    // file's own exemption uses.
    const calRaw = code(readFileSync(join(SRC, "components/run-calendar.tsx"), "utf8"));
    const refusal = calRaw.indexOf("Failed to fire");
    expect(refusal, "the refusal line is gone entirely").toBeGreaterThan(-1);

    const gates = [...staffOnlyIfRanges(calRaw), ...staffOnlyJsxRanges(calRaw)];
    expect(
      insideAnyRange(gates, refusal),
      "the refusal is behind a staff gate; a client's refused schedule is silent again",
    ).toBe(false);

    // Non-vacuity for that negative: the walk found gates in this file at all, so
    // "not inside one" is a real answer rather than an empty range list.
    expect(gates.length, "no staff gate found — the walk is not working on this file").toBeGreaterThan(
      0,
    );
    // And the DATED success line IS inside one, which is the whole change — same
    // walk, opposite verdict, off the same file. (The date-free line a client gets
    // instead is the next test, and it must NOT be inside one.)
    const ran = calRaw.indexOf("Ran {relativeTime(run.lastRunAt)}");
    expect(ran, "the staff success line is gone").toBeGreaterThan(-1);
    expect(
      insideAnyRange(gates, ran),
      "the success line is not gated, so the batch timestamp still reaches a client",
    ).toBe(true);
  });

  it("still tells a client the schedule HAS fired, without handing over the instant", () => {
    // RULE 6, SECOND PASS OVER THIS PANEL, and the reason this test exists at all.
    // The first cut of the A3 fix gated the WHOLE panel on `!viewerIsClient`, and
    // that took a remedy with it that nobody had enumerated: `projectPastRuns`
    // (lib/calendar-past-runs, rule 3) drops every past-run card whose visible
    // deliverables are empty for a client — which is EVERY queued/running run and
    // every batch whose posts are all still locked — and rule 3 names THIS panel as
    // the compensation, as does calendar-body at the field it ships. So with the
    // panel gated to staff, a client whose schedule had fired and was still working,
    // or had delivered only locked posts, had no surface anywhere saying the agent
    // ran. "Delayed" was the worst of it: a stuck label and nothing else.
    //
    // The panel opens for a client again…
    expect(cal, "the panel is staff-gated again; rule 3's substitute is gone").toContain(
      "{(run.lastError || run.lastRunAt) && (",
    );
    // …and the FACT reaches them without the INSTANT. Gate and sentence pinned as
    // ONE string, so neither can move without the other: a gate keyed to a
    // capability flag fails this, and so does a sentence that starts naming a time.
    expect(
      cal,
      "the client's date-free line is gone, re-gated, or has changed what it claims",
    ).toContain(
      '{viewerIsClient && !run.lastError && run.lastRunAt && ( <p className="text-xs text-muted-2">This schedule has run before.</p> )}',
    );

    // NOT inside a staff gate — the same walk as the refusal above, same verdict,
    // which is what makes "a client sees this" mechanical rather than a reading of
    // the braces by eye. This is the assertion that catches the line being moved
    // inside the staff branch while its text stays word for word the same.
    const calRaw = code(readFileSync(join(SRC, "components/run-calendar.tsx"), "utf8"));
    const line = calRaw.indexOf("This schedule has run before.");
    expect(line, "the client's line is gone entirely").toBeGreaterThan(-1);
    const gates = [...staffOnlyIfRanges(calRaw), ...staffOnlyJsxRanges(calRaw)];
    expect(
      gates.length,
      "no staff gate found — the walk is not working on this file",
    ).toBeGreaterThan(0);
    expect(
      insideAnyRange(gates, line),
      "the client's line sits inside a staff gate, so a client is told nothing again",
    ).toBe(false);

    // NO SEPARATE "and it names no time" ASSERTION, deliberately: the pin above is
    // the whole element, sentence included, so any interpolation added to that line
    // fails it already. A second assertion for the same rule is the shape this
    // campaign keeps tripping over — and it could not be mutated on its own, which
    // is how you tell.
  });

  it("asks the disclosure question, not a capability flag standing in for it", () => {
    // The card has three capability booleans that all happen to be staff-only today
    // (canManage, canDelete, canOpenJob — the last two both fed from `canSchedule`).
    // Keying a disclosure directive to one of them would move the rule the next time
    // a capability moves: the "two booleans that read alike" failure. So the card
    // takes its own viewer, and the mount passes the component's.
    //
    // ASKED OF THE MOUNT, not of the file, and the file form was TESTED AND FOUND
    // USELESS: `expect(cal).toContain("viewerIsClient={viewerIsClient}")` is
    // satisfied by any of the five threads in this file (two PostChips, the
    // PostCard, the AssetDetailModal, and this mount), FOUR of which predate this
    // rule — so replacing the mount's thread with `viewerIsClient={!canSchedule}`,
    // the exact substitution this test's own comment forbids, left all of it green,
    // and tsc too, because it is boolean to boolean. Same lesson as the
    // ClientAnalyticsStats mount sweep above: extract the element, then read the
    // prop off THAT.
    //
    // SELF-CLOSING ONLY — and that PRECONDITION IS ASSERTED, not assumed. The
    // comment here used to claim a `<ScheduledRunCard …>…</ScheduledRunCard>`
    // mount "yields no match and fails this on the count, which is the
    // fail-CLOSED direction". It does not: `[\s\S]*?/>` is lazy but unbounded, so
    // it simply runs forward to the next `/>` ANYWHERE later in the file, the
    // count stays 1, and the slice being read is some other element's props. A
    // claim about a guard's failure direction is exactly the kind that has to be
    // checked rather than written.
    expect(
      cal,
      "a ScheduledRunCard mount with children appeared — the extraction below reads a bounded " +
        "self-closing element, so bound it properly before allowing this form",
    ).not.toContain("</ScheduledRunCard>");
    const mounts = [...cal.matchAll(/<ScheduledRunCard\b[\s\S]*?\/>/g)].map((m) => m[0]);
    expect(
      mounts.length,
      "not exactly one self-closing ScheduledRunCard mount — a new one needs threading too",
    ).toBe(1);
    const mount = mounts[0]!;

    // The ARGUMENT, by EQUALITY — one assertion, because equality is strictly
    // stronger than the four `not.toContain("canManage"|"canDelete"|"canOpenJob"|
    // "canSchedule")` checks it would otherwise sit beside, and it also catches the
    // shapes an enumerated blocklist misses: a hard-coded `true`/`false`, a fifth
    // capability nobody listed, a locally derived alias. An omitted prop reads as
    // `undefined` here and fails the same way.
    const arg = /viewerIsClient=\{([^}]*)\}/.exec(mount)?.[1];
    expect(arg, "the mount stands something else in for the component's own viewer").toBe(
      "viewerIsClient",
    );
  });

  it("keeps lastRunAt crossing the boundary, because the client's line reads it", () => {
    // THIS NOTE USED TO SAY THE OPPOSITE, and the test above is what made it false.
    // It read: `calendar-body.tsx` sends `lastRunAt` to a client "even though
    // nothing prints it", and "the follow-up is to gate the field there too". A
    // client's date-free line prints it now, so that follow-up as written would
    // delete the line and take rule 3's substitute with it a second time.
    //
    // Asserted rather than described, so whoever reaches for that follow-up lands
    // here first.
    const body = code(
      readFileSync(join(SRC, "app/(app)/calendar/calendar-body.tsx"), "utf8"),
    ).replace(/\s+/g, " ");
    expect(
      body,
      "lastRunAt no longer reaches a client, so the card's date-free line has no fact left to read",
    ).toContain("...(r.lastRunAt ? { lastRunAt: r.lastRunAt } : {})");
    // The neighbouring field that IS staff-only, quoted so the difference between
    // the two is visible at the one place both are written: /jobs/[id] is
    // staff-guarded, so `lastJobId` has nowhere to send a client anyway.
    expect(body).toContain("...(isClient ? {} : r.lastJobId ? { lastJobId: r.lastJobId } : {})");

    // THE RESIDUAL THAT REMAINS, stated rather than implied gone: the instant is in
    // a client's RSC payload and is kept off their SCREEN by a render gate, not by
    // the projection. Anyone reading the flight data can still find it. Closing it
    // means replacing the field for a client with a boolean the line can read
    // instead — not simply dropping it, which is the mistake this test is here to
    // stop.
  });
});

/* ───────────────────────── the shared range walk ─────────────────────────── */

describe("the JSX gate walk", () => {
  it("bounds a gate at its own closing brace, with a string in the way", () => {
    // The helper is now load-bearing for this file's one exemption, so its teeth
    // are checked here rather than trusted — and with a brace inside a string,
    // which is what a naive walk mis-counts.
    const src = '{isStaff && <Badge title="a { b">{asset.status}</Badge>}\n<p>{asset.status}</p>';
    const ranges = staffOnlyJsxRanges(src);
    expect(ranges.length, "the gate was not recognised").toBe(1);

    const guarded = src.indexOf("{asset.status}");
    const after = src.lastIndexOf("{asset.status}");
    expect(after).toBeGreaterThan(guarded);
    // Both directions: what the gate owns is inside…
    expect(insideAnyRange(ranges, guarded)).toBe(true);
    // …and what follows its brace is not.
    expect(insideAnyRange(ranges, after)).toBe(false);
  });

  it("does not read an `if` gate as a JSX one, or the reverse", () => {
    // The two shapes stay separate on purpose — widening either would widen every
    // exempted range at every caller, which fails open.
    expect(staffOnlyJsxRanges("if (!viewerIsClient) { x(); }")).toEqual([]);
    expect(staffOnlyIfRanges("{!viewerIsClient && <X/>}")).toEqual([]);
  });

  it("skips a template literal whole while bounding a gate", () => {
    // The apostrophe trap this directory has been bitten by: a `'` inside template
    // TEXT must not open a bogus string that eats the gate's closing brace.
    const src = "{isStaff && <p>{`it's here`}{asset.status}</p>}\n<b>{asset.status}</b>";
    const ranges = staffOnlyJsxRanges(src);
    expect(ranges.length).toBe(1);
    expect(insideAnyRange(ranges, src.indexOf("{asset.status}"))).toBe(true);
    expect(insideAnyRange(ranges, src.lastIndexOf("{asset.status}"))).toBe(false);
    // And the primitive doing the work is the shared one.
    expect(isStringDelimiter("`")).toBe(true);
    expect(skipStringLiteral("`a`", 0)).toBe(2);
  });
});
