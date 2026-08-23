import { describe, expect, it } from "vitest";
import {
  buildAgentCatalogUnion,
  controlPlaneAgentHref,
  customAgentKeyForMiddlewareSlug,
} from "../catalog-union";
import type { MiddlewareAgent } from "../middleware-admin";

/**
 * Neither collection is a superset of the other, which is the whole reason
 * this is a union: the library holds agents the control plane never heard of
 * (most of them), and the control plane holds agents the library never had.
 */
function mw(slug: string, overrides: Partial<MiddlewareAgent> = {}): MiddlewareAgent {
  return {
    id: slug,
    slug,
    name: slug,
    description: null,
    status: "active",
    agentType: null,
    model: null,
    modelParams: {},
    config: {},
    tags: [],
    createdAt: "",
    updatedAt: "",
    ...overrides,
  };
}

const lib = (key: string) => ({ key });

describe("buildAgentCatalogUnion", () => {
  it("adds a control-plane agent the library never had", () => {
    // The case that motivated this: intel-report-agent is managed in the
    // control plane and has no customAgents row, so a library-only catalog
    // rendered nothing for it at all.
    const union = buildAgentCatalogUnion([lib("karos-x-agent-v2")], [mw("x-agent"), mw("intel-report-agent")]);

    expect(union.controlPlaneOnly.map((a) => a.slug)).toEqual(["intel-report-agent"]);
  });

  it("does not double-render an agent that exists in both", () => {
    const union = buildAgentCatalogUnion(
      [lib("karos-x-agent-v2"), lib("karos-instagram-agent"), lib("landing-builder")],
      [mw("x-agent"), mw("instagram-agent"), mw("landing-builder-agent")],
    );

    expect(union.controlPlaneOnly).toEqual([]);
  });

  it("passes the library through untouched, in its original order", () => {
    // This must never remove or reorder an agent someone already runs.
    const library = [lib("b-agent"), lib("a-agent"), lib("c-agent")];
    const union = buildAgentCatalogUnion(library, [mw("x-agent")]);

    expect(union.library.map((a) => a.key)).toEqual(["b-agent", "a-agent", "c-agent"]);
  });

  it("renders a mapped agent whose library row is missing", () => {
    // Mapped and absent are different: an importer that has not run yet leaves
    // the pairing valid but the library row missing, and hiding the agent
    // would be wrong.
    const union = buildAgentCatalogUnion([], [mw("x-agent")]);

    expect(union.controlPlaneOnly.map((a) => a.slug)).toEqual(["x-agent"]);
  });

  it("skips a row the middleware could not parse a slug from", () => {
    // Prep's agents/ collection shares a name with karosCMO's since-removed
    // in-app engine, and still holds two of its documents.
    const union = buildAgentCatalogUnion([], [mw("", { id: "FcVYdiTM9RHrsap0Y6aQ", name: "Ghost" })]);

    expect(union.controlPlaneOnly).toEqual([]);
  });

  it("sorts the new cards by name so the list is stable between loads", () => {
    const union = buildAgentCatalogUnion(
      [],
      [mw("zebra", { name: "Zebra" }), mw("alpha", { name: "Alpha" })],
    );

    expect(union.controlPlaneOnly.map((a) => a.name)).toEqual(["Alpha", "Zebra"]);
  });

  it("falls back to the slug when an agent has no name", () => {
    const union = buildAgentCatalogUnion([], [mw("nameless", { name: "" })]);

    expect(union.controlPlaneOnly[0]!.name).toBe("nameless");
  });

  it("carries status through, so a disabled control-plane agent shows as one", () => {
    const union = buildAgentCatalogUnion([], [mw("x-agent", { status: "disabled" })]);

    expect(union.controlPlaneOnly[0]!.status).toBe("disabled");
  });

  it("produces no new cards when the middleware is empty", () => {
    // The degraded path: enrichment failed, the catalog is exactly what it was.
    const union = buildAgentCatalogUnion([lib("karos-x-agent-v2")], []);

    expect(union.controlPlaneOnly).toEqual([]);
    expect(union.library).toHaveLength(1);
  });
});

describe("customAgentKeyForMiddlewareSlug", () => {
  it("maps every control-plane agent that has a library twin", () => {
    expect(customAgentKeyForMiddlewareSlug("x-agent")).toBe("karos-x-agent-v2");
    expect(customAgentKeyForMiddlewareSlug("instagram-agent")).toBe("karos-instagram-agent");
    expect(customAgentKeyForMiddlewareSlug("landing-builder-agent")).toBe("landing-builder");
  });

  it("covers agents routing does not, because the two answer different questions", () => {
    // Routing knows only the three agents cut over to agent-engine. Display
    // has to know every correspondence or the catalog shows instagram-agent
    // twice.
    expect(customAgentKeyForMiddlewareSlug("instagram-agent")).toBeDefined();
  });

  it("returns undefined for an agent with no library twin", () => {
    expect(customAgentKeyForMiddlewareSlug("intel-report-agent")).toBeUndefined();
  });
});

describe("controlPlaneAgentHref", () => {
  it("points at the console, selecting the agent", () => {
    expect(controlPlaneAgentHref("x-agent")).toBe("/admin/agents/control-plane?agent=x-agent");
  });

  it("encodes a slug that would otherwise break the query", () => {
    expect(controlPlaneAgentHref("weird/slug")).toContain("weird%2Fslug");
  });
});
