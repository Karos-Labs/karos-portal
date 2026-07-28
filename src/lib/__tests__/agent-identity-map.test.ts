import { describe, expect, it } from "vitest";
import { resolveContentIdentity, type ClientAgentIdentity } from "@/lib/agent-identity-map";
import type { Asset, Job } from "@/lib/types";

const instagramUmbrella: ClientAgentIdentity = {
  id: "client-1__instagram-agent",
  agentKey: "instagram-agent",
  customAgentId: "ca-ig",
  displayName: "Instagram Agent",
  platform: "instagram",
  chainFamily: "social",
  launchState: "live",
};

const xUmbrella: ClientAgentIdentity = {
  id: "client-1__karos-x-agent",
  agentKey: "karos-x-agent",
  customAgentId: "ca-x",
  displayName: "X Agent",
  platform: "x",
  launchState: "live",
};

const agents = [instagramUmbrella, xUmbrella];

function job(overrides: Partial<Job> = {}): Pick<Job, "clientAgentId" | "customAgentId" | "agentName"> {
  return { agentName: "karos-instagram-agent", ...overrides };
}

function asset(overrides: Partial<Asset> = {}): Pick<
  Asset,
  "agentId" | "meta" | "type" | "templateKey" | "templateName"
> {
  return { type: "instagram_post", ...overrides };
}

describe("resolveContentIdentity", () => {
  it("uses an explicit umbrella link first", () => {
    expect(resolveContentIdentity({ clientAgentId: xUmbrella.id }, agents)).toEqual({
      clientAgentId: xUmbrella.id,
      label: "X Agent",
      platform: "x",
    });
    expect(resolveContentIdentity({ job: job({ clientAgentId: xUmbrella.id }) }, agents)).toMatchObject({
      label: "X Agent",
    });
  });

  it("resolves a run through its custom agent", () => {
    expect(resolveContentIdentity({ job: job({ customAgentId: "ca-ig" }) }, agents)).toEqual({
      clientAgentId: instagramUmbrella.id,
      label: "Instagram Agent",
      platform: "instagram",
    });
  });

  it("renders ONE identity for the F147 double-identity fixture", () => {
    // The 27 Jul screenshot: a run row from the Instagram agent stacked above a
    // calendar post the managed-product map labelled "Social posts (IG/TikTok)".
    // Both are the same agent, so both must now read the same.
    const runRow = resolveContentIdentity({ job: job({ customAgentId: "ca-ig" }) }, agents);
    const calendarPost = resolveContentIdentity(
      { asset: asset({ meta: { taskType: "social_post", agentFolder: "instagram-agent" } }) },
      agents,
    );
    expect(calendarPost.label).toBe(runRow.label);
    expect(calendarPost.clientAgentId).toBe(runRow.clientAgentId);
  });

  it("maps a family-owning umbrella onto legacy assets with no agent link at all", () => {
    expect(resolveContentIdentity({ asset: asset({ type: "social_post" }) }, agents)).toMatchObject({
      clientAgentId: instagramUmbrella.id,
      label: "Instagram Agent",
    });
  });

  it("only a LIVE umbrella claims a family — a launching one must not relabel history", () => {
    const notLive = [{ ...instagramUmbrella, launchState: "launching" as const }];
    expect(
      resolveContentIdentity({ asset: asset({ meta: { agentFolder: "instagram-agent" } }) }, notLive),
    ).toEqual({ label: "Instagram agent" });
  });

  it("keeps today's labels when no umbrella exists (nothing renders blank)", () => {
    expect(resolveContentIdentity({ asset: asset({ type: "email" }) }, [])).toMatchObject({
      label: "Newsletter issue",
    });
    expect(resolveContentIdentity({ job: job() }, [])).toEqual({ label: "karos-instagram-agent" });
    expect(resolveContentIdentity({}, [])).toEqual({ label: "Karos agent" });
  });

  it("does not hand an options-mode umbrella somebody else's family", () => {
    // The X umbrella owns no chainFamily, so a social asset must never resolve
    // to it — that is what keeps "TikTok Agent twice from two systems" fixed
    // rather than re-created in the other direction.
    expect(resolveContentIdentity({ asset: asset({ type: "social_post" }) }, [xUmbrella])).not.toMatchObject(
      { clientAgentId: xUmbrella.id },
    );
  });
});
