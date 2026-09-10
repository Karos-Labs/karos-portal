import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { mintIdToken, resetIdTokenCacheForTests } from "@/lib/gcp-id-token";
import { matchingBrace, stripComments } from "./source-scan";

/**
 * SCRUM-330 / AU47, second pass: NO caller may send an unauthenticated request
 * because minting a token failed.
 *
 * WHAT THE TICKET FOUND. `iamIdToken()` returned `undefined` on any
 * metadata-server error, the request went out with no `Authorization` header,
 * and — because the callee does not verify the header yet — a portal that had
 * never once managed to mint a token looked perfectly healthy. The day IAM
 * starts enforcing, a transient metadata blip stops being silent and becomes an
 * outage nobody can explain.
 *
 * WHAT THE TICKET MISSED, and why this file is a sweep rather than three unit
 * tests. There were THREE copies of that function. The fix landed on
 * `agent-engine/client.ts`, whose own docstring cites one of the other two as
 * the pattern it copied: "mirroring src/lib/agent-service/client.ts's own
 * IAM-ID-token pattern exactly". So the fixed copy pointed straight at an
 * unfixed one, for months, and no test held the rule across them.
 *
 * The rule is therefore stated over the FILESYSTEM: exactly one module may
 * speak to the metadata server, and it fails closed. A fourth caller cannot be
 * added quietly, and a fourth COPY cannot be added at all.
 */

const SRC = path.resolve(__dirname, "../..");
const AUD = "https://svc-prep.example.run.app";

/* ─────────────────── the rule, over the whole tree ─────────────────── */

/** Every .ts under src, so a new copy is swept the day it is written. */
function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const abs = path.join(dir, entry);
    if (statSync(abs).isDirectory()) {
      if (entry === "__tests__" || entry === "node_modules") continue;
      out.push(...walk(abs));
    } else if (entry.endsWith(".ts") || entry.endsWith(".tsx")) {
      out.push(abs);
    }
  }
  return out;
}

const FILES = walk(SRC);

describe("one module talks to the metadata server", () => {
  it("swept a real tree, so the assertions below are not vacuous", () => {
    expect(FILES.length).toBeGreaterThan(300);
  });

  it("names exactly one file that calls it", () => {
    // THE LOAD-BEARING ASSERTION. Three copies of this call is how one of them
    // came to be fixed and two did not. A new caller fails here and has to
    // either use the shared minter or argue for itself in this list.
    const callers = FILES.filter((f) =>
      stripComments(readFileSync(f, "utf8")).includes("metadata.google.internal"),
    ).map((f) => path.relative(SRC, f).split(path.sep).join("/"));
    expect(callers).toEqual(["lib/gcp-id-token.ts"]);
  });

  it("leaves no minter handling its own failures", () => {
    /**
     * A MINTER DELEGATES AND CATCHES NOTHING. That is the precise rule, and it
     * had to be narrowed to get there: the first version flagged any
     * `catch { return undefined }` in a file that mentions an audience, and
     * caught `agentServiceFetchHeaders` — whose `return undefined` on an
     * unparseable URL is the SAFE direction, withholding the bearer token from
     * a host that is not the agent service. Swallowing is only a defect inside
     * the mint.
     *
     * Scoped by function name, then by body: every `*IdToken` function must
     * hand off to the shared minter and must contain no `catch` of its own,
     * because a `catch` there is the only place the old `return undefined`
     * could come back.
     */
    const minters: Array<{ rel: string; body: string }> = [];
    for (const file of FILES) {
      const src = stripComments(readFileSync(file, "utf8"));
      const rel = path.relative(SRC, file).split(path.sep).join("/");
      if (rel === "lib/gcp-id-token.ts") continue; // the one that may catch
      for (const m of src.matchAll(/async function (\w*[Ii]dToken)\s*\(/g)) {
        const open = src.indexOf("{", m.index! + m[0].length - 1);
        minters.push({ rel: `${rel}:${m[1]}`, body: src.slice(open, matchingBrace(src, open) + 1) });
      }
    }
    // Non-vacuity: the three services that mint are all still found.
    expect(minters.map((m) => m.rel).sort()).toEqual([
      "lib/agent-engine/client.ts:iamIdToken",
      "lib/agent-engine/middleware-http.ts:middlewareIdToken",
      "lib/agent-service/client.ts:iamIdToken",
    ]);
    for (const { rel, body } of minters) {
      expect(body, `${rel} does not delegate`).toContain("mintIdToken({");
      expect(body, `${rel} handles its own mint failure`).not.toContain("catch");
      expect(body, `${rel} still answers undefined itself`).not.toContain("return undefined");
    }
  });

  it("has every minter route through the shared one", () => {
    for (const rel of [
      "lib/agent-engine/client.ts",
      "lib/agent-service/client.ts",
      "lib/agent-engine/middleware-http.ts",
    ]) {
      const src = stripComments(readFileSync(path.join(SRC, rel), "utf8"));
      expect(src, `${rel} no longer calls mintIdToken`).toContain("mintIdToken({");
      // And each keeps its OWN error type: the message that reaches a client
      // differs per service, and `agent-onboarding.ts` matches one of them by
      // name.
      expect(src, `${rel} passes no credentialError`).toContain("credentialError:");
    }
  });
});

/* ──────────────────── the shared minter, driven ──────────────────── */

describe("mintIdToken", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  const boom = (reason: string) => new Error(`nope: ${reason}`);
  const opts = (audience: string | undefined) => ({
    audience,
    service: "test-service",
    credentialError: boom,
  });

  beforeEach(() => {
    resetIdTokenCacheForTests();
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    resetIdTokenCacheForTests();
  });

  it("skips auth where there is genuinely none to do", () => {
    // The one path that may still answer `undefined`: local development, no IAM
    // in front, nothing to mint. Removing this would break every dev machine.
    return Promise.all([
      expect(mintIdToken(opts(undefined))).resolves.toBeUndefined(),
      expect(mintIdToken(opts(""))).resolves.toBeUndefined(),
    ]);
  });

  it("does not call the metadata server when no audience is set", async () => {
    await mintIdToken(opts(undefined));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("throws when the metadata server is unreachable", async () => {
    fetchMock.mockRejectedValue(new Error("ECONNREFUSED"));
    await expect(mintIdToken(opts(AUD))).rejects.toThrow(/metadata server unreachable/);
  });

  it("throws on a non-ok response, naming the status", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 403 });
    await expect(mintIdToken(opts(AUD))).rejects.toThrow(/returned 403/);
  });

  it("throws on an empty token, which a 200 can still carry", async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, text: async () => "   " });
    await expect(mintIdToken(opts(AUD))).rejects.toThrow(/empty token/);
  });

  it("logs the reason server-side on every failure", async () => {
    // So a caller whose own message must stay client-safe still leaves an
    // operator something to grep — which is how the question the ticket asks
    // ("is this happening in prod right now") gets answered.
    fetchMock.mockResolvedValue({ ok: false, status: 500 });
    await expect(mintIdToken(opts(AUD))).rejects.toThrow();
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("[gcp-id-token] test-service"),
    );
  });

  it("returns and caches a real token", async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, text: async () => "header.payload.sig" });
    await expect(mintIdToken(opts(AUD))).resolves.toBe("header.payload.sig");
    await expect(mintIdToken(opts(AUD))).resolves.toBe("header.payload.sig");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("caches per audience, so three services do not thrash one slot", async () => {
    // The reason the cache is a Map and not the single slot each of the three
    // copies used to keep: they mint against three different audiences.
    fetchMock
      .mockResolvedValueOnce({ ok: true, status: 200, text: async () => "token-a" })
      .mockResolvedValueOnce({ ok: true, status: 200, text: async () => "token-b" });
    await expect(mintIdToken(opts("https://a.example.run.app"))).resolves.toBe("token-a");
    await expect(mintIdToken(opts("https://b.example.run.app"))).resolves.toBe("token-b");
    await expect(mintIdToken(opts("https://a.example.run.app"))).resolves.toBe("token-a");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not cache a failure", async () => {
    fetchMock
      .mockResolvedValueOnce({ ok: false, status: 500 })
      .mockResolvedValueOnce({ ok: true, status: 200, text: async () => "recovered" });
    await expect(mintIdToken(opts(AUD))).rejects.toThrow();
    await expect(mintIdToken(opts(AUD))).resolves.toBe("recovered");
  });
});

/* ────────── the dispatch path still falls back rather than failing ───────── */

describe("a failed mint on the dispatch path", () => {
  it("is turned into a recoverable MiddlewareDispatchError, not a raw throw", () => {
    // Dispatch already treats a 401 as recoverable — "no/expired identity
    // token, a config problem, not the job's fault" — and falls back to direct
    // Pub/Sub. Now that the mint THROWS instead of returning undefined, the
    // same condition arriving one step earlier has to reach the same place, or
    // failing closed would have turned a silent problem into an orphaned job.
    const src = stripComments(
      readFileSync(path.join(SRC, "lib/agent-engine/middleware-client.ts"), "utf8"),
    );
    expect(src).toMatch(/idToken = await iamIdToken\(\);/);
    expect(src).toContain("Agent middleware credentials unavailable");
    expect(src).toMatch(/shouldFallBack: true, cause/);
    // And 401 must still be on the recoverable list, or the two paths disagree.
    expect(src).toMatch(/status === 401/);
  });
});
