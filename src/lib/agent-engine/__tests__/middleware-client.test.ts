import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

vi.mock("server-only", () => ({}));

import {
  dispatchViaMiddleware,
  isMiddlewareDispatchEnabled,
} from "../middleware-client";

const BASE = "https://agent-middleware-abc-uc.a.run.app";

function okResponse(body: unknown, status = 202): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("isMiddlewareDispatchEnabled", () => {
  it("is off unless the flag AND a URL are both set", () => {
    expect(isMiddlewareDispatchEnabled({})).toBe(false);
    expect(isMiddlewareDispatchEnabled({ AGENT_MIDDLEWARE_DISPATCH_ENABLED: "true" })).toBe(false);
    expect(isMiddlewareDispatchEnabled({ AGENT_MIDDLEWARE_URL: BASE })).toBe(false);
    expect(
      isMiddlewareDispatchEnabled({
        AGENT_MIDDLEWARE_DISPATCH_ENABLED: "true",
        AGENT_MIDDLEWARE_URL: BASE,
      }),
    ).toBe(true);
  });

  it("treats any value other than the literal 'true' as off", () => {
    // A half-set flag must not silently reroute production traffic.
    for (const value of ["1", "yes", "TRUE", ""]) {
      expect(
        isMiddlewareDispatchEnabled({
          AGENT_MIDDLEWARE_DISPATCH_ENABLED: value,
          AGENT_MIDDLEWARE_URL: BASE,
        }),
      ).toBe(false);
    }
  });
});

describe("dispatchViaMiddleware", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.AGENT_MIDDLEWARE_URL = BASE;
    delete process.env.AGENT_MIDDLEWARE_AUDIENCE;
    vi.restoreAllMocks();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("POSTs to /agents/{productId}/jobs with the control plane's field names", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(okResponse({ run: { id: "run_abc" }, topic: "t", pubsub_message_id: "msg_9" }));

    const result = await dispatchViaMiddleware({
      productId: "instagram-agent",
      clientSlug: "acme",
      runKind: "setup",
      inputs: { topic: "cold brew" },
      correlationId: "job_1",
      requestedBy: "user_7",
    });

    expect(result).toEqual({ pubsubMessageId: "msg_9", middlewareRunId: "run_abc" });

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`${BASE}/agents/instagram-agent/jobs`);
    expect(init?.method).toBe("POST");

    // snake_case: the middleware is a Python service and validates strictly.
    const body = JSON.parse(String(init?.body));
    expect(body).toMatchObject({
      client_slug: "acme",
      run_kind: "setup",
      input: { topic: "cold brew" },
      requested_by: "user_7",
      attributes: { correlationId: "job_1" },
    });
  });

  it("omits an empty input rather than sending an empty object", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(okResponse({ run: { id: "r" }, topic: "t", pubsub_message_id: "m" }));

    await dispatchViaMiddleware({
      productId: "x-agent",
      clientSlug: "acme",
      runKind: "recurring",
      inputs: {},
      correlationId: "job_2",
    });

    const body = JSON.parse(String(fetchMock.mock.calls[0]![1]?.body));
    expect(body).not.toHaveProperty("input");
  });

  it("percent-encodes the product id into the path", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(okResponse({ run: { id: "r" }, topic: "t", pubsub_message_id: "m" }));

    await dispatchViaMiddleware({
      productId: "weird/id",
      clientSlug: "acme",
      runKind: "recurring",
      correlationId: "job_3",
    });

    expect(String(fetchMock.mock.calls[0]![0])).toBe(`${BASE}/agents/weird%2Fid/jobs`);
  });

  it("uses a 30s timeout, comfortably above the middleware's own 10s publish timeout", async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      okResponse({ run: { id: "r" }, topic: "t", pubsub_message_id: "m" }),
    );

    await dispatchViaMiddleware({
      productId: "x-agent",
      clientSlug: "acme",
      runKind: "recurring",
      correlationId: "job_4",
    });

    expect(timeoutSpy).toHaveBeenCalledWith(30_000);
  });

  it("attaches an OIDC bearer token when an audience is configured", async () => {
    process.env.AGENT_MIDDLEWARE_AUDIENCE = BASE;

    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      if (String(input).includes("metadata.google.internal")) {
        return new Response("header.payload.signature", { status: 200 });
      }
      return okResponse({ run: { id: "r" }, topic: "t", pubsub_message_id: "m" });
    });

    await dispatchViaMiddleware({
      productId: "x-agent",
      clientSlug: "acme",
      runKind: "recurring",
      correlationId: "job_5",
    });

    const metadataCall = fetchMock.mock.calls.find((c) =>
      String(c[0]).includes("metadata.google.internal"),
    );
    expect(String(metadataCall?.[0])).toContain(`audience=${encodeURIComponent(BASE)}`);
    expect((metadataCall?.[1]?.headers as Record<string, string>)["Metadata-Flavor"]).toBe("Google");

    const dispatchCall = fetchMock.mock.calls.find((c) => String(c[0]).includes("/jobs"));
    const headers = dispatchCall?.[1]?.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer header.payload.signature");
  });

  it("sends no Authorization header when no audience is configured (local dev)", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(okResponse({ run: { id: "r" }, topic: "t", pubsub_message_id: "m" }));

    await dispatchViaMiddleware({
      productId: "x-agent",
      clientSlug: "acme",
      runKind: "recurring",
      correlationId: "job_6",
    });

    const headers = fetchMock.mock.calls[0]![1]?.headers as Record<string, string>;
    expect(headers.authorization).toBeUndefined();
  });

  it("throws on a non-2xx so the caller can fail the job", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response('{"detail":"no active system prompt"}', { status: 422 }),
    );

    await expect(
      dispatchViaMiddleware({
        productId: "x-agent",
        clientSlug: "acme",
        runKind: "recurring",
        correlationId: "job_7",
      }),
    ).rejects.toThrow(/422/);
  });

  it("throws when the response carries no message id", async () => {
    // Without it the agentEngineRuns doc id cannot be derived, so the run
    // would execute but never be reconcilable — worse than a clean failure.
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      okResponse({ run: { id: "r" }, topic: "t" }),
    );

    await expect(
      dispatchViaMiddleware({
        productId: "x-agent",
        clientSlug: "acme",
        runKind: "recurring",
        correlationId: "job_8",
      }),
    ).rejects.toThrow(/pubsub_message_id/);
  });

  it("refuses to run when no URL is configured", async () => {
    delete process.env.AGENT_MIDDLEWARE_URL;

    await expect(
      dispatchViaMiddleware({
        productId: "x-agent",
        clientSlug: "acme",
        runKind: "recurring",
        correlationId: "job_9",
      }),
    ).rejects.toThrow(/AGENT_MIDDLEWARE_URL/);
  });
});
