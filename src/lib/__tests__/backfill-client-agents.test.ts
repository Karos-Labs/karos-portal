/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it } from "vitest";
import { planClient } from "../../../scripts/backfill-client-agents";

/**
 * Phase 3 §9 — the backfill's decision, checked without a database.
 *
 * This is the function that decides what gets written to PRODUCTION Firestore,
 * so the properties that matter are the destructive ones: it never re-dates an
 * asset, never touches an umbrella that already exists, and never invents a
 * template for a post it cannot classify.
 */

const NOW = Date.parse("2026-07-28T12:00:00Z");

function agent(patch: Record<string, any> = {}): any {
  return {
    id: "ag-ig",
    key: "karos-instagram-tiktok-content-agent",
    name: "Instagram Agent",
    description: "internal",
    enabled: true,
    creditCost: 25,
    ...patch,
  };
}

function asset(patch: Record<string, any> = {}): any {
  return {
    id: "a1",
    clientId: "c1",
    type: "social_post",
    title: "A post",
    content: "",
    status: "approved",
    templateKey: "by-the-numbers",
    templateName: "By The Numbers",
    createdBy: "u1",
    createdAt: 1_000,
    updatedAt: 1_000,
    ...patch,
  };
}

function job(patch: Record<string, any> = {}): any {
  return {
    id: "j1",
    clientId: "c1",
    agentId: "agent-service",
    agentName: "Instagram Agent",
    customAgentId: "ag-ig",
    status: "delivered",
    assetIds: [],
    input: {},
    createdAt: 0,
    external: { serviceJobId: "s1", taskType: "custom" },
    ...patch,
  };
}

function plan(over: Record<string, any> = {}) {
  return planClient({
    clientId: "c1",
    clientName: "Acme",
    grantedAgentIds: ["ag-ig"],
    agents: new Map([["ag-ig", agent()]]),
    assets: [],
    jobs: [],
    schedules: [],
    existingUmbrellaIds: new Set<string>(),
    now: NOW,
    ...over,
  });
}

describe("planClient — umbrella creation (§9 step 1)", () => {
  it("creates a live umbrella for an agent that has demonstrably produced", () => {
    const result = plan({ jobs: [job()] });

    expect(result.umbrellas).toHaveLength(1);
    const u = result.umbrellas[0];
    expect(u.docId).toBe("c1__karos-instagram-tiktok-content-agent");
    expect(u.launchState).toBe("live");
    expect(u.platform).toBe("instagram");
    expect(u.optionsMode).toBe(false);
  });

  it("creates not_launched when the agent has never produced anything", () => {
    expect(plan().umbrellas[0].launchState).toBe("not_launched");
  });

  it("skips an agent whose identity maps to no content platform", () => {
    const seo = agent({ id: "ag-seo", key: "karos-seo-agent", name: "SEO Agent" });
    const result = plan({
      grantedAgentIds: ["ag-seo"],
      agents: new Map([["ag-seo", seo]]),
    });
    expect(result.umbrellas).toEqual([]);
  });

  it("skips a disabled agent", () => {
    const result = plan({ agents: new Map([["ag-ig", agent({ enabled: false })]]) });
    expect(result.umbrellas).toEqual([]);
  });

  it("includes an agent activated only by a successful run, not by the grant list", () => {
    const result = plan({ grantedAgentIds: [], jobs: [job()] });
    expect(result.umbrellas).toHaveLength(1);
    expect(result.umbrellas[0].launchState).toBe("live");
  });

  it("SKIPS WHOLE when an umbrella already exists — idempotency", () => {
    const result = plan({
      jobs: [job()],
      assets: [asset({ scheduledAt: NOW + 86_400_000 })],
      existingUmbrellaIds: new Set(["c1__karos-instagram-tiktok-content-agent"]),
    });
    const u = result.umbrellas[0];
    expect(u.existing).toBeTruthy();
    // Nothing is planned into a doc someone may have curated.
    expect(u.templates).toEqual([]);
    expect(u.slots).toEqual([]);
  });
});

describe("planClient — template seeding (§9 step 2)", () => {
  it("seeds one template per distinct derived template, in chain order", () => {
    const result = plan({
      jobs: [job()],
      assets: [
        asset({ id: "a1", jobId: "j1", templateKey: "by-the-numbers", templateName: "By The Numbers" }),
        asset({ id: "a2", jobId: "j1", templateKey: "playbook", templateName: "Playbook" }),
        asset({ id: "a3", jobId: "j1", templateKey: "by-the-numbers", templateName: "By The Numbers" }),
      ],
    });

    const u = result.umbrellas[0];
    expect(u.templates.map((t) => t.key)).toEqual(["by-the-numbers", "playbook"]);
  });

  it("reports an unclassifiable asset as an anomaly instead of inventing a stream", () => {
    const result = plan({
      jobs: [job()],
      assets: [
        asset({ id: "a-mystery", jobId: "j1", templateKey: null, templateName: null, meta: {} }),
      ],
    });

    expect(result.umbrellas[0].templates).toEqual([]);
    expect(result.anomalies.join(" ")).toContain("a-mystery");
  });

  it("leaves the X umbrella's registry empty — the daily pick has no streams", () => {
    const x = agent({ id: "ag-x", key: "karos-x-agent-v2", name: "X Agent" });
    const result = plan({
      grantedAgentIds: ["ag-x"],
      agents: new Map([["ag-x", x]]),
      jobs: [job({ customAgentId: "ag-x", agentName: "X Agent" })],
      assets: [asset({ jobId: "j1", templateKey: "whatever" })],
    });

    const u = result.umbrellas[0];
    expect(u.optionsMode).toBe(true);
    expect(u.templates).toEqual([]);
    expect(u.chainFamily).toBeNull();
    // §9 step 5: no retroactive options slots — they generate forward-only.
    expect(u.slots).toEqual([]);
  });
});

describe("planClient — slot derivation with zero movement (§9 step 4)", () => {
  const future = NOW + 3 * 86_400_000;
  const past = NOW - 3 * 86_400_000;

  it("derives a slot on the day an asset ALREADY has", () => {
    const result = plan({
      jobs: [job()],
      assets: [asset({ id: "a-future", jobId: "j1", scheduledAt: future })],
    });

    const slots = result.umbrellas[0].slots;
    expect(slots).toHaveLength(1);
    expect(slots[0].assetId).toBe("a-future");
    expect(slots[0].dateKey).toBe("2026-07-31");
    expect(slots[0].docId).toBe("c1__karos-instagram-tiktok-content-agent__2026-07-31");
  });

  it("never derives a slot for a past or undated asset", () => {
    const result = plan({
      jobs: [job()],
      assets: [
        asset({ id: "a-past", jobId: "j1", scheduledAt: past }),
        asset({ id: "a-undated", jobId: "j1" }),
      ],
    });
    expect(result.umbrellas[0].slots).toEqual([]);
  });

  it("keeps one slot per day and reports the collision rather than dropping it silently", () => {
    const result = plan({
      jobs: [job()],
      assets: [
        asset({ id: "a-first", jobId: "j1", scheduledAt: future }),
        asset({ id: "a-second", jobId: "j1", scheduledAt: future + 3_600_000 }),
      ],
    });

    expect(result.umbrellas[0].slots).toHaveLength(1);
    expect(result.anomalies.join(" ")).toContain("a-second");
  });

  it("buckets the day in the SCHEDULE's zone, not the container's (F108)", () => {
    // 22:00 UTC on the 30th is already the 31st in Tel Aviv.
    const lateEvening = Date.parse("2026-07-30T22:00:00Z");
    const result = plan({
      jobs: [job()],
      assets: [asset({ id: "a-tz", jobId: "j1", scheduledAt: lateEvening })],
      schedules: [
        {
          id: "pr1",
          clientId: "c1",
          customAgentId: "ag-ig",
          cadence: "weekly",
          status: "active",
          timeZone: "Asia/Jerusalem",
        } as any,
      ],
    });

    expect(result.umbrellas[0].slots[0].dateKey).toBe("2026-07-31");
  });
});

describe("planClient — schedule linkage (§9 step 3)", () => {
  it("links the agent's live weekly schedule", () => {
    const result = plan({
      jobs: [job()],
      schedules: [
        { id: "pr1", clientId: "c1", customAgentId: "ag-ig", cadence: "weekly", status: "active" } as any,
      ],
    });
    expect(result.umbrellas[0].scheduleRunId).toBe("pr1");
  });

  it("ignores a completed schedule and leaves the umbrella unlinked", () => {
    const result = plan({
      jobs: [job()],
      schedules: [
        { id: "pr1", clientId: "c1", customAgentId: "ag-ig", cadence: "weekly", status: "completed" } as any,
      ],
    });
    expect(result.umbrellas[0].scheduleRunId).toBeNull();
  });
});

describe("planClient — job stamps (§9 step 6)", () => {
  it("counts only unstamped jobs of umbrellas it is creating", () => {
    const result = plan({
      jobs: [job({ id: "j1" }), job({ id: "j2", clientAgentId: "already" })],
    });
    expect(result.jobStamps).toBe(1);
  });
});
