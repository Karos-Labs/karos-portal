import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { requireCronSecret } from "@/lib/cron-auth";

function reqWith(headers: Record<string, string>): Request {
  return new Request("https://example.com/api/run-scheduled", { headers });
}

describe("requireCronSecret — constant-time secret comparison", () => {
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(() => {
    process.env.CRON_SECRET = "correct-secret-value";
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("allows a request with the correct bearer secret", () => {
    const res = requireCronSecret(reqWith({ authorization: "Bearer correct-secret-value" }));
    expect(res).toBeNull();
  });

  it("allows a request with the correct X-Cron-Secret header", () => {
    const res = requireCronSecret(reqWith({ "x-cron-secret": "correct-secret-value" }));
    expect(res).toBeNull();
  });

  it("rejects a wrong secret of the SAME length without throwing", () => {
    const wrong = "x".repeat("correct-secret-value".length);
    const res = requireCronSecret(reqWith({ authorization: `Bearer ${wrong}` }));
    expect(res?.status).toBe(401);
  });

  it("rejects a wrong secret of a DIFFERENT length without throwing", () => {
    // timingSafeEqual throws on mismatched buffer lengths — the length check
    // in secretsMatch must guard against that before ever calling it.
    expect(() => requireCronSecret(reqWith({ authorization: "Bearer short" }))).not.toThrow();
    const res = requireCronSecret(reqWith({ authorization: "Bearer short" }));
    expect(res?.status).toBe(401);
  });

  it("rejects a missing secret header", () => {
    const res = requireCronSecret(reqWith({}));
    expect(res?.status).toBe(401);
  });
});
