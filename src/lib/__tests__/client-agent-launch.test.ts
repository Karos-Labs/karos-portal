import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const getClientAgent = vi.fn();
const updateClientAgent = vi.fn();
vi.mock("@/lib/data-client-agents", () => ({
  getClientAgent: (...args: unknown[]) => getClientAgent(...args),
  updateClientAgent: (...args: unknown[]) => updateClientAgent(...args),
}));

import {
  applyLaunchOutcome,
  isLaunchTemplatesArtifact,
  parseLaunchTemplates,
} from "@/lib/jobs/launch-outcome";
import {
  getClientArchiveAssets,
  getClientLibraryAssets,
  isLaunchDeliverable,
} from "@/lib/asset-visibility";
import type { Asset, ClientAgent } from "@/lib/types";

const NOW = Date.UTC(2026, 6, 28, 12);

/* ───────────────────── templates.json (Tomer seam T1) ───────────────── */

describe("parseLaunchTemplates", () => {
  it("reads a bare array and a { templates: [...] } wrapper alike", () => {
    const rows = [{ key: "by-the-numbers", name: "By The Numbers", rationale: "Data posts." }];
    expect(parseLaunchTemplates(JSON.stringify(rows), NOW)).toEqual([
      {
        key: "by-the-numbers",
        name: "By The Numbers",
        rationale: "Data posts.",
        status: "active",
        position: 0,
        source: "launch",
        addedAt: NOW,
      },
    ]);
    expect(parseLaunchTemplates(JSON.stringify({ templates: rows }), NOW)).toHaveLength(1);
  });

  it("refuses keys that are not kebab-case — the key IS the join with Asset.templateKey", () => {
    const rows = [
      { key: "By The Numbers", name: "Bad" },
      { key: "under_score", name: "Bad" },
      { key: "trailing-", name: "Bad" },
      { key: "good-one", name: "Good" },
    ];
    expect(parseLaunchTemplates(JSON.stringify(rows), NOW).map((t) => t.key)).toEqual(["good-one"]);
  });

  it("drops nameless and duplicate rows, and caps the registry", () => {
    const rows = [
      { key: "a", name: "A" },
      { key: "a", name: "A again" },
      { key: "b", name: "  " },
      ...Array.from({ length: 20 }, (_, i) => ({ key: `t${i}`, name: `T${i}` })),
    ];
    const parsed = parseLaunchTemplates(JSON.stringify(rows), NOW);
    expect(parsed.filter((t) => t.key === "a")).toHaveLength(1);
    expect(parsed.some((t) => t.key === "b")).toBe(false);
    expect(parsed.length).toBeLessThanOrEqual(12);
    expect(parsed.map((t) => t.position)).toEqual(parsed.map((_, i) => i));
  });

  it("returns nothing for garbage rather than throwing — the curation pane works without it", () => {
    expect(parseLaunchTemplates("not json", NOW)).toEqual([]);
    expect(parseLaunchTemplates("42", NOW)).toEqual([]);
    expect(parseLaunchTemplates(JSON.stringify([null, 7, "x"]), NOW)).toEqual([]);
  });

  it("recognizes the artifact by basename, anywhere in the tree", () => {
    expect(isLaunchTemplatesArtifact("outputs/client/templates.json")).toBe(true);
    expect(isLaunchTemplatesArtifact("TEMPLATES.JSON")).toBe(true);
    expect(isLaunchTemplatesArtifact("templates.md")).toBe(false);
  });
});

/* ───────────────────── the webhook's state transition ───────────────── */

function umbrella(overrides: Partial<ClientAgent> = {}): ClientAgent {
  return {
    id: "client-1__ig",
    clientId: "client-1",
    agentKey: "instagram-agent",
    customAgentId: "ca-ig",
    displayName: "Instagram Agent",
    platform: "instagram",
    chainFamily: "social",
    launchState: "launching",
    templates: [],
    rotation: [],
    createdBy: "staff-1",
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

describe("applyLaunchOutcome", () => {
  beforeEach(() => {
    getClientAgent.mockReset();
    updateClientAgent.mockReset();
  });

  it("moves a delivered setup run to curating and seeds the registry", async () => {
    getClientAgent.mockResolvedValue(umbrella());
    const result = await applyLaunchOutcome({
      clientAgentId: "client-1__ig",
      status: "done",
      templatesJson: JSON.stringify([{ key: "playbook", name: "Playbook" }]),
      now: NOW,
    });
    expect(result).toEqual({ applied: true, seededTemplates: 1 });
    expect(updateClientAgent).toHaveBeenCalledWith(
      "client-1__ig",
      expect.objectContaining({ launchState: "curating", rotation: ["playbook"] }),
    );
  });

  it("never overwrites a registry a human already curated", async () => {
    getClientAgent.mockResolvedValue(
      umbrella({
        templates: [
          { key: "kept", name: "Kept", status: "active", position: 0, source: "manual", addedAt: 1 },
        ],
      }),
    );
    await applyLaunchOutcome({
      clientAgentId: "client-1__ig",
      status: "done",
      templatesJson: JSON.stringify([{ key: "fresh", name: "Fresh" }]),
      now: NOW,
    });
    const patch = updateClientAgent.mock.calls[0][1];
    expect(patch.templates).toBeUndefined();
    expect(patch.launchState).toBe("curating");
  });

  it("records a failure with the raw error for staff and whether credits came back", async () => {
    getClientAgent.mockResolvedValue(umbrella());
    await applyLaunchOutcome({
      clientAgentId: "client-1__ig",
      status: "failed",
      error: "AGENT_SERVICE_URL unreachable",
      refunded: true,
      now: NOW,
    });
    expect(updateClientAgent).toHaveBeenCalledWith("client-1__ig", {
      launchState: "launch_failed",
      launchError: "AGENT_SERVICE_URL unreachable",
      launchRefunded: true,
    });
  });

  it("treats a cancelled run as terminal, with neutral stored copy (F30)", async () => {
    getClientAgent.mockResolvedValue(umbrella());
    await applyLaunchOutcome({ clientAgentId: "client-1__ig", status: "cancelled", now: NOW });
    expect(updateClientAgent.mock.calls[0][1]).toMatchObject({
      launchState: "launch_failed",
      launchError: "Setup run cancelled",
    });
  });

  it("only advances an in-flight launch — a redelivery can't drag a live agent back", async () => {
    for (const state of ["live", "curating", "not_launched", "launch_failed"] as const) {
      updateClientAgent.mockReset();
      getClientAgent.mockResolvedValue(umbrella({ launchState: state }));
      const result = await applyLaunchOutcome({
        clientAgentId: "client-1__ig",
        status: "done",
        now: NOW,
      });
      expect(result.applied).toBe(false);
      expect(updateClientAgent).not.toHaveBeenCalled();
    }
  });

  it("is a no-op for an umbrella that no longer exists", async () => {
    getClientAgent.mockResolvedValue(null);
    expect(await applyLaunchOutcome({ clientAgentId: "gone", status: "done", now: NOW })).toEqual({
      applied: false,
      seededTemplates: 0,
    });
    expect(updateClientAgent).not.toHaveBeenCalled();
  });
});

/* ─────────────── launch deliverables are never client-visible ────────── */

function asset(overrides: Partial<Asset> = {}): Asset {
  return {
    id: "asset-1",
    clientId: "client-1",
    type: "note",
    title: "Template proposal",
    content: "Here are the templates we recommend…",
    status: "draft",
    createdBy: "agent-service",
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

describe("launch deliverables", () => {
  const deliverable = asset({
    id: "launch-doc",
    meta: { launchDeliverable: true, clientAgentId: "client-1__ig" },
  });
  const normal = asset({ id: "normal", status: "approved" });

  it("is recognized by its flag", () => {
    expect(isLaunchDeliverable(deliverable)).toBe(true);
    expect(isLaunchDeliverable(normal)).toBe(false);
  });

  it("never reaches a client library payload — not even redacted", () => {
    const forClient = getClientLibraryAssets([deliverable, normal], { forClient: true, now: NOW });
    expect(forClient.map((a) => a.id)).toEqual(["normal"]);
  });

  it("never reaches the client archive", () => {
    const approved = asset({
      id: "launch-approved",
      status: "approved",
      meta: { launchDeliverable: true },
    });
    expect(getClientArchiveAssets([approved, normal], { now: NOW }).map((a) => a.id)).toEqual([
      "normal",
    ]);
  });

  it("stays fully visible to staff", () => {
    expect(getClientLibraryAssets([deliverable, normal]).map((a) => a.id)).toContain("launch-doc");
  });
});
