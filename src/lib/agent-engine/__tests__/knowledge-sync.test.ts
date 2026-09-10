import { describe, expect, it, vi, beforeEach } from "vitest";

const { listDocsMock, listTranscriptsMock, listItemsMock, writeJsonMock, configuredMock } = vi.hoisted(() => ({
  listDocsMock: vi.fn(),
  listTranscriptsMock: vi.fn(),
  listItemsMock: vi.fn(),
  writeJsonMock: vi.fn(),
  configuredMock: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/data", () => ({
  listClientContextDocs: listDocsMock,
  listTranscripts: listTranscriptsMock,
  listContextItems: listItemsMock,
}));
vi.mock("../workspace-writer", () => ({
  isWorkspaceWriterConfigured: configuredMock,
  writeWorkspaceJson: writeJsonMock,
}));

import { selectContextDocsForWorkspace, syncClientKnowledgeToWorkspace } from "../knowledge-sync";
import type { Client, ClientContextDoc } from "@/lib/types";

function doc(docType: string, tier: ClientContextDoc["tier"], content: string, version = 1): ClientContextDoc {
  return { id: `${docType}-${tier}`, clientId: "c1", docType: docType as ClientContextDoc["docType"], tier, content, version, createdAt: 1, updatedAt: 1 };
}

function client(overrides: Partial<Client> = {}): Client {
  return { id: "c1", name: "Acme", agentsRepoSlug: "acme", createdAt: 1, updatedAt: 1, ...overrides } as Client;
}

beforeEach(() => {
  listDocsMock.mockReset().mockResolvedValue([]);
  listTranscriptsMock.mockReset().mockResolvedValue([]);
  listItemsMock.mockReset().mockResolvedValue([]);
  writeJsonMock.mockReset().mockResolvedValue(undefined);
  configuredMock.mockReset().mockReturnValue(true);
});

describe("selectContextDocsForWorkspace", () => {
  it("prefers the condensed client tier over its internal twin, one row per docType", () => {
    const rows = selectContextDocsForWorkspace([
      doc("brand-voice", "internal", "full analyst version"),
      doc("brand-voice", "client", "condensed version"),
      doc("icp", "internal", "icp internal only-form"),
    ]);
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.docType === "brand-voice")).toMatchObject({ tier: "client", content: "condensed version" });
    expect(rows.find((r) => r.docType === "icp")).toMatchObject({ tier: "internal" });
  });

  it("NEVER crosses the staff-private internal-only tier — excluded by construction, not by cap", () => {
    const rows = selectContextDocsForWorkspace([
      doc("client-guidelines", "internal-only", "how we handle this account internally"),
      doc("brand-voice", "internal", "shareable"),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.docType).toBe("brand-voice");
    expect(JSON.stringify(rows)).not.toContain("internally");
  });

  it("caps each doc's content and says so, rather than shipping an unbounded read", () => {
    const rows = selectContextDocsForWorkspace([doc("strategy", "internal", "x".repeat(10_000))]);
    expect(rows[0]!.content.length).toBeLessThan(6_100);
    expect(rows[0]!.content.endsWith("[truncated]")).toBe(true);
  });
});

describe("syncClientKnowledgeToWorkspace", () => {
  it("writes the three flat knowledge docs under the client's agentsRepoSlug", async () => {
    listDocsMock.mockResolvedValue([doc("brand-voice", "client", "voice")]);
    listTranscriptsMock.mockResolvedValue([
      { id: "t1", title: "Kickoff", meetingDate: 5, summary: "Agreed on Q4 pillars", actionItems: ["Send deck"], rawText: "SECRET RAW", participants: [], source: "manual" },
    ]);
    listItemsMock.mockResolvedValue([
      { id: "i1", clientId: "c1", kind: "image", name: "hero.png", mimeType: "image/png", sizeBytes: 1, storagePath: "p", url: "https://x/hero.png", note: "primary shot", createdBy: "u", createdAt: 1 },
    ]);

    const result = await syncClientKnowledgeToWorkspace(client());

    expect(result).toMatchObject({ synced: true, contextDocs: 1, transcripts: 1, assets: 1 });
    const paths = writeJsonMock.mock.calls.map((c) => c[0]);
    expect(paths.sort()).toEqual([
      "clients/acme/knowledge/assets.json",
      "clients/acme/knowledge/context-docs.json",
      "clients/acme/knowledge/transcripts.json",
    ]);
    // Transcript rawText never crosses — the summary layer is the distillation.
    const transcriptsPayload = writeJsonMock.mock.calls.find((c) => (c[0] as string).endsWith("transcripts.json"))![1];
    expect(JSON.stringify(transcriptsPayload)).not.toContain("SECRET RAW");
    expect(JSON.stringify(transcriptsPayload)).toContain("Agreed on Q4 pillars");
  });

  it("caps the transcript mirror at the 10 most recent", async () => {
    listTranscriptsMock.mockResolvedValue(
      Array.from({ length: 25 }, (_, i) => ({ id: `t${i}`, title: `Meeting ${i}`, participants: [], source: "manual", rawText: "" })),
    );
    const result = await syncClientKnowledgeToWorkspace(client());
    expect(result.transcripts).toBe(10);
  });

  it("is a counted no-op for a client with no agentsRepoSlug, and when no bucket is configured", async () => {
    expect(await syncClientKnowledgeToWorkspace(client({ agentsRepoSlug: undefined }))).toMatchObject({ synced: false });
    configuredMock.mockReturnValue(false);
    expect(await syncClientKnowledgeToWorkspace(client())).toMatchObject({ synced: false });
    expect(writeJsonMock).not.toHaveBeenCalled();
  });
});
