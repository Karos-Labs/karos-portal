import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { CRON_ROUTES, scheduledCronRoutes } from "@/lib/cron-schedule-manifest";

/**
 * The manifest is only worth anything if it is EXHAUSTIVE, so this derives the
 * route set from the tree rather than trusting the list.
 *
 * What it caught: ten of the fourteen routes below had nothing scheduled to
 * call them in production on 2026-09-23, including the sweep that turns a
 * finished engine run into something the client can see. Two of the ten say so
 * in their own doc comments — which is exactly the failure this closes. A
 * sentence in a file nobody greps is not a checklist.
 *
 * What it deliberately does NOT do is claim anything about GCP. No test here
 * can read the project's scheduler jobs, and a field that pretended to would go
 * stale the first time somebody paused one. This asserts that every route has
 * been THOUGHT ABOUT — scheduled with a cadence, or unscheduled with a reason.
 */

const API_ROOT = join(process.cwd(), "src/app/api");

/** Every route directory whose handler calls `requireCronSecret`. */
function cronRoutesOnDisk(): string[] {
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (entry !== "route.ts") continue;
      if (!readFileSync(full, "utf8").includes("requireCronSecret")) continue;
      found.push(relative(API_ROOT, dir).split(sep).join("/"));
    }
  };
  walk(API_ROOT);
  return found.sort();
}

describe("the cron-schedule manifest covers every scheduler-only route", () => {
  it("lists exactly the routes that guard themselves with requireCronSecret", () => {
    // Both directions on purpose. A missing entry is the bug this exists for; a
    // stale one means the manifest is describing a route that no longer exists,
    // which is how a checklist quietly stops being read.
    expect(CRON_ROUTES.map((r) => r.path).sort()).toEqual(cronRoutesOnDisk());
  });

  it("finds a non-trivial number of them, so an empty walk cannot pass", () => {
    // Anti-vacuity: if `API_ROOT` ever moves, `cronRoutesOnDisk()` returns []
    // and the assertion above would pass against an empty manifest.
    expect(cronRoutesOnDisk().length).toBeGreaterThan(10);
  });

  it("names each route exactly once", () => {
    expect(new Set(CRON_ROUTES.map((r) => r.path)).size).toBe(CRON_ROUTES.length);
  });
});

describe("every route is either scheduled or refused, with a reason", () => {
  it("gives every unscheduled route a stated reason", () => {
    // The point of the field. "Nobody got round to it" is the state this file
    // exists to make impossible to leave unwritten.
    const unexplained = CRON_ROUTES.filter(
      (r) => r.productionSchedule === null && (r.whyNot ?? "").trim().length < 40,
    ).map((r) => r.path);
    expect(unexplained).toEqual([]);
  });

  it("gives every scheduled route a five-field cron expression", () => {
    const malformed = scheduledCronRoutes()
      .filter((r) => (r.productionSchedule ?? "").trim().split(/\s+/).length !== 5)
      .map((r) => `${r.path}: ${r.productionSchedule}`);
    expect(malformed).toEqual([]);
  });

  it("says what each route does per tick", () => {
    const silent = CRON_ROUTES.filter((r) => r.does.trim().length < 30).map((r) => r.path);
    expect(silent).toEqual([]);
  });

  it("keeps the engine reconcile sweep scheduled", () => {
    // Named rather than left to the general rule, because this is the one with
    // measured victims: five runs the engine finished sat in the portal as
    // `queued` holding no deliverable, since the only other completion channel
    // is a human opening the Job page.
    const reconcile = CRON_ROUTES.find((r) => r.path === "agent-engine/reconcile");
    expect(reconcile?.productionSchedule).not.toBeNull();
  });

  it("keeps the retired agent-service sweep unscheduled", () => {
    // agent-service was torn down on 2026-09-02. Wiring this would spend a tick
    // every few minutes timing out against a service that no longer answers.
    const retired = CRON_ROUTES.find((r) => r.path === "agent-service/reconcile");
    expect(retired?.productionSchedule).toBeNull();
  });
});
