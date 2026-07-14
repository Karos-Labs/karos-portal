import { describe, expect, it } from "vitest";
import {
  buildSignatureHeaders,
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  timingSafeStringEqual,
  verifySignature,
} from "../src/webhooks/sign.js";

const SECRET = "test-secret";
const BODY = JSON.stringify({ event: "job.completed", job_id: "abc" });

function headersFor(secret: string, body: string, ts?: number) {
  const headers = buildSignatureHeaders(secret, body, ts);
  return {
    signatureHeader: headers[SIGNATURE_HEADER],
    timestampHeader: headers[TIMESTAMP_HEADER],
  };
}

describe("webhook signing", () => {
  it("round-trips a valid signature", () => {
    const { signatureHeader, timestampHeader } = headersFor(SECRET, BODY);
    expect(
      verifySignature({ secrets: [SECRET], signatureHeader, timestampHeader, rawBody: BODY }),
    ).toBe(true);
  });

  it("rejects a tampered body", () => {
    const { signatureHeader, timestampHeader } = headersFor(SECRET, BODY);
    expect(
      verifySignature({ secrets: [SECRET], signatureHeader, timestampHeader, rawBody: BODY + "x" }),
    ).toBe(false);
  });

  it("rejects a wrong secret but accepts during rotation", () => {
    const { signatureHeader, timestampHeader } = headersFor(SECRET, BODY);
    expect(
      verifySignature({ secrets: ["other"], signatureHeader, timestampHeader, rawBody: BODY }),
    ).toBe(false);
    expect(
      verifySignature({ secrets: ["other", SECRET], signatureHeader, timestampHeader, rawBody: BODY }),
    ).toBe(true);
  });

  it("rejects stale timestamps beyond tolerance", () => {
    const staleTs = Date.now() - 10 * 60 * 1000;
    const { signatureHeader, timestampHeader } = headersFor(SECRET, BODY, staleTs);
    expect(
      verifySignature({ secrets: [SECRET], signatureHeader, timestampHeader, rawBody: BODY }),
    ).toBe(false);
    expect(
      verifySignature({
        secrets: [SECRET],
        signatureHeader,
        timestampHeader,
        rawBody: BODY,
        nowMs: staleTs + 1000,
      }),
    ).toBe(true);
  });

  it("rejects missing or malformed headers", () => {
    const { timestampHeader } = headersFor(SECRET, BODY);
    expect(
      verifySignature({ secrets: [SECRET], signatureHeader: undefined, timestampHeader, rawBody: BODY }),
    ).toBe(false);
    expect(
      verifySignature({ secrets: [SECRET], signatureHeader: "v2=zzzz", timestampHeader, rawBody: BODY }),
    ).toBe(false);
    expect(
      verifySignature({
        secrets: [SECRET],
        signatureHeader: "v1=nothex",
        timestampHeader: "notanumber",
        rawBody: BODY,
      }),
    ).toBe(false);
  });

  it("compares strings in constant time semantics", () => {
    expect(timingSafeStringEqual("abc", "abc")).toBe(true);
    expect(timingSafeStringEqual("abc", "abd")).toBe(false);
    expect(timingSafeStringEqual("abc", "abcd")).toBe(false);
  });
});
