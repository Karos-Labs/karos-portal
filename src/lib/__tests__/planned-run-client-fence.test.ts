/* eslint-disable @typescript-eslint/no-explicit-any */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  isStringDelimiter,
  matchingBrace,
  matchingParen,
  skipStringLiteral,
  stripComments,
} from "./source-scan";

/**
 * #77 — ONE FILE, TWO RULES.
 *
 * `createPlannedRunAction` resolved the client and refused an employee assigned
 * to neither document ("You are not assigned to this client."). Its three
 * siblings did not: `configureClientAgentScheduleAction` and
 * `setPlannedRunStatusAction` asked `requireClientAccess` and
 * `deletePlannedRunAction` asked a bare `requireStaff`, and BOTH of those answer
 * a role question — every staff member passes for every client. So the same
 * employee, `notFound()`ed out of `/clients/C` and refused by every
 * `/api/clients/C` route, could set C's posting pace, pause, retire and DELETE
 * C's schedules.
 *
 * Driven for real: the actions, the real `_shared` authorizers and the real
 * `canViewClient`, with only the session and the data layer mocked. Each action
 * is asked the three questions the campaign's API fence is asked —
 *
 *   1. the refused actor IS refused, with the refusal the create path already
 *      used,
 *   2. the legitimate actors still work — an admin, an employee assigned on the
 *      CLIENT document, an employee assigned on the USER document (the field the
 *      team page actually writes), and the client whose workspace it is on the
 *      two actions that are theirs to use,
 *   3. nothing happened on the way out: a refused actor reaches no Firestore
 *      write. Asked by spying on the writes, not by reading the source for a
 *      fence above them.
 */

const CLIENT = { id: "c1", name: "Acme", assignedEmployeeIds: ["u-emp-1"], customAgentIds: ["ca1"] };

const ADMIN = { uid: "u-admin", role: "KAROS_ADMIN", clientId: null, disabled: false, createdAt: 0 };
/** Assigned on the CLIENT document. */
const ASSIGNED_ON_CLIENT = {
  uid: "u-emp-1",
  role: "KAROS_EMPLOYEE",
  clientId: null,
  disabled: false,
  createdAt: 0,
};
/** Assigned on the USER document — what the team page writes. */
const ASSIGNED_ON_USER = {
  uid: "u-emp-3",
  role: "KAROS_EMPLOYEE",
  clientId: null,
  assignedClientIds: ["c1"],
  disabled: false,
  createdAt: 0,
};
/** Neither document records the relationship. The actor this fence exists for. */
const UNASSIGNED = {
  uid: "u-emp-2",
  role: "KAROS_EMPLOYEE",
  clientId: null,
  disabled: false,
  createdAt: 0,
};
/** The client whose schedules these are. */
const OWN_CLIENT_USER = {
  uid: "u-client",
  role: "CLIENT_USER",
  clientId: "c1",
  disabled: false,
  createdAt: 0,
};

const LEGITIMATE_STAFF = [
  ["an admin", ADMIN],
  ["an employee assigned on the client document", ASSIGNED_ON_CLIENT],
  ["an employee assigned on the user document", ASSIGNED_ON_USER],
] as const;

const NOT_ASSIGNED = "You are not assigned to this client.";

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/data");
vi.mock("@/lib/auth", async (io) => ({
  ...(await io<typeof import("@/lib/auth")>()),
  getCurrentUser: vi.fn(),
}));
// The two product gates downstream of the fence. Neutralised so a refusal can
// only have come from the fence, never from a launch-state or intake block.
vi.mock("@/lib/client-agent-gate", () => ({ clientAgentRunRefusal: vi.fn(async () => null) }));
vi.mock("@/lib/jobs/schedule-gate", () => ({ unfireableScheduleReason: vi.fn(async () => null) }));

import * as data from "@/lib/data";
import { getCurrentUser } from "@/lib/auth";
import {
  configureClientAgentScheduleAction,
  createPlannedRunAction,
  deletePlannedRunAction,
  setPlannedRunStatusAction,
} from "@/lib/actions/planned-run-actions";

function as(user: unknown) {
  vi.mocked(getCurrentUser).mockResolvedValue(user as any);
}

const AGENT = {
  id: "ca1",
  key: "karos-instagram-agent",
  name: "Instagram agent",
  enabled: true,
  icon: "Bot",
  color: "#fff",
};

const RUN = {
  id: "pr1",
  clientId: "c1",
  customAgentId: "ca1",
  cadence: "weekly",
  hour: 9,
  minute: 0,
  status: "paused",
  nextRunAt: Date.now() + 86_400_000,
};

const CREATE_INPUT = {
  clientId: "c1",
  customAgentId: "ca1",
  prompt: "Draft a weekly post.",
  cadence: "once" as const,
  runAt: Date.now() + 86_400_000,
};

const PACE_INPUT = {
  clientId: "c1",
  customAgentId: "ca1",
  postsPerWeek: 3,
  outputsPerRun: 1,
  prompt: "Draft a weekly post.",
  hour: 9,
  minute: 0,
  timeZone: "UTC",
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(data.getClient).mockResolvedValue(CLIENT as any);
  vi.mocked(data.getCustomAgent).mockResolvedValue(AGENT as any);
  vi.mocked(data.getPlannedScheduledRun).mockResolvedValue(RUN as any);
  vi.mocked(data.listPlannedScheduledRuns).mockResolvedValue([]);
  vi.mocked(data.listJobs).mockResolvedValue([]);
  vi.mocked(data.createPlannedScheduledRun).mockResolvedValue("pr-new");
  vi.mocked(data.updatePlannedScheduledRun).mockResolvedValue(undefined);
  vi.mocked(data.deletePlannedScheduledRun).mockResolvedValue(undefined);
});

/** Every Firestore write these four actions can make. */
function expectNoWrites() {
  expect(data.createPlannedScheduledRun).not.toHaveBeenCalled();
  expect(data.updatePlannedScheduledRun).not.toHaveBeenCalled();
  expect(data.deletePlannedScheduledRun).not.toHaveBeenCalled();
}

describe("createPlannedRunAction — the path that already had the fence", () => {
  it("refuses an employee neither document assigns, and writes nothing", async () => {
    as(UNASSIGNED);
    expect(await createPlannedRunAction(CREATE_INPUT)).toEqual({ error: NOT_ASSIGNED });
    expectNoWrites();
  });

  it.each(LEGITIMATE_STAFF)("still schedules for %s", async (_label, user) => {
    as(user);
    expect(await createPlannedRunAction(CREATE_INPUT)).toEqual({ id: "pr-new" });
    expect(data.createPlannedScheduledRun).toHaveBeenCalledTimes(1);
  });
});

describe("configureClientAgentScheduleAction — the pace", () => {
  it("refuses an employee neither document assigns, and writes nothing", async () => {
    as(UNASSIGNED);
    expect(await configureClientAgentScheduleAction(PACE_INPUT)).toEqual({ error: NOT_ASSIGNED });
    expectNoWrites();
  });

  it("never reaches the agent read it would need to say anything else", async () => {
    // ORDER, asked as a fact about what the refused actor reached rather than
    // as "does a fence appear earlier in the file". The agent lookup is the
    // statement the fence now sits in front of.
    as(UNASSIGNED);
    await configureClientAgentScheduleAction(PACE_INPUT);
    expect(data.listPlannedScheduledRuns).not.toHaveBeenCalled();
  });

  it.each(LEGITIMATE_STAFF)("still sets the pace for %s", async (_label, user) => {
    as(user);
    const result = await configureClientAgentScheduleAction(PACE_INPUT);
    expect(result.error).toBeUndefined();
    expect(data.createPlannedScheduledRun).toHaveBeenCalledTimes(1);
  });

  it("still sets the pace for the client whose workspace it is", async () => {
    as(OWN_CLIENT_USER);
    const result = await configureClientAgentScheduleAction(PACE_INPUT);
    expect(result.error).toBeUndefined();
    expect(data.createPlannedScheduledRun).toHaveBeenCalledTimes(1);
  });
});

describe("setPlannedRunStatusAction — pause, resume, retire", () => {
  it("refuses an employee neither document assigns, and writes nothing", async () => {
    as(UNASSIGNED);
    expect(await setPlannedRunStatusAction("pr1", "active")).toEqual({ error: NOT_ASSIGNED });
    expectNoWrites();
  });

  it("refuses them on the reversible half too", async () => {
    // Pausing is the one transition this action allows everyone; "allowed to
    // everyone WHO MAY TOUCH THIS CLIENT" is still the rule.
    as(UNASSIGNED);
    vi.mocked(data.getPlannedScheduledRun).mockResolvedValue({ ...RUN, status: "active" } as any);
    expect(await setPlannedRunStatusAction("pr1", "paused")).toEqual({ error: NOT_ASSIGNED });
    expectNoWrites();
  });

  it.each(LEGITIMATE_STAFF)("still resumes for %s", async (_label, user) => {
    as(user);
    expect(await setPlannedRunStatusAction("pr1", "active")).toEqual({});
    expect(data.updatePlannedScheduledRun).toHaveBeenCalledTimes(1);
  });

  it("still pauses for the client whose schedule it is", async () => {
    as(OWN_CLIENT_USER);
    vi.mocked(data.getPlannedScheduledRun).mockResolvedValue({ ...RUN, status: "active" } as any);
    expect(await setPlannedRunStatusAction("pr1", "paused")).toEqual({});
    expect(data.updatePlannedScheduledRun).toHaveBeenCalledTimes(1);
  });
});

describe("deletePlannedRunAction — the one that cannot be undone", () => {
  it("refuses an employee neither document assigns, and deletes nothing", async () => {
    as(UNASSIGNED);
    expect(await deletePlannedRunAction("pr1")).toEqual({ error: NOT_ASSIGNED });
    expectNoWrites();
  });

  it.each(LEGITIMATE_STAFF)("still deletes for %s", async (_label, user) => {
    as(user);
    expect(await deletePlannedRunAction("pr1")).toEqual({});
    expect(data.deletePlannedScheduledRun).toHaveBeenCalledWith("pr1");
  });

  it("still refuses the client whose schedule it is — staff-only is unchanged", async () => {
    // The fence admits a CLIENT_USER for their own client; the ROLE gate is what
    // keeps delete staff-only, and widening one must not have widened the other.
    as(OWN_CLIENT_USER);
    await expect(deletePlannedRunAction("pr1")).rejects.toThrow("Forbidden");
    expectNoWrites();
  });
});

describe("the refusal says the true thing to whoever reads it", () => {
  it("tells an admin the client is missing, not that they are unassigned", async () => {
    // An admin is assigned to every client, so "You are not assigned to this
    // client." can only ever be false for them — the sole branch they can reach
    // is the missing document. A single shared sentence would be a lie at one
    // of the two sites, which is why there are two.
    as(ADMIN);
    vi.mocked(data.getClient).mockResolvedValue(null as any);
    expect(await createPlannedRunAction(CREATE_INPUT)).toEqual({ error: "Client not found." });
    expectNoWrites();
  });

  it("tells an unassigned employee the actionable thing instead", async () => {
    as(UNASSIGNED);
    expect(await createPlannedRunAction(CREATE_INPUT)).toEqual({ error: NOT_ASSIGNED });
  });
});

describe("a client user pointed at somebody else's workspace", () => {
  const OTHER_CLIENT_USER = { ...OWN_CLIENT_USER, uid: "u-client-2", clientId: "c2" };

  it("is refused the pace, and writes nothing", async () => {
    as(OTHER_CLIENT_USER);
    await expect(configureClientAgentScheduleAction(PACE_INPUT)).rejects.toThrow("Forbidden");
    expectNoWrites();
  });

  it("is refused the pause, and writes nothing", async () => {
    as(OTHER_CLIENT_USER);
    await expect(setPlannedRunStatusAction("pr1", "paused")).rejects.toThrow("Forbidden");
    expectNoWrites();
  });
});

/* ────────────────── the guard that outlives these four blocks ────────────────── */

/**
 * WHAT WOULD HAVE CAUGHT THE ORIGINAL: not a list of actions in a test file —
 * the create path's own test was green while its three siblings were open — but
 * the file. Every exported action in `planned-run-actions.ts` must reach the
 * shared fence, so a fifth one added tomorrow is a failure here until it does.
 *
 * WHAT IT DOES NOT CLAIM: it is a source scan. It proves each exported function
 * CALLS the fence (directly, or through this file's one authorizer); it cannot
 * prove the call is on the path the request takes. The four blocks above are
 * what prove that, per action, for the four that exist today.
 */
describe("every exported action in planned-run-actions.ts reaches the fence", () => {
  const FILE = join(process.cwd(), "src/lib/actions/planned-run-actions.ts");
  // stripComments first: this whole scan is about identifiers, and every one of
  // them appears in the prose above the code it describes.
  const src = stripComments(readFileSync(FILE, "utf8"));

  /**
   * The brace that opens the BODY, from the paren that closes the parameter
   * list. Not `indexOf("{")`: every action here is annotated
   * `): Promise<{ id?: string; error?: string }> {`, and the first brace after
   * the parameter list is the one inside that RETURN TYPE — which slices a
   * 31-character "body" containing no fence and passes nothing. Same walk
   * `server-action-authorizer-sweep` uses, for the same reason.
   */
  function bodyBraceAfter(s: string, closingParen: number): number {
    let angle = 0;
    for (let i = closingParen + 1; i < s.length; i++) {
      const ch = s[i]!;
      if (isStringDelimiter(ch)) {
        i = skipStringLiteral(s, i);
        continue;
      }
      if (ch === "<") angle++;
      else if (ch === ">") {
        if (s[i - 1] !== "=") angle--;
      } else if (ch === "{" && angle <= 0) return i;
      else if (ch === ";" && angle <= 0) return -1;
    }
    return -1;
  }

  /** Exported `async function`s, sliced from the brace after the PARAMETER LIST. */
  const actions = [...src.matchAll(/(?:^|\n)export\s+async\s+function\s+(\w+)\s*\(/g)].map((m) => {
    const openParen = m.index! + m[0].length - 1;
    const openBrace = bodyBraceAfter(src, matchingParen(src, openParen));
    const closeBrace = matchingBrace(src, openBrace);
    return { name: m[1]!, body: src.slice(openBrace, closeBrace + 1) };
  });

  it("found the actions it is about to check, and sliced every one", () => {
    // Non-vacuity twice over: an empty list makes every assertion below hold
    // over nothing, and a body that failed to slice is a body nothing searched.
    expect(actions.map((a) => a.name).sort()).toEqual([
      "configureClientAgentScheduleAction",
      "createPlannedRunAction",
      "deletePlannedRunAction",
      "setPlannedRunStatusAction",
    ]);
    for (const action of actions) {
      expect(action.body.startsWith("{"), `${action.name}: sliced from the wrong brace`).toBe(true);
      expect(action.body.length, `${action.name}: empty body`).toBeGreaterThan(50);
    }
  });

  it.each(
    // Built at collection time from the slice above rather than from a list
    // typed here, so a new action joins this table by existing.
    (() => actions.map((a) => [a.name, a.body] as const))(),
  )("%s", (_name, body) => {
    // The CALL, not the mention: the import line carries both identifiers too,
    // which is how a sweep passes over a guard that has been deleted.
    const asks =
      /\bclientAccessRefusal\s*\(/.test(body) || /\bauthorizeClient\s*\(/.test(body);
    expect(asks, "reaches neither clientAccessRefusal nor this file's authorizeClient").toBe(true);
  });

  it("has the file's own authorizer ask the shared rule", () => {
    // The delegation the table above allows, checked rather than assumed.
    const m = /function\s+authorizeClient\s*\(/.exec(src);
    expect(m, "authorizeClient no longer exists under that name").toBeTruthy();
    const openParen = m!.index + m![0].length - 1;
    const openBrace = src.indexOf("{", matchingParen(src, openParen));
    const body = src.slice(openBrace, matchingBrace(src, openBrace) + 1);
    expect(body).toMatch(/\bclientAccessRefusal\s*\(/);
  });
});
