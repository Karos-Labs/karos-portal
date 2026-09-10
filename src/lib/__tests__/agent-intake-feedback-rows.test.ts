import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LiDraftFeedback, RedditDraftFeedback, XDraftFeedback } from "@/lib/types";

vi.mock("server-only", () => ({}));

const D = vi.hoisted(() => ({
  getAgentIntake: vi.fn(),
  getCustomAgentByKey: vi.fn(),
  listAgentIntake: vi.fn(),
  listClientSeats: vi.fn(),
  listJobs: vi.fn(),
  listLiDraftFeedback: vi.fn(),
  listLiDirectionRequests: vi.fn(),
  listLiAgentState: vi.fn(),
  listSeatVoiceProfiles: vi.fn(),
  listRedditDraftFeedback: vi.fn(),
  listXDraftFeedback: vi.fn(),
  listXNewsUpdates: vi.fn(),
  listXTakes: vi.fn(),
  getAgentProfileDocData: vi.fn(),
}));

vi.mock("@/lib/data", () => D);

const {
  buildLinkedInAgentIntakeView,
  buildRedditAgentIntakeView,
  buildXAgentIntakeView,
} = await import("@/lib/agent-intake-views");

/**
 * The recent-feedback list on the X (e13), LinkedIn (e10) and Reddit (e15)
 * intake surfaces, asked at the server boundary.
 *
 * `draftRef` is the feedback log's join key and is stored raw on purpose, so it
 * is the lab's own vocabulary: "Albert Kattan (seat 1, handle pending) · Avenue
 * 3 · News-reaction (live)". Two of the three surfaces printed it verbatim, and
 * a client's list read "Company page · feedback · Avenue 3 · News-reaction
 * (live) · 2 days ago" (#87).
 *
 * Asked of the PAYLOAD rather than of any rendered output: these props are
 * serialized across the RSC boundary, so "absent from the payload" and "not
 * rendered" are different guarantees and only the first one holds. The three
 * surfaces are driven from one table because the whole fix was to stop them
 * spelling the same rule three times.
 *
 * SCOPE. This file covers the draft label on the feedback rows and nothing else
 * about these builders — the run rows are pinned in intake-run-rows.test.ts, and
 * the intake redaction in agent-intake-gate.test.ts.
 */

/** The parenthetical the lab numbers its seats with. */
const BOOKKEEPING = "(seat 1, handle pending)";
const ACCOUNT_HEADING = `Albert Kattan ${BOOKKEEPING}`;

/**
 * Spellings the ordinal SHAPE can produce, forbidden on every surface. Absent
 * from the first version of this file, which is why Reddit's leak passed: the
 * sweep looked for the headline lab word ("Draft 1") while the client was
 * reading the lowercase tail of it, plus an internal program-mode enum.
 */
const NEVER_IN_A_CLIENT_PAYLOAD = ["draft 1", "warming", "Warming", "established"];

/**
 * One ref per surface, in each agent's own lane vocabulary, with the humanised
 * answer beside it. Spelled out rather than derived: an expectation computed by
 * calling the helper under test would pass whatever the helper does.
 */
const CASES = [
  {
    surface: "x",
    ref: `${ACCOUNT_HEADING} · Avenue 3 · News-reaction (live)`,
    label: "Reacting to the news · live",
    labWord: "Avenue",
    build: () => buildXAgentIntakeView("c1", { isStaff: false }),
    seed: (rows: unknown[]) => D.listXDraftFeedback.mockResolvedValue(rows),
  },
  {
    surface: "linkedin",
    ref: "Karos Labs — Company page · Post 2 · POV thread",
    label: "Your point of view (thread)",
    labWord: "Post 2",
    build: () => buildLinkedInAgentIntakeView("c1", { isStaff: false }),
    seed: (rows: unknown[]) => D.listLiDraftFeedback.mockResolvedValue(rows),
  },
  {
    surface: "reddit",
    // The REAL shape, per docs/reddit-agent-portal.md:135 —
    // `## Account 1 · <name> (u/<handle>) · <warming|established>`. The first
    // version of this fixture omitted the mandatory `(u/handle) · <mode>`, so the
    // account head was one segment like X's and the test passed while a client
    // actually read "Warming · draft 1 · thorough value answer".
    ref: "Karos Labs — company account (u/karos-al) · warming · Draft 1 · Thorough value answer",
    label: "Thorough value answer",
    labWord: "Draft 1",
    build: () => buildRedditAgentIntakeView("c1", { isStaff: false }),
    seed: (rows: unknown[]) => D.listRedditDraftFeedback.mockResolvedValue(rows),
  },
] as const;

function feedbackRow(draftRef?: string): XDraftFeedback & LiDraftFeedback & RedditDraftFeedback {
  return {
    id: "fb_1",
    clientId: "c1",
    account: "company",
    action: "note",
    ...(draftRef === undefined ? {} : { draftRef }),
    createdBy: "uid_a_client_person",
    createdAt: 1,
  } as XDraftFeedback & LiDraftFeedback & RedditDraftFeedback;
}

beforeEach(() => {
  vi.clearAllMocks();
  D.getAgentIntake.mockResolvedValue(null);
  D.getCustomAgentByKey.mockResolvedValue(null);
  D.listAgentIntake.mockResolvedValue([]);
  D.listClientSeats.mockResolvedValue([]);
  D.listJobs.mockResolvedValue([]);
  D.listLiDraftFeedback.mockResolvedValue([]);
  D.listLiDirectionRequests.mockResolvedValue([]);
  D.listLiAgentState.mockResolvedValue([]);
  D.listSeatVoiceProfiles.mockResolvedValue([]);
  D.listRedditDraftFeedback.mockResolvedValue([]);
  D.listXDraftFeedback.mockResolvedValue([]);
  D.listXNewsUpdates.mockResolvedValue([]);
  D.listXTakes.mockResolvedValue([]);
  D.getAgentProfileDocData.mockResolvedValue({ company: null, seats: {} });
});

describe.each(CASES)("the $surface intake's recent feedback", (testCase) => {
  it("carries the humanised lane and not the raw ref", async () => {
    testCase.seed([feedbackRow(testCase.ref)]);
    const props = await testCase.build();

    // Non-vacuity: the row reached the projection, and it says something.
    expect(props.feedback).toHaveLength(1);
    expect(props.feedback[0].draftLabel).toBe(testCase.label);

    const payload = JSON.stringify(props);
    expect(payload).not.toContain(testCase.ref);
    expect(payload).not.toContain(BOOKKEEPING);
    expect(payload).not.toContain(testCase.labWord);
    // Applied to ALL THREE surfaces, not just the one that leaked. Reddit's leak
    // was neither the ref nor its headline lab word: its account head is
    // multi-segment, so dropping one segment by position left an ordinal AND a
    // program-mode enum behind. No surface may print either.
    for (const word of NEVER_IN_A_CLIENT_PAYLOAD) {
      expect(payload, `${testCase.surface}: ${word}`).not.toContain(word);
    }
    // The raw key is gone from the shape too, not merely emptied: a component
    // cannot print what it was never handed.
    expect("draftRef" in props.feedback[0]).toBe(false);
  });

  it("says nothing about a draft when the row names none", async () => {
    // The neighbouring case for the assertion above: a free-form note is not
    // tied to a draft, and the row must not invent a label for it.
    testCase.seed([feedbackRow(undefined)]);
    const props = await testCase.build();
    expect(props.feedback).toHaveLength(1);
    expect("draftLabel" in props.feedback[0]).toBe(false);
    // And never the lane helper's card-heading fallback, which is a status word.
    expect(JSON.stringify(props.feedback)).not.toContain("Draft");
  });

  it("humanises a ref whose lane is unmapped rather than dropping the row", async () => {
    // An angle the copy table has no entry for still reads as a phrase; only a
    // ref with no lane at all goes unlabelled.
    testCase.seed([feedbackRow(`${ACCOUNT_HEADING} · Avenue 9 · SOME_NEW-lane`)]);
    const props = await testCase.build();
    expect(props.feedback[0].draftLabel).toBe("Some new lane");
    expect(JSON.stringify(props)).not.toContain(BOOKKEEPING);
  });

  it("labels nothing when the ref is an account heading with no lane after it", async () => {
    // A single segment cannot be told apart from an account title, so it yields
    // nothing rather than printing seat bookkeeping as if it were an angle.
    testCase.seed([feedbackRow(ACCOUNT_HEADING)]);
    const props = await testCase.build();
    expect("draftLabel" in props.feedback[0]).toBe(false);
    expect(JSON.stringify(props)).not.toContain(BOOKKEEPING);
  });
});
