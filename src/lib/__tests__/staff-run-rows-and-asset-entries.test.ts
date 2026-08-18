import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";

import { isStringDelimiter, matchingBrace, skipStringLiteral, stripComments } from "./source-scan";

/**
 * TWO STAFF SURFACES THAT SAID THE WRONG THING OR LED NOWHERE — the rules that
 * replaced them, and nothing wider.
 *
 *  · #112 /assets?clientId= — the staff review grid scoped to one client —
 *         rendered read-only cards under a comment saying it existed "so they
 *         can review/approve upcoming posts".
 *  · #107 bulk clip upload (manual MP4/MOV upload, no agent involved) had
 *         exactly one entrance in the product, in the action row of a page
 *         titled "AI Agents", while the content library that should hold it
 *         told its readers an agent run was the only way content arrives.
 *
 * A THIRD SURFACE USED TO LIVE HERE (#91, the staff activity timeline naming
 * every run "<agent> delivered a draft" regardless of status). That component
 * (activity-timeline.tsx) was deleted 2026-08: it was rendered only inside
 * ProgressView, which lost its own last renderer when the Workspace board's
 * routes were removed, so the fix it pinned went with the surface it fixed.
 *
 * WHAT IS AND IS NOT CLAIMED HERE. The /assets assertions are source scans,
 * because a server component cannot be rendered in a node run; they are
 * therefore claims about the SHAPE of that file and say nothing about what the
 * browser paints. Every NEGATIVE scan reads comment-free text via
 * `stripComments` — this suite's own subject matter is quoted at length in the
 * docstrings it is scanning, so "the code does not say X" run against raw
 * source would be satisfied by the prose explaining why it must not. Raw
 * source is read exactly once, and positively, to prove that strip is
 * load-bearing.
 */

const ASSETS_PAGE = "src/app/(app)/assets/page.tsx";

function read(rel: string): string {
  return readFileSync(join(process.cwd(), rel), "utf8");
}

/** Comment-free source for `rel`. */
function code(rel: string): string {
  return stripComments(read(rel));
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
