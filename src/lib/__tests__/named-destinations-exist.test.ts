import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";

import { jobStatusLabel } from "@/lib/job-status-copy";

/**
 * A surface this app NAMES has to be a surface a reader can reach.
 *
 * The defect this closes was reported from outside: a client ran an agent, read
 * "the deliverables land in the review queue", went looking for a review queue,
 * and there was none. Not a broken link — a name. Grepping the phrase turned up
 * one user-visible string and a dozen code comments describing an intention; no
 * route, component or label had ever carried it. The place those runs actually
 * land is the staff Jobs list, whose chip for them takes its word from
 * `job-status-copy`'s register, so the sentence now names the nav entry and asks
 * the register for the state.
 *
 * 2026-09-24: A REVIEW QUEUE NOW EXISTS — a staff mode of the Assets page
 * (`components/review-queue.tsx`), not a route and not a client surface. The
 * rule below was rewritten rather than deleted: the phrase is allowed in the
 * two files that implement it and still forbidden everywhere else, because the
 * sentence that caused the report was one a CLIENT read.
 *
 * WHY A SWEEP AND NOT AN ASSERTION ABOUT ONE SENTENCE. A test pinning that one
 * string would go green and stay useless: the failure mode is a WRITER naming a
 * destination that does not exist, and that can happen in any component, in copy
 * nobody re-reads. So the rule is stated over the whole tree — every literal
 * route a component links to resolves to a real route, and the retired phrase
 * cannot come back — and the one sentence is merely the first thing it holds.
 *
 * STILL OPEN, deliberately not enforced here (2026-09). Fourteen client-facing
 * strings say a deliverable "lands in your Workspace", and nothing in either
 * shell is labelled Workspace: `client-rail.tsx` retires it ("Workspace is gone
 * — the locked decision list retires it") and the client's nav offers Home,
 * Calendar and Account Center. That word is this product's name for the client's
 * content area and is wired to a real href in at least one place
 * (`agents/[agentId]/page.tsx` links "in your Workspace" to the archive), so
 * whether to rename the copy or re-label the surface is a vocabulary decision
 * across all fourteen, not a copy fix — and a test that failed on it today would
 * be asserting an answer nobody has given yet.
 */

const SRC = join(process.cwd(), "src");

/** `relative(…)`, normalized to forward slashes so offender paths read the same
 * on Windows as on CI. */
const relToSrc = (file: string): string => relative(SRC, file).split(sep).join("/");
const APP = join(SRC, "app");

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
 * Source with comments removed — the same reason `activity-actors-registry`
 * does it: the docstrings that explain a rule name the strings it forbids, and
 * run against raw text the cheap way to keep this green would be deleting the
 * explanation.
 */
function code(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

/**
 * Whether the App Router serves `path`.
 *
 * Route groups are transparent (`(app)` is not a URL segment), a dynamic
 * segment matches whatever is in its place, and private/parallel folders are not
 * routes at all — so this walks the tree the way Next resolves it rather than
 * string-matching directory names, which would call `/jobs` missing because it
 * actually lives at `app/(app)/jobs`.
 */
function routeExists(path: string): boolean {
  const segments = path.split("/").filter(Boolean);
  if (segments.length === 0) return true;

  const served = (dir: string) =>
    ["page.tsx", "page.ts", "route.ts"].some((f) => existsSync(join(dir, f)));

  function descend(dir: string, index: number): boolean {
    if (index === segments.length) return served(dir);
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (!statSync(full).isDirectory()) continue;
      if (entry.startsWith("(") && entry.endsWith(")")) {
        if (descend(full, index)) return true; // route group: same URL depth
        continue;
      }
      if (entry.startsWith("@") || entry.startsWith("_")) continue;
      if (entry.startsWith("[")) {
        if (descend(full, index + 1)) return true; // dynamic: matches this segment
        continue;
      }
      if (entry === segments[index] && descend(full, index + 1)) return true;
    }
    return false;
  }

  return descend(APP, 0);
}

describe("the destinations this app names", () => {
  it("every literal route a component links to is a route that exists", () => {
    const dangling: string[] = [];
    let checked = 0;
    for (const file of FILES) {
      const src = code(readFileSync(file, "utf8"));
      for (const match of src.matchAll(/href="(\/[A-Za-z0-9\-_/]*)"/g)) {
        checked += 1;
        if (!routeExists(match[1]!)) dangling.push(`${relToSrc(file)} → ${match[1]}`);
      }
    }
    // The sweep is worthless if the extractor stopped matching; this floor fails
    // loudly instead of passing over an empty list.
    expect(checked).toBeGreaterThan(20);
    expect(dangling, "these link somewhere the router does not serve").toEqual([]);
  });

  /**
   * THE PREMISE OF THIS RULE CHANGED, and the rule outlived it.
   *
   * It read "no copy names a review queue, because there is no review queue",
   * which was exactly right while there was none. There is one now: the staff
   * Assets page has a queue mode — one draft at a time, a position, a keyboard
   * — implemented in `components/review-queue.tsx` and mounted by
   * `components/assets-view.tsx`.
   *
   * What has NOT changed is the defect underneath: a reader met a name for a
   * place they could not reach. The queue is STAFF-only, it is a mode of the
   * Assets page rather than a route, and the copy that caused the report was
   * client-facing ("your deliverables land in the review queue"). So the rule
   * becomes: the phrase belongs to the two files that implement it, and nowhere
   * else — a client-facing string naming it would be the original defect again,
   * word for word.
   */
  it("names a review queue only where there is one", () => {
    const IMPLEMENTS = ["components/review-queue.tsx", "components/assets-view.tsx"];
    const offenders: string[] = [];
    let named = 0;
    for (const file of FILES) {
      const src = code(readFileSync(file, "utf8"));
      if (!/review queue/i.test(src)) continue;
      named += 1;
      if (!IMPLEMENTS.includes(relToSrc(file))) offenders.push(relToSrc(file));
    }
    // The premise, so a renamed or deleted queue fails HERE rather than leaving
    // an allowlist guarding a phrase nothing says any more.
    expect(named, "nothing implements the queue this allowlist names").toBeGreaterThan(0);
    expect(
      offenders,
      "the queue is a staff mode of the Assets page, not a place a client can be sent",
    ).toEqual([]);
  });

  it("the run-started panel asks the register for the run state's word", () => {
    const src = code(readFileSync(join(SRC, "components/custom-agents.tsx"), "utf8"));
    expect(src).toContain('jobStatusLabel("review")');
    // A second spelling of the same state is how "review queue" happened. The
    // register's word may change; this file may not be where it changes.
    expect(src).not.toContain(jobStatusLabel("review"));
  });
});
