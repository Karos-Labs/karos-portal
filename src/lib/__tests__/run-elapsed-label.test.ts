import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * "How long", and deliberately not "how far".
 *
 * The run dock says what the agent is doing and shows a sweeping bar with no
 * percentage. The component's own comment explains why there is no fraction:
 * engine runs declare no plan, and a made-up one is the old "ready in 30
 * minutes" in a new shape. The audit asked for "step N of M and elapsed" —
 * half of that is buildable and half is not.
 *
 * A denominator would have to come from the seeded stage count, and **that
 * count has been wrong in production**: the catalog described `instagram-agent`
 * as a 16-stage workflow while the engine ran 122 of them. A bar built on a
 * stale total is not a measurement, it is a promise. Elapsed is true whatever
 * the run turns out to cost.
 *
 * These pin the two judgement calls in the label, both of which read as
 * arbitrary until the run they were written for.
 */

const SOURCE = readFileSync(join(process.cwd(), "src/components/client-agents/run-progress.tsx"), "utf8");

/** The same function the component uses, extracted by behaviour rather than imported — it is a client module. */
function elapsedLabel(minutes: number): string | undefined {
  if (minutes < 1) return undefined;
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} hr` : `${hours} hr ${rest} min`;
}

describe("the elapsed label", () => {
  it("says nothing under a minute", () => {
    // "0 min" beside a spinner reads like a stall, and under a minute tells a
    // reader nothing they do not already know — they just pressed the button.
    expect(elapsedLabel(0)).toBeUndefined();
  });

  it.each([
    [1, "1 min"],
    [59, "59 min"],
    [60, "1 hr"],
    [72, "1 hr 12 min"],
    [120, "2 hr"],
  ])("%s minutes reads as %s", (minutes, expected) => {
    expect(elapsedLabel(minutes)).toBe(expected);
  });

  it("matches the implementation in the component", () => {
    // The shape is duplicated above so the thresholds can be tested without a
    // DOM; this keeps the duplicate honest.
    expect(SOURCE).toContain("if (minutes < 1) return undefined;");
    expect(SOURCE).toContain("if (minutes < 60) return `${minutes} min`;");
  });
});

describe("no fraction is invented", () => {
  it("still declares no percentage while working", () => {
    // `aria-valuenow` appears only on the finished bar. A working bar that
    // claimed a number would be claiming a plan the engine never declared.
    const working = SOURCE.slice(SOURCE.indexOf("role=\"progressbar\""), SOURCE.indexOf("animate-run-bar-sweep"));
    expect(working).toMatch(/working \? \{\} : \{ "aria-valuenow": 100/);
  });

  it("keeps its own clock, because the dock only re-renders when the server's answer changes", () => {
    // Which is the point of the watch — and would leave the elapsed label
    // frozen between changes without this.
    expect(SOURCE).toMatch(/setInterval\(\(\) => setNow\(Date\.now\(\)\), 30_000\)/);
    // And stops with the run, rather than ticking behind a finished one.
    expect(SOURCE).toMatch(/if \(!working \|\| startedAt === undefined\) return;/);
  });
});
