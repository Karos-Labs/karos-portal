import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { isStringDelimiter, matchingBrace, skipStringLiteral, stripComments } from "./source-scan";
import type { Job, JobStatus } from "@/lib/types";

vi.mock("server-only", () => ({}));

const D = vi.hoisted(() => ({
  getAgentIntake: vi.fn(),
  getCustomAgentByKey: vi.fn(),
  listAgentIntake: vi.fn(),
  listClientSeats: vi.fn(),
  listCustomAgents: vi.fn(),
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

const { buildLinkedInAgentIntakeView, buildXAgentIntakeView } = await import(
  "@/lib/agent-intake-views"
);

/**
 * B3 — "a run is working right now and already has their details".
 *
 * That sentence is the seat-removal confirm's one honest disclosure: the agent
 * service already holds its own copy of the payload, the portal has no recall
 * channel, and a run started before the removal can still come back with drafts
 * for the person just removed.
 *
 * IT WAS SHOWN TO THE WRONG VIEWER. `runInFlight` was derived in the BROWSER
 * from the `runs` prop — the DISPLAY list. For staff that list is every run, so
 * staff (who never press this control on their own behalf, and who read every
 * batch anyway) got the warning. For a CLIENT the list is
 * `collapseRunsPerDay(jobs)`: one row per calendar day, newest kept, failures
 * exempt. A run queued at 09:00 leaves that list the moment a later run the
 * same day lands in any non-failed state — and a fire producing a week of
 * drafts is exactly why the collapse exists. So the client, the only viewer the
 * sentence is written for, was the one who never saw it.
 *
 * DRIVEN THROUGH THE CLIENT PROJECTION on purpose. The staff projection cannot
 * fail this: it is the one whose rows are not collapsed, so a test written
 * against it is green under the very bug.
 */

const REPO = path.resolve(__dirname, "../..", "..");
const read = (rel: string) => readFileSync(path.join(REPO, rel), "utf8");

/** Same calendar day, so the collapse has something to collapse. */
const at = (hour: number) => new Date(2026, 6, 20, hour, 0, 0).getTime();

function job(over: { id: string; agentName: string; status: JobStatus; createdAt: number }): Job {
  return {
    clientId: "c1",
    agentId: "agent-service",
    title: "run",
    input: {},
    assetIds: [],
    events: [],
    external: { serviceJobId: `svc-${over.id}`, taskType: "custom" as const },
    createdBy: "u1",
    updatedAt: over.createdAt,
    ...over,
  };
}

/**
 * The shape the probe found: a run that finished later in the day, and an
 * earlier one the agent service is still holding.
 */
const SURFACES = [
  {
    family: "x",
    build: (isStaff: boolean) => buildXAgentIntakeView("c1", { isStaff }),
    agentName: "Karos X Agent",
    component: "src/components/x-agent-intake.tsx",
  },
  {
    family: "linkedin",
    build: (isStaff: boolean) => buildLinkedInAgentIntakeView("c1", { isStaff }),
    agentName: "Karos LinkedIn Agent",
    component: "src/components/linkedin-agent-intake.tsx",
  },
] as const;

beforeEach(() => {
  vi.clearAllMocks();
  D.getAgentIntake.mockResolvedValue(null);
  D.getCustomAgentByKey.mockResolvedValue(null);
  D.listAgentIntake.mockResolvedValue([]);
  D.listClientSeats.mockResolvedValue([]);
  D.listCustomAgents.mockResolvedValue([]);
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

describe.each(SURFACES)("$family — the in-flight warning the client is shown", (surface) => {
  const delivered = () =>
    job({ id: "j-late", agentName: surface.agentName, status: "delivered", createdAt: at(10) });
  const queued = () =>
    job({ id: "j-early", agentName: surface.agentName, status: "queued", createdAt: at(9) });

  it("survives the collapse that hides the queued run from the client's list", async () => {
    D.listJobs.mockResolvedValue([delivered(), queued()]);

    const props = await surface.build(false);

    // NON-VACUITY FIRST: the collapse really did swallow the queued run, so the
    // assertion below is about a run this client's rows cannot see. Without
    // this the test would still pass if the collapse stopped collapsing.
    expect(props.runs).toHaveLength(1);
    expect(props.runs.map((r) => r.status)).not.toContain("queued");

    expect(props.runInFlight, "the client is not warned about the run in flight").toBe(true);
  });

  it("says the same thing to staff, whose rows were never collapsed", async () => {
    D.listJobs.mockResolvedValue([delivered(), queued()]);

    const props = await surface.build(true);

    // The staff list keeps both rows — which is why this projection could not
    // have caught the bug, and why the case above is the one that pins it.
    expect(props.runs).toHaveLength(2);
    expect(props.runInFlight).toBe(true);
  });

  it("does not warn when nothing is in flight", async () => {
    // The other direction. A confirm that always shows the sentence tells the
    // client a run is working when none is, which is its own false statement.
    D.listJobs.mockResolvedValue([
      delivered(),
      job({ id: "j-old", agentName: surface.agentName, status: "failed", createdAt: at(8) }),
    ]);

    expect((await surface.build(false)).runInFlight).toBe(false);
    expect((await surface.build(true)).runInFlight).toBe(false);
  });

  it("counts a run that is still working, not only one still queued", async () => {
    D.listJobs.mockResolvedValue([
      delivered(),
      job({ id: "j-run", agentName: surface.agentName, status: "running", createdAt: at(9) }),
    ]);
    expect((await surface.build(false)).runInFlight).toBe(true);
  });

  it("ignores another agent's run in flight", async () => {
    // The sentence names THIS agent's run. A queued job belonging to a
    // different agent would make every seat card on this page claim work is
    // under way for that person when none is.
    D.listJobs.mockResolvedValue([
      job({ id: "j-other", agentName: "Newsletter Agent", status: "queued", createdAt: at(9) }),
    ]);
    expect((await surface.build(false)).runInFlight).toBe(false);
  });

  it("keeps the answer off the display list, in the component too", () => {
    // The server can hand the right value over and the browser still throw it
    // away by computing its own. MECHANICAL, and keyed to the two arguments
    // rather than to a location: no local binding of that NAME, and no
    // predicate over `runs` — the display list — anywhere in the file. The
    // second closes the path the first leaves open, which is inlining
    // `runInFlight={runs.some(…)}` straight into the forward.
    const src = stripComments(read(surface.component));
    expect(src, `${surface.family} re-derives runInFlight in the browser`).not.toMatch(
      /(?:const|let|var)\s+runInFlight\b/,
    );

    // KEYED TO THE ARGUMENT, NOT TO A SPELLING. This forbade the literal string
    // `runs.some(` — so re-deriving the flag as
    // `runs.filter((r) => …).length > 0` at the SeatCard forward restored the
    // exact defect, and the whole 2560-test suite stayed green. The closed
    // question is not "which array method did they use" but "does every place
    // that SETS this prop pass the server's value through untouched".
    for (const value of propValues(src, "runInFlight")) {
      expect(
        value,
        `${surface.family} sets runInFlight to an expression instead of the server's prop: ` +
          `${value} — any derivation in the browser reads the collapsed display list`,
      ).toBe("{runInFlight}");
    }

    // Non-vacuity, both directions: the scan found the prop at all, and it does
    // reject the shapes it forbids — including the one the string match missed.
    expect(propValues(src, "runInFlight").length).toBeGreaterThan(0);
    expect(propValues('<X runInFlight={runs.some((r) => r.ok)} />', "runInFlight")).toEqual([
      "{runs.some((r) => r.ok)}",
    ]);
    expect(
      propValues('<X runInFlight={runs.filter((r) => r.ok).length > 0} />', "runInFlight"),
    ).toEqual(["{runs.filter((r) => r.ok).length > 0}"]);
  });
});

/**
 * Every value assigned to `name=` as a JSX prop, brace-matched so an expression
 * containing `>` or a nested object is read whole.
 *
 * Asked of the ARGUMENT rather than of a forbidden spelling: a guard that bans
 * `runs.some(` is one `.filter().length` away from being useless, and that is
 * not a hypothetical — it is the mutation that put this helper here.
 */
function propValues(src: string, name: string): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(new RegExp(`\\b${name}=`, "g"))) {
    const at = m.index! + m[0].length;
    if (src[at] === "{") {
      const close = matchingBrace(src, at);
      if (close > at) out.push(src.slice(at, close + 1));
      continue;
    }
    if (isStringDelimiter(src[at]!)) {
      const close = skipStringLiteral(src, at);
      if (close > at) out.push(src.slice(at, close + 1));
    }
  }
  return out;
}

describe("the server is the one place that answers it", () => {
  it("reads the unfiltered scan, not the rows it just collapsed", () => {
    const views = stripComments(read("src/lib/agent-intake-views.ts"));
    // One predicate, both surfaces — two copies is how one of them ends up
    // reading `runs` again.
    expect(views).toContain("function anyRunInFlight(");
    expect(views).toContain("runInFlight: anyRunInFlight(xJobs)");
    expect(views).toContain("runInFlight: anyRunInFlight(liJobs)");
    // `xJobs`/`liJobs` are the scans; `runs` is what toRunRowViews returned.
    expect(views).not.toMatch(/anyRunInFlight\(\s*runs\s*\)/);
  });
});
