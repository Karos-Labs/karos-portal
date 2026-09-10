/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, vi } from "vitest";

import * as data from "@/lib/data";
import * as auth from "@/lib/auth";
import * as gcs from "@/lib/gcs-media";

/**
 * #161 — `f332463` shipped a public API route and no test for it.
 *
 * `POST /api/assets/bulk-upload` is the staff dropzone's back end: it mints a
 * V4 signed PUT url straight into a client's media bucket, registers the
 * uploaded object as an asset on their library, and can sweep the whole bucket
 * for clips a staff member dropped in by hand. Three write paths behind one
 * endpoint, ~900 lines of commit, zero tests — and then the suite became a
 * required CI gate, so "green" started meaning something it did not mean here.
 *
 * SCOPE, stated rather than implied: this file covers the fences and the
 * idempotency, which is what a caller can reach and what corrupts data. It does
 * NOT cover the GCS calls themselves (mocked — signing is @google-cloud/storage's
 * job), the browser dropzone, or `scripts/upload-local-clips.ts`. What is left
 * uncovered is named in the handover rather than papered over with a test that
 * only raises a number.
 *
 * `@/lib/client-visibility` is deliberately NOT mocked: `canViewClient` is the
 * real fence and a stub of it would test this file's opinion of the fence
 * instead of the fence.
 */

vi.mock("server-only", () => ({}));
vi.mock("@/lib/data");
vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return { ...actual, getCurrentUser: vi.fn() };
});
// The three calls that reach Google are stubbed; `mediaObjectPath` and the
// limits stay REAL, so the path the "sign" step hands out and the path the
// "complete" step validates are the same one definition.
vi.mock("@/lib/gcs-media", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/gcs-media")>();
  return {
    ...actual,
    createUploadSignedUrl: vi.fn(),
    createReadSignedUrl: vi.fn(),
    listClientMediaObjects: vi.fn(),
  };
});

const CLIENT = {
  id: "c1",
  name: "Acme",
  status: "active",
  createdAt: 0,
  assignedEmployeeIds: ["u-emp-1"],
};

const ADMIN = { uid: "u-admin", role: "KAROS_ADMIN", clientId: null, createdAt: 0 };
const ASSIGNED = { uid: "u-emp-1", role: "KAROS_EMPLOYEE", clientId: null, createdAt: 0 };
/** Staff, but this client is not theirs — the actor the fence exists for. */
const UNASSIGNED = { uid: "u-emp-2", role: "KAROS_EMPLOYEE", clientId: null, createdAt: 0 };
/** The client's own user. Staff-only route: they are not staff. */
const OWN_CLIENT_USER = { uid: "u-client", role: "CLIENT_USER", clientId: "c1", createdAt: 0 };
const DISABLED_ADMIN = { ...ADMIN, uid: "u-ex", disabled: true };

function as(user: unknown) {
  vi.mocked(auth.getCurrentUser).mockResolvedValue(user as any);
}

async function post(body: unknown) {
  const { POST } = await import("@/app/api/assets/bulk-upload/route");
  return POST(
    new Request("https://portal.test/api/assets/bulk-upload", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

const GCS_PATH = "clients/c1/podcast-clips/1700000000000-clip.mp4";

function completeBody(overrides: Record<string, unknown> = {}) {
  return {
    step: "complete",
    clientId: "c1",
    gcsPath: GCS_PATH,
    filename: "clip.mp4",
    contentType: "video/mp4",
    ...overrides,
  };
}

/** An asset already registered for `path`, as `listAssets` would return it. */
function registered(id: string, path: string, createdAt: number) {
  return { id, clientId: "c1", type: "social_post", meta: { gcsPath: path }, createdAt };
}

/** Nothing may have been written. Asked of every refusal in this file. */
function expectNothingWritten() {
  expect(gcs.createUploadSignedUrl).not.toHaveBeenCalled();
  expect(gcs.createReadSignedUrl).not.toHaveBeenCalled();
  expect(gcs.listClientMediaObjects).not.toHaveBeenCalled();
  expect(data.createAsset).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.clearAllMocks();
  as(ADMIN);
  vi.mocked(data.getClient).mockResolvedValue(CLIENT as any);
  vi.mocked(data.listAssets).mockResolvedValue([] as any);
  vi.mocked(data.createAsset).mockResolvedValue("asset-1" as any);
  vi.mocked(gcs.createUploadSignedUrl).mockResolvedValue("https://gcs.test/put?sig=1" as any);
  vi.mocked(gcs.createReadSignedUrl).mockResolvedValue("https://gcs.test/get?sig=1" as any);
  vi.mocked(gcs.listClientMediaObjects).mockResolvedValue([] as any);
});

describe("who may reach the bulk-upload endpoint at all", () => {
  it("401s a caller with no session", async () => {
    as(null);
    const res = await post({ step: "sign", clientId: "c1", filename: "a.mp4", contentType: "video/mp4", sizeBytes: 1 });
    expect(res.status).toBe(401);
    expectNothingWritten();
  });

  it("401s a deactivated account that still says admin", async () => {
    as(DISABLED_ADMIN);
    const res = await post({ step: "sign", clientId: "c1", filename: "a.mp4", contentType: "video/mp4", sizeBytes: 1 });
    expect(res.status).toBe(401);
    expectNothingWritten();
  });

  it("403s the client whose bucket it is — this dropzone is staff-only", async () => {
    // `canViewClient` would pass a client for their own workspace, so the ROLE
    // test above it is the only thing keeping them out. Worth its own case: a
    // client signing their own upload urls would put unreviewed video into the
    // library the calendar draws from.
    as(OWN_CLIENT_USER);
    const res = await post({ step: "sign", clientId: "c1", filename: "a.mp4", contentType: "video/mp4", sizeBytes: 1 });
    expect(res.status).toBe(403);
    expectNothingWritten();
  });

  it("404s an employee this client is not assigned to", async () => {
    as(UNASSIGNED);
    const res = await post(completeBody());
    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({ error: "Client not found" });
    expectNothingWritten();
  });

  it("gives a client that does not exist the same answer", async () => {
    // Otherwise the difference between 404 and anything else tells an
    // unassigned employee which client ids are real.
    as(UNASSIGNED);
    const refusedReal = await post(completeBody());
    as(ADMIN);
    vi.mocked(data.getClient).mockResolvedValue(null as any);
    const missing = await post(completeBody());
    expect(missing.status).toBe(refusedReal.status);
    await expect(missing.json()).resolves.toEqual(await refusedReal.json());
  });

  it("lets the assigned employee through", async () => {
    // The other direction: an over-tight fence breaks Karos's own staff, and a
    // refusal-only suite would never notice.
    as(ASSIGNED);
    const res = await post(completeBody());
    expect(res.status).toBe(200);
    expect(data.createAsset).toHaveBeenCalledTimes(1);
  });

  it("400s a body with no recognised step, before it reads the client", async () => {
    const res = await post({ step: "definitely-not-a-step", clientId: "c1" });
    expect(res.status).toBe(400);
    expectNothingWritten();
  });
});

describe("step 'sign' — minting an upload url into a client's bucket", () => {
  const sign = (overrides: Record<string, unknown> = {}) =>
    post({ step: "sign", clientId: "c1", filename: "clip.mp4", contentType: "video/mp4", sizeBytes: 1024, ...overrides });

  it("returns a path under this client's own prefix, and a url", async () => {
    const res = await sign();
    expect(res.status).toBe(200);
    const body = await res.json();
    // The prefix is what the "complete" step below validates against, so this
    // is the join between the two halves of the upload.
    expect(body.gcsPath.startsWith("clients/c1/podcast-clips/")).toBe(true);
    expect(body.uploadUrl).toBe("https://gcs.test/put?sig=1");
  });

  it("refuses a content type that is not one of the allowed video types", async () => {
    // The signed url carries the content type; anything accepted here is
    // something the bucket will then hold.
    const res = await sign({ contentType: "application/zip", filename: "payload.zip" });
    expect(res.status).toBe(400);
    expect(gcs.createUploadSignedUrl).not.toHaveBeenCalled();
  });

  it("refuses a file past the size ceiling", async () => {
    const res = await sign({ sizeBytes: gcs.MAX_VIDEO_BYTES + 1 });
    expect(res.status).toBe(413);
    expect(gcs.createUploadSignedUrl).not.toHaveBeenCalled();
  });

  it("refuses a request with no size at all rather than signing it blind", async () => {
    const res = await sign({ sizeBytes: undefined });
    expect(res.status).toBe(400);
    expect(gcs.createUploadSignedUrl).not.toHaveBeenCalled();
  });
});

describe("step 'complete' — registering the uploaded object", () => {
  it("refuses a gcsPath that belongs to another client", async () => {
    // The load-bearing fence of this step. `clientId` and `gcsPath` are two
    // independent fields of the same body, so without this an actor assigned to
    // c1 could register ANOTHER client's object onto c1's library — a read of
    // their media through a signed url this route mints.
    const res = await post(completeBody({ gcsPath: "clients/c2/podcast-clips/1-secret.mp4" }));

    expect(res.status).toBe(400);
    expect(data.createAsset).not.toHaveBeenCalled();
    expect(gcs.createReadSignedUrl).not.toHaveBeenCalled();
  });

  it("refuses a path that only looks like this client's prefix", async () => {
    // `clients/c1` is a prefix of `clients/c10`, so a startsWith on the id alone
    // would let one workspace name another's objects. What keeps them apart is
    // the `/` the route's prefix carries after the id (it tests the whole
    // `clients/<id>/podcast-clips/` segment), and that is worth its own case
    // because shortening the prefix would look like a harmless simplification.
    const res = await post(completeBody({ clientId: "c1", gcsPath: "clients/c10/podcast-clips/1-x.mp4" }));

    expect(res.status).toBe(400);
    expect(data.createAsset).not.toHaveBeenCalled();
  });

  it("registers the clip as a draft on the named client", async () => {
    const res = await post(completeBody({ durationSeconds: 42 }));

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ id: "asset-1" });
    const asset = vi.mocked(data.createAsset).mock.calls[0]![0] as any;
    expect(asset).toMatchObject({
      clientId: "c1",
      // A bulk-uploaded clip is unreviewed by definition: it must land as a
      // draft, never as something a client sees as approved.
      status: "draft",
      videoUrl: "https://gcs.test/get?sig=1",
      createdBy: "u-admin",
    });
    expect(asset.meta).toMatchObject({ bulkUpload: true, gcsPath: GCS_PATH, durationSeconds: 42 });
  });

  it("is idempotent on the object path — a replay mints no second asset", async () => {
    // The bug this closed, and the reason those duplicate documents are in
    // production: a double click, a retry after a timeout or a resumed upload
    // called "complete" twice and got two assets for one object, which the
    // calendar then rendered twice.
    vi.mocked(data.listAssets).mockResolvedValue([registered("asset-original", GCS_PATH, 100)] as any);

    const res = await post(completeBody());

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ id: "asset-original" });
    expect(data.createAsset).not.toHaveBeenCalled();
  });

  it("hands a replay the OLDEST copy when duplicates already exist", async () => {
    // `listAssets` returns newest-first and there are already duplicate
    // documents in production, so "the one registered for this path" has to
    // pick a survivor — the same one calendar-dedupe keeps, or the id this
    // route reports is not the copy the client is looking at.
    vi.mocked(data.listAssets).mockResolvedValue([
      registered("asset-newer", GCS_PATH, 300),
      registered("asset-original", GCS_PATH, 100),
    ] as any);

    const res = await post(completeBody());

    await expect(res.json()).resolves.toEqual({ id: "asset-original" });
    expect(data.createAsset).not.toHaveBeenCalled();
  });

  it("refuses a body with no path or no filename", async () => {
    expect((await post(completeBody({ gcsPath: "" }))).status).toBe(400);
    expect((await post(completeBody({ filename: "" }))).status).toBe(400);
    expect(data.createAsset).not.toHaveBeenCalled();
  });
});

describe("step 'import-bucket' — sweeping up clips dropped in by hand", () => {
  const objects = [
    { gcsPath: "clients/c1/podcast-clips/1-already.mp4", filename: "already.mp4", contentType: "video/mp4" },
    { gcsPath: "clients/c1/podcast-clips/2-fresh.mp4", filename: "fresh.mp4", contentType: "video/mp4" },
  ];

  it("registers only the objects that have no asset yet", async () => {
    vi.mocked(gcs.listClientMediaObjects).mockResolvedValue(objects as any);
    vi.mocked(data.listAssets).mockResolvedValue([
      registered("asset-already", objects[0]!.gcsPath, 100),
    ] as any);

    const res = await post({ step: "import-bucket", clientId: "c1" });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      imported: 1,
      skipped: 1,
      filenames: ["fresh.mp4"],
    });
    expect(data.createAsset).toHaveBeenCalledTimes(1);
    expect((vi.mocked(data.createAsset).mock.calls[0]![0] as any).meta.gcsPath).toBe(
      objects[1]!.gcsPath,
    );
  });

  it("imports nothing twice when run again with everything already registered", async () => {
    vi.mocked(gcs.listClientMediaObjects).mockResolvedValue(objects as any);
    vi.mocked(data.listAssets).mockResolvedValue(
      objects.map((o, i) => registered(`asset-${i}`, o.gcsPath, 100 + i)) as any,
    );

    const res = await post({ step: "import-bucket", clientId: "c1" });

    await expect(res.json()).resolves.toEqual({ imported: 0, skipped: 2, filenames: [] });
    expect(data.createAsset).not.toHaveBeenCalled();
  });

  it("never reads another client's bucket for an actor it refused", async () => {
    as(UNASSIGNED);
    const res = await post({ step: "import-bucket", clientId: "c1" });
    expect(res.status).toBe(404);
    expect(gcs.listClientMediaObjects).not.toHaveBeenCalled();
  });
});
