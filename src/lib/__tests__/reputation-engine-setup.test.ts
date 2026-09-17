import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as data from "@/lib/data";
import {
  isReputationSetupInlinedForClient,
  toReputationEngineRunInput,
} from "@/lib/agent-service/reputation-agent-context";
import type { AgentIntake, Client } from "@/lib/types";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/data");

/**
 * Setup for the reputation agent on the ENGINE path — agent-engine's
 * `reputation-agent` runs a `00-roster-setup` pre-flight that resolves the
 * client's listings from the intake the run carries. These pin the portal's
 * half of that contract: the intake reaches the run under the engine's own
 * keys, and every surface that used to ask for a stand-up run treats an
 * engine-routed client as set up, because the engine does it unasked.
 */

const intake = (overrides: Partial<AgentIntake> = {}): AgentIntake =>
  ({
    id: "i1",
    clientId: "c1",
    agent: "reputation",
    seatId: null,
    createdBy: "u1",
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }) as AgentIntake;

describe("toReputationEngineRunInput — the intake as the engine's run input", () => {
  it("sends only what the client filled, trimmed, under the keys 00-roster-setup reads", () => {
    expect(
      toReputationEngineRunInput(
        intake({
          reviewSurfaces: [" https://apps.apple.com/gb/app/acme/id123456789 ", "Google", ""],
          reviewMarkets: ["Springfield"],
          responseNoGos: ["we will refund you"],
          crisisRoutingTag: " ops@acme.example ",
          reputationContext: "Ownership changed in June.",
        }),
      ),
    ).toEqual({
      reviewSurfaces: ["https://apps.apple.com/gb/app/acme/id123456789", "Google"],
      reviewMarkets: ["Springfield"],
      responseNoGos: ["we will refund you"],
      crisisRoutingTag: "ops@acme.example",
      reputationContext: "Ownership changed in June.",
    });
  });

  it("omits an empty answer rather than sending an empty list — the engine reads absence as 'said nothing'", () => {
    expect(toReputationEngineRunInput(intake({ reviewSurfaces: [], crisisRoutingTag: "   " }))).toEqual({});
    expect(toReputationEngineRunInput(null)).toEqual({});
  });

  it("spells its keys the way the engine's ROSTER_SETUP_INPUT_KEYS does", () => {
    // The engine side is in another repo; this is the one place the portal
    // states the contract, so the names are pinned as literals here.
    const keys = Object.keys(
      toReputationEngineRunInput(
        intake({ reviewSurfaces: ["x"], reviewMarkets: ["x"], responseNoGos: ["x"], crisisRoutingTag: "x", reputationContext: "x" }),
      ),
    ).sort();
    expect(keys).toEqual(["crisisRoutingTag", "reputationContext", "responseNoGos", "reviewMarkets", "reviewSurfaces"]);
  });
});

describe("isReputationSetupInlinedForClient — the engine gate, asked the way the submit core asks it", () => {
  beforeEach(() => {
    vi.mocked(data.getClient).mockResolvedValue({ id: "c1", name: "Acme", agentsRepoSlug: "acme" } as Client);
    vi.stubEnv("AGENT_ENGINE_DISPATCH_ENABLED", "true");
    vi.stubEnv("AGENT_ENGINE_CUSTOM_AGENT_CLIENTS", "acme");
  });

  it("is true for a client whose reputation agent routes to the engine", async () => {
    await expect(isReputationSetupInlinedForClient("c1")).resolves.toBe(true);
  });

  it("is false when the client is outside the allowlist — the run would go nowhere, so setup is not 'handled'", async () => {
    vi.stubEnv("AGENT_ENGINE_CUSTOM_AGENT_CLIENTS", "someone-else");
    await expect(isReputationSetupInlinedForClient("c1")).resolves.toBe(false);
  });

  it("is false when dispatch is off, or the client has no lab slug", async () => {
    vi.stubEnv("AGENT_ENGINE_DISPATCH_ENABLED", "false");
    await expect(isReputationSetupInlinedForClient("c1")).resolves.toBe(false);
    vi.stubEnv("AGENT_ENGINE_DISPATCH_ENABLED", "true");
    vi.mocked(data.getClient).mockResolvedValue({ id: "c1", name: "Acme" } as Client);
    await expect(isReputationSetupInlinedForClient("c1")).resolves.toBe(false);
  });
});

describe("the wiring that has to agree across modules (engine path)", () => {
  const core = readFileSync(join(process.cwd(), "src/lib/jobs/submit-custom.ts"), "utf8");
  const rows = readFileSync(join(process.cwd(), "src/lib/client-agent-rows.ts"), "utf8");
  const views = readFileSync(join(process.cwd(), "src/lib/agent-intake-views.ts"), "utf8");

  it("hands the saved intake to the engine run and skips the stand-up rung ONLY on the engine path", () => {
    expect(core).toContain('toReputationEngineRunInput(await getAgentIntake(input.clientId, "reputation", null))');
    // The legacy rung is still there for the non-engine branch...
    expect(core).toContain("hasReputationV2Setup(input.clientId)");
    // ...and the intake gate is asked BEFORE the branch, on both paths.
    expect(core.indexOf("hasReputationAgentIntake(input.clientId)")).toBeLessThan(core.indexOf("toReputationEngineRunInput("));
    // Merged after the dialog fields, so a dialog key wins over an intake key.
    expect(core).toContain("inputs: { ...toEngineRunInput(engineBriefValues, engineProductId), ...engineExtraInputs }");
  });

  it("reads 'ready' and 'set up' off the same predicate in the rows and the intake view", () => {
    expect(rows).toContain("isReputationSetupInlinedForClient(clientId, agent.key)");
    expect(rows).toContain("hasIntake && (isSetUp || inlined)");
    expect(views).toContain("isReputationSetupInlinedForClient(clientId)");
    expect(views).toContain("const isSetUp = hasRosterRow || inlined;");
  });

  it("counts engine pulses in the run history", () => {
    expect(views).toContain('j.agentId === "agent-engine" && j.agentEngineProductId === "reputation-agent"');
  });
});
