import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * SCRUM-373: gcs-media.ts (and agent-engine/workspace-writer.ts, a THIRD storage
 * seam with its own verbatim copy of the same credential chain — see that
 * file's header) used to build their `@google-cloud/storage` client from
 * `FIREBASE_SERVICE_ACCOUNT_KEY` whenever that var was set, which it is in
 * BOTH environments (prep and prod). That means every GCS call — including the
 * three `.getSignedUrl()` call sites — actually authenticated as
 * `firebase-adminsdk-fbsvc@karoscmo`, a shared production identity, never as
 * the Cloud Run runtime service account a bucket grant targets (SCRUM-369's
 * prep grants were inert for exactly this reason).
 *
 * This test asks the closed question directly: does the constructed `Storage`
 * client carry the Firebase key's credentials at all? Under the regression
 * this guards against (re-adding the FIREBASE_SERVICE_ACCOUNT_KEY branch,
 * however it's spelled), the client picks up that key and this fails.
 */

vi.mock("server-only", () => ({}));

const storageConstructorArgs: unknown[] = [];

const fakeFile = {
  getSignedUrl: vi.fn(async () => ["https://signed.example/fake-url"]),
  save: vi.fn(async () => undefined),
};
const fakeBucket = {
  getFiles: vi.fn(async () => [[]]),
  file: vi.fn(() => fakeFile),
};

vi.mock("@google-cloud/storage", () => {
  class Storage {
    constructor(options?: unknown) {
      storageConstructorArgs.push(options);
    }
    bucket() {
      return fakeBucket;
    }
  }
  return { Storage };
});

const FIREBASE_ADMIN_CLIENT_EMAIL = "firebase-adminsdk-fbsvc@karoscmo.iam.gserviceaccount.com";
const FAKE_FIREBASE_SERVICE_ACCOUNT_KEY = JSON.stringify({
  client_email: FIREBASE_ADMIN_CLIENT_EMAIL,
  private_key: "-----BEGIN PRIVATE KEY-----\nfake\n-----END PRIVATE KEY-----\n",
  project_id: "karoscmo",
});

const ORIGINAL_ENV = { ...process.env };

describe("GCS Storage clients never pick up the Firebase admin credential", () => {
  beforeEach(() => {
    vi.resetModules();
    storageConstructorArgs.length = 0;
    process.env = { ...ORIGINAL_ENV };
    // Both environments set this today (per SCRUM-373's description, unchallenged
    // by Tomer's comment). If the client construction still branches on it, this
    // is exactly the condition that leaks the Firebase identity into GCS.
    process.env.FIREBASE_SERVICE_ACCOUNT_KEY = FAKE_FIREBASE_SERVICE_ACCOUNT_KEY;
    process.env.GCS_MEDIA_BUCKET = "test-media-bucket";
    process.env.AGENT_ENGINE_WORKSPACE_BUCKET = "test-workspace-bucket";
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    vi.restoreAllMocks();
  });

  it("gcs-media.ts's Storage client is not constructed with the Firebase credential", async () => {
    const { listClientMediaObjects } = await import("@/lib/gcs-media");
    await listClientMediaObjects("client-1");

    expect(storageConstructorArgs).toHaveLength(1);
    const [options] = storageConstructorArgs;
    expect(options).toBeUndefined();
  });

  it("gcs-media.ts's signed-URL call sites do not authenticate as firebase-adminsdk-fbsvc@ either", async () => {
    const { createUploadSignedUrl, createReadSignedUrl } = await import("@/lib/gcs-media");
    await createUploadSignedUrl({ gcsPath: "clients/c1/podcast-clips/x.mp4", contentType: "video/mp4" });
    await createReadSignedUrl("clients/c1/podcast-clips/x.mp4");

    // One shared client, built once, reused by every call site.
    expect(storageConstructorArgs).toHaveLength(1);
    expect(storageConstructorArgs[0]).toBeUndefined();
  });

  it("agent-engine/workspace-writer.ts's Storage client (the third storage seam) is likewise unaffected by the Firebase key", async () => {
    const { writeWorkspaceJson } = await import("@/lib/agent-engine/workspace-writer");
    await writeWorkspaceJson("clients/c1/knowledge/topics.json", { ok: true });

    expect(storageConstructorArgs).toHaveLength(1);
    const [options] = storageConstructorArgs;
    expect(options).toBeUndefined();
  });
});
