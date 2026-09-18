import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * ── B1'S READER (SCRUM-493). ──
 *
 * The writing half of the subject table has been live for a while; the reading
 * half did not exist in this repo at all — the middleware served
 * `GET /clients/{slug}/learning/{platform}/subjects` and nothing called it. So
 * the anti-repetition window was a thing the agents could see and the people
 * running the account could not.
 *
 * The two things this file is really about are both about NOT LYING:
 *
 * 1. `undefined` (could not ask) and `[]` (asked, nothing there) stay apart all
 *    the way to the surface. Collapsing them tells an operator "nothing drafted
 *    yet" about a client with a hundred rows and an unreachable control plane —
 *    the same class of quiet wrong answer the loop has already produced once.
 * 2. One platform failing costs the others nothing. A client with five channels
 *    and one unreachable platform gets four tables and is told which one is
 *    missing, rather than an empty pane.
 */

const { fetchMock, baseUrlMock } = vi.hoisted(() => ({ fetchMock: vi.fn(), baseUrlMock: vi.fn() }));

vi.mock("server-only", () => ({}));
vi.mock("../middleware-http", async (importOriginal) => ({
  // `MiddlewareRequestError` is kept REAL: the catch below reads `status` and
  // `detail` off it, and a stubbed stand-in would let the logging drift from the
  // class that actually ships.
  ...(await importOriginal<typeof import("../middleware-http")>()),
  middlewareBaseUrl: baseUrlMock,
  middlewareFetch: fetchMock,
}));

import { readSubjectRows, readSubjectRowsByPlatform, summariseSubjects, type SubjectRow } from "../learning-subjects";
import { MiddlewareRequestError } from "../middleware-http";

const CLIENT = { agentsRepoSlug: "acme" };

/** A row exactly as the middleware's `_subject_row` serialises one. */
function row(patch: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    runId: "run-7",
    subject: "Why calendars fail in month two",
    stage: "attention",
    status: "drafted",
    draftedAt: "2026-09-17T09:00:00+00:00",
    ...patch,
  };
}

beforeEach(() => {
  baseUrlMock.mockReset().mockReturnValue("https://agent-middleware-abc-uc.a.run.app");
  fetchMock.mockReset().mockResolvedValue({ rows: [row()] });
});

describe("asking for the table", () => {
  it("reads the platform's rows, newest first, and caps the page", async () => {
    const rows = await readSubjectRows(CLIENT, "x", { limit: 50 });

    expect(fetchMock).toHaveBeenCalledWith("/clients/acme/learning/x/subjects?limit=50");
    expect(rows).toHaveLength(1);
    expect(rows![0]).toMatchObject({ runId: "run-7", subject: "Why calendars fail in month two", stage: "attention" });
  });

  it("escapes the slug rather than pasting it into the path", async () => {
    await readSubjectRows({ agentsRepoSlug: "a c/me" }, "x");
    expect(fetchMock.mock.calls[0]![0]).toBe("/clients/a%20c%2Fme/learning/x/subjects?limit=100");
  });

  it("clamps a caller's limit to what the endpoint accepts", async () => {
    // The middleware refuses anything over 500 with a 422; sending it would turn
    // a too-eager caller into a broken pane rather than a large one.
    await readSubjectRows(CLIENT, "x", { limit: 5000 });
    expect(fetchMock.mock.calls[0]![0]).toContain("limit=500");
    await readSubjectRows(CLIENT, "x", { limit: 0 });
    expect(fetchMock.mock.calls[1]![0]).toContain("limit=1");
  });
});

describe("`could not ask` is not `nothing there`", () => {
  it("answers undefined for a client that is not on the engine", async () => {
    expect(await readSubjectRows({ agentsRepoSlug: undefined }, "x")).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("answers undefined when there is no control plane in this environment", async () => {
    baseUrlMock.mockReturnValue(undefined);
    expect(await readSubjectRows(CLIENT, "x")).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("answers undefined when the call fails, and never throws", async () => {
    fetchMock.mockRejectedValue(new MiddlewareRequestError("boom", { status: 503, detail: "bucket not configured" }));
    await expect(readSubjectRows(CLIENT, "x")).resolves.toBeUndefined();
  });

  it("answers an EMPTY ARRAY when the client simply has no rows", async () => {
    // The distinction this whole file exists for.
    fetchMock.mockResolvedValue({ rows: [] });
    expect(await readSubjectRows(CLIENT, "x")).toEqual([]);
  });

  it("answers an empty array for a body with no rows key, rather than undefined", async () => {
    // A 200 with a shape we did not expect is still an answer; treating it as a
    // failure would hide a contract change behind "the control plane is down".
    fetchMock.mockResolvedValue({});
    expect(await readSubjectRows(CLIENT, "x")).toEqual([]);
  });
});

describe("a row the UI cannot render is dropped, not passed through", () => {
  it("drops a row whose stage or status is outside the table's own CHECK constraints", async () => {
    // Both columns are CHECK-constrained in `0007_learning_loop.sql`, so a value
    // outside them means the contract moved. Rendering it would paint a status
    // chip with no colour and a stage column nobody can group by.
    fetchMock.mockResolvedValue({
      rows: [row(), row({ id: "2", stage: "consideration" }), row({ id: "3", status: "published" })],
    });
    const rows = await readSubjectRows(CLIENT, "x");
    expect(rows).toHaveLength(1);
    expect(rows![0]!.id).toBe("11111111-1111-1111-1111-111111111111");
  });

  it("drops a row missing any of the fields the table is keyed on", async () => {
    fetchMock.mockResolvedValue({ rows: [row({ subject: undefined }), row({ id: undefined }), row({ runId: undefined }), null, "nope"] });
    expect(await readSubjectRows(CLIENT, "x")).toEqual([]);
  });

  it("keeps the goal line when the run wrote one, and omits it when it did not", async () => {
    // `goal` / `audience` / `whyNow` are what make this a reporting row rather
    // than a list of titles — the same three the client sees on the card.
    fetchMock.mockResolvedValue({ rows: [row({ goal: "earn attention", audience: "heads of marketing", whyNow: "Q4 planning" })] });
    expect((await readSubjectRows(CLIENT, "x"))![0]).toMatchObject({
      goal: "earn attention",
      audience: "heads of marketing",
      whyNow: "Q4 planning",
    });

    fetchMock.mockResolvedValue({ rows: [row()] });
    expect((await readSubjectRows(CLIENT, "x"))![0]).not.toHaveProperty("goal");
  });
});

describe("several platforms at once", () => {
  it("asks for each platform and keys the answer by it", async () => {
    fetchMock.mockImplementation(async (path: string) =>
      path.includes("/linkedin/") ? { rows: [row({ id: "li" })] } : { rows: [row({ id: "x" })] },
    );

    const byPlatform = await readSubjectRowsByPlatform(CLIENT, ["x", "linkedin"]);

    expect(Object.keys(byPlatform).sort()).toEqual(["linkedin", "x"]);
    expect(byPlatform["linkedin"]![0]!.id).toBe("li");
  });

  it("one platform failing leaves the others whole, and is reported as undefined", async () => {
    fetchMock.mockImplementation(async (path: string) => {
      if (path.includes("/reddit/")) throw new MiddlewareRequestError("down", { status: 502, detail: "bad gateway" });
      return { rows: [row()] };
    });

    const byPlatform = await readSubjectRowsByPlatform(CLIENT, ["x", "reddit", "linkedin"]);

    expect(byPlatform["x"]).toHaveLength(1);
    expect(byPlatform["linkedin"]).toHaveLength(1);
    expect(byPlatform["reddit"]).toBeUndefined();
  });
});

describe("the summary a reader actually scans", () => {
  const rows = (...specs: Array<Partial<SubjectRow>>): SubjectRow[] =>
    specs.map((s, i) => ({
      id: `r${i}`,
      runId: `run-${i}`,
      subject: `s${i}`,
      stage: "attention",
      status: "drafted",
      ...s,
    })) as SubjectRow[];

  it("counts the stage mix, which is what D32 is about", () => {
    const summary = summariseSubjects(
      rows({ stage: "attention" }, { stage: "attention" }, { stage: "expertise" }, { stage: "decide" }),
    );
    expect(summary.stages).toEqual({ attention: 2, expertise: 1, decide: 1 });
    expect(summary.total).toBe(4);
  });

  it("counts `posted` by STATUS, not by the presence of a timestamp", () => {
    // A row can carry `postedAt` from a later correction while its status says
    // something else, and the status is what the loop reads.
    const summary = summariseSubjects(
      rows({ status: "posted" }, { status: "approved", postedAt: "2026-09-17T10:00:00+00:00" }, { status: "skipped" }),
    );
    expect(summary.posted).toBe(1);
  });

  it("reports the newest draft date, and nothing when no row carries one", () => {
    expect(
      summariseSubjects(rows({ draftedAt: "2026-09-10T00:00:00+00:00" }, { draftedAt: "2026-09-17T00:00:00+00:00" }))
        .newestDraftedAt,
    ).toBe("2026-09-17T00:00:00+00:00");
    expect(summariseSubjects(rows({})).newestDraftedAt).toBeUndefined();
  });

  it("is all zeroes for an empty table rather than throwing", () => {
    expect(summariseSubjects([])).toEqual({ total: 0, posted: 0, stages: { attention: 0, expertise: 0, decide: 0 } });
  });
});
