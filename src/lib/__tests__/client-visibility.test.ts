import { describe, expect, it } from "vitest";
import { toClientPortalView } from "@/lib/client-visibility";
import type { Client } from "@/lib/types";

function makeClient(patch: Partial<Client> = {}): Client {
  return {
    id: "c1",
    name: "Acme",
    status: "active",
    assignedEmployeeIds: ["staff-1", "staff-2"],
    clientKeyId: "ck_supersecretjointoken",
    agentsRepoSlug: "acme",
    logoStoragePath: "clients/c1/logo.png",
    onboardingError: "pipeline blew up on stage 3",
    customAgentIds: ["agent-1"],
    linkedinSeatLimit: 5,
    website: "https://acme.test",
    brandVoice: "warm",
    isAiProcessing: true,
    aiProcessingError: "out of credits",
    createdAt: 1,
    createdBy: "staff-1",
    ...patch,
  };
}

describe("toClientPortalView", () => {
  it("never carries the workspace join token into the client payload", () => {
    const view = toClientPortalView(makeClient());
    expect(view.clientKeyId).toBeUndefined();
    expect(JSON.stringify(view)).not.toContain("ck_supersecretjointoken");
  });

  it("drops internal routing, storage and pipeline fields", () => {
    const view = toClientPortalView(makeClient());
    expect(view.agentsRepoSlug).toBeUndefined();
    expect(view.logoStoragePath).toBeUndefined();
    expect(view.onboardingError).toBeUndefined();
    expect(view.customAgentIds).toBeUndefined();
    expect(view.linkedinSeatLimit).toBeUndefined();
    expect(view.assignedEmployeeIds).toEqual([]);
    expect(view.createdBy).toBe("");
  });

  it("keeps what the rail actually renders", () => {
    const view = toClientPortalView(makeClient());
    expect(view.id).toBe("c1");
    expect(view.name).toBe("Acme");
    expect(view.website).toBe("https://acme.test");
    expect(view.brandVoice).toBe("warm");
    expect(view.isAiProcessing).toBe(true);
    expect(view.aiProcessingError).toBe("out of credits");
  });

  it("is built by construction — an unknown future field is excluded by default", () => {
    const withFuture = { ...makeClient(), someNewSecret: "leak-me" } as unknown as Client;
    expect(JSON.stringify(toClientPortalView(withFuture))).not.toContain("leak-me");
  });
});
