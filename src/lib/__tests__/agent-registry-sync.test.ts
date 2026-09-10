import { describe, expect, it } from "vitest";
import { MANAGED_PRODUCTS } from "@/lib/agent-service/products";

/**
 * Drift guard between the platform's agent catalog and the agent-service
 * execution registry (the real source of truth for what can run). The service
 * has no HTTP catalog endpoint and no shared package — its task types are a
 * compile-time `TASK_TYPES` tuple in agent-service/src/types.ts — so this test
 * reads that file and fails CI the moment the two diverge. When the service
 * adds/removes a task type, this breaks until the platform mirror
 * (MANAGED_PRODUCTS + the ManagedTaskType union) is updated to match, so the
 * copilot can never silently reference a stale agent set.
 *
 * "custom" is the service's generic runner (any git-imported custom agent);
 * it is NOT a MANAGED_PRODUCT (custom agents are dynamic, per-client), so the
 * platform's managed set is the service set minus "custom".
 */
/**
 * agent-service's task types, frozen.
 *
 * This used to be read out of `agent-service/src/types.ts`, which is the
 * better shape when the file exists: the guard could not go stale because it
 * re-derived the truth every run. That directory is gone from this repo, and
 * with the deploy workflows gone too the service can no longer change — the
 * revisions serving production are the last ones there will be. A frozen
 * literal is therefore accurate, and keeping the check is worth more than
 * deleting it because the platform side CAN still change: this is what stops
 * someone adding a managed product that maps to a task type nothing executes.
 *
 * Recovered from agent-service/src/types.ts at 942218f, the commit before the
 * directory was removed.
 */
const SERVICE_TASK_TYPES = ["social_post", "landing_page", "custom"] as const;

function serviceTaskTypes(): string[] {
  return [...SERVICE_TASK_TYPES];
}

const GENERIC_RUNNER = "custom";

describe("agent registry sync — platform catalog ⟷ agent-service TASK_TYPES", () => {
  it("every managed product maps to a real, executable service task type", () => {
    const serviceSet = new Set(serviceTaskTypes());
    for (const product of MANAGED_PRODUCTS) {
      expect(
        serviceSet.has(product.taskType),
        `MANAGED_PRODUCTS has "${product.taskType}" but the agent service does not execute it`,
      ).toBe(true);
    }
  });

  it("the platform covers every service task type (no agent goes unreferenced)", () => {
    const serviceSet = new Set(serviceTaskTypes());
    const platformSet = new Set<string>([
      ...MANAGED_PRODUCTS.map((p) => p.taskType),
      GENERIC_RUNNER, // custom agents run through the generic runner, not a product
    ]);
    const missing = [...serviceSet].filter((t) => !platformSet.has(t));
    expect(
      missing,
      `agent-service can run [${missing.join(", ")}] but the platform references neither a managed product nor the generic runner for them — update MANAGED_PRODUCTS / ManagedTaskType`,
    ).toEqual([]);
  });

  it("the generic runner exists in the service (custom agents depend on it)", () => {
    expect(serviceTaskTypes()).toContain(GENERIC_RUNNER);
  });
});
