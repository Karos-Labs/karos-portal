import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * ClientIntegration credentials (generic social OAuth/manual connectors) must be
 * encrypted at rest the same way employee-seat tokens are (see
 * seat-architecture.test.ts) — this was a gap found in a security review:
 * upsertClientIntegration wrote plaintext tokens straight to Firestore.
 */

const store = new Map<string, Record<string, unknown> | undefined>();

vi.mock("server-only", () => ({}));
vi.mock("@/lib/firebase/admin", () => {
  const docRef = (id: string) => ({
    id,
    async get() {
      const data = store.get(id);
      return { exists: data !== undefined, id, data: () => data };
    },
    async set(data: Record<string, unknown>, opts?: { merge?: boolean }) {
      const prev = opts?.merge ? store.get(id) ?? {} : {};
      store.set(id, { ...prev, ...data });
    },
  });
  const collection = () => ({
    doc: (id: string) => docRef(id),
    where: (field: string, _op: string, value: unknown) => ({
      async get() {
        const docs = [...store.entries()]
          .filter(([, data]) => data && (data as Record<string, unknown>)[field] === value)
          .map(([id, data]) => ({ id, data: () => data }));
        return { docs };
      },
    }),
  });
  const db = { collection };
  return { adminDb: () => db };
});

import { upsertClientIntegration, listClientIntegrations } from "@/lib/data";
import { isEncrypted } from "@/lib/crypto/token-cipher";

describe("client integration credentials — encrypted at rest", () => {
  beforeEach(() => {
    process.env.TOKEN_ENCRYPTION_KEY = "0".repeat(64);
    store.clear();
  });
  afterEach(() => {
    delete process.env.TOKEN_ENCRYPTION_KEY;
  });

  it("stores OAuth tokens ENCRYPTED and returns them DECRYPTED", async () => {
    await upsertClientIntegration({
      clientId: "c1",
      platform: "facebook",
      credentials: { accessToken: "secret-at", refreshToken: "secret-rt" },
      method: "oauth",
      connectedBy: "u1",
      connectedAt: 0,
      updatedAt: 0,
    });

    const raw = store.get("c1_facebook") as { credentials: Record<string, string> };
    expect(isEncrypted(raw.credentials.accessToken)).toBe(true);
    expect(raw.credentials.accessToken).not.toContain("secret-at");

    const [integration] = await listClientIntegrations("c1");
    expect(integration.credentials).toEqual({ accessToken: "secret-at", refreshToken: "secret-rt" });
  });

  it("survives reading production-encrypted credentials without a key", async () => {
    // The state that crashed ClientDetailPage: blobs written WITH the key
    // (production), listed by an environment WITHOUT it (local dev on the
    // same Firestore). The row must come back — flagged, secrets dropped —
    // not throw through every page that lists a client.
    await upsertClientIntegration({
      clientId: "c1",
      platform: "linkedin",
      credentials: { accessToken: "prod-at" },
      method: "oauth",
      connectedBy: "u1",
      connectedAt: 0,
      updatedAt: 0,
    });
    delete process.env.TOKEN_ENCRYPTION_KEY;

    const [integration] = await listClientIntegrations("c1");
    expect(integration.credentialsUnavailable).toBe(true);
    expect(integration.credentials).toEqual({});
    expect(integration.platform).toBe("linkedin");
  });

  it("round-trips manually-pasted API keys the same way", async () => {
    await upsertClientIntegration({
      clientId: "c1",
      platform: "resend",
      credentials: { apiKey: "manual-secret" },
      method: "manual",
      connectedBy: "u1",
      connectedAt: 0,
      updatedAt: 0,
    });

    const raw = store.get("c1_resend") as { credentials: Record<string, string> };
    expect(isEncrypted(raw.credentials.apiKey)).toBe(true);

    const [integration] = await listClientIntegrations("c1");
    expect(integration.credentials.apiKey).toBe("manual-secret");
  });
});
