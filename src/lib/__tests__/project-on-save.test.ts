import { vi, describe, expect, it, beforeEach } from "vitest";
import type { Client } from "@/lib/types";

vi.mock("server-only", () => ({}));

const projectClientToWorkspace = vi.fn();
const getClient = vi.fn();
const listClientContextDocs = vi.fn();

vi.mock("@/lib/agent-engine/context-doc-projection", () => ({ projectClientToWorkspace }));
vi.mock("@/lib/data", () => ({ getClient, listClientContextDocs }));

const { projectClientOnSave } = await import("../agent-engine/project-on-save");

const CLIENT = { id: "c1", name: "Karos Labs", agentsRepoSlug: "karoslabs" } as unknown as Client;
const OK = { projected: true, contextDocs: 4, brand: true, profile: true };

beforeEach(() => {
  vi.clearAllMocks();
  getClient.mockResolvedValue(CLIENT);
  listClientContextDocs.mockResolvedValue([]);
  projectClientToWorkspace.mockResolvedValue(OK);
});

describe("projectClientOnSave", () => {
  it("projects the client with its documents", async () => {
    const docs = [{ id: "d1" }];
    listClientContextDocs.mockResolvedValue(docs);

    await expect(projectClientOnSave("c1", "client-record-saved")).resolves.toEqual(OK);
    expect(projectClientToWorkspace).toHaveBeenCalledWith(CLIENT, docs);
  });

  /**
   * `projectClientToWorkspace` takes `undefined` to mean "brand and profile
   * only", which is right for the branding refresh that just rewrote them and
   * wrong here — the point of an on-save projection is that the whole workspace
   * matches the record afterwards. A regression to `undefined` would leave the
   * context documents stale and every assertion above still green, so this is
   * asserted on its own.
   */
  it("always reads the documents, never projects brand-and-profile only", async () => {
    await projectClientOnSave("c1", "branding-saved");
    expect(listClientContextDocs).toHaveBeenCalledWith("c1");
    expect(projectClientToWorkspace.mock.calls[0]![1]).not.toBeUndefined();
  });

  it("returns a reason instead of throwing when the client has gone", async () => {
    getClient.mockResolvedValue(undefined);
    await expect(projectClientOnSave("gone", "client-record-saved")).resolves.toMatchObject({
      projected: false,
      reason: "no client record",
    });
    expect(projectClientToWorkspace).not.toHaveBeenCalled();
  });

  /**
   * T-B13 is explicit: "a failure must not fail the document save." The
   * projector handles its own write failures; what this catches is everything
   * before it — a Firestore read that throws, a client that vanished mid-save.
   * If this ever propagates, a person loses an edit because a bucket in another
   * project is misconfigured.
   */
  it("swallows a thrown Firestore error rather than failing the save", async () => {
    listClientContextDocs.mockRejectedValue(new Error("firestore unavailable"));
    await expect(projectClientOnSave("c1", "context-doc-corrected")).resolves.toMatchObject({
      projected: false,
      reason: "firestore unavailable",
    });
  });

  it("swallows a throw from the projector itself", async () => {
    projectClientToWorkspace.mockRejectedValue(new Error("bucket exploded"));
    await expect(projectClientOnSave("c1", "branding-saved")).resolves.toMatchObject({
      projected: false,
      reason: "bucket exploded",
    });
  });

  it("logs one structured line naming the reason, so a silent no-op is greppable", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    projectClientToWorkspace.mockResolvedValue({ projected: false, contextDocs: 0, brand: false, profile: false, reason: "client has no agentsRepoSlug" });

    await projectClientOnSave("c1", "client-record-saved");

    const line = info.mock.calls[0]![0] as string;
    expect(line).toContain("[project-on-save]");
    const payload = JSON.parse(line.slice(line.indexOf("{")));
    expect(payload).toMatchObject({ clientId: "c1", reason: "client-record-saved", projected: false, skipped: "client has no agentsRepoSlug" });
    info.mockRestore();
  });
});
