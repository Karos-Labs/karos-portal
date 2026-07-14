import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { signOAuthState, verifyOAuthState, buildEmployeeCallbackUrl } from "@/lib/integrations/oauth";

describe("OAuth state signing — employee seat flow", () => {
  it("round-trips the seatId through sign → verify", () => {
    const state = signOAuthState({ clientId: "c1", uid: "u1", provider: "linkedin", seatId: "seat_9" });
    const parsed = verifyOAuthState(state);
    expect(parsed).toMatchObject({ clientId: "c1", uid: "u1", provider: "linkedin", seatId: "seat_9" });
  });

  it("still works for the legacy (no seatId) flow", () => {
    const state = signOAuthState({ clientId: "c1", uid: "u1", provider: "linkedin" });
    const parsed = verifyOAuthState(state);
    expect(parsed?.seatId).toBeUndefined();
    expect(parsed?.clientId).toBe("c1");
  });

  it("rejects a tampered state (forged seatId can't pass the HMAC)", () => {
    const state = signOAuthState({ clientId: "c1", uid: "u1", provider: "linkedin", seatId: "seat_9" });
    const [data, sig] = state.split(".");
    // Re-encode a payload with a different seatId but keep the original signature.
    const forged = Buffer.from(
      JSON.stringify({ clientId: "c1", uid: "u1", provider: "linkedin", seatId: "seat_HACK", nonce: "x", ts: Date.now() }),
    ).toString("base64url");
    expect(verifyOAuthState(`${forged}.${sig}`)).toBeNull();
    // Sanity: the untampered one verifies.
    expect(verifyOAuthState(`${data}.${sig}`)).not.toBeNull();
  });

  it("rejects a malformed state", () => {
    expect(verifyOAuthState("not-a-valid-state")).toBeNull();
  });

  it("builds the dedicated employee callback path", () => {
    expect(buildEmployeeCallbackUrl()).toMatch(/\/api\/integrations\/linkedin\/employee\/callback$/);
  });
});
