import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * ── C1'S READ (SCRUM-486). ──
 *
 * The strategy map is built by the engine, kept by the middleware and consumed
 * by every draft. Nothing in this repo had ever looked at it, so the pool of
 * things a client is going to be told about — and how much of it is left — was
 * visible to the agents and to no one else.
 *
 * THREE ANSWERS, NOT TWO, and that is the whole shape of this file:
 *
 * - `undefined` — could not ask (not an engine client, no control plane, the
 *   call failed).
 * - `null` — asked, and this client has no map. **An ordinary state**: the
 *   engine builds the map lazily on the first drafting run, so every client
 *   between setup and their first run is here, and a surface that treats it as
 *   an error would shout at every new account.
 * - a map — there is one.
 */

const { fetchMock, baseUrlMock } = vi.hoisted(() => ({ fetchMock: vi.fn(), baseUrlMock: vi.fn() }));

vi.mock("server-only", () => ({}));
vi.mock("../middleware-http", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../middleware-http")>()),
  middlewareBaseUrl: baseUrlMock,
  middlewareFetch: fetchMock,
}));

import { readStrategyMap, readStrategyMapsByPlatform, summariseStrategyMap, type StrategyMap } from "../learning-strategy-map";
import { MiddlewareRequestError } from "../middleware-http";

const CLIENT = { agentsRepoSlug: "acme" };

/** The context payload as `GET /clients/{slug}/learning/{platform}` serialises it — by ALIAS. */
function context(map: unknown): Record<string, unknown> {
  return { platform: "x", settings: {}, feedback: { rows: [] }, "subject-window": { rows: [] }, "strategy-map": map };
}

function mapBody(rows: unknown[] = []): Record<string, unknown> {
  return {
    platform: "x",
    builtAt: "2026-09-10T08:00:00+00:00",
    source: "engine",
    audience: ["heads of marketing", "founders"],
    defaultMix: { attention: 3, expertise: 2, decide: 1 },
    rows,
  };
}

const rowBody = (patch: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: "row-1",
  problem: "calendars die in month two",
  stage: "attention",
  idea: "the month-two cliff",
  ...patch,
});

beforeEach(() => {
  baseUrlMock.mockReset().mockReturnValue("https://agent-middleware-abc-uc.a.run.app");
  fetchMock.mockReset().mockResolvedValue(context(mapBody([rowBody()])));
});

describe("reading the map", () => {
  it("asks the CONTEXT endpoint, because there is no GET for the map itself", () => {
    // Worth pinning: if a dedicated endpoint ever lands, this is the line that
    // says why this file took the long way round.
    return readStrategyMap(CLIENT, "x").then(() => {
      expect(fetchMock).toHaveBeenCalledWith("/clients/acme/learning/x");
    });
  });

  it("returns the map with its rows, audience and mix", async () => {
    const map = await readStrategyMap(CLIENT, "x");
    expect(map).toMatchObject({
      platform: "x",
      builtAt: "2026-09-10T08:00:00+00:00",
      source: "engine",
      audience: ["heads of marketing", "founders"],
      defaultMix: { attention: 3, expertise: 2, decide: 1 },
    });
    expect(map!.rows).toHaveLength(1);
    expect(map!.rows[0]).toMatchObject({ id: "row-1", idea: "the month-two cliff", stage: "attention" });
  });

  it("reads the camelCase key too, so an alias change does not silently empty the pane", async () => {
    fetchMock.mockResolvedValue({ platform: "x", strategyMap: mapBody([rowBody()]) });
    expect((await readStrategyMap(CLIENT, "x"))!.rows).toHaveLength(1);
  });
});

describe("no map is not the same as no answer", () => {
  it("returns NULL for a client whose first run has not happened yet", async () => {
    // The map is built lazily, so this is every client between setup and their
    // first draft — not an error, and not something to hide behind a spinner.
    fetchMock.mockResolvedValue(context(null));
    expect(await readStrategyMap(CLIENT, "x")).toBeNull();
  });

  it("returns null when the key is absent entirely", async () => {
    fetchMock.mockResolvedValue({ platform: "x", settings: {} });
    expect(await readStrategyMap(CLIENT, "x")).toBeNull();
  });

  it("returns UNDEFINED when the question could not be asked", async () => {
    expect(await readStrategyMap({ agentsRepoSlug: undefined }, "x")).toBeUndefined();
    baseUrlMock.mockReturnValue(undefined);
    expect(await readStrategyMap(CLIENT, "x")).toBeUndefined();
  });

  it("returns undefined when the call fails, and never throws", async () => {
    fetchMock.mockRejectedValue(new MiddlewareRequestError("down", { status: 502, detail: "bad gateway" }));
    await expect(readStrategyMap(CLIENT, "x")).resolves.toBeUndefined();
  });
});

describe("rows the panel cannot render", () => {
  it("drops a row with no id or an off-vocabulary stage, and keeps the rest", async () => {
    // `stage` is CHECK-constrained in the migration, and the id is how a subject
    // row points back at the idea it came from (`strategyRowId`).
    fetchMock.mockResolvedValue(
      context(mapBody([rowBody(), rowBody({ id: "row-2", stage: "consideration" }), rowBody({ id: undefined })])),
    );
    const map = await readStrategyMap(CLIENT, "x");
    expect(map!.rows).toHaveLength(1);
    expect(map!.rows[0]!.id).toBe("row-1");
  });

  it("survives a map with no rows array at all", async () => {
    fetchMock.mockResolvedValue(context({ platform: "x" }));
    const map = await readStrategyMap(CLIENT, "x");
    expect(map).toMatchObject({ rows: [], audience: [], defaultMix: {} });
  });
});

describe("several platforms", () => {
  it("keys each answer by platform and keeps one failure to itself", async () => {
    fetchMock.mockImplementation(async (path: string) => {
      if (path.endsWith("/reddit")) throw new MiddlewareRequestError("down", { status: 500, detail: "boom" });
      if (path.endsWith("/linkedin")) return context(null);
      return context(mapBody([rowBody()]));
    });

    const byPlatform = await readStrategyMapsByPlatform(CLIENT, ["x", "linkedin", "reddit"]);

    expect(byPlatform["x"]!.rows).toHaveLength(1);
    expect(byPlatform["linkedin"]).toBeNull();
    expect(byPlatform["reddit"]).toBeUndefined();
  });
});

describe("how much of the pool is left", () => {
  const map = (rows: Array<Partial<StrategyMap["rows"][number]>>): StrategyMap => ({
    platform: "x",
    audience: [],
    defaultMix: {},
    rows: rows.map((r, i) => ({ id: `r${i}`, stage: "attention", ...r })) as StrategyMap["rows"],
  });

  it("counts used by `usedByRunId`, not by status", () => {
    // The status vocabulary is the engine's and has moved once already; the run
    // id is set exactly when a draft came out of the row.
    const summary = summariseStrategyMap(
      map([{ usedByRunId: "run-1" }, { status: "used" }, { usedByRunId: "run-2" }, {}]),
    );
    expect(summary).toMatchObject({ total: 4, used: 2, remaining: 2 });
  });

  it("counts the stage mix so an empty stage is visible", () => {
    const summary = summariseStrategyMap(map([{ stage: "attention" }, { stage: "decide" }, { stage: "decide" }]));
    expect(summary.stages).toEqual({ attention: 1, expertise: 0, decide: 2 });
  });

  it("reports an exhausted pool as zero remaining rather than as empty", () => {
    // A map whose rows are all used and a map with no rows need different
    // answers: the first is a client about to repeat itself and needs a rebuild.
    expect(summariseStrategyMap(map([{ usedByRunId: "run-1" }]))).toMatchObject({ total: 1, remaining: 0 });
    expect(summariseStrategyMap(map([]))).toMatchObject({ total: 0, remaining: 0 });
  });
});
