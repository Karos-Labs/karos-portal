/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, vi } from "vitest";

import * as data from "@/lib/data";
import * as clientAgentData from "@/lib/data-client-agents";
import * as auth from "@/lib/auth";
import { getClientCustomAgents } from "@/lib/agent-roster";

/**
 * #161 — `0a3eab3` fixed a client-visible bug and shipped no test.
 *
 * The Copilot's `@mention` dropdown listed LIVE umbrellas only. "Live" is the
 * END of the launch pipeline, so for most clients the dropdown was empty — they
 * had agents, and the product said they had none. The fix folds in the client's
 * assigned custom-agent roster and dedupes the two lists by the underlying
 * custom agent.
 *
 * The dedupe is the half with no coverage anywhere, and it is the half that
 * fails VISIBLY: get it wrong and a client sees the same agent listed twice.
 * Worse, the two rows carry different ids — an umbrella id and a bare
 * custom-agent id — and chat/route.ts resolves them into different focus
 * contexts, so picking the wrong twin silently gives the copilot an agent with
 * no templates and no feedback history.
 *
 * (The fence on this route, and the "no live umbrella, still lists the agent"
 * case, are covered in client-api-access-guard.test.ts. This file is only about
 * how the two lists combine.)
 */

vi.mock("server-only", () => ({}));
vi.mock("@/lib/data");
vi.mock("@/lib/data-client-agents");
vi.mock("@/lib/agent-roster", () => ({ getClientCustomAgents: vi.fn() }));
vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return { ...actual, getCurrentUser: vi.fn() };
});

const CLIENT = { id: "c1", name: "Acme", status: "active", createdAt: 0, assignedEmployeeIds: [] };
const OWN_CLIENT_USER = { uid: "u-client", role: "CLIENT_USER", clientId: "c1", createdAt: 0 };

/** The assigned roster entry: the bare catalog agent, with the catalog's name. */
const CATALOG_AGENT = { id: "agent-x", name: "X agent" };

/** An umbrella over that same catalog agent, with the client's own name for it. */
function umbrella(patch: Record<string, unknown> = {}) {
  return {
    id: "ca-x",
    clientId: "c1",
    customAgentId: "agent-x",
    displayName: "Acme's X voice",
    launchState: "live",
    platform: "x",
    templates: [],
    ...patch,
  };
}

async function mentionable() {
  const { GET } = await import("@/app/api/clients/[id]/agents/mentionable/route");
  const res = await GET(new Request("https://portal.test/x"), {
    params: Promise.resolve({ id: "c1" }),
  });
  return (await res.json()) as { agents: { id: string; displayName: string; platform: string | null }[] };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(auth.getCurrentUser).mockResolvedValue(OWN_CLIENT_USER as any);
  vi.mocked(data.getClient).mockResolvedValue(CLIENT as any);
  vi.mocked(data.listCustomAgents).mockResolvedValue([{ id: "agent-x", icon: "Bird" }] as any);
  vi.mocked(clientAgentData.listClientAgents).mockResolvedValue([] as any);
  vi.mocked(getClientCustomAgents).mockResolvedValue([CATALOG_AGENT] as any);
});

describe("the @mention roster combines the two lists without doubling anything", () => {
  it("lists an assigned agent that has no umbrella yet, under its catalog name", async () => {
    const { agents } = await mentionable();

    expect(agents).toEqual([
      // AF-20: the platform comes off the agent itself, so an agent with no
      // umbrella still wears its logo. It used to be the umbrella's stored
      // string alone, i.e. null for most of the list this route widened to
      // include — the copilot's whole point being that these ARE the client's
      // agents whether or not anyone has finished a launch for them.
      { id: "agent-x", displayName: "X agent", icon: "Bird", platform: "x" },
    ]);
  });

  it("collapses a live umbrella and its catalog agent into ONE row", async () => {
    vi.mocked(clientAgentData.listClientAgents).mockResolvedValue([umbrella()] as any);

    const { agents } = await mentionable();

    // One row, not two — and it is the umbrella's: its own id (which the chat
    // route resolves to the richer context) and the name the client gave it.
    expect(agents).toHaveLength(1);
    expect(agents[0]).toEqual({
      id: "ca-x",
      displayName: "Acme's X voice",
      icon: "Bird",
      platform: "x",
    });
  });

  it("leaves an umbrella that is not live out of it, keeping the catalog row", async () => {
    // The other half of the precedence rule. A curating umbrella has no settled
    // persona yet, so it must not take over the row — and it must not add a
    // second one either.
    vi.mocked(clientAgentData.listClientAgents).mockResolvedValue([
      umbrella({ launchState: "curating" }),
    ] as any);

    const { agents } = await mentionable();

    expect(agents).toEqual([
      // AF-20: the platform comes off the agent itself, so an agent with no
      // umbrella still wears its logo. It used to be the umbrella's stored
      // string alone, i.e. null for most of the list this route widened to
      // include — the copilot's whole point being that these ARE the client's
      // agents whether or not anyone has finished a launch for them.
      { id: "agent-x", displayName: "X agent", icon: "Bird", platform: "x" },
    ]);
  });

  it("reads the agent KEY, which a renamed agent's name can no longer give", async () => {
    // The precise rung. Nothing in "Acme voice" says LinkedIn; the key does,
    // and the key never leaves the route — only the token it resolved to.
    vi.mocked(getClientCustomAgents).mockResolvedValue([{ id: "agent-li", name: "Acme voice" }] as any);
    vi.mocked(data.listCustomAgents).mockResolvedValue([
      { id: "agent-li", icon: "Bot", key: "karos-linkedin-agent" },
    ] as any);

    const { agents } = await mentionable();

    expect(agents[0].platform).toBe("linkedin");
    expect(agents[0]).not.toHaveProperty("key");
  });

  it("sends null for an agent that targets no platform, rather than a nearest guess", async () => {
    // Landing Builder keeps the stored lucide icon it has always had. A chip
    // that wears the wrong logo is a worse answer than one that wears none.
    vi.mocked(getClientCustomAgents).mockResolvedValue([
      { id: "agent-lb", name: "Landing Builder" },
    ] as any);
    vi.mocked(data.listCustomAgents).mockResolvedValue([
      { id: "agent-lb", icon: "LayoutTemplate", key: "karos-landing-builder" },
    ] as any);

    const { agents } = await mentionable();

    expect(agents).toEqual([
      { id: "agent-lb", displayName: "Landing Builder", icon: "LayoutTemplate", platform: null },
    ]);
  });

  it("keeps two different agents apart", async () => {
    // Non-vacuity for the dedupe: it must collapse the SAME agent, not merge
    // the list down to one row whatever is in it.
    vi.mocked(getClientCustomAgents).mockResolvedValue([
      CATALOG_AGENT,
      { id: "agent-li", name: "LinkedIn agent" },
    ] as any);
    vi.mocked(clientAgentData.listClientAgents).mockResolvedValue([umbrella()] as any);

    const { agents } = await mentionable();

    expect(agents.map((a) => a.id)).toEqual(["ca-x", "agent-li"]);
  });
});
