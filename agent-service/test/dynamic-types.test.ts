import { describe, expect, it } from "vitest";
import { AGENT_MODEL_ALIASES } from "../src/task-types.js";
import { isDynamicAgentBrief } from "../src/dynamic-types.js";
import type { DynamicAgentModelAlias, DynamicAgentSpec } from "../src/dynamic-types.js";

describe("AGENT_MODEL_ALIASES", () => {
  it("resolves every DynamicAgentModelAlias to a concrete model id", () => {
    const aliases: DynamicAgentModelAlias[] = ["opus", "sonnet", "haiku"];
    for (const alias of aliases) {
      expect(typeof AGENT_MODEL_ALIASES[alias]).toBe("string");
      expect(AGENT_MODEL_ALIASES[alias].length).toBeGreaterThan(0);
    }
  });

  it("maps exactly the three aliases — nothing extra, nothing missing", () => {
    expect(Object.keys(AGENT_MODEL_ALIASES).sort()).toEqual(["haiku", "opus", "sonnet"]);
  });

  it("never resolves an alias to a raw id containing another alias's name as a substring mismatch (sanity: each id is distinct)", () => {
    const ids = Object.values(AGENT_MODEL_ALIASES);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

function minimalSpec(): DynamicAgentSpec {
  return {
    id: "spec-1",
    name: "Test",
    description: "d",
    category: "c",
    icon: "Sparkles",
    creditsCost: 1,
    active: true,
    version: 1,
    inputSchema: [],
    steps: [{ id: "s1", type: "ai", label: "Step", model: "sonnet", prompt: "Go", order: 0 }],
    createdAt: 0,
    updatedAt: 0,
    createdBy: "u1",
  };
}

describe("isDynamicAgentBrief", () => {
  it("recognizes a brief carrying a specSnapshot with a steps array", () => {
    expect(isDynamicAgentBrief({ specSnapshot: minimalSpec() })).toBe(true);
  });

  it("rejects a legacy hardcoded-agent brief", () => {
    expect(
      isDynamicAgentBrief({ entry_skill_dir: "products/live/x", instructions: "go", prompt: "3 posts" }),
    ).toBe(false);
  });

  it("rejects a brief with a specSnapshot that isn't a real spec object", () => {
    expect(isDynamicAgentBrief({ specSnapshot: "not-an-object" })).toBe(false);
    expect(isDynamicAgentBrief({ specSnapshot: { steps: "not-an-array" } })).toBe(false);
    expect(isDynamicAgentBrief({})).toBe(false);
  });
});
