import path from "path";
import { describe, expect, it } from "vitest";
import { readSource } from "./source-scan";
import { isRecommendedTask, taskExecutorLabel, taskPlatform } from "@/lib/recommended-tasks";
import type { ClientTask } from "@/lib/types";

/**
 * PORTAL FEEDBACK ROUND 2, 2026-09 — the contract Home's two task lists now
 * share, and the one the product owner's ruling replaced.
 *
 * The ruling, verbatim: "I don't want the 'Generate more recommended tasks'
 * here. We set, after onboarding, a set number of tasks. I want the tasks to
 * show here on Home, and users to be able to X them if they don't want them, or
 * click a button that brings them to where they have to fill in the inputs
 * needed to kick off the task. It shouldn't be linked to the calendar. […] It
 * shouldn't be just Approve or Skip: it should be an X-out or a 'Let's do this'
 * button, and 'Let's do this' brings them to the page where they put in the
 * input needed."
 *
 * Four of those are structural claims a source sweep can hold, and each one is
 * a regression that has already happened once on this page: a banner that
 * counted the tasks instead of showing them, a generator button on a set that
 * was decided at onboarding, calendar language on a widget that no longer has a
 * calendar behind it, and controls hidden behind `:hover` — which on touch and
 * for keyboard nav is the same as not having them (#89).
 */

const src = (rel: string) => readSource(path.resolve(__dirname, "../..", rel));

const row = src("components/home-task-row.tsx");
const recommended = src("components/home-recommended-tasks.tsx");
const actionList = src("components/home-action-list.tsx");
const home = src("app/(app)/clients/[id]/page.tsx");

/** JSX bodies only — the file's own comments explain the rules and may name
 *  the very words the rules forbid. */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

describe("the shared Home row (home-task-row.tsx)", () => {
  it("is the only row chrome either widget renders", () => {
    for (const [name, source] of [
      ["home-action-list.tsx", actionList],
      ["home-recommended-tasks.tsx", recommended],
    ] as const) {
      expect(source, `${name} must render the shared row`).toContain("<HomeTaskRow");
      expect(source, `${name} must import the shared row`).toContain(
        'from "@/components/home-task-row"',
      );
    }
  });

  it("offers exactly one X and one 'Let's do this', and no third verb", () => {
    expect(row).toContain("Let's do this");
    expect(row).toContain('<Icon name="X"');
    // The snooze clock is gone from both lists: a two-verb row.
    expect(withoutComments(row)).not.toContain('name="Clock"');
    expect(withoutComments(actionList)).not.toContain("dismissActionAction");
  });

  it("keeps both controls reachable without a pointer", () => {
    // The touch-reach intent (#89), pinned harder than before: the controls
    // used to be revealed on `group-hover` with an `[@media(hover:none)]`
    // fallback. They are now the row's PRIMARY gesture — the row itself is no
    // longer a link — so no visibility gate of any kind may return.
    const body = withoutComments(row);
    for (const gate of ["group-hover", "group-focus-within", "opacity-0", "hover:none"]) {
      expect(body, `home-task-row.tsx must not gate its controls on ${gate}`).not.toContain(gate);
    }
    // Every control carries an accessible name; the X is icon-only.
    expect(row).toContain("aria-label={dismiss.label}");
    expect(recommended).toContain('label: "Not for us"');
    expect(actionList).toContain('label: "Not relevant for me"');
  });

  it("does not nest the controls inside a row-wide link", () => {
    // A row that is itself a <Link> cannot hold buttons without nesting
    // interactive elements — which is what forced the old hover overlay.
    expect(withoutComments(actionList)).not.toContain("<Link");
  });
});

describe("Home's Recommended tasks widget", () => {
  it("offers no Approve and no generator", () => {
    const body = withoutComments(recommended);
    expect(body).not.toContain("Approve");
    expect(body).not.toContain("RefreshTaskMapButton");
    expect(body).not.toContain("Generate");
  });

  it("says nothing about the calendar", () => {
    // "It shouldn't be linked to the calendar." The widget renders every
    // pending task at once; the calendar rendered each on its own inferred day,
    // which is why a busy client saw one of nine.
    expect(withoutComments(recommended).toLowerCase()).not.toContain("calendar");
  });

  it("takes its rows as plain data, hrefs resolved server-side", () => {
    // Flight cannot pass a function across the boundary, so the agent link is
    // built on the page (it needs resolveTaskCustomAgentId) and arrives as a
    // string.
    expect(recommended).toContain("href: string");
    expect(home).toContain("resolveTaskCustomAgentId");
    expect(home).toContain("/agents/${customAgentId}?task=${t.id}");
    expect(home).toContain("/agents?task=${t.id}");
  });
});

describe("Home itself", () => {
  it("no longer mounts the calendar sparse banner or its gap plumbing", () => {
    const body = withoutComments(home);
    expect(body).not.toContain("CalendarSparseBanner");
    expect(body).not.toContain("computePlatformGaps");
    expect(body).not.toContain("gapPlatformNames");
  });

  it("mounts the widget on BOTH branches, staff and client (parity, 2026-09)", () => {
    const mounts = [...home.matchAll(/\{recommendedTasksWidget\}/g)];
    expect(mounts, "one mount per branch of clients/[id]/page.tsx").toHaveLength(2);
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
