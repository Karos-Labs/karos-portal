/* eslint-disable @typescript-eslint/no-explicit-any */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as data from "@/lib/data";
import { CREDIT_COSTS } from "@/lib/credits";

/**
 * WHO PAYS for a recurring agent fire — one decision, one field.
 *
 * `PlannedScheduledRun.billClientCredits` is documented as the switch for
 * whether each scheduled fire spends the client's credits. It used not to decide
 * that at all: the submit core charged purely on `isBillableClientActor(actor)`,
 * and the cron resolves the actor from `createdBy`. The two fields then drifted,
 * because the configure action recomputed the FLAG on every save (create AND
 * edit) while `createdBy` was frozen at creation — so whoever last touched the
 * pace rewrote the billing intent without touching the actor. Money moved the
 * wrong way in three distinct shapes:
 *
 *  1. Staff set the pace, the client later pressed Save → flag true, createdBy
 *     staff → every fire FREE, while the client's own dialog quoted "Estimated
 *     weekly cost: N credits".
 *  2. The client created the schedule, staff later bumped Outputs per run →
 *     flag false, createdBy the client → the client WAS charged, but at
 *     multiplier 1 while N drafts were produced.
 *  3. An admin in "View as Client" created it → the impersonated session carries
 *     the CLIENT's uid, so createdBy is the client and every fire charged them,
 *     while the flag (written from a non-billable impersonated actor) said false.
 *
 * These tests drive the REAL cron route through the REAL submit core with only
 * the data layer and the agent service mocked, so the assertions are on the
 * actual `chargeClientCredits` call each fire would make.
 */

vi.mock("server-only", () => ({}));
vi.mock("@/lib/data");
vi.mock("@/lib/data-client-agents");
vi.mock("@/lib/actions/_shared");
vi.mock("@/lib/job-alerts", () => ({
  notifyScheduleFireFailure: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/credit-reconcile", () => ({
  refundJobCharge: vi.fn().mockResolvedValue({ refunded: false }),
}));
vi.mock("@/lib/mcp/job-token", () => ({ mintJobToken: () => null }));
vi.mock("@/lib/agent-service/client", () => ({
  isAgentServiceConfigured: () => true,
  submitAgentServiceJob: vi.fn().mockResolvedValue({ job_id: "svc-1" }),
  cancelAgentServiceJob: vi.fn().mockResolvedValue({ status: "cancelled" }),
}));

process.env.NEXT_PUBLIC_APP_URL = "https://portal.test";

const AGENT_ID = "ca-instagram";
/** Bound to no client (no `-company-<slug>` suffix) and not an intake-gated agent. */
const AGENT_KEY = "karos-instagram-agent";
const UNIT = CREDIT_COSTS.customAgentRun;

const CLIENT_USER = {
  uid: "u-client",
  email: "client@acme.test",
  name: "Client User",
  role: "CLIENT_USER",
  disabled: false,
  clientId: "c1",
  createdAt: 0,
} as any;

const STAFF_USER = {
  uid: "u-staff",
  email: "staff@karoslabs.com",
  name: "Staff User",
  role: "KAROS_EMPLOYEE",
  disabled: false,
  clientId: null,
  createdAt: 0,
} as any;

function schedule(patch: Record<string, any> = {}): any {
  return {
    id: "pr1",
    clientId: "c1",
    customAgentId: AGENT_ID,
    agentName: "Instagram agent",
    agentIcon: "Camera",
    agentColor: "#0f0",
    prompt: "One post about the launch.",
    cadence: "weekly",
    hour: 9,
    minute: 0,
    weekdays: [1, 3, 5],
    nextRunAt: 1_000,
    status: "active",
    createdBy: CLIENT_USER.uid,
    createdAt: 0,
    updatedAt: 0,
    ...patch,
  };
}

/** Runs one cron tick over a single due schedule row. */
async function fire(run: any) {
  (data.listDuePlannedScheduledRuns as any).mockResolvedValue([run]);
  (data.claimPlannedScheduledRun as any).mockResolvedValue(true);
  const { GET } = await import("@/app/api/run-scheduled/route");
  const res = await GET(new Request("https://portal.test/api/run-scheduled") as any);
  return res.json();
}

/** The single charge a tick made, or null when it charged nothing. */
function charge() {
  const calls = (data.chargeClientCredits as any).mock.calls;
  expect(calls.length).toBeLessThan(2);
  return calls.length === 1 ? calls[0][0] : null;
}

/** Everything the submit core reads, mocked. Re-usable after a clearAllMocks. */
function installDataMocks() {
  (data.getUser as any).mockImplementation(async (uid: string) =>
    uid === STAFF_USER.uid ? STAFF_USER : CLIENT_USER,
  );
  (data.getClient as any).mockResolvedValue({
    id: "c1",
    name: "Acme",
    customAgentIds: [AGENT_ID],
  });
  (data.getCustomAgent as any).mockResolvedValue({
    id: AGENT_ID,
    key: AGENT_KEY,
    name: "Instagram agent",
    enabled: true,
    entrySkillDir: "skills/instagram",
    skillRoots: [],
    includeClientSkills: false,
    instructions: "Write like the brand.",
  });
  (data.listJobs as any).mockResolvedValue([]);
  (data.createJob as any).mockResolvedValue("job-1");
  (data.updateJob as any).mockResolvedValue(undefined);
  (data.updatePlannedScheduledRun as any).mockResolvedValue(undefined);
  (data.chargeClientCredits as any).mockResolvedValue({ balance: 100 });
}

beforeEach(() => {
  vi.clearAllMocks();
  installDataMocks();
});

describe("scheduled fire billing — the stored flag decides, not the actor", () => {
  it("charges the client when the flag says so even though createdBy is STAFF (sequence 1)", async () => {
    const result = await fire(
      schedule({ billClientCredits: true, createdBy: STAFF_USER.uid, outputsPerRun: 1 }),
    );

    expect(result.submitted).toBe(1);
    // Before the fix this fired free: the actor resolved from createdBy was
    // staff, so isBillableClientActor said no while the client's dialog had
    // quoted a weekly price.
    expect(charge()).toMatchObject({ clientId: "c1", amount: UNIT });
  });

  it("does NOT charge when the flag says no even though createdBy is the CLIENT (sequence 3)", async () => {
    // The "View as Client" shape: the impersonated session carries the client's
    // uid, so createdBy is the client and the stored account reads as a real
    // (billable) client user — while the flag, written from the impersonated
    // actor, correctly recorded "do not bill".
    const result = await fire(
      schedule({ billClientCredits: false, createdBy: CLIENT_USER.uid, outputsPerRun: 1 }),
    );

    expect(result.submitted).toBe(1);
    expect(charge()).toBeNull();
    // The run still happened — this is a free fire, not a refusal.
    expect(data.createJob).toHaveBeenCalled();
  });

  it("bills the batch at outputsPerRun × the unit price", async () => {
    await fire(schedule({ billClientCredits: true, createdBy: CLIENT_USER.uid, outputsPerRun: 4 }));

    const c = charge();
    expect(c).toMatchObject({ amount: UNIT * 4, operation: "custom_agent_run" });
    expect(c.reason).toContain("4 outputs");
  });

  it("leaves a correctly-configured client schedule on exactly the figure it charged before", async () => {
    // The guard rail: this fix redirects who pays, it must not re-price the case
    // that already worked. Flag and actor agreed here before and after.
    await fire(schedule({ billClientCredits: true, createdBy: CLIENT_USER.uid, outputsPerRun: 3 }));

    expect(charge()).toMatchObject({ amount: UNIT * 3, jobId: "job-1", agentId: AGENT_ID });
  });

  it("prices a one-output billed fire at the bare unit cost", async () => {
    // outputsPerRun absent is the overwhelmingly common row; the multiplier
    // became unconditional, so pin that it still resolves to 1 rather than
    // multiplying by something.
    await fire(schedule({ billClientCredits: true, createdBy: CLIENT_USER.uid }));

    const c = charge();
    expect(c).toMatchObject({ amount: UNIT });
    expect(c.reason).not.toContain("outputs");
  });
});

describe("scheduled fire billing — legacy rows keep today's behaviour", () => {
  /**
   * `billClientCredits` is optional and rows written before it existed have it
   * undefined. Reading that as `false` would silently make a whole fleet of live
   * schedules free — the worst outcome available here — so an absent flag is
   * treated as "no recorded intent" and the cron omits `bill` entirely, leaving
   * the submit core's actor test in charge. That is exactly what those rows did
   * before this change, so nothing about them moves.
   */
  it("charges a legacy row created by a client, as it does today", async () => {
    await fire(schedule({ createdBy: CLIENT_USER.uid }));

    expect(charge()).toMatchObject({ amount: UNIT });
  });

  it("still fires a legacy row created by staff for free, as it does today", async () => {
    await fire(schedule({ createdBy: STAFF_USER.uid }));

    expect(charge()).toBeNull();
    expect(data.createJob).toHaveBeenCalled();
  });

  it("treats an explicitly stored false as an intent, unlike an absent flag", async () => {
    // The pair that proves `undefined` and `false` are not collapsed: same
    // client createdBy, opposite outcomes.
    await fire(schedule({ createdBy: CLIENT_USER.uid }));
    expect(charge()).not.toBeNull();

    vi.clearAllMocks();
    installDataMocks();
    await fire(schedule({ createdBy: CLIENT_USER.uid, billClientCredits: false }));
    expect(charge()).toBeNull();
  });
});

describe("submitCustomAgentJob — every other caller still keys on the actor", () => {
  /**
   * `bill` defaults to the actor test on purpose: the scheduled-run cron is the
   * only caller with a stored intent to state, and the run dialog, the launch,
   * the MCP tool and the task engine must all keep behaving exactly as they did.
   */
  async function submit(user: any, input: Record<string, any> = {}) {
    const { submitCustomAgentJob } = await import("@/lib/jobs/submit-custom");
    return submitCustomAgentJob(user, {
      clientId: "c1",
      agentId: AGENT_ID,
      prompt: "One post about the launch.",
      ...input,
    } as any);
  }

  it("charges a billable client actor when no bill is passed", async () => {
    const result = await submit(CLIENT_USER);

    expect(result.error).toBeUndefined();
    expect(charge()).toMatchObject({ amount: UNIT, actorUid: CLIENT_USER.uid });
  });

  it("does not charge staff when no bill is passed", async () => {
    const result = await submit(STAFF_USER);

    expect(result.error).toBeUndefined();
    expect(charge()).toBeNull();
  });

  it("does not charge an impersonated client session when no bill is passed", async () => {
    const result = await submit({ ...CLIENT_USER, impersonatedBy: "u-admin" });

    expect(result.error).toBeUndefined();
    expect(charge()).toBeNull();
  });

  it("keeps `bill` an opt-in that only the scheduled-run cron uses", () => {
    // A second caller adopting it would be a second money decision in the
    // codebase, which is the whole class of defect this fix closes. Pinned at
    // the source, because the alternative is noticing it in a ledger.
    const callers = [
      "src/lib/execution-engine.ts",
      "src/lib/mcp/tools.ts",
      "src/lib/actions/external-job-actions.ts",
      "src/lib/actions/custom-agent-actions.ts",
      "src/lib/actions/client-agent-run-actions.ts",
      "src/lib/actions/client-agent-actions.ts",
    ];
    for (const file of callers) {
      const src = readFileSync(join(process.cwd(), file), "utf8");
      expect(src, `${file} calls submitCustomAgentJob`).toContain("submitCustomAgentJob(");
      expect(src, `${file} now passes an explicit bill`).not.toMatch(/\bbill:/);
    }
    const cron = readFileSync(join(process.cwd(), "src/app/api/run-scheduled/route.ts"), "utf8");
    expect(cron).toMatch(/\bbill: run\.billClientCredits\b/);
    // And it passes the flag only when the row actually recorded one, so a
    // legacy row falls through to the actor test rather than to `false`.
    expect(cron).toContain('typeof run.billClientCredits === "boolean"');
  });
});
