import path from "path";
import { describe, expect, it } from "vitest";
import { readSource } from "./source-scan";
import { isRecommendedTask, taskExecutorLabel, taskPlatform } from "@/lib/recommended-tasks";
import type { ClientTask } from "@/lib/types";

/**
 * WHAT A "RECOMMENDED TASK" IS, AND WHERE IT IS ALLOWED TO APPEAR.
 *
 * PORTAL FEEDBACK ROUND 2, 2026-09 put the swarm's proposals on Home as a list
 * with an X and a "Let's do this". ROUND 4 TOOK THAT LIST OFF HOME AGAIN, and
 * the ruling says why: "recommended tasks" on Home must be a fixed, small set
 * of SETUP STEPS that get the client to a first result with our agents, ordered
 * per client at onboarding — not the swarm's content ideas, which are not setup
 * steps and are not linked to an agent by construction.
 *
 * So `RecommendedTasksWidget` (and `ActionListWidget` beside it) are gone, and
 * what this file still pins is everything that DID survive:
 *  · the predicate and the label helpers — the Calendar's review cards, the
 *    sparse banner and the `?task=` kickoff strip all still read them;
 *  · the shared Home row, which the setup ladder now renders;
 *  · Home's mount contract, on BOTH branches (staff and client), which is the
 *    regression that has already happened once on this page in each direction.
 */

const src = (rel: string) => readSource(path.resolve(__dirname, "../..", rel));

const row = src("components/home-task-row.tsx");
const getSetUp = src("components/home-get-set-up.tsx");
const home = src("app/(app)/clients/[id]/page.tsx");

/** JSX bodies only — the files' own comments explain the rules and may name
 *  the very words the rules forbid. */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

describe("the shared Home row (home-task-row.tsx)", () => {
  it("is the row chrome Home's list renders", () => {
    expect(getSetUp, "the setup ladder must render the shared row").toContain("<HomeTaskRow");
    expect(getSetUp, "the setup ladder must import the shared row").toContain(
      'from "@/components/home-task-row"',
    );
  });

  // round 6 (§2.2): INVERTED. "Let's do this" was one label for six different
  // actions, so it predicted nothing about where the press went — which is why
  // "Complete your profile" landed on a page with no clue what to do. The label
  // is the caller's now and names the action and the missing thing, and the
  // fallback is gone rather than left as a default nobody may rely on.
  it("takes its control label from the caller, and offers no generic one", () => {
    expect(row).not.toContain("Let's do this");
    expect(row).toContain("{start.label}");
    expect(row).toContain('<Icon name="X"');
    // The snooze clock stays gone: a two-verb row.
    expect(withoutComments(row)).not.toContain('name="Clock"');
  });

  // round 6 (rule 3 · §2.1): four of six rows were not clickable at all, while
  // the module that resolved them claimed every row was a destination.
  it("makes a row with a destination the whole link, with one static chevron", () => {
    const body = withoutComments(row);
    expect(body, "no row-wide link").toContain("<Link");
    expect(body).toContain("row-lift");
    expect(body).toContain('name="ChevronRight"');
    // One chevron in the file, and it does not move: rows carry exactly one
    // trailing glyph and hover is a fill, never a slide.
    expect([...body.matchAll(/name="ChevronRight"/g)]).toHaveLength(1);
    expect(body).not.toContain("group-hover:translate");
    // The row-link and the button are mutually exclusive: an anchor may not
    // contain a control, which is what the old hover overlay was invented for.
    expect(body).toContain("if (href && !start && !dismiss)");
  });

  it("keeps both controls reachable without a pointer", () => {
    // The touch-reach intent (#89): the controls used to be revealed on
    // `group-hover` with an `[@media(hover:none)]` fallback. They are the row's
    // PRIMARY gesture now — the row itself is not a link — so no visibility
    // gate of any kind may return.
    const body = withoutComments(row);
    for (const gate of ["group-hover", "group-focus-within", "opacity-0", "hover:none"]) {
      expect(body, `home-task-row.tsx must not gate its controls on ${gate}`).not.toContain(gate);
    }
    // The X is icon-only, so it carries an accessible name.
    expect(row).toContain("aria-label={dismiss.label}");
  });

  it("does not nest controls inside a row-wide link", () => {
    // A row that is itself a <Link> cannot hold buttons without nesting
    // interactive elements — which is what forced the old hover overlay.
    expect(withoutComments(getSetUp)).not.toContain("<Link");
  });
});

describe("Home itself", () => {
  const body = withoutComments(home);

  it("mounts ONE list, and it is the setup ladder", () => {
    expect(body, "the content-idea list is back on Home").not.toContain(
      "RecommendedTasksWidget",
    );
    expect(body, "the 24-row checklist widget is back on Home").not.toContain(
      "ActionListWidget",
    );
    expect(body).toContain("<GetSetUpWidget");
  });

  it("mounts it on BOTH branches, staff and client (parity, 2026-09)", () => {
    const mounts = [...body.matchAll(/\{getSetUpWidget\}/g)];
    expect(mounts, "one mount per branch of clients/[id]/page.tsx").toHaveLength(2);
  });

  it("no longer builds the content-idea rows at all", () => {
    // The swarm's proposals still reach the Calendar and the kickoff strip;
    // Home stopped resolving them, so the row builder and its agent-link
    // resolver left with the widget.
    expect(body).not.toContain("resolveTaskCustomAgentId");
    expect(body).not.toContain("isRecommendedTask");
    expect(body).not.toContain("taskExecutorLabel");
  });

  it("still does not mount the calendar sparse banner or its gap plumbing", () => {
    expect(body).not.toContain("CalendarSparseBanner");
    expect(body).not.toContain("computePlatformGaps");
    expect(body).not.toContain("gapPlatformNames");
  });
});

describe("what counts as a recommended task", () => {
  const base: Pick<ClientTask, "status" | "owner" | "source"> = {
    status: "pending",
    owner: "karos_managed",
    source: "copilot",
  };

  it("is the swarm's own pending proposals and nothing else", () => {
    expect(isRecommendedTask(base)).toBe(true);
    expect(isRecommendedTask({ ...base, status: "in_progress" })).toBe(false);
    expect(isRecommendedTask({ ...base, owner: "client_managed" })).toBe(false);
    expect(isRecommendedTask({ ...base, source: "manual" })).toBe(false);
  });

  it("names the executing agent, never a raw product slug", () => {
    expect(taskExecutorLabel({ metadata: { agentName: "Instagram Agent" } })).toBe(
      "Instagram Agent",
    );
    expect(taskExecutorLabel({ metadata: { productType: "not_a_product" as never } })).toBe("Karos AI");
    expect(taskExecutorLabel({})).toBe("Karos AI");
  });

  it("reads a platform only when one is actually stored", () => {
    expect(taskPlatform({ metadata: { platform: "instagram" } })).toBe("instagram");
    expect(taskPlatform({ metadata: { platform: "" } })).toBeUndefined();
    expect(taskPlatform({})).toBeUndefined();
  });
});
