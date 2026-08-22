import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

vi.mock("server-only", () => ({}));

import {
  MiddlewareRequestError,
  activatePromptVersion,
  bindTemplate,
  createPromptVersion,
  getActivePrompt,
  getRun,
  listAgents,
  listFeedback,
  listTemplates,
  promoteFeedback,
  setAgentStatus,
  submitFeedback,
  updateAgent,
} from "../middleware-admin";
import { __resetMiddlewareTokenCache } from "../middleware-http";

const BASE = "https://agent-middleware-abc-uc.a.run.app";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const originalEnv = { ...process.env };

beforeEach(() => {
  process.env.AGENT_MIDDLEWARE_URL = BASE;
  delete process.env.AGENT_MIDDLEWARE_AUDIENCE;
  __resetMiddlewareTokenCache();
  vi.restoreAllMocks();
});

afterEach(() => {
  process.env = { ...originalEnv };
});

/** Captures the single fetch call the function under test makes. */
function capture(response: Response = json({})) {
  const mock = vi.spyOn(globalThis, "fetch").mockResolvedValue(response);
  return () => {
    const [url, init] = mock.mock.calls[0]!;
    return {
      url: String(url),
      method: init?.method ?? "GET",
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined,
    };
  };
}

describe("agents", () => {
  it("maps the snake_case wire shape to camelCase, so no component ever sees agent_type", async () => {
    capture(
      json({
        items: [
          {
            id: "instagram-agent",
            slug: "instagram-agent",
            name: "Instagram",
            description: null,
            status: "active",
            agent_type: "social",
            model: null,
            model_params: { temperature: 0.4 },
            config: {},
            tags: ["social"],
            created_at: "2026-08-01T00:00:00Z",
            updated_at: "2026-08-02T00:00:00Z",
          },
        ],
        limit: 50,
        offset: 0,
        has_more: false,
        total: 1,
      }),
    );

    const page = await listAgents();

    expect(page.items[0]).toMatchObject({ agentType: "social", modelParams: { temperature: 0.4 }, status: "active" });
    expect(page.hasMore).toBe(false);
    expect(page.total).toBe(1);
    expect(page.items[0]).not.toHaveProperty("agent_type");
  });

  it("reports total as null when the backend cannot count cheaply", async () => {
    // Runs and feedback omit `total` by design; treating a missing count as 0
    // would render "0 results" above a full list.
    capture(json({ items: [], limit: 50, offset: 0, has_more: true }));

    const page = await listAgents();

    expect(page.total).toBeNull();
    expect(page.hasMore).toBe(true);
  });

  it("sends only the keys actually being changed", async () => {
    const read = capture(json({ id: "a", slug: "a", status: "active" }));

    await updateAgent("instagram-agent", { name: "Renamed" });

    const call = read();
    expect(call.method).toBe("PATCH");
    expect(call.body).toEqual({ name: "Renamed" });
  });

  it("distinguishes clearing a field from leaving it alone", async () => {
    // null clears `description`; undefined must not appear in the body at all,
    // or a rename would silently wipe the description too.
    const read = capture(json({ id: "a", slug: "a", status: "active" }));

    await updateAgent("a", { description: null });

    expect(read().body).toEqual({ description: null });
  });

  it("uses the dedicated status endpoint rather than a general patch", async () => {
    const read = capture(json({ id: "a", slug: "a", status: "disabled" }));

    await setAgentStatus("a", "disabled");

    const call = read();
    expect(call.url).toBe(`${BASE}/agents/a/status`);
    expect(call.body).toEqual({ status: "disabled" });
  });

  it("percent-encodes the agent reference into the path", async () => {
    const read = capture(json({ items: [], limit: 50, offset: 0 }));

    await listFeedback("weird/ref");

    expect(read().url).toContain("/agents/weird%2Fref/feedback");
  });
});

describe("prompts", () => {
  it("creates a new version and activates it by default", async () => {
    // Versions are immutable in the control plane — that is what keeps a run's
    // recorded promptVersion meaningful — so an edit is always a new version.
    const read = capture(json({ id: "p2", agent_id: "a", version: 2, content: "x", is_active: true }));

    await createPromptVersion("a", { content: "new body" });

    const call = read();
    expect(call.url).toBe(`${BASE}/agents/a/prompts`);
    expect(call.body).toEqual({ content: "new body", activate: true });
  });

  it("can store a version without making it live", async () => {
    const read = capture(json({ id: "p3", agent_id: "a", version: 3, content: "x", is_active: false }));

    await createPromptVersion("a", { content: "draft", activate: false, notes: "wip" });

    expect(read().body).toMatchObject({ activate: false, notes: "wip" });
  });

  it("treats an agent with no prompt as null, not as a broken page", async () => {
    capture(new Response('{"detail":"no active prompt"}', { status: 404 }));

    await expect(getActivePrompt("a")).resolves.toBeNull();
  });

  it("still throws on a real failure while fetching the active prompt", async () => {
    capture(new Response("boom", { status: 500 }));

    await expect(getActivePrompt("a")).rejects.toBeInstanceOf(MiddlewareRequestError);
  });

  it("activates an existing version by id", async () => {
    const read = capture(json({ id: "p1", agent_id: "a", version: 1, content: "x", is_active: true }));

    await activatePromptVersion("a", "p1");

    const call = read();
    expect(call.url).toBe(`${BASE}/agents/a/prompts/p1/activate`);
    expect(call.method).toBe("POST");
  });
});

describe("templates", () => {
  it("lists templates with a search term", async () => {
    const read = capture(json({ items: [], limit: 50, offset: 0 }));

    await listTemplates({ q: "landing", limit: 10 });

    const call = read();
    expect(call.url).toContain("/templates?");
    expect(call.url).toContain("limit=10");
    expect(call.url).toContain("q=landing");
  });

  it("binds a template by purpose with PUT, because purpose is the link id", async () => {
    const read = capture(new Response(null, { status: 204 }));

    await bindTemplate("instagram-agent", "carousel_slide", "slide-v2");

    const call = read();
    expect(call.method).toBe("PUT");
    expect(call.url).toBe(`${BASE}/agents/instagram-agent/templates/carousel_slide`);
    expect(call.body).toEqual({ template_ref: "slide-v2", is_primary: true });
  });

  it("handles a 204 without trying to parse a body", async () => {
    capture(new Response(null, { status: 204 }));

    await expect(bindTemplate("a", "p", "t")).resolves.toBeUndefined();
  });
});

describe("two-tier feedback", () => {
  it("tier one: records a verdict against the run", async () => {
    const read = capture(
      json({ id: "f1", run_id: "r1", agent_id: "a", rating: 2, status: "needs_changes", promoted_example_id: null }),
    );

    const result = await submitFeedback("a", "r1", {
      rating: 2,
      status: "needs_changes",
      correctionNotes: "too formal",
      correctedOutput: "the better version",
      reviewer: "tomer@karoslabs.com",
    });

    const call = read();
    expect(call.url).toBe(`${BASE}/agents/a/runs/r1/feedback`);
    expect(call.body).toEqual({
      rating: 2,
      status: "needs_changes",
      correction_notes: "too formal",
      corrected_output: "the better version",
      reviewer: "tomer@karoslabs.com",
    });
    // Not yet promoted — tier one changes nothing about future runs.
    expect(result.promotedExampleId).toBeNull();
  });

  it("tier two: promotes a verdict into a few-shot example", async () => {
    const read = capture(
      json({ id: "e1", agent_id: "a", user_input: "in", assistant_output: "out", is_active: true, position: 0 }),
    );

    const example = await promoteFeedback("a", "f1", { label: "tone fix" });

    const call = read();
    expect(call.url).toBe(`${BASE}/agents/a/feedback/f1/promote`);
    expect(call.method).toBe("POST");
    expect(call.body).toEqual({ label: "tone fix" });
    expect(example.isActive).toBe(true);
  });

  it("promote sends an empty body when nothing is overridden, so the server uses the stored correction", async () => {
    const read = capture(json({ id: "e1", agent_id: "a", user_input: "in", assistant_output: "out" }));

    await promoteFeedback("a", "f1");

    expect(read().body).toEqual({});
  });

  it("carries a run's recorded prompt version through, which is the point of the control plane", async () => {
    capture(
      json({
        id: "r1",
        agent_id: "a",
        status: "succeeded",
        prompt_id: "p2",
        prompt_version: 2,
        input_payload: {},
        output: { text: "hi" },
        feedback: [{ id: "f1", run_id: "r1", agent_id: "a", rating: 5, status: "approved" }],
      }),
    );

    const run = await getRun("a", "r1");

    expect(run.promptVersion).toBe(2);
    expect(run.feedback).toHaveLength(1);
    expect(run.feedback[0]!.status).toBe("approved");
  });
});

describe("errors and auth", () => {
  it("surfaces FastAPI's detail, which is what tells an admin why an edit was rejected", async () => {
    capture(new Response(JSON.stringify({ detail: "content must not be empty" }), { status: 422 }));

    await expect(createPromptVersion("a", { content: "x" })).rejects.toMatchObject({
      status: 422,
      detail: "content must not be empty",
    });
  });

  it("does not fall back to anything on failure", async () => {
    // Deliberate contrast with dispatch: an admin edit either happened or it
    // did not, and there is no second way to make it happen.
    capture(new Response("gateway down", { status: 503 }));

    await expect(listAgents()).rejects.toBeInstanceOf(MiddlewareRequestError);
  });

  it("reports an unreachable control plane without a status", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("ECONNREFUSED"));

    await expect(listAgents()).rejects.toMatchObject({ status: undefined });
  });

  it("refuses to run when no URL is configured", async () => {
    delete process.env.AGENT_MIDDLEWARE_URL;

    await expect(listAgents()).rejects.toThrow(/AGENT_MIDDLEWARE_URL/);
  });

  it("attaches an OIDC token for the configured audience", async () => {
    process.env.AGENT_MIDDLEWARE_AUDIENCE = BASE;

    const mock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      if (String(input).includes("metadata.google.internal")) return new Response("tok.en.sig", { status: 200 });
      return json({ items: [], limit: 50, offset: 0 });
    });

    await listAgents();

    const metadataCall = mock.mock.calls.find((c) => String(c[0]).includes("metadata.google.internal"));
    expect(String(metadataCall?.[0])).toContain(`audience=${encodeURIComponent(BASE)}`);

    const apiCall = mock.mock.calls.find((c) => String(c[0]).includes("/agents"));
    expect((apiCall?.[1]?.headers as Record<string, string>).authorization).toBe("Bearer tok.en.sig");
  });

  it("reuses a cached token across calls instead of hitting the metadata server every time", async () => {
    process.env.AGENT_MIDDLEWARE_AUDIENCE = BASE;

    const mock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      if (String(input).includes("metadata.google.internal")) return new Response("tok.en.sig", { status: 200 });
      return json({ items: [], limit: 50, offset: 0 });
    });

    await listAgents();
    await listTemplates();

    const metadataCalls = mock.mock.calls.filter((c) => String(c[0]).includes("metadata.google.internal"));
    expect(metadataCalls).toHaveLength(1);
  });

  it("sends no Authorization header when no audience is configured (local dev)", async () => {
    const read = capture(json({ items: [], limit: 50, offset: 0 }));

    await listAgents();

    expect(read().headers.authorization).toBeUndefined();
  });

  it("never caches admin reads, so an edit is visible immediately after it lands", async () => {
    const mock = vi.spyOn(globalThis, "fetch").mockResolvedValue(json({ items: [], limit: 50, offset: 0 }));

    await listAgents();

    expect(mock.mock.calls[0]![1]?.cache).toBe("no-store");
  });
});
