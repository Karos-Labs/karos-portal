import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { eventsFromJobs, type TimelineJob } from "@/components/activity-timeline";
import { JOB_STATUS_META, jobStatusLabel } from "@/lib/job-status-copy";
import type { JobStatus } from "@/lib/types";
import { isStringDelimiter, matchingBrace, skipStringLiteral, stripComments } from "./source-scan";

/**
 * THREE STAFF SURFACES THAT SAID THE WRONG THING OR LED NOWHERE — the rules that
 * replaced them, and nothing wider.
 *
 *  · #91  the staff activity timeline titled EVERY run "<agent> delivered a
 *         draft", whatever its status. A queued run, a cancelled one and a
 *         failed one were indistinguishable, and a failed one contradicted
 *         itself inside a single row: "delivered a draft" over "Failed: …".
 *  · #112 /assets?clientId= — the staff review grid scoped to one client —
 *         rendered read-only cards under a comment saying it existed "so they
 *         can review/approve upcoming posts".
 *  · #107 bulk clip upload (manual MP4/MOV upload, no agent involved) had
 *         exactly one entrance in the product, in the action row of a page
 *         titled "AI Agents", while the content library that should hold it
 *         told its readers an agent run was the only way content arrives.
 *
 * WHAT IS AND IS NOT CLAIMED HERE. The run-state assertions are behavioural —
 * they drive `eventsFromJobs` over every state in the union, so a state added to
 * `JobStatus` is covered without anyone editing this file. The /assets
 * assertions are source scans, because a server component cannot be rendered in
 * a node run; they are therefore claims about the SHAPE of that file and say
 * nothing about what the browser paints. Every NEGATIVE scan reads comment-free
 * text via `stripComments` — this suite's own subject matter is quoted at length
 * in the docstrings it is scanning, so "the code does not say X" run against raw
 * source would be satisfied by the prose explaining why it must not. Raw source
 * is read exactly once, and positively, to prove that strip is load-bearing.
 */

const TIMELINE = "src/components/activity-timeline.tsx";
const ASSETS_PAGE = "src/app/(app)/assets/page.tsx";

function read(rel: string): string {
  return readFileSync(join(process.cwd(), rel), "utf8");
}

/** Comment-free source for `rel`. */
function code(rel: string): string {
  return stripComments(read(rel));
}

/* ─────────────────── #91 · a run row named for its own state ─────────────── */

// activity-timeline.tsx is a "use client" component and imports the server
// action barrel for its staff note composer. Nothing under test touches it.
vi.mock("@/lib/actions", () => ({ addActivityNoteAction: async () => {} }));

/**
 * Every run state there is, read off the register's own key set rather than
 * listed here — `JOB_STATUS_META` is a `Record<JobStatus, …>`, which tsc keeps
 * total, so a new state joins these tests unasked.
 */
const ALL_STATUSES = Object.keys(JOB_STATUS_META) as JobStatus[];

const AGENT = "Reddit reply agent";

function timelineJob(overrides: Partial<TimelineJob> = {}): TimelineJob {
  return {
    id: "job-1",
    agentName: AGENT,
    status: "review",
    title: "reddit_reply · Acme",
    createdAt: 1_754_000_000_000,
    ...overrides,
  };
}

function rowFor(status: JobStatus, overrides: Partial<TimelineJob> = {}) {
  const rows = eventsFromJobs([timelineJob({ status, ...overrides })]);
  expect(rows).toHaveLength(1);
  return rows[0];
}

/**
 * One JSX attribute's VALUE on an element string, brace-matched — or null when
 * the attribute is absent. A spread that supplies the prop conditionally
 * (`{...(x ? { p: x } : {})}`) is deliberately NOT resolved: it is invisible
 * here and therefore reads as absent, which is the fail-closed direction.
 */
function jsxAttr(mount: string, name: string): string | null {
  // Shorthand — `canApprove` with no `=` — is the JSX spelling of `{true}`, and
  // it is how this page actually passes it. Reading only `name=` returned null
  // and made the guard fail on correct code, which is the other way a guard can
  // be useless.
  if (new RegExp(`\\b${name}\\s*(?=[\\s/>])`).test(mount) && !new RegExp(`\\b${name}=`).test(mount)) {
    return "{true}";
  }
  const m = new RegExp(`\\b${name}=`).exec(mount);
  if (!m) return null;
  const at = m.index + m[0].length;
  if (mount[at] !== "{") {
    const q = mount[at];
    if (q !== '"' && q !== "'") return null;
    const end = mount.indexOf(q, at + 1);
    return end < 0 ? null : mount.slice(at, end + 1);
  }
  let depth = 0;
  for (let i = at; i < mount.length; i++) {
    if (mount[i] === "{") depth++;
    else if (mount[i] === "}" && --depth === 0) return mount.slice(at, i + 1);
  }
  return null;
}

describe("the staff activity timeline names a run by its own state", () => {
  it("finds states to judge, so the loops below are not empty walks", () => {
    // The register is the source of the loop bound; if it ever came back empty
    // every assertion under it would pass by vacuity.
    expect(ALL_STATUSES.length).toBeGreaterThan(4);
    expect(ALL_STATUSES).toContain("failed");
    expect(ALL_STATUSES).toContain("queued");
  });

  it("titles each state exactly `<agent> · <that state's register label>`", () => {
    // The bound, asserted where the loop is and not only in the sibling above:
    // an `it` whose whole body is a `for` over an empty list passes, and that is
    // the failure mode this suite is least likely to notice about itself.
    expect(ALL_STATUSES.length).toBeGreaterThan(4);
    for (const status of ALL_STATUSES) {
      expect(rowFor(status).title).toBe(`${AGENT} · ${jobStatusLabel(status)}`);
    }
  });

  it("gives no two run states the same title — the shape of the defect", () => {
    // THE assertion. Before the fix every state produced the same string, so
    // this set had size 1 whatever the union's size was — which is why the
    // comparison is against `ALL_STATUSES.length` and no number is written here.
    const titles = ALL_STATUSES.map((status) => rowFor(status).title);
    expect(new Set(titles).size).toBe(ALL_STATUSES.length);
  });

  it("never announces a delivery for a state that is not one", () => {
    expect(ALL_STATUSES.length).toBeGreaterThan(4);
    const delivered = jobStatusLabel("delivered");
    for (const status of ALL_STATUSES) {
      if (status === "delivered") continue;
      expect(rowFor(status).title, `${status} claims ${delivered}`).not.toContain(delivered);
    }
  });

  it("says a failure once, and lets the error stand without a prefix", () => {
    // The row used to carry the word twice — "delivered a draft" as the title
    // and "Failed: <error>" underneath it.
    const row = rowFor("failed", { error: "Upstream returned 502" });
    expect(row.title).toBe(`${AGENT} · ${jobStatusLabel("failed")}`);
    expect(row.description).toBe("Upstream returned 502");
  });

  it("falls back to the run's own title when a failed run stored no message", () => {
    // "Failed: Unknown error" is gone; the title already carries the state, so
    // the description spends its line on the only other fact there is.
    const row = rowFor("failed", { title: "reddit_reply · Acme" });
    expect(row.description).toBe("reddit_reply · Acme");
  });

  it("keeps the retired phrase in the explanation only, never in the code", () => {
    // Deliberately reads BOTH texts: the docstrings quote the old title because
    // explaining the fix requires it, which is exactly why a raw-source scan
    // would be satisfied by prose.
    expect(read(TIMELINE)).toContain("delivered a draft");
    expect(code(TIMELINE)).not.toContain("delivered a draft");
  });
});

/* ────────── #112 · one client's library is still a review surface ────────── */

/**
 * Where `<Name` opens in `src` at or after `from`, as a WHOLE element name, or
 * -1.
 *
 * `indexOf("<BulkUploadClips")` is a prefix match, so it is satisfied by
 * `<BulkUploadClipsPreview` — a mutation run against the first draft of this
 * file renamed the one render site and the entrance count below did not move.
 * The character after the name has to be one that can follow a tag name.
 */
function elementAt(src: string, name: string, from: number): number {
  const pattern = new RegExp(`<${name}(?=[\\s/>])`, "g");
  pattern.lastIndex = from;
  const match = pattern.exec(src);
  return match ? match.index : -1;
}

/**
 * The source text of every `<Name …/>` element in a file.
 *
 * THE `/>` IS NOT FOUND BY `indexOf`, and the first draft of this file learned
 * why the hard way: `<EmptyState icon={<Icon … />} description="…" />` closes an
 * INNER element before it closes itself, so the naive search cut the slice
 * before the attribute it was written to read, and the extractor reported "no
 * description" on a file that has one. Braces are skipped whole through
 * `matchingBrace` and literals through `skipStringLiteral`, so a nested element,
 * a spread or a quoted `/>` cannot end the walk early.
 *
 * Keyed to the element rather than to a branch or a line: the rule these feed is
 * "every mount of this grid carries the same controls", which has to hold at a
 * mount nobody has written yet.
 */
function jsxElements(rel: string, name: string): string[] {
  const src = code(rel);
  const open = `<${name}`;
  const found: string[] = [];
  let at = elementAt(src, name, 0);
  while (at !== -1) {
    let end = -1;
    for (let i = at + open.length; i < src.length; i++) {
      const ch = src[i];
      if (isStringDelimiter(ch)) {
        i = skipStringLiteral(src, i);
        continue;
      }
      if (ch === "{") {
        i = matchingBrace(src, i);
        continue;
      }
      if (ch === "/" && src[i + 1] === ">") {
        end = i;
        break;
      }
      // A bare `>` means the element takes children; none of the elements this
      // suite reads do, so that is a shape change worth failing on rather than
      // silently returning a truncated slice.
      if (ch === ">") break;
    }
    expect(end, `<${name} in ${rel} is not a self-closing element`).toBeGreaterThan(at);
    found.push(src.slice(at, end));
    at = elementAt(src, name, end);
  }
  return found;
}

describe("the /assets grid carries the same controls at every mount", () => {
  it("hands each one the approve controls and the push targets they need", () => {
    // The single-client branch delivered the visibility half of A10.6 and
    // dropped the approving half, so a branch whose own comment promised review
    // AND approval could do neither. Scoped to this page: `/clients/[id]/assets`
    // mounts the same grid and is not this suite's to rule on. Without
    // connectedPlatformsByClient the approve panel's manual-push tier names a
    // "Publish now" control the card cannot render (the F107 note on AssetsView).
    const mounts = jsxElements(ASSETS_PAGE, "AssetsView");
    expect(mounts.length, `no <AssetsView found on ${ASSETS_PAGE}`).toBeGreaterThan(0);
    // KEYED TO THE VALUE, not to the attribute's presence. `toContain("canApprove")`
    // is satisfied by `canApprove={false}` and `toContain("connectedPlatformsByClient")`
    // by `connectedPlatformsByClient={undefined}` — either edit reinstates #112
    // exactly (a read-only grid, or an approve panel naming a "Publish now" the
    // card cannot render) with this green. Both props are ALSO the rule-4 shape:
    // `canApprove` defaults to false and the platforms arrive through a spread,
    // so each can be dropped silently.
    for (const mount of mounts) {
      const approve = jsxAttr(mount, "canApprove");
      expect(approve, `an <AssetsView on ${ASSETS_PAGE} does not pass canApprove`).not.toBeNull();
      expect(approve, `an <AssetsView on ${ASSETS_PAGE} cannot approve`).not.toMatch(
        /^\{\s*(false|undefined|null)\s*\}$/,
      );
      // The platforms arrive through a CONDITIONAL SPREAD
      // (`{...(x ? { connectedPlatformsByClient: x } : {})}`), which is the
      // repo's idiom for an exactOptionalPropertyTypes prop. So the question is
      // whether the mount names the prop at all — as an attribute or inside a
      // spread — and, when it is a plain attribute, that it is not falsified.
      const targets = jsxAttr(mount, "connectedPlatformsByClient");
      expect(
        mount.includes("connectedPlatformsByClient"),
        `an <AssetsView on ${ASSETS_PAGE} has no push targets`,
      ).toBe(true);
      if (targets !== null) {
        expect(targets, `an <AssetsView on ${ASSETS_PAGE} passes empty push targets`).not.toMatch(
          /^\{\s*(undefined|null)\s*\}$/,
        );
      }
    }
  });
});

/* ─────────── #107 · bulk clip upload has a home a reader looks in ────────── */

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(full)) out.push(full);
  }
  return out;
}

/** Repo-relative, POSIX-separated, tests excluded. */
const SOURCE_FILES = walk(join(process.cwd(), "src"))
  .map((f) => relative(process.cwd(), f).split(sep).join("/"))
  .filter((f) => !f.includes("__tests__"));

/** The `description` attribute of every `<EmptyState …/>` in a file. */
function emptyStateDescriptions(rel: string): string[] {
  return jsxElements(rel, "EmptyState").map((element) => {
    const match = /description="([^"]*)"/.exec(element);
    if (!match) throw new Error(`an <EmptyState in ${rel} has no literal description`);
    return match[1];
  });
}

describe("bulk clip upload is reachable from the content library", () => {
  it("has more than one entrance in the product", () => {
    // The finding's own measurement: `grep -rn BulkUploadClips src` returned one
    // import and one render site, and that site was the action row of a page
    // titled "AI Agents" — for a feature that involves no agent at all.
    // `elementAt`, not `includes("<BulkUploadClips")`: that prefix is satisfied
    // by `<BulkUploadClipsPreview`, and a mutation run proved it — the render
    // site was renamed and this count did not move.
    const rendered = SOURCE_FILES.filter(
      (f) => elementAt(code(f), "BulkUploadClips", 0) !== -1,
    );
    expect(rendered.length, `only these render it: ${rendered.join(", ") || "nothing"}`)
      .toBeGreaterThan(1);
    expect(rendered).toContain(ASSETS_PAGE);
  });

  it("is not contradicted by an empty state on the page that now offers it", () => {
    // It read "Run an agent on a client to generate deliverables" — naming the
    // one route it knew, and so telling a reader hunting for the clip uploader
    // that no such thing existed. Every empty state on the page, not the first
    // one: a second added later has the same reader and the same duty.
    const descriptions = emptyStateDescriptions(ASSETS_PAGE);
    expect(descriptions.length, `no <EmptyState found on ${ASSETS_PAGE}`).toBeGreaterThan(0);
    for (const description of descriptions) {
      expect(description, `"${description}" names no way in but an agent run`).toMatch(/upload/i);
    }
  });

  it("submits the param this page reads, to the route this page serves", () => {
    // Both halves derived rather than typed: the route comes from where the page
    // file actually lives, so a moved route is a red test instead of a picker
    // posting into a 404.
    const route = "/" + ASSETS_PAGE.replace("src/app/(app)/", "").replace("/page.tsx", "");
    const src = code(ASSETS_PAGE);
    expect(src).toMatch(new RegExp(`<Form\\s+action="${route}"`));
    expect(src).toMatch(/const \{ clientId: \w+ \} = await searchParams/);
    expect(src).toMatch(/name="clientId"/);
  });
});
