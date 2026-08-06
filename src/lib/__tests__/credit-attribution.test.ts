/* eslint-disable @typescript-eslint/no-explicit-any */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as data from "@/lib/data";
import {
  CLIENT_PRICE_ROWS,
  CREDIT_COSTS,
  CREDIT_OPERATION_LABEL,
  TASK_EXECUTION_COSTS,
  NEWSLETTER_RUN_CREDITS,
  BLOG_RUN_CREDITS,
  clientPriceText,
} from "@/lib/credits";
import { REDDIT_OUTPUTS_PER_RUN, MAX_OUTPUTS_PER_RUN } from "@/lib/scheduled-runs";
import { stripComments } from "./source-scan";

/**
 * THE LEDGER MUST BE ABLE TO NAME WHAT IT CHARGED FOR, AND MUST NOT HIDE THE
 * LARGEST CHARGE.
 *
 * Two write-side omissions and one duplicated list, all landing on a client's
 * bill:
 *
 *  · the scheduler submit core (`lib/agent-service/run-custom-agent.ts`) wrote
 *    job docs with neither `customAgentId` nor `runType`, while its twin
 *    (`lib/jobs/submit-custom.ts`) has always written both. Everything that
 *    joins spend to an agent joins on those two fields.
 *  · the copilot's price block and the client's rate card were two hand-kept
 *    copies of one list, and both omitted `agent_launch` — the one-time agent
 *    setup charge, the biggest single thing a client is billed for.
 *  · the submit core clamped a scheduled batch's charge multiplier at 10 while
 *    the layer that writes schedules clamps at the product's own ceiling.
 *
 * The behavioural halves drive the REAL cron routes through the REAL submit
 * cores with only the data layer and the agent service mocked, so the
 * assertions are on the actual `createJob` / `chargeClientCredits` calls.
 */

vi.mock("server-only", () => ({}));
vi.mock("@/lib/data");
vi.mock("@/lib/data-client-agents");
vi.mock("@/lib/actions/_shared");
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
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
vi.mock("@/lib/cron-auth", () => ({ requireCronSecret: () => null }));
// The Reddit intake hard-gate, satisfied so the CEILING is what the Reddit case
// below is testing. `isRedditAgent` itself is left real: it is the identity the
// clamp keys on, and faking it would test nothing.
vi.mock("@/lib/agent-service/reddit-agent-context", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  hasRedditAgentIntake: vi.fn().mockResolvedValue(true),
  buildRedditAgentContextFiles: vi.fn().mockResolvedValue([]),
}));

process.env.APP_URL = "https://portal.test";

const AGENT_ID = "ca-instagram";
/** Bound to no client (no `-company-<slug>` suffix) and not an intake-gated agent. */
const AGENT_KEY = "karos-instagram-agent";
const REDDIT_AGENT_ID = "ca-reddit";
const REDDIT_AGENT_KEY = "karos-reddit-agent";
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

function agentDoc(patch: Record<string, any> = {}) {
  return {
    id: AGENT_ID,
    key: AGENT_KEY,
    name: "Instagram agent",
    enabled: true,
    entrySkillDir: "skills/instagram",
    skillRoots: [],
    includeClientSkills: false,
    instructions: "Write like the brand.",
    ...patch,
  };
}

function installDataMocks() {
  (data.getUser as any).mockResolvedValue(CLIENT_USER);
  (data.getClient as any).mockResolvedValue({
    id: "c1",
    name: "Acme",
    customAgentIds: [AGENT_ID, REDDIT_AGENT_ID],
  });
  (data.getCustomAgent as any).mockResolvedValue(agentDoc());
  (data.listJobs as any).mockResolvedValue([]);
  (data.createJob as any).mockResolvedValue("job-1");
  (data.updateJob as any).mockResolvedValue(undefined);
  (data.updateScheduledRun as any).mockResolvedValue(undefined);
  (data.updatePlannedScheduledRun as any).mockResolvedValue(undefined);
  (data.chargeClientCredits as any).mockResolvedValue({ balance: 100 });
}

/** The single job doc a tick wrote. */
function createdJob() {
  const calls = (data.createJob as any).mock.calls;
  expect(calls.length, "expected exactly one job doc").toBe(1);
  return calls[0][0];
}

/** The single charge a tick made, or null when it charged nothing. */
function charge() {
  const calls = (data.chargeClientCredits as any).mock.calls;
  expect(calls.length).toBeLessThan(2);
  return calls.length === 1 ? calls[0][0] : null;
}

beforeEach(() => {
  vi.clearAllMocks();
  installDataMocks();
});

/* ── #36: the scheduler core's job doc ────────────────────────────── */

describe("the legacy scheduler's job doc can be joined back to its agent", () => {
  /** Runs one `/api/scheduler` tick over a single due `scheduledRuns` row. */
  async function fireLegacy(patch: Record<string, any> = {}) {
    (data.listDueScheduledRuns as any).mockResolvedValue([
      {
        id: "sr1",
        clientId: "c1",
        agentId: AGENT_ID,
        label: "Instagram agent",
        prompt: "One post about the launch.",
        assetType: "social_post",
        cadence: { daysOfWeek: [1, 3, 5], hour: 9, minute: 0, timezone: "UTC" },
        nextRunAt: 1_000,
        enabled: true,
        ...patch,
      },
    ]);
    (data.claimScheduledRun as any).mockResolvedValue(true);
    const { GET } = await import("@/app/api/scheduler/route");
    const res = await GET(new Request("https://portal.test/api/scheduler") as any);
    return res.json();
  }

  it("stamps the custom agent's id, so spend can be attributed to it", async () => {
    const result = await fireLegacy();
    expect(result.fired).toBe(1);

    // The whole of #58: without this field the settings page resolved the
    // ledger's agentId against nothing and printed the charge as belonging to a
    // removed agent, for an agent sitting enabled in the library.
    expect(createdJob().customAgentId).toBe(AGENT_ID);
  });

  it("takes the id from the agent it is running, not from the schedule row", async () => {
    // Keyed to the argument: a row whose stored agentId disagrees with the
    // document the route resolved must not be able to mis-attribute the spend.
    (data.getCustomAgent as any).mockResolvedValue(agentDoc({ id: "ca-resolved" }));
    await fireLegacy({ agentId: "ca-stale-on-the-row" });

    expect(createdJob().customAgentId).toBe("ca-resolved");
  });

  it("stamps the run type the cron states, so the charge can be named", async () => {
    // THIS TEST SAID "writes no run type when none was passed" and asserted
    // `undefined`. That was true only while the hand-off was open: the core
    // gained the parameter and the cron had not yet passed it. The cron passes
    // "scheduled" now — it is the scheduler, so it is the one caller that can
    // say so truthfully — and a run whose kind is recorded is the whole point of
    // #57, which otherwise buckets it as a kind we could not determine.
    const result = await fireLegacy();
    expect(result.fired).toBe(1);
    expect(createdJob().runType).toBe("scheduled");
  });

  it("still does not GUESS one in the core when a caller states none", async () => {
    // The half that must stay true: a default keyed to who happens to call a
    // function becomes a lie about money the moment a second caller appears, so
    // the core stamps only what it is handed.
    const { submitCustomAgentRun } = await import("@/lib/agent-service/run-custom-agent");
    await submitCustomAgentRun({
      agent: agentDoc() as any,
      client: { id: "c1", name: "Acme" } as any,
      prompt: "One post.",
      actor: { uid: "scheduler", name: "Scheduler", role: "staff" },
      charge: null,
    } as any);
    expect(createdJob().runType).toBeUndefined();
  });

  it("stamps the run type it IS handed", async () => {
    const { submitCustomAgentRun } = await import("@/lib/agent-service/run-custom-agent");
    await submitCustomAgentRun({
      agent: agentDoc() as any,
      client: { id: "c1", name: "Acme" } as any,
      prompt: "One post.",
      actor: { uid: "scheduler", name: "Scheduler", role: "staff" },
      charge: null,
      runType: "scheduled",
    });

    const job = createdJob();
    expect(job.runType).toBe("scheduled");
    expect(job.customAgentId).toBe(AGENT_ID);
  });
});

/* ── #76: the last line of defence on a batch charge ──────────────── */

describe("the submit core clamps a batch charge to what the product sells", () => {
  async function submit(input: Record<string, any> = {}) {
    const { submitCustomAgentJob } = await import("@/lib/jobs/submit-custom");
    return submitCustomAgentJob(CLIENT_USER, {
      clientId: "c1",
      agentId: AGENT_ID,
      prompt: "One post about the launch.",
      ...input,
    } as any);
  }

  it("refuses to bill more outputs than the generic ceiling, however it is asked", async () => {
    // A stale page or a direct call asking for 10 used to be billed for 10 —
    // twice what the schedule dialog and its server clamp allow.
    const result = await submit({ chargeMultiplier: 10 });

    expect(result.error).toBeUndefined();
    expect(charge()).toMatchObject({ amount: UNIT * MAX_OUTPUTS_PER_RUN });
  });

  it("holds the Reddit pin, which no generic ceiling would", async () => {
    // F27 left stored rows above the cap un-clamped, and the scheduler bills
    // chargeMultiplier on every fire — so the ceiling here has to be the
    // AGENT's, not a constant.
    (data.getCustomAgent as any).mockResolvedValue(
      agentDoc({ id: REDDIT_AGENT_ID, key: REDDIT_AGENT_KEY, name: "Reddit agent" }),
    );
    (data.getClient as any).mockResolvedValue({
      id: "c1",
      name: "Acme",
      customAgentIds: [REDDIT_AGENT_ID],
    });

    await submit({ agentId: REDDIT_AGENT_ID, chargeMultiplier: 5 });

    expect(charge()).toMatchObject({ amount: UNIT * REDDIT_OUTPUTS_PER_RUN });
    expect(REDDIT_OUTPUTS_PER_RUN).toBeLessThan(MAX_OUTPUTS_PER_RUN);
  });

  it("leaves every legitimate multiplier exactly where it was", async () => {
    // The other direction, which two rounds of this campaign have got wrong:
    // the clamp must not re-price a value the product does sell.
    for (const outputs of [1, 2, 3, 4, MAX_OUTPUTS_PER_RUN]) {
      vi.clearAllMocks();
      installDataMocks();
      await submit({ chargeMultiplier: outputs });
      expect(charge(), `outputsPerRun=${outputs}`).toMatchObject({ amount: UNIT * outputs });
    }
  });

  it("still prices an unspecified multiplier at one run", async () => {
    await submit();
    expect(charge()).toMatchObject({ amount: UNIT });
  });
});

/* ── #34/#35: one price list, and it carries the setup charge ─────── */

const REPO = join(__dirname, "..", "..", "..");
const source = (rel: string) => stripComments(readFileSync(join(REPO, rel), "utf8"));

const PANEL = "src/components/credits-panel.tsx";
const CHAT_ROUTE = "src/app/api/clients/[id]/chat/route.ts";

describe("the client-billable price list", () => {
  it("has a row for the one-time agent setup charge", () => {
    // Keyed to the LEDGER OPERATION it prices, not to a label typed here: the
    // charge exists as `agent_launch`, and CREDIT_OPERATION_LABEL is what the
    // ledger already calls it.
    const setupRows = CLIENT_PRICE_ROWS.filter((row) =>
      row.label.toLowerCase().includes(CREDIT_OPERATION_LABEL.agent_launch.toLowerCase()),
    );
    expect(setupRows, "no price row for the agent_launch charge").toHaveLength(1);
  });

  it("quotes no figure for it, because there is no price to read", () => {
    // #167 is open and `launchCreditCost` has no default. A row that filled one
    // in would be the F130 placeholder-pricing failure at the most expensive
    // SKU, so the assertion is mechanical: the setup row prints no digit.
    const setup = CLIENT_PRICE_ROWS.find((row) => row.credits == null);
    expect(setup, "the setup row must be the priced-per-agent one").toBeDefined();
    expect(setup!.label.toLowerCase()).toContain("setup");
    expect(clientPriceText(setup!)).not.toMatch(/\d/);
    expect(clientPriceText(setup!, { withUnit: true })).not.toMatch(/\d/);
    // …and it points at the surface that DOES hold the number.
    expect(setup!.note ?? "").toMatch(/agent/i);
  });

  it("has exactly one row with no number — everything else is a real price", () => {
    const unpriced = CLIENT_PRICE_ROWS.filter((row) => row.credits == null);
    expect(unpriced).toHaveLength(1);
  });

  it("reads every figure off a pricing constant rather than typing one", () => {
    const constants = new Set<number>([
      ...Object.values(CREDIT_COSTS),
      ...Object.values(TASK_EXECUTION_COSTS),
      // The two products that left TASK_EXECUTION_COSTS for the custom-agent
      // path and CARRIED their price rather than dropping it. Still quoted on
      // the card by name, and still read off a constant — which is the rule this
      // test enforces, not "the constant lives in one particular object".
      NEWSLETTER_RUN_CREDITS,
      BLOG_RUN_CREDITS,
    ]);
    // Non-vacuity: an empty list would satisfy the loop below silently.
    expect(CLIENT_PRICE_ROWS.length).toBeGreaterThanOrEqual(10);
    for (const row of CLIENT_PRICE_ROWS) {
      if (row.credits == null) continue;
      expect(constants.has(row.credits), `"${row.label}" quotes ${row.credits}, not a constant`).toBe(
        true,
      );
    }
  });

  it("leaves no client-billable rate off the card", () => {
    // The other direction of the same rule, and the one that keeps the comment
    // on CLIENT_PRICE_ROWS true without a reader having to take its word:
    // `ai_tool` charges (audience simulation, task map refresh, insights
    // refresh, company description, X account suggestions) are billed at
    // CREDIT_COSTS rates, so a rate the card does not quote is a charge a client
    // can incur and find nowhere. `taskAssist` is the one with no row of its own
    // — it is 1, the copilot-message rate — and a reprice that moves it off the
    // card fails here rather than silently.
    const quoted = new Set(
      CLIENT_PRICE_ROWS.map((row) => row.credits).filter((n): n is number => n != null),
    );
    const rates = Object.values(CREDIT_COSTS);
    expect(rates.length).toBeGreaterThanOrEqual(7); // non-vacuity
    for (const [name, rate] of Object.entries(CREDIT_COSTS)) {
      expect(quoted.has(rate), `CREDIT_COSTS.${name} = ${rate} is quoted on no row`).toBe(true);
    }
    for (const [name, rate] of Object.entries({
      NEWSLETTER_RUN_CREDITS,
      BLOG_RUN_CREDITS,
    })) {
      expect(quoted.has(rate), `${name} = ${rate} is quoted on no row`).toBe(true);
    }
    for (const [name, rate] of Object.entries(TASK_EXECUTION_COSTS)) {
      expect(quoted.has(rate), `TASK_EXECUTION_COSTS.${name} = ${rate} is quoted on no row`).toBe(
        true,
      );
    }
  });

  it("spells a floor, a flat price and a per-agent price three different ways", () => {
    expect(clientPriceText({ label: "x", credits: 5 })).toBe("5");
    expect(clientPriceText({ label: "x", credits: 5 }, { withUnit: true })).toBe("5 credits");
    expect(clientPriceText({ label: "x", credits: 1 }, { withUnit: true })).toBe("1 credit");
    expect(clientPriceText({ label: "x", credits: 25, from: true })).toBe("from 25");
    expect(clientPriceText({ label: "x", credits: null })).toBe(
      clientPriceText({ label: "x", credits: null }, { withUnit: true }),
    );
  });

  it("never says tokens", () => {
    for (const row of CLIENT_PRICE_ROWS) {
      expect(`${row.label} ${row.note ?? ""}`.toLowerCase()).not.toContain("token");
    }
  });
});

describe("both price surfaces render that one list and keep no copy", () => {
  it("the client's rate card maps CLIENT_PRICE_ROWS", () => {
    const panel = source(PANEL);
    expect(panel).toContain("CLIENT_PRICE_ROWS.map(");
    expect(panel).toContain("clientPriceText(row)");
  });

  it("the rate card declares no price rows of its own", () => {
    // The shape of the copy that was deleted: an array of objects each with a
    // quoted label. Comments are stripped first, so the prose above the list
    // cannot satisfy this.
    const panel = source(PANEL);
    expect(panel).not.toMatch(/\{\s*label:\s*["'`]/);
    expect(panel).not.toContain("TASK_EXECUTION_COSTS");
  });

  it("the copilot's credits appendix is built from the same list", () => {
    const route = source(CHAT_ROUTE);
    expect(route).toMatch(/const priceLines = CLIENT_PRICE_ROWS\.map\(/);
  });

  it("the copilot's credits appendix quotes no price of its own", () => {
    const route = source(CHAT_ROUTE);
    const open = route.indexOf("const creditsAppendix = credits");
    expect(open, "the credits appendix moved or was renamed").toBeGreaterThan(-1);
    const close = route.indexOf('\n    : "";', open);
    expect(close).toBeGreaterThan(open);
    const appendix = route.slice(open, close);

    expect(appendix).toContain("${priceLines}");
    // Every figure the model is given now arrives through priceLines or the
    // per-agent lines. A price re-typed into the prompt is how the two lists
    // drifted apart in the first place.
    expect(appendix).not.toContain("CREDIT_COSTS.");
    expect(appendix).not.toContain("TASK_EXECUTION_COSTS");
  });

  it("still forbids the model inventing a figure beyond the list", () => {
    const route = source(CHAT_ROUTE);
    // The instruction is only safe once the list is complete — it is what made
    // the missing setup row an answer of "the run price" or nothing.
    expect(route).toContain("Never invent credit figures beyond these.");
  });
});

/* ── the wiring a pure test cannot see ────────────────────────────── */

const SETTINGS_PAGE = "src/app/(app)/clients/[id]/settings/page.tsx";

describe("the settings page hands the breakdown a complete name map", () => {
  const page = source(SETTINGS_PAGE);

  /**
   * The argument object of the one summarizeClientSpend call on the page.
   *
   * A FUNCTION, not a describe-body constant: an `expect()` that throws in a
   * describe body reports "(0 test)" and drops the whole file silently, which
   * is the most expensive way available to make this suite stop guarding.
   */
  function spendCallArgs(): string {
    const open = page.indexOf("summarizeClientSpend({");
    expect(open, "summarizeClientSpend moved or was renamed").toBeGreaterThan(-1);
    expect(
      page.indexOf("summarizeClientSpend({", open + 1),
      "more than one call — this slice would only cover the first",
    ).toBe(-1);
    const close = page.indexOf("\n  });", open);
    expect(close).toBeGreaterThan(open);
    return page.slice(open, close);
  }

  it("resolves names through spendAgentNames, not from the jobs alone", () => {
    expect(spendCallArgs()).toContain("agentNameById: spendAgentNames({");
  });

  it("feeds it all three rungs", () => {
    const spendCall = spendCallArgs();
    // Dropping any one of these silently degrades the map, and the degradation
    // is invisible until a client reads a charge with no name against it.
    expect(spendCall).toContain("customAgents,");
    expect(spendCall).toContain("jobs: spendJobs,");
    expect(spendCall).toContain("umbrellas: spendUmbrellas,");
  });

  it("reads the agent library for every role, not only for admins", () => {
    // The library rung is the one that names an agent no job points at, and a
    // CLIENT_USER is exactly the reader who needs it.
    expect(page).toContain("listCustomAgents()");
    expect(page).not.toMatch(/isAdmin \? listCustomAgents\(\)/);
  });
});
