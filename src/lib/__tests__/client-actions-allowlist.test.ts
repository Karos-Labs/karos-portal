/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `updateClientAction` writes an ALLOWLIST of fields, not "everything the
 * caller sent minus a denylist".
 *
 * The denylist it replaced stripped seven keys. Everything else on `Client`
 * went straight to Firestore from any staff session that posted it — which
 * agents a client is granted (`customAgentIds`), its `status`, the AI
 * processing lock, the LinkedIn seat ceiling. These tests post exactly those
 * and expect none of them to land, alongside the positive half: every field the
 * two staff editors actually send still does.
 */

const STAFF = {
  uid: "u-emp",
  name: "Eli Employee",
  email: "eli@karoslabs.com",
  role: "KAROS_EMPLOYEE",
  clientId: null,
  assignedClientIds: ["c1"],
};

describe("updateClientAction writes only the fields the editors own", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  async function load() {
    const updateClient = vi.fn(async (_id: string, _patch: Record<string, unknown>) => {});
    vi.doMock("server-only", () => ({}));
    vi.doMock("next/cache", () => ({ revalidatePath: () => {} }));
    vi.doMock("next/server", () => ({ after: () => {} }));
    vi.doMock("@/lib/branding", () => ({ applyBrandingForClient: async () => {} }));
    vi.doMock("@/lib/auth", () => ({ requireUser: async () => STAFF }));
    vi.doMock("@/lib/actions/_shared", () => ({
      requireStaff: async () => STAFF,
      logGenerationFailure: async () => {},
    }));
    vi.doMock("@/lib/data", () => ({
      createClient: async () => "c-new",
      updateClient,
      deleteClientCascade: async () => {},
      getClientByKeyId: async () => null,
      tryAcquireAiProcessingLock: async () => false,
      releaseAiProcessingLock: async () => {},
    }));
    const mod = await import("@/lib/actions/client-actions");
    return { updateClient, updateClientAction: mod.updateClientAction };
  }

  it("drops every Client field that is not on the list, however sensitive or mundane", async () => {
    const { updateClient, updateClientAction } = await load();
    const result = await updateClientAction("c1", {
      name: "Acme",
      // None of these has ever had an editor; every one used to be writable.
      customAgentIds: ["agent-x"],
      status: "archived",
      onboardingStatus: "done",
      isAiProcessing: true,
      aiProcessingStartedAt: 1,
      linkedinSeatLimit: 99,
      setupLadderOrder: ["a"],
      logoStoragePath: "/etc/passwd",
      starredAgentIds: ["x"],
      // The seven the old denylist knew about.
      clientKeyId: "ck_stolen",
      createdAt: 1,
      createdBy: "someone-else",
      lastDigestSentDay: 20260101,
      assignedEmployeeIds: [STAFF.uid],
      industry: "legacy",
    } as any);

    expect(result).toEqual({ ok: true });
    expect(updateClient).toHaveBeenCalledTimes(1);
    const patch = updateClient.mock.calls[0]![1];
    expect(Object.keys(patch)).toEqual(["name"]);
  });

  it("writes every field the two staff editors send, normalised the way each always was", async () => {
    const { updateClient, updateClientAction } = await load();
    await updateClientAction("c1", {
      name: "  Acme  ",
      contactEmail: " Ops@Acme.COM ",
      website: " https://acme.test ",
      category: "Retail",
      description: " Sells things. ",
      brandVoice: " Plain. ",
      agentsRepoSlug: "acme",
      timeZone: "Europe/Zurich",
      dailyDigestEnabled: true,
      domainsCsv: " acme.test, Acme.com ,",
      clipsPerDay: "2",
      postsPerDay: "",
      forbiddenTopicsText: "politics\ncompetitor pricing\n",
    });
    const patch = updateClient.mock.calls[0]![1] as Record<string, unknown>;
    expect(patch).toMatchObject({
      name: "Acme",
      contactEmail: "ops@acme.com",
      website: "https://acme.test",
      category: "Retail",
      description: "Sells things.",
      brandVoice: "Plain.",
      agentsRepoSlug: "acme",
      timeZone: "Europe/Zurich",
      dailyDigestEnabled: true,
      domains: ["acme.test", "acme.com"],
      forbiddenTopics: ["politics", "competitor pricing"],
    });
    expect(patch.dailyPace).toMatchObject({ clipsPerDay: 2 });
  });

  it("refuses to blank the name", async () => {
    const { updateClient, updateClientAction } = await load();
    const result = await updateClientAction("c1", { name: "   " });
    expect(result).toEqual({ ok: false, error: "Client name is required." });
    expect(updateClient).not.toHaveBeenCalled();
  });

  it("ignores a text field sent as the wrong type instead of storing it", async () => {
    const { updateClient, updateClientAction } = await load();
    await updateClientAction("c1", { website: { $set: "x" }, dailyDigestEnabled: "yes" } as any);
    const patch = updateClient.mock.calls[0]![1] as Record<string, unknown>;
    expect(patch).not.toHaveProperty("website");
    // A truthy non-boolean is not "enabled".
    expect(patch.dailyDigestEnabled).toBe(false);
  });

  it("stores an unresolvable time zone as empty and clears the pace when both boxes are blank", async () => {
    const { updateClient, updateClientAction } = await load();
    await updateClientAction("c1", { timeZone: "Mars/Olympus", clipsPerDay: "", postsPerDay: "" });
    const patch = updateClient.mock.calls[0]![1] as Record<string, unknown>;
    expect(patch.timeZone).toBe("");
    expect(patch.dailyPace).toBeNull();
  });
});
