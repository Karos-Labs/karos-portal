/* eslint-disable @typescript-eslint/no-explicit-any */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as data from "@/lib/data";
import * as dataClientAgents from "@/lib/data-client-agents";
import * as sharedActions from "@/lib/actions/_shared";
import * as jobAlerts from "@/lib/job-alerts";
import { submitCustomAgentJob } from "@/lib/jobs/submit-custom";
import { computeNextRun } from "@/lib/scheduled-runs";

/**
 * A SCHEDULE THAT FIRES WHEN IT SHOULD NOT, OR TWICE — driven through the real
 * cron route and the real server actions, over a simulated clock.
 *
 * Every fire here is money: /api/run-scheduled hands the submit core a `bill`
 * decision and a chargeMultiplier of outputsPerRun, so a second fire is a
 * second invoice as well as a second post. scheduled-run-billing.test.ts pins
 * "one fire ⇒ one charge"; this file pins how many fires there are.
 *
 * The data layer is a small in-memory row whose `claimPlannedScheduledRun`
 * mirrors the real transaction (compare-and-set on nextRunAt, stamping
 * lastRunAt and opening the in-flight window). Everything above it — the route,
 * the actions, the cadence maths, the gates — is the real code.
 */

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/data");
vi.mock("@/lib/data-client-agents");
vi.mock("@/lib/actions/_shared");
vi.mock("@/lib/job-alerts", () => ({
  notifyScheduleFireFailure: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/jobs/submit-custom", () => ({
  submitCustomAgentJob: vi.fn(),
  isCustomAgentGrantedToClient: vi.fn().mockResolvedValue(true),
}));

const AGENT_ID = "ca-instagram";
const AGENT_KEY = "karos-instagram-agent";
const ZONE = "America/Sao_Paulo";
const UMBRELLA_ID = "ca1";

const CLIENT_USER = {
  uid: "u-client",
  email: "client@acme.test",
  name: "Client User",
  role: "CLIENT_USER",
  disabled: false,
  clientId: "c1",
  createdAt: 0,
} as any;

const STAFF_USER = { ...CLIENT_USER, uid: "u-staff", role: "KAROS_EMPLOYEE", clientId: null };

/** 2026-07-06 is a Monday; 03:00 UTC is that Monday 00:00 in Sao Paulo. */
const MONDAY_LOCAL_MIDNIGHT = Date.UTC(2026, 6, 6, 3);

/** Local wall clock of an instant in the schedule's zone — the client's view. */
function localParts(at: number): { day: string; time: string } {
  const fmt = (o: Intl.DateTimeFormatOptions) =>
    new Intl.DateTimeFormat("en-CA", { timeZone: ZONE, ...o }).format(new Date(at));
  return {
    day: fmt({ year: "numeric", month: "2-digit", day: "2-digit" }),
    time: fmt({ hour: "2-digit", minute: "2-digit", hour12: false }),
  };
}

/* ─────────────────────────── the in-memory row ──────────────────────────── */

let row: Record<string, any>;

function scheduleRow(patch: Record<string, any> = {}): Record<string, any> {
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
    weekday: 1,
    weekdays: [1, 3, 5],
    timeZone: ZONE,
    outputsPerRun: 1,
    billClientCredits: true,
    status: "active",
    createdBy: CLIENT_USER.uid,
    createdAt: 0,
    updatedAt: 0,
    ...patch,
  };
}

function installStore() {
  (data.listDuePlannedScheduledRuns as any).mockImplementation(async (before: number) =>
    row.status === "active" && row.nextRunAt <= before ? [structuredClone(row)] : [],
  );
  // Mirrors src/lib/data.ts claimPlannedScheduledRun. The shape is asserted
  // against the real source below, so this mock cannot quietly drift into
  // testing a transaction the product does not run.
  (data.claimPlannedScheduledRun as any).mockImplementation(
    async (id: string, expectedNextRunAt: number, advance: any) => {
      if (row.id !== id || row.status !== "active" || row.nextRunAt !== expectedNextRunAt) {
        return false;
      }
      row.lastRunAt = Date.now();
      row.fireInFlightSince = Date.now();
      row.updatedAt = Date.now();
      if ("completed" in advance) row.status = "completed";
      else row.nextRunAt = advance.nextRunAt;
      return true;
    },
  );
  (data.updatePlannedScheduledRun as any).mockImplementation(
    async (id: string, patch: Record<string, any>) => {
      if (row.id === id) Object.assign(row, patch);
    },
  );
  (data.getPlannedScheduledRun as any).mockImplementation(async (id: string) =>
    row.id === id ? structuredClone(row) : null,
  );
  (data.listPlannedScheduledRuns as any).mockImplementation(async () => [structuredClone(row)]);
  (data.getUser as any).mockResolvedValue(CLIENT_USER);
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
  });
  (data.listJobs as any).mockResolvedValue([]);
  (data.createPlannedScheduledRun as any).mockResolvedValue("pr-new");
  (dataClientAgents.getClientAgentByKey as any).mockResolvedValue({
    id: UMBRELLA_ID,
    clientId: "c1",
    agentKey: AGENT_KEY,
    customAgentId: AGENT_ID,
    displayName: "Instagram agent",
    launchState: "live",
    templates: [],
  });
  (dataClientAgents.getAgentSlot as any).mockResolvedValue(null);
  (sharedActions.requireClientAccess as any).mockResolvedValue(CLIENT_USER);
  (sharedActions.requireStaff as any).mockResolvedValue(STAFF_USER);
  (submitCustomAgentJob as any).mockResolvedValue({ jobId: "job-1" });
}

/** One cron tick at a simulated instant. */
async function tick(at: number) {
  vi.setSystemTime(at);
  const { GET } = await import("@/app/api/run-scheduled/route");
  const res = await GET(new Request("https://portal.test/api/run-scheduled") as any);
  return res.json();
}

/** Recorded by the submit mock so a fire's instant survives the call. */
let firedInstants: number[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  firedInstants = [];
  row = scheduleRow();
  installStore();
  (submitCustomAgentJob as any).mockImplementation(async () => {
    firedInstants.push(Date.now());
    return { jobId: `job-${firedInstants.length}` };
  });
});

afterEach(() => {
  vi.useRealTimers();
});

/* ───────── #61 — re-arming a day that already fired, and billing it ─────── */

describe("#61 the pace dialog cannot re-arm a day that already posted", () => {
  const TICK = 30 * 60_000;

  /**
   * Drain the schedule over `days` of simulated cron ticks, optionally moving
   * the wall clock mid-timeline through the REAL pace-edit action.
   */
  async function runTimeline(opts: { days: number; edit?: { at: number; hour: number } }) {
    row.nextRunAt = computeNextRun({
      cadence: "weekly",
      weekdays: [1, 3, 5],
      hour: 9,
      minute: 0,
      from: MONDAY_LOCAL_MIDNIGHT,
      timeZone: ZONE,
    });
    let edited = false;
    for (
      let now = MONDAY_LOCAL_MIDNIGHT;
      now < MONDAY_LOCAL_MIDNIGHT + opts.days * 24 * 3_600_000;
      now += TICK
    ) {
      if (opts.edit && !edited && now >= opts.edit.at) {
        vi.setSystemTime(opts.edit.at);
        const { configureClientAgentScheduleAction } = await import(
          "@/lib/actions/planned-run-actions"
        );
        const result = await configureClientAgentScheduleAction({
          clientId: "c1",
          customAgentId: AGENT_ID,
          postsPerWeek: 3,
          outputsPerRun: 1,
          prompt: "One post about the launch.",
          hour: opts.edit.hour,
          minute: 0,
          timeZone: ZONE,
        });
        expect(result.error).toBeUndefined();
        edited = true;
      }
      await tick(now);
    }
    return firedInstants.map(localParts);
  }

  it("posts once on the Monday the client moves 09:00 to 18:00 — not twice", async () => {
    // The reported sequence: the agent posts at 09:00, the client opens the
    // pace dialog at 10:00 the same morning and picks 18:00. Recomputing
    // nextRunAt from `now` alone re-arms THAT DAY, so the client gets a second
    // post that evening and a second charge for it.
    const fires = await runTimeline({
      days: 10,
      edit: { at: MONDAY_LOCAL_MIDNIGHT + 10 * 3_600_000, hour: 18 },
    });

    const days = fires.map((f) => f.day);
    expect(new Set(days).size).toBe(days.length);
    expect(days.filter((d) => d === fires[0].day)).toHaveLength(1);
    // The edit still took effect — this is not "the change was ignored".
    expect(fires[0].time).toBe("09:00");
    expect(fires[1].time).toBe("18:00");
    // Mon/Wed/Fri over ten days from a Monday: Mon, Wed, Fri, Mon, Wed.
    expect(fires).toHaveLength(5);
  });

  it("moving the time EARLIER on a fired day is refused the same way", async () => {
    // 09:00 has passed, so an 08:00 slot today is already behind the clock and
    // the old code happened to be safe here. Pinned so the fix cannot be
    // narrowed to "later times only" — the rule is the DAY, not the direction.
    const fires = await runTimeline({
      days: 10,
      edit: { at: MONDAY_LOCAL_MIDNIGHT + 10 * 3_600_000, hour: 8 },
    });
    const days = fires.map((f) => f.day);
    expect(new Set(days).size).toBe(days.length);
    expect(fires[1].time).toBe("08:00");
  });

  it("an untouched schedule fires exactly one post per posting day", async () => {
    // The un-regressed baseline: the fix must not cost a fire on the ordinary
    // path. Three posting days a week, two weeks.
    const fires = await runTimeline({ days: 14 });
    expect(fires).toHaveLength(6);
    for (const fire of fires) expect(fire.time).toBe("09:00");
    expect(new Set(fires.map((f) => f.day)).size).toBe(6);
  });

  it("a pace edit BEFORE the day's slot still arms that same day", async () => {
    // The other side of the guard: nothing has fired yet today, so moving the
    // time to 18:00 at 07:00 must give the client a post at 18:00 TODAY. A
    // guard that keyed on "today" rather than on "the day that fired" would
    // silently cost them a post.
    const fires = await runTimeline({
      days: 3,
      edit: { at: MONDAY_LOCAL_MIDNIGHT + 7 * 3_600_000, hour: 18 },
    });
    expect(fires).toHaveLength(2); // Monday 18:00 and Wednesday 18:00
    expect(fires[0].time).toBe("18:00");
    expect(fires[0].day).toBe(localParts(MONDAY_LOCAL_MIDNIGHT).day);
  });

  it("a catch-up fire does not also arm today's own slot", async () => {
    // An outage strands the cursor on the previous Friday. The cron recovers at
    // 08:00 on a Monday and drains it — and today's 09:00 slot is genuinely in
    // the future, so an advance that only asks "is it after now?" fires again an
    // hour later. Two posts, two charges, out of one outage.
    row.nextRunAt = MONDAY_LOCAL_MIDNIGHT - 3 * 24 * 3_600_000 + 12 * 3_600_000;
    await tick(MONDAY_LOCAL_MIDNIGHT + 8 * 3_600_000);
    await tick(MONDAY_LOCAL_MIDNIGHT + 9 * 3_600_000 + 60_000);
    await tick(MONDAY_LOCAL_MIDNIGHT + 12 * 3_600_000);

    expect(firedInstants).toHaveLength(1);
    expect(localParts(row.nextRunAt).day).not.toBe(localParts(MONDAY_LOCAL_MIDNIGHT).day);
  });
});

/* ────────── #62 — a slot already filled must not keep its run armed ─────── */

describe("#62 a day whose slot is already filled does not fire again", () => {
  function slot(patch: Record<string, any> = {}) {
    return {
      id: `${UMBRELLA_ID}__2026-07-06`,
      clientId: "c1",
      clientAgentId: UMBRELLA_ID,
      dateKey: "2026-07-06",
      templateKey: "daily-post",
      status: "planned",
      assetId: null,
      jobId: null,
      createdBy: "u-staff",
      createdAt: 0,
      updatedAt: 0,
      ...patch,
    };
  }

  async function fireWithSlot(slotDoc: unknown) {
    row = scheduleRow({ clientAgentId: UMBRELLA_ID, nextRunAt: MONDAY_LOCAL_MIDNIGHT });
    installStore();
    (submitCustomAgentJob as any).mockImplementation(async () => {
      firedInstants.push(Date.now());
      return { jobId: "job-1" };
    });
    (dataClientAgents.getAgentSlot as any).mockResolvedValue(slotDoc);
    return tick(MONDAY_LOCAL_MIDNIGHT + 9 * 3_600_000);
  }

  for (const [label, patch] of [
    ["an asset is already linked to the day", { assetId: "a1" }],
    ["a generation job already holds the day", { jobId: "job-earlier" }],
    ["the day is already published", { status: "posted", assetId: "a1" }],
    ["the day was removed from the plan", { status: "skipped" }],
  ] as const) {
    it(`skips the fire when ${label}`, async () => {
      const result = await fireWithSlot(slot(patch));

      expect(submitCustomAgentJob).not.toHaveBeenCalled();
      expect(result.submitted).toBe(0);
      expect(result.skipped).toBe(1);
      expect(result.results[0].reason).toBeTruthy();
      // The cursor still moved: a skipped day must not leave the row due on
      // every subsequent tick.
      expect(row.nextRunAt).toBeGreaterThan(MONDAY_LOCAL_MIDNIGHT + 9 * 3_600_000);
      expect(row.fireInFlightSince).toBeNull();
    });
  }

  it("fires normally when the day's slot is still empty", async () => {
    const result = await fireWithSlot(slot());

    expect(submitCustomAgentJob).toHaveBeenCalledTimes(1);
    expect(result.submitted).toBe(1);
  });

  it("fires normally when the umbrella has no slot doc for the day at all", async () => {
    // An absent slot is not evidence of a fill. Reading it as one would stop
    // every schedule whose horizon has not been generated — an outage wearing a
    // safety rule's clothes.
    const result = await fireWithSlot(null);

    expect(submitCustomAgentJob).toHaveBeenCalledTimes(1);
    expect(result.submitted).toBe(1);
  });

  it("does not read a day's slot for a BATCH fire", async () => {
    // outputsPerRun > 1 produces several posts across several days. Today's
    // slot being taken says nothing about the other four, and treating it as an
    // answer would cost the client the whole batch they are paying for.
    row = scheduleRow({
      clientAgentId: UMBRELLA_ID,
      outputsPerRun: 4,
      nextRunAt: MONDAY_LOCAL_MIDNIGHT,
    });
    installStore();
    (submitCustomAgentJob as any).mockResolvedValue({ jobId: "job-1" });
    (dataClientAgents.getAgentSlot as any).mockResolvedValue(slot({ assetId: "a1" }));

    const result = await tick(MONDAY_LOCAL_MIDNIGHT + 9 * 3_600_000);

    expect(result.submitted).toBe(1);
    expect(submitCustomAgentJob).toHaveBeenCalledTimes(1);
  });

  it("does not treat an OPTIONS day as an answer about the batch that fills it", async () => {
    // The X pick-of-three umbrella: its days carry the WEEKLY batch's assetId,
    // written by the slicer, and the schedule that fires is that batch's
    // producer. Reading last week's refs as "already done" would stop the batch
    // that fills next week — the product, silently off.
    row = scheduleRow({ clientAgentId: UMBRELLA_ID, nextRunAt: MONDAY_LOCAL_MIDNIGHT });
    installStore();
    (submitCustomAgentJob as any).mockResolvedValue({ jobId: "job-1" });
    (dataClientAgents.getAgentSlot as any).mockResolvedValue(
      slot({ kind: "options", assetId: "batch-1", optionRefs: ["r1", "r2", "r3"] }),
    );

    const result = await tick(MONDAY_LOCAL_MIDNIGHT + 9 * 3_600_000);

    expect(result.submitted).toBe(1);
  });

  it("still blocks a filled SINGLE day on the same umbrella — the exemption is narrow", async () => {
    // The pair for the two exemptions above: change only `kind` back to single
    // and only the one output, and the guard bites again. An exemption that
    // quietly generalised would show up here as a second passing fire.
    const result = await fireWithSlot(slot({ kind: "single", assetId: "a1" }));

    expect(result.submitted).toBe(0);
    expect(submitCustomAgentJob).not.toHaveBeenCalled();
  });

  it("never reads a slot for a schedule that has no umbrella", async () => {
    row = scheduleRow({ nextRunAt: MONDAY_LOCAL_MIDNIGHT });
    installStore();
    (submitCustomAgentJob as any).mockResolvedValue({ jobId: "job-1" });

    await tick(MONDAY_LOCAL_MIDNIGHT + 9 * 3_600_000);

    expect(dataClientAgents.getAgentSlot).not.toHaveBeenCalled();
    expect(submitCustomAgentJob).toHaveBeenCalledTimes(1);
  });

  it("asks for the day in the SCHEDULE's zone, not the container's", async () => {
    // A UTC container and a Sao Paulo client disagree about which day it is for
    // three hours every evening. Asking on the wrong calendar checks a slot the
    // client is not living in — which both misses a fill and, on the other side
    // of midnight, blocks a day that has not happened yet.
    row = scheduleRow({ clientAgentId: UMBRELLA_ID, nextRunAt: MONDAY_LOCAL_MIDNIGHT });
    installStore();
    (submitCustomAgentJob as any).mockResolvedValue({ jobId: "job-1" });
    // 2026-07-07T01:30Z is still 2026-07-06 22:30 in Sao Paulo.
    await tick(Date.UTC(2026, 6, 7, 1, 30));

    expect(dataClientAgents.getAgentSlot).toHaveBeenCalledWith(`${UMBRELLA_ID}__2026-07-06`);
  });

  it("refuses the fire rather than guessing when the slot read fails", async () => {
    row = scheduleRow({ clientAgentId: UMBRELLA_ID, nextRunAt: MONDAY_LOCAL_MIDNIGHT });
    installStore();
    (submitCustomAgentJob as any).mockResolvedValue({ jobId: "job-1" });
    (dataClientAgents.getAgentSlot as any).mockRejectedValue(new Error("Firestore unavailable"));

    const result = await tick(MONDAY_LOCAL_MIDNIGHT + 9 * 3_600_000);

    expect(submitCustomAgentJob).not.toHaveBeenCalled();
    expect(result.failed).toBe(1);
    expect(row.lastError).toContain("Firestore unavailable");
    expect(jobAlerts.notifyScheduleFireFailure).toHaveBeenCalled();
  });
});

/* ───────── #68 — a crash between claim and submit is now observable ─────── */

describe("#68 the claim→submit window leaves a trace", () => {
  it("closes the window on a clean fire", async () => {
    row.nextRunAt = MONDAY_LOCAL_MIDNIGHT;
    await tick(MONDAY_LOCAL_MIDNIGHT + 9 * 3_600_000);

    expect(row.lastRunAt).toBeTruthy();
    expect(row.fireInFlightSince).toBeNull();
  });

  it("closes it on a refusal, and on a throw", async () => {
    row.nextRunAt = MONDAY_LOCAL_MIDNIGHT;
    (submitCustomAgentJob as any).mockResolvedValue({ error: "Out of credits." });
    await tick(MONDAY_LOCAL_MIDNIGHT + 9 * 3_600_000);
    expect(row.fireInFlightSince).toBeNull();
    expect(row.lastError).toBe("Out of credits.");

    row = scheduleRow({ nextRunAt: MONDAY_LOCAL_MIDNIGHT + 2 * 24 * 3_600_000 });
    installStore();
    (submitCustomAgentJob as any).mockRejectedValue(new Error("socket hang up"));
    await tick(MONDAY_LOCAL_MIDNIGHT + 2 * 24 * 3_600_000 + 9 * 3_600_000);
    expect(row.fireInFlightSince).toBeNull();
    expect(row.lastError).toBe("socket hang up");
  });

  it("reports a fire that claimed its slot and never came back", async () => {
    // The container died between the claim and the submit: the row is left with
    // a fresh lastRunAt, a null lastError, an advanced nextRunAt and no job.
    // Every other field says "clean fire", which is why nothing alerted and the
    // "Stuck" flag never tripped — nextRunAt is legitimately in the future.
    const vanishedAt = MONDAY_LOCAL_MIDNIGHT + 9 * 3_600_000;
    row = scheduleRow({
      nextRunAt: MONDAY_LOCAL_MIDNIGHT + 2 * 24 * 3_600_000,
      lastRunAt: vanishedAt,
      lastError: null,
      fireInFlightSince: vanishedAt,
    });
    installStore();
    (submitCustomAgentJob as any).mockResolvedValue({ jobId: "job-2" });

    const result = await tick(MONDAY_LOCAL_MIDNIGHT + 2 * 24 * 3_600_000 + 9 * 3_600_000);

    expect(jobAlerts.notifyScheduleFireFailure).toHaveBeenCalledTimes(1);
    const alert = (jobAlerts.notifyScheduleFireFailure as any).mock.calls[0][0];
    expect(alert.scheduleId).toBe("pr1");
    expect(alert.error).toContain(new Date(vanishedAt).toISOString());
    // Reported, not re-fired: this tick's own run goes ahead normally and the
    // vanished window is not charged for a second time.
    expect(result.submitted).toBe(1);
    expect(row.fireInFlightSince).toBeNull();
  });

  it("says nothing about a row that has never had an open window", async () => {
    // Legacy rows have no such field, and a settled row has null. Neither is a
    // vanished fire, and a guard that cried wolf on every row would be muted
    // within a week.
    for (const value of [undefined, null]) {
      vi.clearAllMocks();
      row = scheduleRow({ nextRunAt: MONDAY_LOCAL_MIDNIGHT, fireInFlightSince: value });
      installStore();
      (submitCustomAgentJob as any).mockResolvedValue({ jobId: "job-1" });

      await tick(MONDAY_LOCAL_MIDNIGHT + 9 * 3_600_000);

      expect(jobAlerts.notifyScheduleFireFailure).not.toHaveBeenCalled();
    }
  });

  it("opens the window inside the claim transaction, not after it", async () => {
    // The mock above mirrors claimPlannedScheduledRun. If the real transaction
    // stopped stamping the marker, every assertion in this describe would still
    // pass against a fiction — so the one thing the mock cannot verify about
    // itself is checked at the source. Matched on the assignment, not on the
    // word, which also appears in the prose around it.
    const src = readFileSync(join(process.cwd(), "src/lib/data.ts"), "utf8");
    const start = src.indexOf("export async function claimPlannedScheduledRun");
    expect(start).toBeGreaterThan(-1);
    const body = src.slice(start, src.indexOf("\n}", start));
    expect(body).toMatch(/fireInFlightSince:\s*Date\.now\(\)/);
  });
});

/* ────── #66 — a client cannot revive a schedule staff retired ──────────── */

describe("#66 'completed' is staff-only in BOTH directions", () => {
  it("refuses a client bringing a retired schedule back to active", async () => {
    row = scheduleRow({ status: "completed", nextRunAt: MONDAY_LOCAL_MIDNIGHT });
    installStore();
    const { setPlannedRunStatusAction } = await import("@/lib/actions/planned-run-actions");

    const result = await setPlannedRunStatusAction("pr1", "active");

    expect(result.error).toBeTruthy();
    expect(data.updatePlannedScheduledRun).not.toHaveBeenCalled();
  });

  it("refuses a client touching a retired schedule at all", async () => {
    row = scheduleRow({ status: "completed", nextRunAt: MONDAY_LOCAL_MIDNIGHT });
    installStore();
    const { setPlannedRunStatusAction } = await import("@/lib/actions/planned-run-actions");

    expect((await setPlannedRunStatusAction("pr1", "paused")).error).toBeTruthy();
    expect((await setPlannedRunStatusAction("pr1", "completed")).error).toBeTruthy();
    expect(data.updatePlannedScheduledRun).not.toHaveBeenCalled();
  });

  it("still lets a client pause and resume a live schedule", async () => {
    // The reversible pair stays open — refusing it would trap a client with a
    // schedule they are trying to stop.
    vi.setSystemTime(MONDAY_LOCAL_MIDNIGHT + 12 * 3_600_000);
    row = scheduleRow({ status: "active", nextRunAt: MONDAY_LOCAL_MIDNIGHT + 24 * 3_600_000 });
    installStore();
    const { setPlannedRunStatusAction } = await import("@/lib/actions/planned-run-actions");

    expect(await setPlannedRunStatusAction("pr1", "paused")).toEqual({});
    expect(await setPlannedRunStatusAction("pr1", "active")).toEqual({});
  });

  it("lets STAFF restart a retired recurring schedule, into the future", async () => {
    vi.setSystemTime(MONDAY_LOCAL_MIDNIGHT + 12 * 3_600_000);
    (sharedActions.requireClientAccess as any).mockResolvedValue(STAFF_USER);
    row = scheduleRow({
      status: "completed",
      nextRunAt: MONDAY_LOCAL_MIDNIGHT - 30 * 24 * 3_600_000,
      lastRunAt: MONDAY_LOCAL_MIDNIGHT - 30 * 24 * 3_600_000,
    });
    installStore();
    (sharedActions.requireClientAccess as any).mockResolvedValue(STAFF_USER);
    const { setPlannedRunStatusAction } = await import("@/lib/actions/planned-run-actions");

    expect(await setPlannedRunStatusAction("pr1", "active")).toEqual({});
    expect(row.nextRunAt).toBeGreaterThan(Date.now());
  });

  it("refuses to re-arm a one-off whose time has already passed", async () => {
    // A "once" row has no cadence to re-anchor to, so the resume path skips the
    // re-anchor entirely: flipping it back to active leaves a past nextRunAt on
    // an active row, which is due on the very next tick. The client gets a run
    // they did not ask for now, and pays for it.
    vi.setSystemTime(MONDAY_LOCAL_MIDNIGHT + 12 * 3_600_000);
    for (const actor of [CLIENT_USER, STAFF_USER]) {
      vi.clearAllMocks();
      row = scheduleRow({
        cadence: "once",
        status: "paused",
        nextRunAt: MONDAY_LOCAL_MIDNIGHT - 24 * 3_600_000,
      });
      installStore();
      (sharedActions.requireClientAccess as any).mockResolvedValue(actor);
      const { setPlannedRunStatusAction } = await import("@/lib/actions/planned-run-actions");

      const result = await setPlannedRunStatusAction("pr1", "active");

      expect(result.error, `actor ${actor.role}`).toBeTruthy();
      expect(data.updatePlannedScheduledRun).not.toHaveBeenCalled();
    }
  });

  it("still resumes a one-off whose time is still ahead", async () => {
    vi.setSystemTime(MONDAY_LOCAL_MIDNIGHT + 12 * 3_600_000);
    row = scheduleRow({
      cadence: "once",
      status: "paused",
      nextRunAt: MONDAY_LOCAL_MIDNIGHT + 5 * 24 * 3_600_000,
    });
    installStore();
    const { setPlannedRunStatusAction } = await import("@/lib/actions/planned-run-actions");

    expect(await setPlannedRunStatusAction("pr1", "active")).toEqual({});
    expect(row.status).toBe("active");
    expect(row.nextRunAt).toBe(MONDAY_LOCAL_MIDNIGHT + 5 * 24 * 3_600_000);
  });

  it("a resume does not re-arm a day that already fired", async () => {
    // Pause-and-resume is the other way to reach the #61 defect: without the
    // same argument the pace edit passes, a resume at 10:00 on a day that
    // posted at 09:00 could re-arm it.
    vi.setSystemTime(MONDAY_LOCAL_MIDNIGHT + 10 * 3_600_000);
    row = scheduleRow({
      status: "paused",
      cadence: "daily",
      hour: 18,
      minute: 0,
      weekdays: undefined,
      nextRunAt: MONDAY_LOCAL_MIDNIGHT + 9 * 3_600_000,
      lastRunAt: MONDAY_LOCAL_MIDNIGHT + 9 * 3_600_000,
    });
    installStore();
    const { setPlannedRunStatusAction } = await import("@/lib/actions/planned-run-actions");

    expect(await setPlannedRunStatusAction("pr1", "active")).toEqual({});
    expect(localParts(row.nextRunAt).day).not.toBe(localParts(MONDAY_LOCAL_MIDNIGHT).day);
  });
});
