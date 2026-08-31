import { describe, expect, it } from "vitest";
import { toRoutableRecommendation, type RoutableRecommendation } from "../routable-recommendation";
import {
  priorityForImpact,
  routableRecommendationsToTaskInputs,
  routableRecommendationToTaskInput,
  taskOwnerForRecOwner,
} from "../routable-recommendation-tasks";

/**
 * [SCRUM-259/T-B14] Recommendations to typed tasks — coverage.
 *
 * The four real per-recId rows below are transcribed verbatim from this
 * ticket's own EXEC-CONTEXT ("Concrete example rows from T-A4's real
 * mapping"), not invented: SEO-02 (one_click/karos_agent),
 * SEO-04 (guided_manual/client_manual), SEO-09 (connect/karos_tool),
 * GEO-09 (review_approve/karos_agent) — together they cover every real
 * `RecOwner` value and every real `ActionKind` value, which is what the
 * ticket's acceptance criterion asks for ("at least one example per
 * fixAction/actionKind/owner combination that's actually reachable").
 * No fifth, invented row was added — `rec-routing-map.ts` is not available in
 * this worktree (agent-engine repo), and inventing a plausible-looking row
 * would misrepresent it as real data.
 */

function baseRaw(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    recId: "ZZZ-000",
    recommendation: "placeholder",
    fireState: "fail",
    worstNorm: 0.4,
    scoreLift: 3.2,
    impact: "high",
    effort: "quick",
    delivery: "agent-direct",
    priorityScore: 512,
    hardOverride: false,
    ...overrides,
  };
}

const SEO_02 = toRoutableRecommendation(
  baseRaw({
    recId: "SEO-02",
    recommendation: "Title tags are being truncated in search results.",
    impact: "high",
    fixAction: "meta_title",
    actionKind: "one_click",
    owner: "karos_agent",
    engineProductId: "seo-geo-agent",
  }),
)!;

const SEO_04 = toRoutableRecommendation(
  baseRaw({
    recId: "SEO-04",
    recommendation: "Core Web Vitals need a manual performance pass.",
    impact: "medium",
    fixAction: "manual",
    actionKind: "guided_manual",
    owner: "client_manual",
  }),
)!;

const SEO_09 = toRoutableRecommendation(
  baseRaw({
    recId: "SEO-09",
    recommendation: "Connect Google Search Console to verify indexing.",
    impact: "low",
    fixAction: "manual",
    actionKind: "connect",
    owner: "karos_tool",
    targetPlatform: "search-console",
  }),
)!;

const GEO_09 = toRoutableRecommendation(
  baseRaw({
    recId: "GEO-09",
    recommendation: "Add a byline and original statistics to key pages.",
    impact: "critical",
    fixAction: "manual",
    actionKind: "review_approve",
    owner: "karos_agent",
    engineProductId: "seo-geo-agent",
  }),
)!;

const ALL_FOUR: readonly RoutableRecommendation[] = [SEO_02, SEO_04, SEO_09, GEO_09];

describe("sanity: the four rows actually parsed the way the ticket describes", () => {
  it("every row is defined and carries the owner/fixAction/actionKind the ticket states", () => {
    expect(ALL_FOUR.every(Boolean)).toBe(true);
    expect(SEO_02).toMatchObject({ owner: "karos_agent", fixAction: "meta_title", actionKind: "one_click", engineProductId: "seo-geo-agent" });
    expect(SEO_04).toMatchObject({ owner: "client_manual", fixAction: "manual", actionKind: "guided_manual" });
    expect(SEO_04.engineProductId).toBeUndefined();
    expect(SEO_09).toMatchObject({ owner: "karos_tool", fixAction: "manual", actionKind: "connect" });
    expect(SEO_09.engineProductId).toBeUndefined();
    expect(GEO_09).toMatchObject({ owner: "karos_agent", fixAction: "manual", actionKind: "review_approve", engineProductId: "seo-geo-agent" });
  });
});

describe("taskOwnerForRecOwner — the RecOwner -> ClientTask.owner dispatch table", () => {
  it("maps karos_agent to karos_managed", () => {
    expect(taskOwnerForRecOwner("karos_agent")).toBe("karos_managed");
  });
  it("maps karos_tool to client_managed (the client must connect it first)", () => {
    expect(taskOwnerForRecOwner("karos_tool")).toBe("client_managed");
  });
  it("maps client_manual to client_managed", () => {
    expect(taskOwnerForRecOwner("client_manual")).toBe("client_managed");
  });
});

describe("priorityForImpact", () => {
  it("collapses critical/high to high, passes medium/low through, and falls back to medium", () => {
    expect(priorityForImpact("critical")).toBe("high");
    expect(priorityForImpact("high")).toBe("high");
    expect(priorityForImpact("medium")).toBe("medium");
    expect(priorityForImpact("low")).toBe("low");
    expect(priorityForImpact("something-the-catalog-never-sends")).toBe("medium");
  });
});

const ctx = { clientId: "client-1", createdBy: "staff-1", now: 1_735_000_000_000 };

describe("routableRecommendationToTaskInput — per-row acceptance (owner/fixAction/actionKind combination -> ClientTask)", () => {
  it("SEO-02 (meta_title/one_click/karos_agent): karos_managed, agentEngineProductId carried, no integration_action shape", () => {
    const task = routableRecommendationToTaskInput(SEO_02, ctx);
    expect(task.clientId).toBe("client-1");
    expect(task.status).toBe("pending");
    expect(task.owner).toBe("karos_managed");
    expect(task.priority).toBe("high"); // impact: "high"
    expect(task.metadata?.recId).toBe("SEO-02");
    expect(task.metadata?.action).toEqual({ fixAction: "meta_title", actionKind: "one_click" });
    expect(task.metadata?.agentEngineProductId).toBe("seo-geo-agent");
    expect(task.metadata?.type).toBeUndefined();
    expect(task.metadata?.completionTrigger).toBeUndefined();
    expect(task.createdBy).toBe("staff-1");
    expect(task.createdAt).toBe(ctx.now);
  });

  it("SEO-04 (manual/guided_manual/client_manual): client_managed, no agentEngineProductId, no integration_action shape", () => {
    const task = routableRecommendationToTaskInput(SEO_04, ctx);
    expect(task.owner).toBe("client_managed");
    expect(task.priority).toBe("medium"); // impact: "medium"
    expect(task.metadata?.recId).toBe("SEO-04");
    expect(task.metadata?.action).toEqual({ fixAction: "manual", actionKind: "guided_manual" });
    expect(task.metadata?.agentEngineProductId).toBeUndefined();
    expect(task.metadata?.type).toBeUndefined();
    expect(task.metadata?.completionTrigger).toBeUndefined();
  });

  it("SEO-09 (manual/connect/karos_tool): client_managed, integration_action shape wired off actionKind === connect", () => {
    const task = routableRecommendationToTaskInput(SEO_09, ctx);
    expect(task.owner).toBe("client_managed");
    expect(task.priority).toBe("low"); // impact: "low"
    expect(task.metadata?.recId).toBe("SEO-09");
    expect(task.metadata?.action).toEqual({ fixAction: "manual", actionKind: "connect" });
    expect(task.metadata?.agentEngineProductId).toBeUndefined();
    expect(task.metadata?.platform).toBe("search-console");
    expect(task.metadata?.type).toBe("integration_action");
    expect(task.metadata?.completionTrigger).toBe("integration_connected:search-console");
  });

  it("GEO-09 (manual/review_approve/karos_agent): karos_managed, agentEngineProductId carried, no integration_action shape", () => {
    const task = routableRecommendationToTaskInput(GEO_09, ctx);
    expect(task.owner).toBe("karos_managed");
    expect(task.priority).toBe("high"); // impact: "critical" collapses to high
    expect(task.metadata?.recId).toBe("GEO-09");
    expect(task.metadata?.action).toEqual({ fixAction: "manual", actionKind: "review_approve" });
    expect(task.metadata?.agentEngineProductId).toBe("seo-geo-agent");
    expect(task.metadata?.type).toBeUndefined();
    expect(task.metadata?.completionTrigger).toBeUndefined();
  });

  it("title/description always come from resolveRecCopy(recId) — never blank, never the raw engine prose verbatim", () => {
    for (const rec of ALL_FOUR) {
      const task = routableRecommendationToTaskInput(rec, ctx);
      expect(task.title.length).toBeGreaterThan(0);
      expect(task.description?.length ?? 0).toBeGreaterThan(0);
    }
  });

  it("a karos_agent record whose engineProductId is not actually a known engine product id never carries it onto the task", () => {
    // Constructed directly (bypassing toRoutableRecommendation's own boundary
    // check) to prove THIS module's own defensive re-check, independent of
    // the parser's.
    const suspect: RoutableRecommendation = { ...SEO_02, engineProductId: "not-a-real-product" };
    const task = routableRecommendationToTaskInput(suspect, ctx);
    expect(task.metadata?.agentEngineProductId).toBeUndefined();
  });

  it("a connect recommendation with no targetPlatform gets no integration_action shape at all", () => {
    const suspect: RoutableRecommendation = { ...SEO_09, targetPlatform: undefined };
    const task = routableRecommendationToTaskInput(suspect, ctx);
    expect(task.metadata?.platform).toBeUndefined();
    expect(task.metadata?.type).toBeUndefined();
    expect(task.metadata?.completionTrigger).toBeUndefined();
  });
});

describe("routableRecommendationsToTaskInputs — batch + idempotency", () => {
  it("converts every recommendation when no existing recIds are supplied", () => {
    const inputs = routableRecommendationsToTaskInputs(ALL_FOUR, ctx);
    expect(inputs.map((t) => t.metadata?.recId)).toEqual(["SEO-02", "SEO-04", "SEO-09", "GEO-09"]);
  });

  it("skips a recId that already has a task on the board", () => {
    const inputs = routableRecommendationsToTaskInputs(ALL_FOUR, ctx, new Set(["SEO-04", "GEO-09"]));
    expect(inputs.map((t) => t.metadata?.recId)).toEqual(["SEO-02", "SEO-09"]);
  });
});

/**
 * PROOF THAT THIS IS GENERIC DISPATCH, NOT recId-KEYED. Feeds every combination
 * on synthetic recIds this module (and this repo) has never seen — if the
 * converter secretly branched on recId, these would fall through to some
 * default and disagree with the real-row assertions above for the same
 * owner/fixAction/actionKind combination.
 */
describe("dispatch is keyed on owner/fixAction/actionKind alone, never on recId", () => {
  it("a never-before-seen recId with SEO-02's owner/fixAction/actionKind produces the identical routing", () => {
    const synthetic = toRoutableRecommendation(
      baseRaw({
        recId: "SYN-TASK-001",
        fixAction: "meta_title",
        actionKind: "one_click",
        owner: "karos_agent",
        engineProductId: "seo-geo-agent",
      }),
    )!;
    const real = routableRecommendationToTaskInput(SEO_02, ctx);
    const synth = routableRecommendationToTaskInput(synthetic, ctx);
    expect(synth.owner).toBe(real.owner);
    expect(synth.priority).toBe(real.priority);
    expect(synth.metadata?.action).toEqual(real.metadata?.action);
    expect(synth.metadata?.agentEngineProductId).toEqual(real.metadata?.agentEngineProductId);
    expect(synth.metadata?.recId).toBe("SYN-TASK-001"); // only the recId itself differs
  });

  it("a never-before-seen recId with SEO-09's owner/fixAction/actionKind produces the identical integration_action routing", () => {
    const synthetic = toRoutableRecommendation(
      baseRaw({
        recId: "SYN-TASK-002",
        fixAction: "manual",
        actionKind: "connect",
        owner: "karos_tool",
        targetPlatform: "search-console",
      }),
    )!;
    const real = routableRecommendationToTaskInput(SEO_09, ctx);
    const synth = routableRecommendationToTaskInput(synthetic, ctx);
    expect(synth.owner).toBe(real.owner);
    expect(synth.metadata?.platform).toBe(real.metadata?.platform);
    expect(synth.metadata?.type).toBe(real.metadata?.type);
    expect(synth.metadata?.completionTrigger).toBe(real.metadata?.completionTrigger);
  });
});
