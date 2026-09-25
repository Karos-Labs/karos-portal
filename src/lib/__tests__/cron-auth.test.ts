import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

/**
 * `requireCronSecret`: the shared secret (constant-time), and since SCRUM-513
 * a Google-signed OIDC token from a named service account, so Cloud Scheduler
 * jobs no longer have to carry the secret as a readable literal header.
 */

const { verifyIdTokenMock } = vi.hoisted(() => ({ verifyIdTokenMock: vi.fn() }));
vi.mock("google-auth-library", () => ({
  OAuth2Client: class {
    verifyIdToken = verifyIdTokenMock;
  },
}));

import { requireCronSecret } from "@/lib/cron-auth";

function reqWith(headers: Record<string, string>): Request {
  return new Request("https://example.com/api/run-scheduled", { headers });
}

const JWT = "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl";
const SA = "karos-cmo-sa@karoscmo.iam.gserviceaccount.com";

function ticket(payload: Record<string, unknown>) {
  return { getPayload: () => payload };
}

const ORIGINAL_ENV = { ...process.env };
beforeEach(() => {
  process.env.CRON_SECRET = "correct-secret-value";
  verifyIdTokenMock.mockReset();
});
afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("requireCronSecret — constant-time secret comparison", () => {
  it("allows a request with the correct bearer secret", async () => {
    expect(await requireCronSecret(reqWith({ authorization: "Bearer correct-secret-value" }))).toBeNull();
  });

  it("allows a request with the correct X-Cron-Secret header", async () => {
    expect(await requireCronSecret(reqWith({ "x-cron-secret": "correct-secret-value" }))).toBeNull();
  });

  it("rejects a wrong secret of the SAME length without throwing", async () => {
    const wrong = "x".repeat("correct-secret-value".length);
    expect((await requireCronSecret(reqWith({ authorization: `Bearer ${wrong}` })))?.status).toBe(401);
  });

  it("rejects a wrong secret of a DIFFERENT length without throwing", async () => {
    // timingSafeEqual throws on mismatched buffer lengths — the length check
    // in secretsMatch must guard against that before ever calling it.
    await expect(requireCronSecret(reqWith({ authorization: "Bearer short" }))).resolves.toBeDefined();
    expect((await requireCronSecret(reqWith({ authorization: "Bearer short" })))?.status).toBe(401);
  });

  it("rejects a missing secret header", async () => {
    expect((await requireCronSecret(reqWith({})))?.status).toBe(401);
  });
});

describe("requireCronSecret — Cloud Scheduler OIDC (SCRUM-513)", () => {
  beforeEach(() => {
    process.env.CRON_OIDC_SERVICE_ACCOUNTS = SA;
    process.env.APP_URL = "https://app.karoslabs.com";
  });

  it("accepts a verified token from the named service account, audience = the app or a URL under /api", async () => {
    verifyIdTokenMock.mockResolvedValue(ticket({ email: SA.toUpperCase(), email_verified: true, aud: "https://app.karoslabs.com" }));
    expect(await requireCronSecret(reqWith({ authorization: `Bearer ${JWT}` }))).toBeNull();
    verifyIdTokenMock.mockResolvedValue(ticket({ email: SA, email_verified: true, aud: "https://app.karoslabs.com/api/publish" }));
    expect(await requireCronSecret(reqWith({ authorization: `Bearer ${JWT}` }))).toBeNull();
  });

  it("refuses a token from any other account, an unverified email, or another audience", async () => {
    verifyIdTokenMock.mockResolvedValueOnce(ticket({ email: "someone@else.iam.gserviceaccount.com", email_verified: true, aud: "https://app.karoslabs.com" }));
    expect((await requireCronSecret(reqWith({ authorization: `Bearer ${JWT}` })))?.status).toBe(401);
    verifyIdTokenMock.mockResolvedValueOnce(ticket({ email: SA, email_verified: false, aud: "https://app.karoslabs.com" }));
    expect((await requireCronSecret(reqWith({ authorization: `Bearer ${JWT}` })))?.status).toBe(401);
    verifyIdTokenMock.mockResolvedValueOnce(ticket({ email: SA, email_verified: true, aud: "https://agent-engine.run.app" }));
    expect((await requireCronSecret(reqWith({ authorization: `Bearer ${JWT}` })))?.status).toBe(401);
    verifyIdTokenMock.mockResolvedValueOnce(ticket({ email: SA, email_verified: true, aud: "https://app.karoslabs.com.evil.example/api/x" }));
    expect((await requireCronSecret(reqWith({ authorization: `Bearer ${JWT}` })))?.status).toBe(401);
  });

  it("a token that does not verify is a 401, never a second try against the secret", async () => {
    verifyIdTokenMock.mockRejectedValueOnce(new Error("bad signature"));
    expect((await requireCronSecret(reqWith({ authorization: `Bearer ${JWT}` })))?.status).toBe(401);
  });

  it("the shared secret keeps working while OIDC is on, so jobs can move one at a time", async () => {
    expect(await requireCronSecret(reqWith({ authorization: "Bearer correct-secret-value" }))).toBeNull();
    expect(verifyIdTokenMock).not.toHaveBeenCalled();
  });

  it("with no service accounts configured, OIDC is off and a token is just a wrong secret", async () => {
    delete process.env.CRON_OIDC_SERVICE_ACCOUNTS;
    expect((await requireCronSecret(reqWith({ authorization: `Bearer ${JWT}` })))?.status).toBe(401);
    expect(verifyIdTokenMock).not.toHaveBeenCalled();
  });

  it("CRON_OIDC_AUDIENCE overrides APP_URL", async () => {
    process.env.CRON_OIDC_AUDIENCE = "https://karos-cmo-zc6vfwnzsq-ew.a.run.app";
    verifyIdTokenMock.mockResolvedValue(ticket({ email: SA, email_verified: true, aud: "https://karos-cmo-zc6vfwnzsq-ew.a.run.app/api/publish" }));
    expect(await requireCronSecret(reqWith({ authorization: `Bearer ${JWT}` }))).toBeNull();
  });
});
