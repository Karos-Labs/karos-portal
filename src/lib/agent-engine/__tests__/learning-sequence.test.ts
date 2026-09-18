import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * ── `slotStage`: THE ONE FIELD SEQUENCING OWNS (SCRUM-468 bullet 2). ──
 *
 * `docs/agent-architecture.md` §1.1 and the engine's `stageForRun` have both
 * expected this field since the standard was written. Nothing in this repo has
 * ever sent one, so every scheduled fire looked exactly like someone pressing
 * Run, and the decision the calendar exists to make was taken by the fallback
 * on every single run.
 *
 * The two halves worth testing are the two halves of the sentence: a CALENDAR
 * run gets a stage, and a manual one deliberately does NOT — the absence is
 * information, and a helpful default would quietly override the person who
 * chose this moment.
 */

const { fetchMock, baseUrlMock } = vi.hoisted(() => ({ fetchMock: vi.fn(), baseUrlMock: vi.fn() }));

vi.mock("server-only", () => ({}));
vi.mock("../middleware-http", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../middleware-http")>()),
  middlewareBaseUrl: baseUrlMock,
  middlewareFetch: fetchMock,
}));

import { readSequence, slotStageForCalendarRun, slotStageForRun } from "../learning-sequence";
import { MiddlewareRequestError } from "../middleware-http";

const CLIENT = { agentsRepoSlug: "acme" };

function slot(patch: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    slot: 1,
    stage: "attention",
    subject: "Why intake queues break in month two",
    goal: "earn attention",
    rowId: "sm-1",
    source: "strategy-map",
    reason: "attention was furthest behind the mix; ranked no performance data, map order",
    ...patch,
  };
}

function body(slots: unknown[] = [slot()], patch: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    platform: "x",
    slots,
    unfilled: 0,
    mix: { attention: 3, expertise: 2, decide: 1 },
    notes: ["Ranked by the map's own order: the what-works summary does not exist yet (02 §3.4)."],
    ...patch,
  };
}

beforeEach(() => {
  baseUrlMock.mockReset().mockReturnValue("https://agent-middleware-abc-uc.a.run.app");
  fetchMock.mockReset().mockResolvedValue(body());
});

describe("asking for the plan", () => {
  it("asks the platform's sequence endpoint and escapes the slug", async () => {
    await readSequence({ agentsRepoSlug: "a c/me" }, "x", { slots: 6 });
    expect(fetchMock).toHaveBeenCalledWith("/clients/a%20c%2Fme/learning/x/sequence?slots=6");
  });

  it("clamps a caller's slot count to what the endpoint accepts", async () => {
    // Outside 1..60 the middleware answers 422, which would turn a too-eager
    // caller into a missing plan rather than a shorter one.
    await readSequence(CLIENT, "x", { slots: 900 });
    expect(fetchMock.mock.calls[0]![0]).toContain("slots=60");
    await readSequence(CLIENT, "x", { slots: 0 });
    expect(fetchMock.mock.calls[1]![0]).toContain("slots=1");
  });

  it("carries the slot, what it could not do, and what it could not see", async () => {
    const plan = await readSequence(CLIENT, "x");
    expect(plan!.slots[0]).toMatchObject({ stage: "attention", rowId: "sm-1", goal: "earn attention" });
    expect(plan!.unfilled).toBe(0);
    // `notes` is how the plan says the what-works summary does not exist. A
    // reader that drops it cannot tell a performance ranking from map order.
    expect(plan!.notes[0]).toContain("what-works");
  });

  it("drops a slot with an off-funnel stage or no subject, and keeps the rest", async () => {
    fetchMock.mockResolvedValue(
      body([slot(), slot({ slot: 2, stage: "consideration" }), slot({ slot: 3, subject: "  " })]),
    );
    expect((await readSequence(CLIENT, "x"))!.slots).toHaveLength(1);
  });
});

describe("`no plan` and `could not ask` are different answers", () => {
  it("returns NULL for a client whose first run has not happened yet", async () => {
    // The map is built lazily, so this is every client between setup and their
    // first draft.
    fetchMock.mockResolvedValue(null);
    expect(await readSequence(CLIENT, "x")).toBeNull();
  });

  it("returns UNDEFINED when the question could not be asked", async () => {
    expect(await readSequence({ agentsRepoSlug: undefined }, "x")).toBeUndefined();
    baseUrlMock.mockReturnValue(undefined);
    expect(await readSequence(CLIENT, "x")).toBeUndefined();
  });

  it("returns undefined when the call fails, and never throws", async () => {
    fetchMock.mockRejectedValue(new MiddlewareRequestError("down", { status: 502, detail: "bad gateway" }));
    await expect(readSequence(CLIENT, "x")).resolves.toBeUndefined();
  });
});

describe("the stage a calendar run is given", () => {
  it("is the FIRST slot's, because that is what goes out next", async () => {
    fetchMock.mockResolvedValue(body([slot({ stage: "expertise" }), slot({ slot: 2, stage: "decide" })]));
    expect(await slotStageForRun(CLIENT, "x")).toBe("expertise");
  });

  it("asks for one slot, not six", async () => {
    await slotStageForRun(CLIENT, "x");
    expect(fetchMock.mock.calls[0]![0]).toContain("slots=1");
  });

  it("is undefined for every reason there is no plan, and they are all survivable", async () => {
    // The engine derives a stage from history when the field is absent, so all
    // three of these cost a run its sequencing and nothing else.
    fetchMock.mockResolvedValue(null);
    expect(await slotStageForRun(CLIENT, "x")).toBeUndefined();

    fetchMock.mockResolvedValue(body([], { unfilled: 4 }));
    expect(await slotStageForRun(CLIENT, "x")).toBeUndefined();

    fetchMock.mockRejectedValue(new MiddlewareRequestError("down", { status: 503, detail: "no db" }));
    expect(await slotStageForRun(CLIENT, "x")).toBeUndefined();
  });
});

describe("only a calendar run gets one", () => {
  it("a SCHEDULED fire on a platform product carries the stage", async () => {
    expect(await slotStageForCalendarRun(CLIENT, "x-agent", "scheduled")).toEqual({
      slotStage: "attention",
    });
  });

  it.each(["manual", "manual_template", "launch", "test", undefined] as const)(
    "a %s run carries none, and does not even ask",
    async (runType) => {
      // §1.1: "Do not send `slotStage` on a manual run to 'be helpful'. The
      // absence is information." A person who pressed Run chose this moment
      // for a reason the calendar knows nothing about.
      expect(await slotStageForCalendarRun(CLIENT, "x-agent", runType)).toEqual({});
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it("a product with no platform carries none", async () => {
    // The SEO audit, the landing builder: no funnel to take a stage from.
    expect(await slotStageForCalendarRun(CLIENT, "seo-geo-agent", "scheduled")).toEqual({});
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("a scheduled fire the control plane could not answer for carries none rather than failing", async () => {
    fetchMock.mockRejectedValue(new MiddlewareRequestError("down", { status: 503, detail: "no db" }));
    await expect(slotStageForCalendarRun(CLIENT, "x-agent", "scheduled")).resolves.toEqual({});
  });
});
