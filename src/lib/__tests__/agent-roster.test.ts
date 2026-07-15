import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { getClientMock, listCustomAgentsMock } = vi.hoisted(() => ({
  getClientMock: vi.fn(),
  listCustomAgentsMock: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/data", () => ({
  getClient: getClientMock,
  listCustomAgents: listCustomAgentsMock,
}));

import {
  getClientCustomAgents,
  buildAgentCatalog,
  managedCatalogEntries,
  type ClientCustomAgentSummary,
} from "@/lib/agent-roster";
import { MANAGED_PRODUCTS } from "@/lib/agent-service/products";
import type { CustomAgent } from "@/lib/types";

function agent(patch: Partial<CustomAgent>): CustomAgent {
  return {
    id: "ca",
    key: "ca",
    name: "Agent",
    description: "does things",
    icon: "Bot",
    color: "#fff",
    entrySkillDir: "",
    skillRoots: [],
    includeClientSkills: false,
    instructions: "secret instructions",
    enabled: true,
    createdBy: "u1",
    createdAt: 0,
    ...patch,
  } as CustomAgent;
}

beforeEach(() => {
  getClientMock.mockResolvedValue({ id: "c1", customAgentIds: ["ca_1", "ca_2"] });
  listCustomAgentsMock.mockResolvedValue([
    agent({ id: "ca_1", name: "Video Agent", enabled: true }),
    agent({ id: "ca_2", name: "Disabled Agent", enabled: false }),
    agent({ id: "ca_3", name: "Ungranted Agent", enabled: true }),
  ]);
});

afterEach(() => vi.clearAllMocks());

describe("getClientCustomAgents", () => {
  it("returns only granted AND enabled agents, as client-safe summaries", async () => {
    const result = await getClientCustomAgents("c1");
    expect(result).toEqual([{ id: "ca_1", name: "Video Agent", description: "does things" }]);
    // Never leaks instructions/skill paths.
    expect(JSON.stringify(result)).not.toContain("secret instructions");
  });

  it("returns empty when the client has no granted agents (and skips the list query)", async () => {
    getClientMock.mockResolvedValue({ id: "c1", customAgentIds: [] });
    expect(await getClientCustomAgents("c1")).toEqual([]);
    expect(listCustomAgentsMock).not.toHaveBeenCalled();
  });

  it("returns empty when the client is missing", async () => {
    getClientMock.mockResolvedValue(null);
    expect(await getClientCustomAgents("c1")).toEqual([]);
  });
});

describe("buildAgentCatalog", () => {
  it("lists every managed product first, tagged kind=managed", () => {
    const catalog = buildAgentCatalog([]);
    expect(catalog).toHaveLength(MANAGED_PRODUCTS.length);
    expect(catalog.every((e) => e.kind === "managed")).toBe(true);
    expect(catalog[0].id).toBe(MANAGED_PRODUCTS[0].taskType);
  });

  it("appends custom agents tagged kind=custom after the managed products", () => {
    const custom: ClientCustomAgentSummary[] = [{ id: "ca_1", name: "Video Agent", description: "d" }];
    const catalog = buildAgentCatalog(custom);
    expect(catalog).toHaveLength(MANAGED_PRODUCTS.length + 1);
    const last = catalog.at(-1)!;
    expect(last).toMatchObject({ id: "ca_1", name: "Video Agent", kind: "custom", outputKind: "custom" });
  });

  it("managedCatalogEntries carries deliverables + brief keys from the registry", () => {
    const managed = managedCatalogEntries();
    expect(managed[0].deliverables).toEqual(MANAGED_PRODUCTS[0].deliverables);
    expect(managed[0].briefKeys).toEqual(MANAGED_PRODUCTS[0].briefFields.map((f) => f.key));
  });
});
