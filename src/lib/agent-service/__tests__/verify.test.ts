import { vi, describe, expect, it } from "vitest";

// Must be hoisted before any import that transitively pulls in server-only
vi.mock("server-only", () => ({}));

import { createHmac } from "node:crypto";
import { verifyAgentServiceSignature } from "../verify";
import { agentServiceFetchHeaders } from "../client";

const SECRET = "platform-secret";
const BODY = JSON.stringify({ event: "job.completed", job_id: "svc-1", status: "done" });

function sign(secret: string, timestampMs: number, rawBody: string): string {
  return `v1=${createHmac("sha256", secret).update(`${timestampMs}.${rawBody}`).digest("hex")}`;
}

describe("verifyAgentServiceSignature", () => {
  it("accepts a correctly signed payload", () => {
    const ts = Date.now();
    expect(
      verifyAgentServiceSignature({
        secrets: [SECRET],
        signatureHeader: sign(SECRET, ts, BODY),
        timestampHeader: String(ts),
        rawBody: BODY,
      }),
    ).toBe(true);
  });

  it("rejects tampered bodies, wrong secrets, and missing headers", () => {
    const ts = Date.now();
    const header = sign(SECRET, ts, BODY);
    expect(
      verifyAgentServiceSignature({
        secrets: [SECRET],
        signatureHeader: header,
        timestampHeader: String(ts),
        rawBody: BODY.replace("done", "failed"),
      }),
    ).toBe(false);
    expect(
      verifyAgentServiceSignature({
        secrets: ["wrong"],
        signatureHeader: header,
        timestampHeader: String(ts),
        rawBody: BODY,
      }),
    ).toBe(false);
    expect(
      verifyAgentServiceSignature({
        secrets: [SECRET],
        signatureHeader: null,
        timestampHeader: String(ts),
        rawBody: BODY,
      }),
    ).toBe(false);
  });

  it("supports secret rotation via multiple accepted secrets", () => {
    const ts = Date.now();
    expect(
      verifyAgentServiceSignature({
        secrets: ["new-secret", SECRET],
        signatureHeader: sign(SECRET, ts, BODY),
        timestampHeader: String(ts),
        rawBody: BODY,
      }),
    ).toBe(true);
  });

  it("rejects replays outside the tolerance window", () => {
    const stale = Date.now() - 6 * 60 * 1000;
    expect(
      verifyAgentServiceSignature({
        secrets: [SECRET],
        signatureHeader: sign(SECRET, stale, BODY),
        timestampHeader: String(stale),
        rawBody: BODY,
      }),
    ).toBe(false);
  });
});

describe("agentServiceFetchHeaders", () => {
  const env = { base: "http://localhost:8080", token: "dev-token" };

  it("attaches the bearer token for agent-service (local store) URLs", () => {
    const url = "http://localhost:8080/v1/jobs/abc/artifacts/clients/x/outputs/y/client/01.png";
    expect(agentServiceFetchHeaders(url, env)).toEqual({ authorization: "Bearer dev-token" });
  });

  it("does NOT attach a header for GCS signed URLs (different host)", () => {
    const url = "https://storage.googleapis.com/bucket/artifacts/abc/01.png?X-Goog-Signature=deadbeef";
    expect(agentServiceFetchHeaders(url, env)).toBeUndefined();
  });

  it("tolerates a trailing slash on the base and returns nothing when unconfigured", () => {
    const url = "http://localhost:8080/v1/jobs/abc/artifacts/z";
    expect(agentServiceFetchHeaders(url, { base: "http://localhost:8080/", token: "t" })).toEqual({
      authorization: "Bearer t",
    });
    expect(agentServiceFetchHeaders(url, {})).toBeUndefined();
    expect(agentServiceFetchHeaders(url, { base: "http://localhost:8080" })).toBeUndefined();
  });
});
