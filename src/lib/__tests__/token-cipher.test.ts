import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  encryptToken,
  decryptToken,
  isEncrypted,
  encryptCredentials,
  decryptCredentials,
  decryptCredentialsAvailable,
} from "@/lib/crypto/token-cipher";

// 32-byte key as 64 hex chars.
const KEY = "0".repeat(64);

describe("token-cipher with a key set", () => {
  beforeEach(() => {
    process.env.TOKEN_ENCRYPTION_KEY = KEY;
  });
  afterEach(() => {
    delete process.env.TOKEN_ENCRYPTION_KEY;
  });

  it("encrypts to an enc:v1 blob and round-trips", () => {
    const blob = encryptToken("secret-oauth-token");
    expect(isEncrypted(blob)).toBe(true);
    expect(blob).not.toContain("secret-oauth-token");
    expect(decryptToken(blob)).toBe("secret-oauth-token");
  });

  it("produces a fresh IV each call (ciphertext differs, plaintext same)", () => {
    const a = encryptToken("same");
    const b = encryptToken("same");
    expect(a).not.toBe(b);
    expect(decryptToken(a)).toBe("same");
    expect(decryptToken(b)).toBe("same");
  });

  it("detects tampering (GCM auth tag) on decrypt", () => {
    const blob = encryptToken("tamper-me");
    // Flip the last char of the ciphertext segment.
    const tampered = blob.slice(0, -1) + (blob.at(-1) === "A" ? "B" : "A");
    expect(() => decryptToken(tampered)).toThrow();
  });

  it("round-trips a whole credentials map", () => {
    const enc = encryptCredentials({ accessToken: "at", refreshToken: "rt" });
    expect(isEncrypted(enc.accessToken)).toBe(true);
    expect(decryptCredentials(enc)).toEqual({ accessToken: "at", refreshToken: "rt" });
  });
});

describe("token-cipher without a key (dev)", () => {
  afterEach(() => {
    delete process.env.TOKEN_ENCRYPTION_KEY;
  });

  it("falls back to a plain: marker that still round-trips", () => {
    delete process.env.TOKEN_ENCRYPTION_KEY;
    const blob = encryptToken("devtoken");
    expect(blob).toBe("plain:devtoken");
    expect(isEncrypted(blob)).toBe(false);
    expect(decryptToken(blob)).toBe("devtoken");
  });

  it("treats an unmarked legacy value as plaintext on decrypt", () => {
    expect(decryptToken("legacy-plaintext")).toBe("legacy-plaintext");
  });

  // The lenient READ path. Production writes enc:v1: blobs into the same
  // Firestore local dev reads, and local dev holds no key — that state must
  // degrade to "secrets unreadable here", never to a crashed page.
  it("drops values it cannot decrypt and says so, keeping what it can read", () => {
    process.env.TOKEN_ENCRYPTION_KEY = "0".repeat(64);
    const enc = encryptToken("prod-secret");
    delete process.env.TOKEN_ENCRYPTION_KEY;

    const { credentials, unavailable } = decryptCredentialsAvailable({
      accessToken: enc,
      note: "plain:dev-note",
      legacy: "legacy-plaintext",
    });
    expect(unavailable).toBe(true);
    expect(credentials).toEqual({ note: "dev-note", legacy: "legacy-plaintext" });
  });

  it("reports nothing unavailable when every value decrypts", () => {
    process.env.TOKEN_ENCRYPTION_KEY = "0".repeat(64);
    const { credentials, unavailable } = decryptCredentialsAvailable(
      encryptCredentials({ accessToken: "at" }),
    );
    expect(unavailable).toBe(false);
    expect(credentials).toEqual({ accessToken: "at" });
  });
});
