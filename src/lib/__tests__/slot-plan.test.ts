import { describe, expect, it } from "vitest";
import {
  OPTIONS_PER_SLOT,
  assignOptionRefs,
  generateSlotHorizon,
  matchAssetsToSlots,
  reorderTemplateKeys,
  slotInstant,
  slotScheduleFor,
  validateSlotReorder,
  type OptionCandidate,
  type SlotSchedule,
} from "@/lib/slot-plan";
import { CHAIN_SLOT_HOUR } from "@/lib/post-chain";
import { dateKeyInZone } from "@/lib/client-agents";
import type { AgentSlot, Asset, PlannedScheduledRun } from "@/lib/types";

const ZONE = "America/Sao_Paulo";
/** Mon 2026-07-27, 09:00 in the schedule's zone. */
const NOW = Date.UTC(2026, 6, 27, 12, 0);

const activeSchedule: SlotSchedule = {
  // Mon / Wed / Fri
  weekdays: [1, 3, 5],
  timeZone: ZONE,
  status: "active",
};

function horizonInput(overrides: Partial<Parameters<typeof generateSlotHorizon>[0]> = {}) {
  return {
    clientId: "client-1",
    clientAgentId: "client-1__ig",
    rotation: ["playbook", "numbers"],
    schedule: activeSchedule,
    existingSlots: [] as Array<Pick<AgentSlot, "dateKey" | "templateKey">>,
    now: NOW,
    horizonDays: 14,
    ...overrides,
  };
}

/* ─────────────────────── reading the schedule row ──────────────────── */

describe("slotScheduleFor", () => {
  const run = {
    cadence: "weekly",
    weekdays: [1, 3, 3],
    weekday: 2,
    timeZone: ZONE,
    status: "active",
  } satisfies Pick<PlannedScheduledRun, "weekdays" | "weekday" | "timeZone" | "status" | "cadence">;

  it("prefers the multi-day weekdays array and de-duplicates it", () => {
    expect(slotScheduleFor(run, "UTC")).toEqual({
      weekdays: [1, 3],
      timeZone: ZONE,
      status: "active",
    });
  });

  it("falls back to the single weekday, and to the caller's zone on legacy rows", () => {
    expect(slotScheduleFor({ ...run, weekdays: [] }, "UTC")).toMatchObject({ weekdays: [2] });
    expect(slotScheduleFor({ ...run, timeZone: undefined }, "UTC")).toMatchObject({ timeZone: "UTC" });
  });

  it("plans nothing off a non-weekly cadence", () => {
    expect(slotScheduleFor({ ...run, cadence: "monthly" }, "UTC")).toBeNull();
  });
});

/* ───────────────────────── horizon generation ──────────────────────── */

describe("generateSlotHorizon", () => {
  it("fires only on the schedule's weekdays, in the schedule's zone", () => {
    const slots = generateSlotHorizon(horizonInput());
    expect(slots.map((s) => s.dateKey)).toEqual([
      "2026-07-27", // Mon
      "2026-07-29", // Wed
      "2026-07-31", // Fri
      "2026-08-03",
      "2026-08-05",
      "2026-08-07",
      "2026-08-10",
    ]);
    expect(slots.every((s) => s.status === "planned")).toBe(true);
    expect(slots[0].id).toBe("client-1__ig__2026-07-27");
  });

  it("cycles the rotation and never invents a template outside it", () => {
    const slots = generateSlotHorizon(horizonInput());
    expect(slots.slice(0, 4).map((s) => s.templateKey)).toEqual([
      "playbook",
      "numbers",
      "playbook",
      "numbers",
    ]);
  });

  it("skips days that already have a slot and never rewrites them", () => {
    const slots = generateSlotHorizon(
      horizonInput({
        existingSlots: [{ dateKey: "2026-07-29", templateKey: "numbers" }],
      }),
    );
    expect(slots.map((s) => s.dateKey)).not.toContain("2026-07-29");
  });

  it("continues the rotation where the existing plan left off", () => {
    const slots = generateSlotHorizon(
      horizonInput({
        existingSlots: [
          { dateKey: "2026-07-27", templateKey: "playbook" },
          { dateKey: "2026-07-29", templateKey: "numbers" },
        ],
      }),
    );
    // Next new day resumes at "playbook", not at rotation position 0 by luck.
    expect(slots[0]).toMatchObject({ dateKey: "2026-07-31", templateKey: "playbook" });
  });

  it("freezes extension while the schedule is paused (§4.4) and without a schedule", () => {
    expect(generateSlotHorizon(horizonInput({ schedule: { ...activeSchedule, status: "paused" } }))).toEqual([]);
    expect(generateSlotHorizon(horizonInput({ schedule: null }))).toEqual([]);
  });

  it("plans nothing when every template is paused (empty rotation)", () => {
    expect(generateSlotHorizon(horizonInput({ rotation: [] }))).toEqual([]);
  });

  it("plans one fixed-key options slot per firing day in options mode", () => {
    const slots = generateSlotHorizon(
      horizonInput({ kind: "options", optionsTemplateKey: "daily-post", rotation: [] }),
    );
    expect(slots.every((s) => s.kind === "options" && s.templateKey === "daily-post")).toBe(true);
    expect(slots.length).toBeGreaterThan(0);
  });

  it("is idempotent — re-running with its own output plans nothing new", () => {
    const first = generateSlotHorizon(horizonInput());
    const second = generateSlotHorizon(horizonInput({ existingSlots: first }));
    expect(second).toEqual([]);
  });
});

/* ─────────────────────── asset ↔ slot matching ─────────────────────── */

let seq = 0;
function labAsset(overrides: Partial<Asset> = {}): Asset {
  seq += 1;
  return {
    id: `asset-${seq}`,
    clientId: "client-1",
    type: "instagram_post",
    title: "Post",
    content: "Body",
    status: "draft",
    meta: { source: "lab-import" },
    createdBy: "staff-1",
    createdAt: NOW - 86_400_000,
    updatedAt: NOW - 86_400_000,
    ...overrides,
  };
}

function slot(overrides: Partial<AgentSlot> & { dateKey: string; templateKey: string }): AgentSlot {
  return {
    id: `slot-${overrides.dateKey}`,
    clientId: "client-1",
    clientAgentId: "client-1__ig",
    status: "planned",
    createdBy: "staff-1",
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

describe("matchAssetsToSlots", () => {
  const slots = [
    slot({ dateKey: "2026-07-29", templateKey: "playbook" }),
    slot({ dateKey: "2026-07-31", templateKey: "numbers" }),
    slot({ dateKey: "2026-08-03", templateKey: "playbook" }),
  ];

  it("fills each slot with the earliest unassigned asset OF THAT TEMPLATE", () => {
    const assets = [
      labAsset({ id: "p2", templateKey: "playbook", orderKey: "2026-07-02#b" }),
      labAsset({ id: "p1", templateKey: "playbook", orderKey: "2026-07-01#a" }),
      labAsset({ id: "n1", templateKey: "numbers", orderKey: "2026-07-05#a" }),
    ];
    const result = matchAssetsToSlots({ assets, slots, family: "social", timeZone: ZONE, now: NOW });
    expect(result.matches).toEqual([
      { slotId: "slot-2026-07-29", assetId: "p1", dateKey: "2026-07-29" },
      { slotId: "slot-2026-07-31", assetId: "n1", dateKey: "2026-07-31" },
      { slotId: "slot-2026-08-03", assetId: "p2", dateKey: "2026-08-03" },
    ]);
  });

  it("re-dates matched assets to CHAIN_SLOT_HOUR of their slot's day in the schedule's zone", () => {
    const assets = [labAsset({ id: "p1", templateKey: "playbook", orderKey: "2026-07-01#a" })];
    const result = matchAssetsToSlots({ assets, slots, family: "social", timeZone: ZONE, now: NOW });
    const assignment = result.assignments.find((a) => a.id === "p1");
    expect(assignment?.scheduledAt).toBe(slotInstant("2026-07-29", ZONE));
    expect(dateKeyInZone(assignment!.scheduledAt, ZONE)).toBe("2026-07-29");
    expect(new Date(assignment!.scheduledAt).getTime()).toBe(
      Date.UTC(2026, 6, 29, CHAIN_SLOT_HOUR + 3, 0), // Sao Paulo is UTC-3
    );
  });

  it("never moves an asset onto a past or same-day slot", () => {
    const past = [
      slot({ dateKey: "2026-07-20", templateKey: "playbook" }),
      slot({ dateKey: dateKeyInZone(NOW, ZONE), templateKey: "playbook" }),
    ];
    const assets = [labAsset({ templateKey: "playbook", orderKey: "2026-07-01#a" })];
    const result = matchAssetsToSlots({ assets, slots: past, family: "social", timeZone: ZONE, now: NOW });
    expect(result.matches).toEqual([]);
    expect(result.assignments).toEqual([]);
  });

  it("leaves non-candidates alone: published, staff-booked, placeholders, reference docs, foreign families", () => {
    const assets = [
      labAsset({ id: "published", templateKey: "playbook", status: "published" }),
      labAsset({ id: "booked", templateKey: "playbook", status: "approved", scheduledAt: NOW + 86_400_000 }),
      labAsset({ id: "placeholder", templateKey: "playbook", publishMode: "placeholder" }),
      labAsset({ id: "readme", templateKey: "template-ideas" }),
      labAsset({ id: "email", templateKey: "playbook", type: "email" }),
      labAsset({ id: "no-provenance", templateKey: "playbook", meta: {} }),
    ];
    const result = matchAssetsToSlots({ assets, slots, family: "social", timeZone: ZONE, now: NOW });
    expect(result.matches).toEqual([]);
    expect(result.unfilledSlotIds).toHaveLength(3);
  });

  it("reports leftovers and unfilled days instead of forcing a fit", () => {
    const assets = [
      labAsset({ id: "p1", templateKey: "playbook", orderKey: "2026-07-01#a" }),
      labAsset({ id: "p2", templateKey: "playbook", orderKey: "2026-07-02#a" }),
      labAsset({ id: "p3", templateKey: "playbook", orderKey: "2026-07-03#a" }),
    ];
    const result = matchAssetsToSlots({ assets, slots, family: "social", timeZone: ZONE, now: NOW });
    expect(result.matches.map((m) => m.assetId)).toEqual(["p1", "p2"]);
    expect(result.unmatchedAssetIds).toEqual(["p3"]);
    expect(result.unfilledSlotIds).toEqual(["slot-2026-07-31"]);
  });

  it("emits no assignment when the asset is already on its slot's instant", () => {
    const scheduledAt = slotInstant("2026-07-29", ZONE);
    const assets = [
      labAsset({ id: "p1", templateKey: "playbook", orderKey: "k", scheduledAt }),
    ];
    const result = matchAssetsToSlots({ assets, slots, family: "social", timeZone: ZONE, now: NOW });
    expect(result.matches).toHaveLength(1);
    expect(result.assignments).toEqual([]);
  });

  it("skips options slots — they present picks, they never re-date chain assets", () => {
    const optionSlots = [slot({ dateKey: "2026-07-29", templateKey: "daily-post", kind: "options" })];
    const assets = [labAsset({ templateKey: "daily-post", orderKey: "k" })];
    const result = matchAssetsToSlots({
      assets,
      slots: optionSlots,
      family: "social",
      timeZone: ZONE,
      now: NOW,
    });
    expect(result.matches).toEqual([]);
  });
});

/* ───────────────────────────── reordering ──────────────────────────── */

describe("validateSlotReorder", () => {
  const ctx = {
    slots: [
      slot({ id: "future", dateKey: "2026-08-01", templateKey: "playbook" }),
      slot({ id: "past", dateKey: "2026-07-01", templateKey: "playbook" }),
      slot({ id: "done", dateKey: "2026-08-05", templateKey: "playbook", status: "posted" }),
    ],
    activeTemplateKeys: ["playbook", "numbers"],
    todayKey: "2026-07-27",
  };

  it("accepts a future day moved to an active template", () => {
    expect(validateSlotReorder([{ slotId: "future", templateKey: "numbers" }], ctx)).toEqual({ ok: true });
  });

  it("refuses past days, posted days, unknown days, dead templates, and duplicates", () => {
    expect(validateSlotReorder([{ slotId: "past", templateKey: "numbers" }], ctx).ok).toBe(false);
    expect(validateSlotReorder([{ slotId: "done", templateKey: "numbers" }], ctx).ok).toBe(false);
    expect(validateSlotReorder([{ slotId: "ghost", templateKey: "numbers" }], ctx).ok).toBe(false);
    expect(validateSlotReorder([{ slotId: "future", templateKey: "retired" }], ctx).ok).toBe(false);
    expect(
      validateSlotReorder(
        [
          { slotId: "future", templateKey: "numbers" },
          { slotId: "future", templateKey: "playbook" },
        ],
        ctx,
      ).ok,
    ).toBe(false);
    expect(validateSlotReorder([], ctx).ok).toBe(false);
  });
});

describe("reorderTemplateKeys", () => {
  it("applies a partial reorder without dropping the streams it did not name", () => {
    expect(reorderTemplateKeys(["a", "b", "c"], ["c"])).toEqual(["c", "a", "b"]);
    expect(reorderTemplateKeys(["a", "b", "c"], ["c", "b", "a"])).toEqual(["c", "b", "a"]);
    expect(reorderTemplateKeys(["a", "b"], ["ghost", "b"])).toEqual(["b", "a"]);
  });
});

/* ──────────────────── options slots: the pick-of-3 selector ─────────── */

function candidate(ref: string, direction?: string, account?: string): OptionCandidate {
  return { ref, direction: direction ?? null, account: account ?? null };
}

describe("assignOptionRefs", () => {
  const days = [
    slot({ id: "d1", dateKey: "2026-07-28", templateKey: "daily-post", kind: "options" }),
    slot({ id: "d2", dateKey: "2026-07-29", templateKey: "daily-post", kind: "options" }),
  ];

  it("gives each day three options and never reuses a draft across days", () => {
    const pool = Array.from({ length: 6 }, (_, i) => candidate(`r${i}`, `dir${i}`));
    const assignments = assignOptionRefs(pool, days);
    expect(assignments).toHaveLength(2);
    expect(assignments[0].optionRefs).toHaveLength(OPTIONS_PER_SLOT);
    const all = assignments.flatMap((a) => a.optionRefs);
    expect(new Set(all).size).toBe(all.length);
  });

  it("is deterministic — the same batch and plan produce the same assignment", () => {
    const pool = Array.from({ length: 6 }, (_, i) => candidate(`r${i}`, `dir${i % 3}`));
    expect(assignOptionRefs(pool, days)).toEqual(assignOptionRefs(pool, days));
  });

  it("diversifies a day by direction rather than taking three of the same angle", () => {
    const pool = [
      candidate("a1", "news"),
      candidate("a2", "news"),
      candidate("a3", "news"),
      candidate("b1", "story"),
      candidate("c1", "teach"),
    ];
    const [first] = assignOptionRefs(pool, days);
    expect(first.optionRefs).toEqual(["a1", "b1", "c1"]);
  });

  it("falls back to distinct accounts, then to filling, when directions run out", () => {
    const pool = [
      candidate("a1", "news", "company"),
      candidate("a2", "news", "seat-1"),
      candidate("a3", "news", "company"),
    ];
    const [first] = assignOptionRefs(pool, days);
    expect(first.optionRefs).toEqual(["a1", "a2", "a3"]);
  });

  it("never reassigns a day that already has options or a pick", () => {
    const taken = [
      slot({
        id: "d1",
        dateKey: "2026-07-28",
        templateKey: "daily-post",
        kind: "options",
        optionRefs: ["x1", "x2", "x3"],
      }),
      days[1],
    ];
    const assignments = assignOptionRefs([candidate("r1"), candidate("r2"), candidate("r3")], taken);
    expect(assignments.map((a) => a.slotId)).toEqual(["d2"]);
  });

  it("leaves a day empty rather than presenting a 'pick of 3' with one card", () => {
    expect(assignOptionRefs([candidate("only")], days)).toEqual([]);
  });
});
