import { describe, expect, it } from "vitest";
import { matchingBrace } from "./source-scan";
import { readFileSync } from "fs";
import { join } from "path";
import {
  firstNonFiniteScheduleField,
  parseWallClockTime,
  validateScheduleTiming,
} from "@/lib/scheduling";
import type { PlannedScheduledRun } from "@/lib/types";

/**
 * THE CLOSED QUESTION: can a number that is not a finite number leave a
 * schedule form and become a stored fire time?
 *
 * Two forms write PlannedScheduledRun — the client pace dialog
 * (custom-agents.tsx → configureClientAgentScheduleAction) and the staff
 * calendar dialog (schedule-run-modal.tsx → createPlannedRunAction) — and both
 * used to send whatever `time.split(":")` produced. An empty
 * `<input type="time">` is `""`: through `Number` that is hour 0 / minute
 * undefined (a midnight nobody chose), and through `parseInt` it is NaN (a fire
 * time that drifts, because NaN passes through Math.round/min/max unharmed).
 *
 * WHAT THESE TESTS COVER: the browser pre-flight. Every numeric field a
 * schedule form sends is finite before the server action is called, and an
 * unreadable time produces a message instead of a save.
 *
 * RESIDUAL, stated rather than implied: the server's own `clampInt`
 * (src/lib/actions/planned-run-actions.ts) is still NaN-transparent, so a
 * crafted server-action payload can still put a non-finite hour on a row. That
 * file belongs to another fixer this round and is untouched here; nothing below
 * claims otherwise.
 */

/** Every field PlannedScheduledRun stores as a number — derived from the type. */
type NumericScheduleField = {
  [K in keyof PlannedScheduledRun]-?: NonNullable<PlannedScheduledRun[K]> extends number
    ? K
    : never;
}[keyof PlannedScheduledRun];

const NUMERIC_SCHEDULE_FIELDS = [
  "hour",
  "minute",
  "weekday",
  "dayOfMonth",
  "outputsPerRun",
  "nextRunAt",
  "lastRunAt",
  "lastErrorAt",
  // Added by the scheduler-double-fire fixer in the same round as this file:
  // the claim→submit observability marker (PlannedScheduledRun.fireInFlightSince).
  // Listed here because the type-exhaustiveness check below is what demanded it.
  "fireInFlightSince",
  "createdAt",
  "updatedAt",
] as const satisfies readonly NumericScheduleField[];

const repoFile = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");

describe("parseWallClockTime", () => {
  it("reads a real wall clock", () => {
    expect(parseWallClockTime("09:30")).toEqual({ ok: true, hour: 9, minute: 30 });
    expect(parseWallClockTime("23:59")).toEqual({ ok: true, hour: 23, minute: 59 });
    expect(parseWallClockTime("9:05")).toEqual({ ok: true, hour: 9, minute: 5 });
  });

  it("keeps midnight reachable — an hour of 0 IS a time a client can pick", () => {
    // The whole defect is that an ABSENT choice looked like this one. Rejecting
    // falsy values would have closed the hole by taking midnight with it.
    expect(parseWallClockTime("00:00")).toEqual({ ok: true, hour: 0, minute: 0 });
    expect(parseWallClockTime("00:30")).toEqual({ ok: true, hour: 0, minute: 30 });
    expect(parseWallClockTime("12:00")).toEqual({ ok: true, hour: 12, minute: 0 });
  });

  it("tolerates the seconds a stepped time input can append", () => {
    expect(parseWallClockTime("09:30:00")).toEqual({ ok: true, hour: 9, minute: 30 });
  });

  it("refuses a cleared field instead of saving midnight", () => {
    for (const empty of ["", "   ", null, undefined]) {
      const result = parseWallClockTime(empty);
      expect(result.ok).toBe(false);
      expect(result).not.toHaveProperty("hour");
    }
  });

  it("refuses anything that is not a wall clock, rather than passing NaN on", () => {
    for (const bad of ["abc", "9", ":30", "09:", "24:00", "09:60", "-1:00", "1:2", "09-30", "NaN:NaN"]) {
      const result = parseWallClockTime(bad);
      expect(result.ok, `${bad} must not parse`).toBe(false);
    }
  });

  it("never yields a non-finite hour or minute for ANY input it accepts", () => {
    const candidates = [
      "",
      " ",
      "abc",
      "24:00",
      "09:60",
      "-1:-1",
      "1e3:00",
      "Infinity:00",
      "0x0:00",
      ...Array.from({ length: 24 }, (_, h) => `${String(h).padStart(2, "0")}:00`),
      ...Array.from({ length: 60 }, (_, m) => `07:${String(m).padStart(2, "0")}`),
    ];
    for (const raw of candidates) {
      const result = parseWallClockTime(raw);
      if (!result.ok) continue;
      expect(Number.isInteger(result.hour), `hour for ${raw}`).toBe(true);
      expect(Number.isInteger(result.minute), `minute for ${raw}`).toBe(true);
      expect(result.hour).toBeGreaterThanOrEqual(0);
      expect(result.hour).toBeLessThanOrEqual(23);
      expect(result.minute).toBeGreaterThanOrEqual(0);
      expect(result.minute).toBeLessThanOrEqual(59);
    }
  });

  it("hands back a sentence a person can act on, not an internal value", () => {
    for (const bad of ["", "nope"]) {
      const result = parseWallClockTime(bad);
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.error.length).toBeGreaterThan(10);
      expect(result.error).toMatch(/^[A-Z][\s\S]*\.$/);
      expect(result.error).not.toMatch(/NaN|undefined|null|hour|minute/);
    }
  });
});

describe("firstNonFiniteScheduleField", () => {
  it("sweeps every numeric field PlannedScheduledRun declares", () => {
    for (const field of NUMERIC_SCHEDULE_FIELDS) {
      expect(firstNonFiniteScheduleField({ [field]: Number.NaN })).toBe(field);
      expect(firstNonFiniteScheduleField({ [field]: Number.POSITIVE_INFINITY })).toBe(field);
      expect(firstNonFiniteScheduleField({ [field]: Number.NEGATIVE_INFINITY })).toBe(field);
    }
    // Non-empty and duplicate-free, so the loop above cannot pass vacuously.
    // The SIZE of the list is deliberately not pinned here — that would be the
    // same rule written twice, and the type check below already fixes it
    // exactly.
    expect(NUMERIC_SCHEDULE_FIELDS.length).toBeGreaterThan(0);
    expect(new Set<string>(NUMERIC_SCHEDULE_FIELDS).size).toBe(NUMERIC_SCHEDULE_FIELDS.length);
  });

  it("keeps that list exhaustive against the type", () => {
    type Unlisted = Exclude<NumericScheduleField, (typeof NUMERIC_SCHEDULE_FIELDS)[number]>;
    // The list is pinned to the type from BOTH sides, at compile time:
    //  · `satisfies readonly NumericScheduleField[]` above rejects a name the
    //    type does not declare as a number;
    //  · the line below rejects a numeric field the type declares and the list
    //    omits — `npx tsc --noEmit` fails on it, not this assertion.
    // So a schedule field added upstream cannot quietly escape the sweep.
    const everyNumericFieldIsListed: [Unlisted] extends [never] ? true : never = true;
    expect(everyNumericFieldIsListed).toBe(true);
  });

  it("lets a legitimate zero through", () => {
    for (const field of NUMERIC_SCHEDULE_FIELDS) {
      expect(firstNonFiniteScheduleField({ [field]: 0 })).toBeNull();
    }
    expect(firstNonFiniteScheduleField({ hour: 0, minute: 0, weekday: 0 })).toBeNull();
  });

  it("is not the server's business about absent fields", () => {
    expect(firstNonFiniteScheduleField({ outputsPerRun: undefined })).toBeNull();
    expect(firstNonFiniteScheduleField({})).toBeNull();
  });

  it("names the offending field even when a finite one is swept first", () => {
    expect(firstNonFiniteScheduleField({ hour: 9, minute: Number.NaN })).toBe("minute");
  });
});

describe("validateScheduleTiming", () => {
  it("passes a readable time and finite counts straight through", () => {
    expect(validateScheduleTiming({ time: "07:15", counts: { postsPerWeek: 3, outputsPerRun: 1 } }))
      .toEqual({ ok: true, hour: 7, minute: 15 });
  });

  it("refuses the save when a count is non-finite, without naming the field", () => {
    const result = validateScheduleTiming({ time: "07:15", counts: { postsPerWeek: Number.NaN } });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).not.toMatch(/postsPerWeek|NaN/);
  });

  it("reports the time problem first when both are wrong", () => {
    const result = validateScheduleTiming({ time: "", counts: { postsPerWeek: Number.NaN } });
    expect(result).toEqual(parseWallClockTime(""));
  });
});

describe("both schedule forms run the pre-flight before calling their action", () => {
  /** Everything the client pace dialog does before the server action is called. */
  function pacePreflight(): string {
    const src = repoFile("src/components/custom-agents.tsx");
    const start = src.indexOf("export function AgentScheduleModal");
    expect(start).toBeGreaterThan(-1);
    const end = src.indexOf("export function RunCustomAgentModal", start);
    expect(end).toBeGreaterThan(start);
    const modal = src.slice(start, end);
    const saveAt = modal.indexOf("function save() {");
    expect(saveAt).toBeGreaterThan(-1);
    const callAt = modal.indexOf("configureClientAgentScheduleAction(", saveAt);
    expect(callAt).toBeGreaterThan(saveAt);
    return modal.slice(saveAt, callAt);
  }

  /** Everything the staff calendar dialog does before the server action is called. */
  function staffPreflight(): string {
    const src = repoFile("src/components/schedule-run-modal.tsx");
    const start = src.indexOf("async function submit() {");
    expect(start).toBeGreaterThan(-1);
    const callAt = src.indexOf("createPlannedRunAction(", start);
    expect(callAt).toBeGreaterThan(start);
    return src.slice(start, callAt);
  }

  it("guards the client pace dialog and stops on failure", () => {
    const preflight = pacePreflight();
    expect(preflight).toContain("validateScheduleTiming(");
    // Keyed to the ARGUMENT: the counts this save sends are the counts swept.
    expect(preflight).toContain("counts: { postsPerWeek, outputsPerRun }");
    expect(preflight).toContain("setError(timing.error)");
    expect(preflight).toContain("return;");
  });

  it("guards the staff calendar dialog and stops on failure", () => {
    // The staff dialog validates once, in a memo the preview shares, so the
    // binding and the stop are asserted separately: `timing` must come from the
    // validator, and submit() must refuse before it calls the action.
    const src = repoFile("src/components/schedule-run-modal.tsx");
    expect(src).toMatch(/const timing\s*=\s*useMemo\(\s*\(\)\s*=>\s*validateScheduleTiming\(/);
    expect(src).toContain("validateScheduleTiming({ time, counts: { weekday, dayOfMonth } })");

    // THE STOP IS ASSERTED INSIDE THE GUARD'S OWN BLOCK, not anywhere in the
    // pre-flight. `toContain("return;")` over the whole slice was satisfied by
    // `if (!clientId) { setError("Pick a client."); return; }` — an unrelated
    // line — so the "and stops on failure" half of this test's name was
    // unverified, and a compilable reinstatement of the exact defect (an
    // unreadable time submitted as 00:00) left the suite green. This is the
    // `toContain`-on-a-repeated-string trap the campaign has now paid for four
    // times; the sibling assertion above only bites because that slice happens
    // to hold ONE return.
    const preflight = staffPreflight();
    const at = preflight.indexOf("if (!timing.ok)");
    expect(at, "the staff dialog no longer asks the validator before submitting").toBeGreaterThan(-1);
    const brace = preflight.indexOf("{", at);
    const block = preflight.slice(brace, matchingBrace(preflight, brace) + 1);
    expect(block, "the timing guard reports but does not stop").toContain("setError(timing.error)");
    expect(block, "the timing guard falls through to the action").toMatch(/\breturn\b/);
  });

  it("leaves no form splitting a raw time value into schedule numbers", () => {
    // The exact shape both defects had. Zero occurrences asserted, so this only
    // passes while it really is gone.
    for (const rel of ["src/components/custom-agents.tsx", "src/components/schedule-run-modal.tsx"]) {
      expect(repoFile(rel), rel).not.toContain('time.split(":")');
    }
  });

  it("leaves no `|| 0` substituting midnight for an unread hour", () => {
    const staff = repoFile("src/components/schedule-run-modal.tsx");
    expect(staff).not.toMatch(/hour:\s*hour\s*\|\|\s*0/);
    expect(staff).not.toMatch(/minute:\s*minute\s*\|\|\s*0/);
  });
});
