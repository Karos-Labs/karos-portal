/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  CREDIT_COSTS,
  CreditError,
  creditsLabel,
  insightsRefreshPrice,
  simulationPrice,
  taskMapRefreshPrice,
} from "@/lib/credits";

/**
 * FIVE WAYS A CLIENT SPENT KAROS MONEY UNMETERED OR UNREFUNDED, asked one site
 * at a time, by driving the REAL action or route with only the data layer, the
 * auth session and the model SDK mocked.
 *
 * Each site gets the same four questions, because the cluster is one shape
 * repeated: is a billable client charged, is staff not, is a denial refused
 * before any model call, and — the half that was missing everywhere — are the
 * credits handed back when the paid-for call produces nothing.
 *
 * The assertions are on the actual `chargeClientCredits` / `creditClientCredits`
 * the site would issue, not on the helper being called, so a future refactor
 * that keeps the helper but loses the charge still fails here.
 */

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>();
  return { ...actual, after: (fn: () => void) => fn() };
});
vi.mock("@/lib/data");
vi.mock("@/lib/auth");
vi.mock("@/lib/intel", () => ({ applyDocCorrections: vi.fn() }));
vi.mock("@/lib/simulation-engine", () => ({
  buildSimulationPersonas: vi.fn(),
  runSimulation: vi.fn(),
}));
vi.mock("@/lib/agent-swarm", () => ({ buildSwarmContext: vi.fn(), runSwarm: vi.fn() }));
vi.mock("ai", () => ({ generateText: vi.fn(), generateObject: vi.fn(), streamText: vi.fn() }));
vi.mock("@ai-sdk/anthropic", () => ({
  anthropic: Object.assign((id: string) => ({ id }), {
    tools: { webSearch_20250305: () => ({}) },
  }),
}));
vi.mock("@/services/logger", () => ({
  logger: { logUsage: vi.fn(), logGenerationFailure: vi.fn() },
  readWebSearchCount: () => 0,
}));

import { generateText, streamText } from "ai";
import * as data from "@/lib/data";
import { getCurrentUser } from "@/lib/auth";
import { applyDocCorrections } from "@/lib/intel";
import { buildSimulationPersonas, runSimulation } from "@/lib/simulation-engine";
import { buildSwarmContext, runSwarm } from "@/lib/agent-swarm";

const CLIENT_USER = {
  uid: "u-client",
  email: "dana@acme.test",
  name: "Dana",
  role: "CLIENT_USER" as const,
  clientId: "c1",
  createdAt: 0,
};
// KAROS_ADMIN, not KAROS_EMPLOYEE: this file's own getClient() mock returns a
// client with no assignedEmployeeIds, so an employee fixture would now be
// refused by requireClientAccess's D-77 assignment fence (2026-08) — a
// tenancy question this file isn't asking. Billing treats admin and employee
// identically (isBillableClientActor only branches on CLIENT_USER), so this
// is a like-for-like swap for what "is staff, and isn't charged" means here.
const STAFF = {
  uid: "u-staff",
  email: "tomer@karoslabs.com",
  name: "Tomer",
  role: "KAROS_ADMIN" as const,
  createdAt: 0,
};
const DENIAL = new CreditError(
  "insufficient_balance",
  "Not enough credits. This action costs 5 credits and 2 are left. Ask your Karos team for a top-up.",
);

const charges = () => vi.mocked(data.chargeClientCredits).mock.calls.map((c) => c[0]);
const refunds = () => vi.mocked(data.creditClientCredits).mock.calls.map((c) => c[0]);
const asClient = () => vi.mocked(getCurrentUser).mockResolvedValue(CLIENT_USER as any);
const asStaff = () => vi.mocked(getCurrentUser).mockResolvedValue(STAFF as any);

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(data.chargeClientCredits).mockResolvedValue({ balance: 100, entryId: "charge-1" });
  vi.mocked(data.creditClientCredits).mockResolvedValue({ balance: 100 });
  vi.mocked(data.getClient).mockResolvedValue({ id: "c1", name: "Acme", brief: "We sell things." } as any);
});

/* ───────────────────────── #28 · Propose accounts ───────────────────────── */

describe("#28 — the X intake's Propose accounts button", () => {
  const ROSTER = JSON.stringify(
    Array.from({ length: 10 }, (_, i) => ({ handle: `@voice${i}`, why: "relevant" })),
  );
  const propose = async () => {
    const { proposeXRosterAction } = await import("@/lib/actions/x-agent-actions");
    return proposeXRosterAction({ clientId: "c1" });
  };

  beforeEach(() => {
    // The ordered, allowlisted read (#59) — which tiers each actor may draw on
    // is x-roster-context-tier.test.ts's subject; here it only has to yield
    // context so these cases are about the charge and the refund.
    vi.mocked(data.getClientContextDocInTierOrder).mockResolvedValue({
      content: "Buyers are ops leads.",
    } as any);
    vi.mocked(generateText).mockResolvedValue({ text: ROSTER } as any);
  });

  it("charges a client user at the copilot-message rate", async () => {
    asClient();
    const out = await propose();
    expect(out.handles).toHaveLength(10);
    expect(charges()).toEqual([
      expect.objectContaining({
        clientId: "c1",
        amount: CREDIT_COSTS.chatMessage,
        operation: "ai_tool",
      }),
    ]);
  });

  it("charges staff nothing", async () => {
    asStaff();
    const out = await propose();
    expect(out.handles).toHaveLength(10);
    expect(charges()).toEqual([]);
  });

  it("refuses before the model runs when credits are denied", async () => {
    asClient();
    vi.mocked(data.chargeClientCredits).mockRejectedValueOnce(DENIAL);
    const out = await propose();
    expect(out.error).toBe(DENIAL.message);
    expect(generateText).not.toHaveBeenCalled();
  });

  it("hands the credit back when the proposal fails", async () => {
    asClient();
    vi.mocked(generateText).mockRejectedValueOnce(new Error("anthropic 529"));
    const out = await propose();
    expect(out.error).toMatch(/try again or type accounts manually/i);
    expect(refunds()).toEqual([
      expect.objectContaining({ kind: "refund", amount: CREDIT_COSTS.chatMessage }),
    ]);
  });

  it("hands the credit back when the proposal comes back too thin", async () => {
    asClient();
    vi.mocked(generateText).mockResolvedValue({ text: JSON.stringify([{ handle: "@one", why: "x" }]) } as any);
    const out = await propose();
    expect(out.error).toMatch(/too thin/);
    expect(refunds()).toEqual([expect.objectContaining({ kind: "refund" })]);
  });
});

/* ─────────────────────── #29 · Refresh Task Map (swarm) ─────────────────── */

describe("#29 — the copilot's Refresh Task Map chip", () => {
  /**
   * Drains the SSE body, because the refund lives in the stream's `finally` and
   * never runs for a reader that walks away. The drained text comes back with
   * the response — reading it twice is what a plain `res.json()` would attempt.
   */
  async function refreshTaskMap(): Promise<{ res: Response; body: string }> {
    const { POST } = await import("@/app/api/tasks/generate-swarm/route");
    const res = await POST(
      new Request("https://portal.test/api/tasks/generate-swarm", {
        method: "POST",
        body: JSON.stringify({ clientId: "c1" }),
      }),
    );
    const body = res.body ? await new Response(res.body).text() : "";
    return { res, body };
  }
  const swarmYielding = (created: number) =>
    vi.mocked(runSwarm).mockImplementation(async function* () {
      yield { type: "done", created } as any;
    });

  beforeEach(() => {
    vi.mocked(data.tryAcquireAiProcessingLock).mockResolvedValue(true);
    vi.mocked(buildSwarmContext).mockResolvedValue({} as any);
    swarmYielding(4);
  });

  it("charges a client user one task execution for the six-turn debate", async () => {
    asClient();
    await refreshTaskMap();
    expect(charges()).toEqual([
      expect.objectContaining({ amount: CREDIT_COSTS.taskExecution, operation: "ai_tool" }),
    ]);
  });

  it("charges staff nothing", async () => {
    asStaff();
    await refreshTaskMap();
    expect(charges()).toEqual([]);
  });

  it("refuses with 402 before the debate starts when credits are denied", async () => {
    asClient();
    vi.mocked(data.chargeClientCredits).mockRejectedValueOnce(DENIAL);
    const { res, body } = await refreshTaskMap();
    expect(res.status).toBe(402);
    expect(JSON.parse(body)).toEqual({ error: DENIAL.message });
    expect(runSwarm).not.toHaveBeenCalled();
    // The concurrency lock must not be left held by a refused run.
    expect(data.releaseAiProcessingLock).toHaveBeenCalledWith("c1");
  });

  it("hands the credits back when the debate lands no tasks", async () => {
    asClient();
    swarmYielding(0);
    await refreshTaskMap();
    expect(refunds()).toEqual([
      expect.objectContaining({ kind: "refund", amount: CREDIT_COSTS.taskExecution }),
    ]);
  });

  /**
   * The charge is the only thing between the concurrency lock and the stream
   * that can throw, and a stranded lock blocks every Regenerate and Refresh Task
   * Map for that client until somebody clears it by hand.
   */
  it("releases the concurrency lock when the charge throws outright", async () => {
    asClient();
    vi.mocked(data.chargeClientCredits).mockRejectedValueOnce(new Error("DEADLINE_EXCEEDED"));
    await expect(refreshTaskMap()).rejects.toThrow("DEADLINE_EXCEEDED");
    expect(data.releaseAiProcessingLock).toHaveBeenCalledWith("c1");
    expect(runSwarm).not.toHaveBeenCalled();
  });

  it("hands the credits back when the debate throws", async () => {
    asClient();
    vi.mocked(runSwarm).mockImplementation(() => {
      throw new Error("swarm exploded");
    });
    await refreshTaskMap();
    expect(refunds()).toEqual([expect.objectContaining({ kind: "refund" })]);
  });

  it("keeps the charge when the debate actually produced tasks", async () => {
    asClient();
    await refreshTaskMap();
    expect(refunds()).toEqual([]);
  });

  /**
   * THE ANNOUNCE. The chip has no confirmation step — pressing it mounts the War
   * Room and the debate starts — so the press IS the commitment, and it said
   * nothing about the price. A client with credits therefore learned the cost
   * from their balance, which is worse than the 402 the broke case already got.
   *
   * The oracle is THE AMOUNT THIS VERY CALL CHARGED, not a constant and not a
   * literal: repricing the debate cannot leave the chip quoting the old number,
   * and a reprice to 1 fails on the plural rather than passing as "1 credits".
   */
  it("quotes the price it charges, to the reader who pays", async () => {
    asClient();
    await refreshTaskMap();
    const charged = charges()[0]!.amount;
    expect(taskMapRefreshPrice(true)).toBe(creditsLabel(charged));
    expect(taskMapRefreshPrice(false)).toBeNull();
    expect(taskMapRefreshPrice(true)).not.toMatch(/token/i);
  });
});

/* ───────────────────────── #30 · Audience Simulation ────────────────────── */

describe("#30 — Audience Simulation", () => {
  async function simulate() {
    const { POST } = await import("@/app/api/clients/[id]/simulate/route");
    const req = new Request("https://portal.test/api/clients/c1/simulate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ assetId: "a1" }),
    });
    return POST(req, { params: Promise.resolve({ id: "c1" }) });
  }
  const verdict = (error?: string) => ({ personaId: "p1", personaName: "Ops lead", ...(error ? { error } : { score: 7 }) });

  beforeEach(() => {
    vi.mocked(data.getAsset).mockResolvedValue({
      id: "a1",
      clientId: "c1",
      title: "Launch post",
      content: "Body copy.",
      type: "social_post",
      channels: ["linkedin"],
    } as any);
    vi.mocked(buildSimulationPersonas).mockResolvedValue([{ id: "p1", name: "Ops lead" }] as any);
    vi.mocked(runSimulation).mockResolvedValue([verdict()] as any);
  });

  it("charges a client user one in-process AI run per press", async () => {
    asClient();
    const res = await simulate();
    expect(res.status).toBe(200);
    expect(charges()).toEqual([
      expect.objectContaining({ amount: CREDIT_COSTS.taskExecution, operation: "ai_tool" }),
    ]);
  });

  it("charges staff nothing", async () => {
    asStaff();
    await simulate();
    expect(charges()).toEqual([]);
  });

  it("refuses with 402 before the panel runs when credits are denied", async () => {
    asClient();
    vi.mocked(data.chargeClientCredits).mockRejectedValueOnce(DENIAL);
    const res = await simulate();
    expect(res.status).toBe(402);
    expect(buildSimulationPersonas).not.toHaveBeenCalled();
  });

  it("hands the credits back when the panel cannot be built", async () => {
    asClient();
    vi.mocked(buildSimulationPersonas).mockRejectedValueOnce(new Error("planner failed"));
    const res = await simulate();
    expect(res.status).toBe(502);
    expect(refunds()).toEqual([
      expect.objectContaining({ kind: "refund", amount: CREDIT_COSTS.taskExecution }),
    ]);
  });

  /**
   * runSimulation never throws — it settles each persona and reports failures as
   * `error` entries — so a panel where every verdict failed returns HTTP 200
   * with nothing readable in it. That is the case a catch-based refund misses.
   */
  it("hands the credits back when every persona failed, despite a 200", async () => {
    asClient();
    vi.mocked(runSimulation).mockResolvedValue([verdict("model timeout"), verdict("model timeout")] as any);
    const res = await simulate();
    expect(res.status).toBe(200);
    expect(refunds()).toEqual([expect.objectContaining({ kind: "refund" })]);
  });

  it("keeps the charge for a PARTIAL panel — that is a real result", async () => {
    asClient();
    vi.mocked(runSimulation).mockResolvedValue([verdict(), verdict("model timeout")] as any);
    await simulate();
    expect(refunds()).toEqual([]);
  });

  /**
   * THE ANNOUNCE. Pricing a button that says nothing about the price just moves
   * the surprise: the 402 is handled, but a client who has credits learns the
   * cost by watching the rail drop. The panel quotes it before the press, off
   * the SAME constant the charge above asserts, so a repricing cannot leave the
   * button lying.
   */
  it("quotes the price it charges, to the reader who pays", async () => {
    asClient();
    await simulate();
    // The oracle is what THIS call charged. `${CREDIT_COSTS.taskExecution}
    // credits` was the old assertion, and it would have stayed green through the
    // bug it was meant to guard: reprice the constant to 1 and both sides read
    // "1 credits". Pluralising off the charged amount fails instead.
    const charged = charges()[0]!.amount;
    expect(simulationPrice(true)).toBe(creditsLabel(charged));
    // Staff runs are free (asserted above), so no price is quoted at them.
    expect(simulationPrice(false)).toBeNull();
    // Credits are never "tokens" — that word is claimed by PATs and LLM counts.
    expect(simulationPrice(true)).not.toMatch(/token/i);
  });
});

/* ─────────────── AI Insights · the forced "Refresh" ─────────────────────── */

/**
 * The insights route's CACHE-MISS rerun is deliberately free — it is triggered
 * by new analytics data, not by a client, and a client cannot manufacture
 * analytics rows by clicking. `?force=1` is the other path: it skips the cache
 * read outright, so the panel's own Refresh button was an unmetered model call a
 * client could press as often as they liked.
 *
 * Driven through the PIPELINE branch (no measured engagement yet, but assets
 * exist), which is the shortest route to a model call: `records: []` keeps the
 * mock-data gate open, and one asset keeps the truly-empty short-circuit shut.
 */
describe("AI Insights · the forced Refresh", () => {
  async function refresh(force: boolean) {
    const { POST } = await import("@/app/api/clients/[id]/insights/route");
    const url = `https://portal.test/api/clients/c1/insights${force ? "?force=1" : ""}`;
    return POST(new Request(url, { method: "POST" }), { params: Promise.resolve({ id: "c1" }) });
  }

  beforeEach(() => {
    vi.mocked(data.listClientMarketingAnalytics).mockResolvedValue([]);
    vi.mocked(data.listAssets).mockResolvedValue([
      { id: "a1", clientId: "c1", title: "Launch post", type: "social_post", status: "draft", createdAt: Date.now() },
    ] as any);
    vi.mocked(data.listClientIntegrations).mockResolvedValue([]);
    vi.mocked(data.getClientInsightsCache).mockResolvedValue(null as any);
    vi.mocked(streamText).mockReturnValue({
      toTextStreamResponse: () => new Response("**Pipeline**\n- One draft ready\n"),
    } as any);
  });

  it("charges a client user one model call for a forced refresh", async () => {
    asClient();
    await refresh(true);
    expect(charges()).toEqual([
      expect.objectContaining({ amount: CREDIT_COSTS.chatMessage, operation: "ai_tool" }),
    ]);
  });

  it("charges nothing for the unforced rerun a page load makes", async () => {
    asClient();
    await refresh(false);
    expect(streamText).toHaveBeenCalled();
    expect(charges()).toEqual([]);
  });

  it("charges staff nothing", async () => {
    asStaff();
    await refresh(true);
    expect(charges()).toEqual([]);
  });

  it("refuses with 402 before the briefing streams when credits are denied", async () => {
    asClient();
    vi.mocked(data.chargeClientCredits).mockRejectedValueOnce(DENIAL);
    const res = await refresh(true);
    expect(res.status).toBe(402);
    expect(streamText).not.toHaveBeenCalled();
  });

  /**
   * THE ANNOUNCE, with the same oracle as the other two: the amount this call
   * actually charged. A price the control does not state is one the client reads
   * off their balance afterwards.
   */
  it("quotes the price it charges, to the reader who pays", async () => {
    asClient();
    await refresh(true);
    const charged = charges()[0]!.amount;
    expect(insightsRefreshPrice(true)).toBe(creditsLabel(charged));
    expect(insightsRefreshPrice(false)).toBeNull();
    expect(insightsRefreshPrice(true)).not.toMatch(/token/i);
  });
});

/* ──────────── #31 · charged before the call, refunded only on "unchanged" ── */

describe("#31 — a client paying for a crash", () => {
  async function correct() {
    const { applyTargetedDocCorrectionAction } = await import("@/lib/actions/intel-actions");
    return applyTargetedDocCorrectionAction("doc-1", "We are based in Tel Aviv, not Haifa.");
  }

  beforeEach(() => {
    vi.mocked(data.getClientContextDocById).mockResolvedValue({
      id: "doc-1",
      clientId: "c1",
      docType: "brand-voice",
      tier: "client",
      content: "Original body.",
      version: 3,
    } as any);
  });

  it("charges a client user for a correction that lands", async () => {
    asClient();
    vi.mocked(applyDocCorrections).mockResolvedValue("Corrected body.");
    const out = await correct();
    expect(out).toEqual({ ok: true });
    expect(charges()).toEqual([
      expect.objectContaining({ amount: CREDIT_COSTS.targetedCorrection, operation: "doc_correction" }),
    ]);
    expect(refunds()).toEqual([]);
  });

  it("charges staff nothing", async () => {
    asStaff();
    vi.mocked(applyDocCorrections).mockResolvedValue("Corrected body.");
    await correct();
    expect(charges()).toEqual([]);
  });

  /** The one refund path that already worked — pinned so it cannot regress. */
  it("still refunds a correction the structural checks discarded", async () => {
    asClient();
    vi.mocked(applyDocCorrections).mockResolvedValue("Original body.");
    const out = await correct();
    expect(out.error).toMatch(/have not been charged/);
    expect(refunds()).toEqual([
      expect.objectContaining({ kind: "refund", amount: CREDIT_COSTS.targetedCorrection }),
    ]);
  });

  /** THE DEFECT: the charge happened, the model threw, nothing came back. */
  it("refunds when the correction THROWS, not only when it changes nothing", async () => {
    asClient();
    vi.mocked(applyDocCorrections).mockRejectedValueOnce(new Error("anthropic 529 overloaded"));
    const out = await correct();
    expect(out.error).toBeTruthy();
    expect(refunds()).toEqual([
      expect.objectContaining({ kind: "refund", amount: CREDIT_COSTS.targetedCorrection }),
    ]);
  });

  it("refunds a GLOBAL correction that throws partway through", async () => {
    asClient();
    vi.mocked(data.listClientContextDocs).mockResolvedValue([
      { id: "d1", docType: "brand-voice", content: "A" },
      { id: "d2", docType: "market-strategy", content: "B" },
    ] as any);
    vi.mocked(applyDocCorrections).mockRejectedValue(new Error("anthropic 529 overloaded"));
    const { applyGlobalDocCorrectionAction } = await import("@/lib/actions/intel-actions");
    const out = await applyGlobalDocCorrectionAction("c1", "We are in Tel Aviv.");
    expect(out.error).toBeTruthy();
    expect(refunds()).toEqual([
      expect.objectContaining({ kind: "refund", amount: CREDIT_COSTS.globalCorrection }),
    ]);
  });

  it("refunds a GLOBAL correction that changed no document at all", async () => {
    asClient();
    vi.mocked(data.listClientContextDocs).mockResolvedValue([
      { id: "d1", docType: "brand-voice", content: "A" },
    ] as any);
    vi.mocked(applyDocCorrections).mockResolvedValue("A");
    const { applyGlobalDocCorrectionAction } = await import("@/lib/actions/intel-actions");
    await applyGlobalDocCorrectionAction("c1", "We are in Tel Aviv.");
    expect(refunds()).toEqual([
      expect.objectContaining({ kind: "refund", amount: CREDIT_COSTS.globalCorrection }),
    ]);
    expect(data.updateContextDocContent).not.toHaveBeenCalled();
  });

  it("refunds the AI task plan when its Haiku call throws", async () => {
    asClient();
    vi.mocked(data.getClientTask).mockResolvedValue({
      id: "t1",
      clientId: "c1",
      title: "Draft the launch post",
      description: "",
      source: "custom",
      priority: "high",
      metadata: {},
    } as any);
    vi.mocked(generateText).mockRejectedValueOnce(new Error("anthropic 529 overloaded"));
    const { generateTaskPlanAction } = await import("@/lib/actions/task-actions");
    await expect(generateTaskPlanAction("t1", "c1")).rejects.toThrow();
    expect(refunds()).toEqual([
      expect.objectContaining({ kind: "refund", amount: CREDIT_COSTS.taskAssist }),
    ]);
  });
});
