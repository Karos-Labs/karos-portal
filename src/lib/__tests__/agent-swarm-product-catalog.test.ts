import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * SCRUM-262 (T-B22) — the swarm's managed-productType vocabulary must be
 * DERIVED from the canonical MANAGED_PRODUCTS catalog (agent-service/products.ts,
 * already the single source of truth agent-roster.ts's managedCatalogEntries()
 * builds from), never hand-duplicated as a second, independently-maintained
 * list. A hand-typed list is exactly the divergence risk C4 (SCRUM-212) names
 * as its ownership principle: "what is auto-derived does not go stale; what is
 * hand-written in the portal does."
 *
 * This test mocks the catalog to include a THIRD product absent from the old
 * hardcoded `PRODUCT_TYPES` tuple in agent-swarm.ts. On unmodified code the
 * swarm's zod schema still only knows the two hand-typed values and rejects
 * the new one — a real product the catalog now serves that the swarm could
 * never assign a task to. After deriving the vocabulary from MANAGED_PRODUCTS,
 * the schema tracks the catalog automatically.
 */

vi.mock("server-only", () => ({}));
vi.mock("ai", () => ({ generateObject: vi.fn() }));
vi.mock("@ai-sdk/anthropic", () => ({ anthropic: vi.fn(() => "mock-model") }));
vi.mock("next/server", () => ({ after: (fn: () => void) => fn() }));
vi.mock("@/services/logger", () => ({ logger: { logUsage: vi.fn(), logGenerationFailure: vi.fn() } }));
vi.mock("@/lib/campaign-engine", () => ({ generateCampaignBundle: vi.fn() }));
vi.mock("@/lib/data", () => ({
  getTaskBoardCapacity: vi.fn(),
  createClientTask: vi.fn(),
  getClient: vi.fn(),
  listAssets: vi.fn(),
  listClientIntegrations: vi.fn(),
  getClientPerformanceBenchmarks: vi.fn(),
  listCustomAgents: vi.fn(),
}));

// The catalog the fix must derive from — three products, the third one
// ("podcast_clip") absent from today's hand-typed PRODUCT_TYPES tuple.
vi.mock("@/lib/agent-service/products", () => ({
  MANAGED_PRODUCTS: [
    { taskType: "social_post", name: "Social posts" },
    { taskType: "landing_page", name: "Landing page" },
    { taskType: "podcast_clip", name: "Podcast clip" },
  ],
  getManagedProduct: vi.fn(),
}));

beforeEach(() => {
  vi.resetModules();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("swarmTaskSchema.productType — derived from MANAGED_PRODUCTS, not hand-duplicated", () => {
  it("accepts every taskType the canonical catalog currently serves", async () => {
    const { swarmTaskSchema } = await import("@/lib/agent-swarm");
    const { MANAGED_PRODUCTS } = await import("@/lib/agent-service/products");

    for (const product of MANAGED_PRODUCTS as Array<{ taskType: string }>) {
      const result = swarmTaskSchema.safeParse({
        title: "t",
        description: "d",
        priority: "medium",
        productType: product.taskType,
        weight: 50,
      });
      expect(
        result.success,
        `productType "${product.taskType}" is in MANAGED_PRODUCTS but swarmTaskSchema rejected it: ${
          result.success ? "" : JSON.stringify(result.error.issues)
        }`,
      ).toBe(true);
    }
  });
});
