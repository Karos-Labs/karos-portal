import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * ONE PROGRESS SYSTEM, NOT TWO (2026-09-10).
 *
 * Two answers to "how is my run doing" were built in parallel: SCRUM-416's
 * transport — a client-safe polling route, a shell-level watch and a dock that
 * outlives the dialog — and the six phases read off the engine's live step. The
 * transport could only say queued / running / in review; the phases could say
 * "Writing the copy" but had no way to reach a page the reader had navigated to.
 *
 * They are joined: the phase rides the SAME poll as the status. These guards
 * are for the joins, because each one fails silently rather than loudly:
 *
 *  - a phase-only change dropped by the store never throws, the bar just stops
 *    moving while the agent works;
 *  - a route that falls back to the heavy reader still answers correctly, it
 *    just fetches every step's `output` four times a second per watched run;
 *  - a raw step id reaching a browser renders fine, in jargon.
 */

const ROOT = join(__dirname, "..", "..", "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");
const code = (rel: string) =>
  read(rel).replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

const ROUTE = code("src/app/api/runs/[id]/progress/route.ts");
const WATCH = code("src/components/run-watch.tsx");
const DOCK = code("src/components/run-progress-dock.tsx");
const DIALOG = code("src/components/custom-agents.tsx");

describe("the progress route", () => {
  it("reads the run lean, not the full view", () => {
    // Both reconcile predicates read `view.run` and nothing else; the full
    // reader pulls every step's output and the gate payload to answer that.
    expect(ROUTE).toContain("readAgentEngineRunProgress(");
    expect(ROUTE).not.toMatch(/\breadAgentEngineRun\(/);
  });

  it("resolves the phase server-side, so no engine step id crosses", () => {
    expect(ROUTE).toContain("phaseProgress(");
    // The raw step fields may appear only as ARGUMENTS to `phaseProgress`,
    // which turns them into the six client words. Cut that call out of the
    // response body and nothing engine-shaped may be left in it.
    const body = ROUTE.slice(ROUTE.indexOf("const body: RunProgressView"));
    const call = body.indexOf("phaseProgress(");
    expect(call).toBeGreaterThan(-1);
    let depth = 0;
    let end = body.indexOf("(", call);
    for (let i = end; i < body.length; i++) {
      if (body[i] === "(") depth++;
      else if (body[i] === ")" && --depth === 0) {
        end = i;
        break;
      }
    }
    const rest = body.slice(0, call) + body.slice(end + 1);
    for (const raw of ["currentStepId", "currentStepKind", "recordedStepIds"]) {
      expect(rest, `${raw} is sent to the browser raw`).not.toContain(raw);
    }
  });

  it("sends no phase for a run that stopped", () => {
    // There is no honest phase for work that did not happen; the outcome
    // sentence says what to do instead.
    expect(ROUTE).toMatch(/outcome !== "stopped"/);
  });
});

describe("the watch", () => {
  it("counts a phase change as a change, while the status stays `running`", () => {
    // Writing → visuals is one status and two phases. Comparing only the
    // status would freeze the bar for the whole of the part worth watching.
    expect(WATCH).toMatch(/phaseMoved/);
    expect(WATCH).toMatch(/hit\.status === r\.status && !phaseMoved/);
  });

  it("never restores a phase from storage", () => {
    // A phase read back after a reload can be minutes stale.
    expect(WATCH).toMatch(/\.map\(\(\{ phase: _phase, \.\.\.rest \}\) => rest\)/);
  });
});

describe("the two surfaces that paint it", () => {
  it("prefer the phase and keep the ladder for runs with no engine behind them", () => {
    for (const [name, src] of [["dock", DOCK], ["started panel", DIALOG]] as const) {
      expect(src, name).toContain("<AgentRunProgress");
      expect(src, name).toContain("<ManagedJobProgress");
    }
  });

  it("drop the estimate beside a named step", () => {
    // A number standing next to the thing it was guessing at.
    for (const [name, src] of [["dock", DOCK], ["started panel", DIALOG]] as const) {
      expect(src, name).toMatch(/outcome === "working" && !(run\.)?phase \?/);
    }
  });

  it("keep the dock compact: bar and headline, no six-row list", () => {
    const at = DOCK.indexOf("<AgentRunProgress");
    expect(DOCK.slice(at, at + 200)).toContain("steps={[]}");
  });
});
