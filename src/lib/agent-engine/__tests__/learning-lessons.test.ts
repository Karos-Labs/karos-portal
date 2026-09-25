import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The staff lessons panel's reader and its one control (SCRUM-508).
 *
 * Two things this file is about: the three states stay apart (`undefined`
 * could not ask, `null` nothing learned yet, a value), and a retire that did
 * not land is REPORTED, because a person told "retired" when it was not will
 * believe the agent ignored them next week.
 */

const { fetchMock, baseUrlMock } = vi.hoisted(() => ({ fetchMock: vi.fn(), baseUrlMock: vi.fn() }));

vi.mock("server-only", () => ({}));
vi.mock("../middleware-http", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../middleware-http")>()),
  middlewareBaseUrl: baseUrlMock,
  middlewareFetch: fetchMock,
}));

import { parseLearnedLessons, readLearnedLessons, setLessonRetired } from "../learning-lessons";
import { MiddlewareRequestError } from "../middleware-http";

const CLIENT = { agentsRepoSlug: "acme" };

const BODY = {
  neverTopics: [],
  standingInstructions: [],
  voiceNotes: [
    { lesson: "less jargon on slide one", fromRunId: "pubsub-1", source: "change_request" },
    { lesson: 'Takes "synergy" out: removed in 4 edits and never published once.', evidence: 4, source: "edits" },
    { lesson: "   ", source: "note" },
    { lesson: "odd source", source: "invented" },
  ],
  likes: [{ why: "posted as written", subject: "why pilots stall", runId: "pubsub-2", at: "2026-09-20T10:00:00Z" }, { why: "posted as written" }],
  retiredLessons: ["open with a question", 7],
  derivedAt: "2026-09-25T09:00:00Z",
  derivedFromCount: 12,
};

beforeEach(() => {
  fetchMock.mockReset();
  baseUrlMock.mockReset().mockReturnValue("https://middleware.test");
});

describe("parseLearnedLessons", () => {
  it("keeps what the panel can show, drops blanks, and never trusts an unknown source", () => {
    const parsed = parseLearnedLessons(BODY);
    expect(parsed.voiceLessons).toEqual([
      { lesson: "less jargon on slide one", source: "change_request", fromRunId: "pubsub-1" },
      { lesson: 'Takes "synergy" out: removed in 4 edits and never published once.', source: "edits", evidence: 4 },
      { lesson: "odd source" },
    ]);
    expect(parsed.likes).toEqual([{ subject: "why pilots stall", runId: "pubsub-2", at: "2026-09-20T10:00:00Z" }]);
    expect(parsed.retired).toEqual(["open with a question"]);
    expect(parsed.derivedFromCount).toBe(12);
  });

  it("an empty or malformed body is an empty record, not a crash", () => {
    expect(parseLearnedLessons(null)).toEqual({ voiceLessons: [], likes: [], retired: [] });
    expect(parseLearnedLessons({ voiceNotes: "nope" })).toEqual({ voiceLessons: [], likes: [], retired: [] });
  });
});

describe("readLearnedLessons", () => {
  it("null when the client has no preferences row yet, a value when it has, undefined when it cannot ask", async () => {
    fetchMock.mockResolvedValueOnce(null);
    expect(await readLearnedLessons(CLIENT)).toBeNull();

    fetchMock.mockResolvedValueOnce(BODY);
    expect((await readLearnedLessons(CLIENT))?.voiceLessons).toHaveLength(3);
    expect(fetchMock).toHaveBeenLastCalledWith("/clients/acme/learning/preferences");

    fetchMock.mockRejectedValueOnce(new MiddlewareRequestError("down", { status: 503, detail: "down" } as never));
    expect(await readLearnedLessons(CLIENT)).toBeUndefined();

    expect(await readLearnedLessons({ agentsRepoSlug: undefined } as never)).toBeUndefined();
    baseUrlMock.mockReturnValueOnce(undefined);
    expect(await readLearnedLessons(CLIENT)).toBeUndefined();
  });
});

describe("setLessonRetired", () => {
  it("posts to retire or restore with the lesson and who did it, and returns the re-derived list", async () => {
    fetchMock.mockResolvedValueOnce({ ...BODY, retiredLessons: ["less jargon on slide one"] });
    const retired = await setLessonRetired(CLIENT, { lesson: "  less jargon on slide one ", retired: true, updatedBy: "jane@karoslabs.com" });
    expect(retired.ok).toBe(true);
    expect(fetchMock).toHaveBeenLastCalledWith("/clients/acme/learning/preferences/lessons/retire", {
      method: "POST",
      body: { lesson: "less jargon on slide one", updatedBy: "jane@karoslabs.com" },
    });
    if (retired.ok) expect(retired.lessons.retired).toEqual(["less jargon on slide one"]);

    fetchMock.mockResolvedValueOnce(BODY);
    await setLessonRetired(CLIENT, { lesson: "less jargon on slide one", retired: false });
    expect(fetchMock.mock.calls.at(-1)![0]).toBe("/clients/acme/learning/preferences/lessons/restore");
  });

  it("reports a failure instead of pretending, and refuses a blank lesson without calling out", async () => {
    fetchMock.mockRejectedValueOnce(new Error("ECONNRESET"));
    const failed = await setLessonRetired(CLIENT, { lesson: "x", retired: true });
    expect(failed.ok).toBe(false);

    fetchMock.mockReset();
    const blank = await setLessonRetired(CLIENT, { lesson: "   ", retired: true });
    expect(blank.ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();

    const noSlug = await setLessonRetired({ agentsRepoSlug: undefined } as never, { lesson: "x", retired: true });
    expect(noSlug.ok).toBe(false);
  });
});
