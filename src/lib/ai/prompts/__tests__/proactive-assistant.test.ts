import { describe, expect, it } from "vitest";

import {
  buildProactiveSystemAppendix,
  type AgentCatalogEntry,
  type ProactiveSystemContext,
} from "@/lib/ai/prompts/proactive-assistant";

/**
 * T-B6 (SCRUM-250) — the planner's prompt must read `capabilities` (and its
 * C4 siblings `platforms` / `consumesMedia` / `requiredInputs`) OFF THE
 * DESCRIPTOR, with zero knowledge of any specific agent hardcoded in portal
 * code (per the ticket's own C4/SCRUM-212 vocabulary).
 *
 * The proof is a fixture whose id/name/capability tags exist NOWHERE else in
 * this codebase ("zz_fixture_agent_9000", "produce_confetti", "mastodon").
 * Those strings can only appear in `buildProactiveSystemAppendix`'s output by
 * having been read off the fixture object at call time — no hand-written
 * agent list in `proactive-assistant.ts` could have produced them. Changing
 * the fixture between the two tests below, and getting a correspondingly
 * different appendix each time with no code change, is what rules out a
 * per-agent conditional/name-check anywhere in the render path.
 */

const baseCtx: Omit<ProactiveSystemContext, "agents"> = {
  linkedSocialPlatforms: [],
  integrations: [],
  scheduledNext14ByPlatform: {},
  hasGmailIntegration: false,
  hasScheduledContent: true,
  activeTaskCount: 0,
  maxActiveTasks: 10,
};

function fixtureEntry(patch: Partial<AgentCatalogEntry> = {}): AgentCatalogEntry {
  return {
    id: "zz_fixture_agent_9000",
    name: "Zz Fixture Agent",
    outputKind: "zz_fixture_agent_9000",
    description: "A fixture agent that exists only in this test.",
    capabilities: ["produce_confetti", "produce_glitter"],
    platforms: ["mastodon"],
    consumesMedia: true,
    requiredInputs: ["glitter_amount"],
    kind: "managed",
    ...patch,
  };
}

describe("buildProactiveSystemAppendix — descriptor-driven agent catalog (T-B6/SCRUM-250)", () => {
  it("renders capabilities/platforms/consumesMedia/requiredInputs verbatim from the fixture descriptor", () => {
    const appendix = buildProactiveSystemAppendix({ ...baseCtx, agents: [fixtureEntry()] });

    expect(appendix).toContain("capabilities: produce_confetti, produce_glitter");
    expect(appendix).toContain("platforms: mastodon");
    expect(appendix).toContain("accepts uploaded image/video media as input");
    expect(appendix).toContain("required inputs: glitter_amount");
  });

  it("changes when the fixture changes — proving it is read, not hardcoded", () => {
    const first = buildProactiveSystemAppendix({ ...baseCtx, agents: [fixtureEntry()] });
    const second = buildProactiveSystemAppendix({
      ...baseCtx,
      agents: [
        fixtureEntry({
          capabilities: ["produce_webpage"],
          platforms: [],
          consumesMedia: false,
          requiredInputs: [],
        }),
      ],
    });

    // The first fixture's tags are gone once the fixture no longer carries them.
    expect(first).toContain("produce_confetti");
    expect(second).not.toContain("produce_confetti");
    expect(second).not.toContain("mastodon");
    expect(second).not.toContain("accepts uploaded image/video media as input");
    expect(second).not.toContain("required inputs:");
    // The new fixture's own tag shows up instead.
    expect(second).toContain("capabilities: produce_webpage");
  });

  it("omits capabilities/platforms/media/required-input lines entirely when the descriptor carries none — no fallback to invented defaults", () => {
    const appendix = buildProactiveSystemAppendix({
      ...baseCtx,
      agents: [
        fixtureEntry({
          capabilities: [],
          platforms: undefined,
          consumesMedia: undefined,
          requiredInputs: undefined,
        }),
      ],
    });

    expect(appendix).not.toContain("capabilities:");
    expect(appendix).not.toContain("platforms:");
    expect(appendix).not.toContain("accepts uploaded image/video media as input");
    expect(appendix).not.toContain("required inputs:");
  });

  it("treats two differently-named agents with identical descriptors identically — the render is a pure function of the descriptor, not of id/name", () => {
    const agentA = fixtureEntry({ id: "agent_a", name: "Agent A" });
    const agentB = fixtureEntry({ id: "agent_b", name: "Totally Different Name Co." });

    const appendixA = buildProactiveSystemAppendix({ ...baseCtx, agents: [agentA] });
    const appendixB = buildProactiveSystemAppendix({ ...baseCtx, agents: [agentB] });

    const stripName = (s: string) => s.replace(/Agent A|Totally Different Name Co\./g, "<NAME>").replace(/agent_a|agent_b/g, "<ID>");
    expect(stripName(appendixA)).toBe(stripName(appendixB));
  });
});
