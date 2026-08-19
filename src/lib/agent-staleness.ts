/**
 * Per-agent staleness + review-backlog detection — the signal the Task Map
 * debate (agent-swarm.ts) was missing. Every existing signal it reasons from
 * (calendar-gaps.ts's `computePlatformGaps`, performance benchmarks, brand
 * guidelines) answers at the PLATFORM/content-volume level; none of them can
 * tell a persona "LinkedIn Agent hasn't run in 9 days" or "3 drafts have sat
 * in review for 4+ days" — the two things this module answers.
 *
 * Pure and client-safe (no Firestore, no framework import), matching
 * calendar-gaps.ts's own house style: narrow `Pick<>` inputs, a companion
 * `*Summary` string-builder for the persona prompt.
 */

import type { Asset, Job, PlannedScheduledRun } from "@/lib/types";

/** Matches CONTENT_GAP_HORIZON_DAYS (lib/calendar-gaps.ts) — one shared notion of "too long". */
export const STALE_NO_CADENCE_DAYS = 14;

const DAY_MS = 24 * 60 * 60 * 1000;

export type AgentStalenessStatus = "never_run" | "overdue_schedule" | "stale_no_cadence" | "fresh";

export interface AgentStalenessSignal {
  agentId: string;
  agentName: string;
  lastRunAt: number | null;
  daysSinceLastRun: number | null;
  status: AgentStalenessStatus;
}

/**
 * One entry per granted agent. Joined by `customAgentId` — not name-matching
 * — `Job` and `PlannedScheduledRun` both carry it directly; matching by name
 * is the legacy fallback calendar-body.tsx already has to work around for
 * jobs old enough to predate the id.
 */
export function computeAgentStaleness(
  grantedAgents: readonly { id: string; name: string }[],
  jobs: readonly Pick<Job, "customAgentId" | "createdAt">[],
  scheduledRuns: readonly Pick<PlannedScheduledRun, "customAgentId" | "status" | "nextRunAt">[],
  now: number,
): AgentStalenessSignal[] {
  return grantedAgents.map((agent) => {
    const runs = jobs.filter((j) => j.customAgentId === agent.id);
    const lastRunAt = runs.length ? Math.max(...runs.map((j) => j.createdAt)) : null;
    const daysSinceLastRun = lastRunAt != null ? Math.floor((now - lastRunAt) / DAY_MS) : null;
    const activeSchedule = scheduledRuns.find(
      (r) => r.customAgentId === agent.id && r.status === "active",
    );

    if (activeSchedule && activeSchedule.nextRunAt < now) {
      return { agentId: agent.id, agentName: agent.name, lastRunAt, daysSinceLastRun, status: "overdue_schedule" };
    }
    if (lastRunAt == null) {
      return { agentId: agent.id, agentName: agent.name, lastRunAt: null, daysSinceLastRun: null, status: "never_run" };
    }
    if (!activeSchedule && daysSinceLastRun! >= STALE_NO_CADENCE_DAYS) {
      return { agentId: agent.id, agentName: agent.name, lastRunAt, daysSinceLastRun, status: "stale_no_cadence" };
    }
    return { agentId: agent.id, agentName: agent.name, lastRunAt, daysSinceLastRun, status: "fresh" };
  });
}

/** Prose block for the swarm's prompt — parallel to calendar-gaps.ts's own gap summary. */
export function agentStalenessSummary(signals: readonly AgentStalenessSignal[]): string {
  const flagged = signals.filter((s) => s.status !== "fresh");
  if (flagged.length === 0) return "No agent staleness — every granted agent has run recently.";
  return flagged
    .map((s) => {
      if (s.status === "never_run") return `- ${s.agentName} (${s.agentId}): NEVER RUN since being granted.`;
      if (s.status === "overdue_schedule") {
        return `- ${s.agentName} (${s.agentId}): has an active schedule that is OVERDUE (missed its expected fire).`;
      }
      return `- ${s.agentName} (${s.agentId}): STALE — last ran ${s.daysSinceLastRun} days ago, no active cadence.`;
    })
    .join("\n");
}

/**
 * How many drafts have sat unreviewed, and for how long — the same count
 * client-home-overview.tsx already computes for the "deliverables in review"
 * attention row, fed forward into task generation instead of staying
 * display-only.
 */
export function reviewBacklogSummary(
  assets: readonly Pick<Asset, "status" | "createdAt">[],
  now: number,
): string {
  const drafts = assets.filter((a) => a.status === "draft");
  if (drafts.length === 0) return "No review backlog.";
  const oldestDays = Math.floor((now - Math.min(...drafts.map((a) => a.createdAt))) / DAY_MS);
  return `${drafts.length} draft(s) awaiting review, oldest ${oldestDays} day(s) old.`;
}
