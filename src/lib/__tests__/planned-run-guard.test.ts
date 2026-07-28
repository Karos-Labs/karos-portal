/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as data from "@/lib/data";
import * as dataClientAgents from "@/lib/data-client-agents";
import * as sharedActions from "@/lib/actions/_shared";

/**
 * D2 — a client cannot re-arm a schedule on a non-live umbrella.
 *
 * configureClientAgentScheduleAction refuses to WRITE a pace against an
 * umbrella that is still being set up. setPlannedRunStatusAction did not, so
 * the refusal was one pause/resume away from being nothing: flip the schedule
 * to paused, flip it back to active, and it re-anchors nextRunAt into the
 * future and starts firing paid runs of an agent whose template set nobody has
 * confirmed — from a card simultaneously telling the client it is being set up.
 *
 * Pausing stays open at every launch state: a client may always stop their
 * agent, and refusing that would strand a schedule they are trying to stop.
 */

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/data");
vi.mock("@/lib/data-client-agents");
vi.mock("@/lib/actions/_shared");

const CLIENT = {
  uid: "u-client",
  email: "client@acme.test",
  name: "Client User",
  role: "CLIENT_USER",
  disabled: false,
  clientId: "c1",
  createdAt: 0,
} as any;

const CUSTOM_AGENT_ID = "ca-instagram";

function scheduledRun(patch: Record<string, any> = {}): any {
  return {
    id: "pr1",
    clientId: "c1",
    customAgentId: CUSTOM_AGENT_ID,
    cadence: "weekly",
    hour: 9,
    minute: 0,
    status: "paused",
    ...patch,
  };
}

function umbrella(launchState: string) {
  return {
    id: "ca1",
    clientId: "c1",
    agentKey: "karos-instagram-agent",
    customAgentId: CUSTOM_AGENT_ID,
    displayName: "Instagram agent",
    launchState,
    templates: [],
  } as any;
}

beforeEach(() => {
  vi.clearAllMocks();
  (sharedActions.requireClientAccess as any).mockResolvedValue(CLIENT);
  (data.getPlannedScheduledRun as any).mockResolvedValue(scheduledRun());
  (data.getCustomAgent as any).mockResolvedValue({
    id: CUSTOM_AGENT_ID,
    key: "karos-instagram-agent",
    name: "Instagram agent",
    enabled: true,
  });
});

describe("D2 — setPlannedRunStatusAction honors the §2 guard rail", () => {
  for (const state of ["not_launched", "launching", "curating", "launch_failed"]) {
    it(`refuses a client resuming a schedule while the umbrella is "${state}"`, async () => {
      (dataClientAgents.getClientAgentByKey as any).mockResolvedValue(umbrella(state));
      const { setPlannedRunStatusAction } = await import("@/lib/actions/planned-run-actions");

      const result = await setPlannedRunStatusAction("pr1", "active");

      expect(result.error).toBeTruthy();
      expect(data.updatePlannedScheduledRun).not.toHaveBeenCalled();
    });
  }

  it("still lets the client PAUSE a schedule on a non-live umbrella", async () => {
    (dataClientAgents.getClientAgentByKey as any).mockResolvedValue(umbrella("curating"));
    (data.getPlannedScheduledRun as any).mockResolvedValue(scheduledRun({ status: "active" }));
    const { setPlannedRunStatusAction } = await import("@/lib/actions/planned-run-actions");

    const result = await setPlannedRunStatusAction("pr1", "paused");

    expect(result).toEqual({});
    expect(data.updatePlannedScheduledRun).toHaveBeenCalled();
  });

  it("lets the client resume once the umbrella is live", async () => {
    (dataClientAgents.getClientAgentByKey as any).mockResolvedValue(umbrella("live"));
    const { setPlannedRunStatusAction } = await import("@/lib/actions/planned-run-actions");

    const result = await setPlannedRunStatusAction("pr1", "active");

    expect(result).toEqual({});
    expect(data.updatePlannedScheduledRun).toHaveBeenCalled();
  });

  it("does not block STAFF resuming a non-live umbrella's schedule", async () => {
    (sharedActions.requireClientAccess as any).mockResolvedValue({
      ...CLIENT,
      role: "KAROS_EMPLOYEE",
      clientId: null,
    });
    (dataClientAgents.getClientAgentByKey as any).mockResolvedValue(umbrella("curating"));
    const { setPlannedRunStatusAction } = await import("@/lib/actions/planned-run-actions");

    const result = await setPlannedRunStatusAction("pr1", "active");

    expect(result).toEqual({});
    expect(data.updatePlannedScheduledRun).toHaveBeenCalled();
  });
});
