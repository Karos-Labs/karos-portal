import { describe, expect, it } from "vitest";
import {
  computeAgentStaleness,
  agentStalenessSummary,
  reviewBacklogSummary,
  STALE_NO_CADENCE_DAYS,
} from "@/lib/agent-staleness";

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = 1_700_000_000_000;

const AGENT_A = { id: "ca1", name: "LinkedIn Agent" };
const AGENT_B = { id: "ca2", name: "Instagram Agent" };

describe("computeAgentStaleness", () => {
  it("flags a granted agent that has never run", () => {
    const [signal] = computeAgentStaleness([AGENT_A], [], [], NOW);
    expect(signal.status).toBe("never_run");
    expect(signal.lastRunAt).toBeNull();
    expect(signal.daysSinceLastRun).toBeNull();
  });

  it("is fresh when the agent ran recently and has no stale-triggering gap", () => {
    const jobs = [{ customAgentId: "ca1", createdAt: NOW - DAY_MS }];
    const [signal] = computeAgentStaleness([AGENT_A], jobs, [], NOW);
    expect(signal.status).toBe("fresh");
    expect(signal.daysSinceLastRun).toBe(1);
  });

  it("flags stale_no_cadence once daysSinceLastRun crosses the shared horizon, with no active schedule", () => {
    const jobs = [{ customAgentId: "ca1", createdAt: NOW - STALE_NO_CADENCE_DAYS * DAY_MS }];
    const [signal] = computeAgentStaleness([AGENT_A], jobs, [], NOW);
    expect(signal.status).toBe("stale_no_cadence");
  });

  it("an active schedule prevents stale_no_cadence even past the horizon — overdue_schedule takes over instead", () => {
    const jobs = [{ customAgentId: "ca1", createdAt: NOW - 30 * DAY_MS }];
    const futureSchedule = [{ customAgentId: "ca1", status: "active" as const, nextRunAt: NOW + DAY_MS }];
    const [onTime] = computeAgentStaleness([AGENT_A], jobs, futureSchedule, NOW);
    expect(onTime.status).toBe("fresh");

    const overdueSchedule = [{ customAgentId: "ca1", status: "active" as const, nextRunAt: NOW - DAY_MS }];
    const [overdue] = computeAgentStaleness([AGENT_A], jobs, overdueSchedule, NOW);
    expect(overdue.status).toBe("overdue_schedule");
  });

  it("joins by customAgentId, not agent name — a job for a different agent never counts", () => {
    const jobs = [{ customAgentId: "ca2", createdAt: NOW - DAY_MS }];
    const [signal] = computeAgentStaleness([AGENT_A], jobs, [], NOW);
    expect(signal.status).toBe("never_run");
  });

  it("evaluates every granted agent independently", () => {
    const jobs = [{ customAgentId: "ca1", createdAt: NOW - DAY_MS }];
    const signals = computeAgentStaleness([AGENT_A, AGENT_B], jobs, [], NOW);
    expect(signals.find((s) => s.agentId === "ca1")?.status).toBe("fresh");
    expect(signals.find((s) => s.agentId === "ca2")?.status).toBe("never_run");
  });
});

describe("agentStalenessSummary", () => {
  it("says nothing is stale when every signal is fresh", () => {
    const jobs = [{ customAgentId: "ca1", createdAt: NOW - DAY_MS }];
    const signals = computeAgentStaleness([AGENT_A], jobs, [], NOW);
    expect(agentStalenessSummary(signals)).toMatch(/no agent staleness/i);
  });

  it("names the agent and the reason for every flagged one, and omits fresh agents", () => {
    const jobs = [{ customAgentId: "ca1", createdAt: NOW - DAY_MS }];
    const signals = computeAgentStaleness([AGENT_A, AGENT_B], jobs, [], NOW);
    const summary = agentStalenessSummary(signals);
    expect(summary).toContain(AGENT_B.name);
    expect(summary).toContain("NEVER RUN");
    expect(summary).not.toContain(AGENT_A.name);
  });
});

describe("reviewBacklogSummary", () => {
  it("reports none when there are no drafts", () => {
    expect(reviewBacklogSummary([], NOW)).toMatch(/no review backlog/i);
  });

  it("counts drafts and names the oldest one's age", () => {
    const assets: { status: "draft" | "published"; createdAt: number }[] = [
      { status: "draft", createdAt: NOW - 5 * DAY_MS },
      { status: "draft", createdAt: NOW - 2 * DAY_MS },
      { status: "published", createdAt: NOW - 10 * DAY_MS },
    ];
    const summary = reviewBacklogSummary(assets, NOW);
    expect(summary).toContain("2 draft");
    expect(summary).toContain("5 day");
  });
});
