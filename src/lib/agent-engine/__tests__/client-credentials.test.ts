import { vi, describe, expect, it, beforeEach, afterEach } from "vitest";

// Must be hoisted before any import that transitively pulls in server-only.
vi.mock("server-only", () => ({}));

import {
  AgentEngineCredentialError,
  __iamIdTokenForTests as iamIdToken,
  __resetIdTokenCacheForTests,
} from "../client";

/**
 * SCRUM-330. The defect these cover is not "the token is wrong" — it is that a
 * MISSING credential used to be indistinguishable from a SUCCESSFUL one, so the
 * portal sent an unauthenticated request and the failure surfaced three layers
 * up, at call time, in production.
 *
 * Each case therefore asserts a THROW, not a return value. A test that accepted
 * `undefined` here would pass against the exact code being removed.
 */

const AUD = "https://agent-engine-prep.example.run.app";
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  __resetIdTokenCacheForTests();
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  __resetIdTokenCacheForTests();
});

describe("iamIdToken fails closed once an audience is configured", () => {
  it("throws when the metadata server is unreachable", async () => {
    fetchMock.mockRejectedValue(new Error("ECONNREFUSED"));
    await expect(iamIdToken({ AGENT_ENGINE_AUDIENCE: AUD })).rejects.toBeInstanceOf(AgentEngineCredentialError);
  });

  it("throws when the metadata server answers non-2xx", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 403, text: async () => "forbidden" });
    await expect(iamIdToken({ AGENT_ENGINE_AUDIENCE: AUD })).rejects.toThrow(/returned 403/);
  });

  it("throws when the metadata server answers 200 with an empty body", async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, text: async () => "   " });
    await expect(iamIdToken({ AGENT_ENGINE_AUDIENCE: AUD })).rejects.toThrow(/empty token/);
  });

  it("never resolves to undefined on any failure path", async () => {
    // The whole defect in one assertion: undefined is what the old code returned.
    for (const failure of [
      () => fetchMock.mockRejectedValue(new Error("boom")),
      () => fetchMock.mockResolvedValue({ ok: false, status: 500, text: async () => "" }),
      () => fetchMock.mockResolvedValue({ ok: true, status: 200, text: async () => "" }),
    ]) {
      __resetIdTokenCacheForTests();
      fetchMock.mockReset();
      failure();
      const result = await iamIdToken({ AGENT_ENGINE_AUDIENCE: AUD }).then(
        (v) => ({ resolved: v }),
        (e) => ({ threw: e }),
      );
      expect(result).not.toHaveProperty("resolved");
    }
  });
});

describe("iamIdToken still skips auth where there is genuinely none to do", () => {
  it("returns undefined — without calling the metadata server — when no audience is configured", async () => {
    await expect(iamIdToken({})).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("treats an empty-string audience as unset", async () => {
    await expect(iamIdToken({ AGENT_ENGINE_AUDIENCE: "" })).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns the token on the happy path", async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, text: async () => "  header.payload.sig  " });
    await expect(iamIdToken({ AGENT_ENGINE_AUDIENCE: AUD })).resolves.toBe("header.payload.sig");
  });
});
