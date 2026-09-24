import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * A module nobody calls is the defect this whole thread exists to fix.
 *
 * The engine's `preferredByPerformance` has been reading
 * `context/learning/<platform>/what-works` since it shipped, and nothing ever
 * wrote it — consumer built, producer never was. Shipping a projection and a
 * writer that no route invokes would reproduce that exactly one repository to
 * the left, and it would look finished from both ends.
 *
 * So this asserts the call site, and the three things about WHERE it sits that
 * a later edit could quietly undo.
 */

const ROUTE = readFileSync(join(process.cwd(), "src/app/api/analytics/sync/route.ts"), "utf8");

describe("the analytics cron projects the performance signal", () => {
  it("calls it at all", () => {
    expect(ROUTE).toMatch(/await syncPerformanceSignalToWorkspace\(client\)/);
  });

  it("calls it AFTER the metrics are written, not before", () => {
    // The projection is derived from the rows this loop just wrote. Running it
    // first would project last tick's data and look entirely correct.
    const call = ROUTE.indexOf("syncPerformanceSignalToWorkspace(client)");
    const write = ROUTE.indexOf('action: "written", source');
    expect(write).toBeGreaterThan(-1);
    expect(call).toBeGreaterThan(write);
  });

  it("wraps it in its own try, so a failed projection does not cost the client its metrics", () => {
    // The rows are the thing that must land; the projection is the derived
    // artefact. One `catch` around both would let a bug in the cheap half
    // discard the expensive half.
    const region = ROUTE.slice(
      ROUTE.indexOf("syncPerformanceSignalToWorkspace(client)") - 200,
      ROUTE.indexOf("syncPerformanceSignalToWorkspace(client)") + 600,
    );
    expect(region).toMatch(/try \{[\s\S]*syncPerformanceSignalToWorkspace/);
    expect(region).toMatch(/what-works projection failed/);
  });

  it("reports the refusal rather than swallowing it", () => {
    // "Measured, nothing conclusive" is the answer for most clients for a
    // while, and a sweep that printed nothing for them would read as a sweep
    // that skipped them.
    expect(ROUTE).toMatch(/p\.refusal \?\?/);
  });
});
