/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * THE FIVE ROUTES THE FOLDER-SHAPED GUARD COULD NOT SEE.
 *
 * `client-api-access-guard.test.ts` fenced everything under `/api/clients/[id]`
 * and left a filesystem tripwire over that directory. The directory was the
 * wrong key: five handlers elsewhere took a client id straight off the request
 * and asked nothing about it, and the green tripwire made the cluster look
 * certified while they stayed open. Each one WRITES:
 *
 *   tasks/generate-swarm         took the client's AI lock, spent 5 of their
 *                                credits, and persisted tasks to their board
 *   assets/bulk-upload           signed an upload URL into their media bucket
 *                                and created assets in their library
 *   auth/social/[provider]       signed the OAuth state the callback trusts, so
 *                                a channel connected onto another client
 *   integrations/linkedin/…/auth same, for one employee-advocacy seat
 *   asset-media (both /assets/[id] routes) served any client's clip or download
 *                                to any staff member — `!isStaff(user) && …`
 *
 * All five were one shape: a check that establishes WHICH KIND of actor this is,
 * used as though it answered WHICH CLIENTS they may touch. The sixth
 * (linkedin/employee/auth) was found by the re-keyed tripwire rather than by a
 * reader, which is the argument for keying on the argument.
 *
 * These tests drive the handlers for real and ask the question the source scan
 * cannot: that the refused actor is refused AND that nothing happened on the way
 * out — no lock taken, no charge, no signed URL, no state token minted.
 */

const CLIENT = { id: "c1", name: "Acme", status: "active", createdAt: 0, assignedEmployeeIds: ["u-emp-1"] };

const ADMIN = { uid: "u-admin", role: "KAROS_ADMIN", clientId: null, createdAt: 0 };
const ASSIGNED = { uid: "u-emp-1", role: "KAROS_EMPLOYEE", clientId: null, createdAt: 0 };
/** The actor every fence in this file exists for. */
const UNASSIGNED = { uid: "u-emp-2", role: "KAROS_EMPLOYEE", clientId: null, createdAt: 0 };
const OWN_CLIENT_USER = { uid: "u-client", role: "CLIENT_USER", clientId: "c1", createdAt: 0 };

vi.mock("server-only", () => ({}));
vi.mock("@/lib/data");
vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return { ...actual, getCurrentUser: vi.fn(), requireUser: vi.fn() };
});
vi.mock("@/lib/client-model-charge", () => ({
  chargeClientModelCall: vi.fn(),
  refundClientModelCall: vi.fn(),
  refundOnce: vi.fn(() => async () => {}),
}));
vi.mock("@/lib/agent-swarm", () => ({
  buildSwarmContext: vi.fn(async () => ({})),
  runSwarm: vi.fn(async () => ({ tasksCreated: 0 })),
}));
vi.mock("@/lib/actions/_shared", () => ({
  logActivity: vi.fn(),
  logGenerationFailure: vi.fn(),
}));
vi.mock("@/lib/gcs-media", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/gcs-media")>();
  return {
    ...actual,
    createUploadSignedUrl: vi.fn(async () => "https://signed.test/up"),
    createReadSignedUrl: vi.fn(async () => "https://signed.test/read"),
    createDownloadSignedUrl: vi.fn(async () => "https://signed.test/dl"),
    listClientMediaObjects: vi.fn(async () => []),
  };
});
vi.mock("@/lib/integrations/oauth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/integrations/oauth")>();
  return {
    ...actual,
    signOAuthState: vi.fn(() => "state-token"),
    generateCodeVerifier: vi.fn(() => "verifier"),
    generateCodeChallenge: vi.fn(async () => "challenge"),
    isOAuthEnabled: vi.fn(() => true),
  };
});
vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({ set: vi.fn(), get: vi.fn(), delete: vi.fn() })),
}));

import * as data from "@/lib/data";
import { getCurrentUser, requireUser } from "@/lib/auth";
import { chargeClientModelCall } from "@/lib/client-model-charge";
import { createUploadSignedUrl } from "@/lib/gcs-media";
import { signOAuthState } from "@/lib/integrations/oauth";

function as(user: unknown) {
  vi.mocked(getCurrentUser).mockResolvedValue(user as any);
  vi.mocked(requireUser).mockResolvedValue(user as any);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(data.getClient).mockResolvedValue(CLIENT as any);
  vi.mocked(data.tryAcquireAiProcessingLock).mockResolvedValue(true as any);
  vi.mocked(data.releaseAiProcessingLock).mockResolvedValue(undefined as any);
  vi.mocked(data.listEmployeeSeats).mockResolvedValue([{ id: "seat1" }] as any);
  vi.mocked(data.listAssets).mockResolvedValue([] as any);
  vi.mocked(data.createAsset).mockResolvedValue("a-new" as any);
  vi.mocked(chargeClientModelCall).mockResolvedValue({ denied: null, chargedAt: null } as any);
  process.env.LINKEDIN_CLIENT_ID = "app-id";
  process.env.LINKEDIN_CLIENT_SECRET = "app-secret";
});

/* ───────────────────────── tasks/generate-swarm ───────────────────────── */

describe("POST /api/tasks/generate-swarm", () => {
  async function call() {
    const { POST } = await import("@/app/api/tasks/generate-swarm/route");
    return POST(
      new Request("https://portal.test/api/tasks/generate-swarm", {
        method: "POST",
        body: JSON.stringify({ clientId: "c1" }),
      }),
    );
  }

  it("refuses an unassigned employee", async () => {
    as(UNASSIGNED);
    const res = await call();
    expect(res.status).toBe(404);
  });

  /**
   * The two things that made this the worst of the five. The lock is a Firestore
   * transaction on the client's own document — taking it blocks their real runs —
   * and the charge is 5 credits of theirs. Asked by spying on both, not by
   * reading the source order.
   */
  it("takes no lock and spends nothing when it refuses", async () => {
    as(UNASSIGNED);
    await call();
    expect(data.tryAcquireAiProcessingLock).not.toHaveBeenCalled();
    expect(chargeClientModelCall).not.toHaveBeenCalled();
  });

  it("says nothing about whether the client exists", async () => {
    as(UNASSIGNED);
    const refused = await (await call()).json();
    vi.mocked(data.getClient).mockResolvedValue(null as any);
    as(ADMIN);
    const missing = await (await call()).json();
    expect(refused).toEqual(missing);
  });

  it.each([
    ["an admin", ADMIN],
    ["an assigned employee", ASSIGNED],
    ["the client's own user", OWN_CLIENT_USER],
  ])("still lets %s through to the run", async (_who, user) => {
    as(user);
    await call();
    expect(data.tryAcquireAiProcessingLock).toHaveBeenCalledWith("c1");
  });
});

/* ────────────────────────── assets/bulk-upload ────────────────────────── */

describe("POST /api/assets/bulk-upload", () => {
  async function sign(body: unknown) {
    const { POST } = await import("@/app/api/assets/bulk-upload/route");
    return POST(
      new Request("https://portal.test/api/assets/bulk-upload", {
        method: "POST",
        body: JSON.stringify(body),
      }) as any,
    );
  }

  const SIGN_BODY = {
    step: "sign",
    clientId: "c1",
    filename: "clip.mp4",
    contentType: "video/mp4",
    sizeBytes: 1024,
  };

  it("refuses an unassigned employee", async () => {
    as(UNASSIGNED);
    expect((await sign(SIGN_BODY)).status).toBe(404);
  });

  it("mints no upload URL into a bucket it refused", async () => {
    as(UNASSIGNED);
    await sign(SIGN_BODY);
    expect(createUploadSignedUrl).not.toHaveBeenCalled();
  });

  it.each([
    ["an admin", ADMIN],
    ["an assigned employee", ASSIGNED],
  ])("still signs for %s", async (_who, user) => {
    as(user);
    expect((await sign(SIGN_BODY)).status).toBe(200);
    expect(createUploadSignedUrl).toHaveBeenCalled();
  });
});

/* ───────────────────── auth/social/[provider] (connect) ───────────────────── */

describe("GET /api/auth/social/[provider]", () => {
  async function connect() {
    const { GET } = await import("@/app/api/auth/social/[provider]/route");
    const { NextRequest } = await import("next/server");
    return GET(
      new NextRequest("https://portal.test/api/auth/social/linkedin?clientId=c1"),
      { params: Promise.resolve({ provider: "linkedin" }) },
    );
  }

  it("refuses an unassigned employee", async () => {
    as(UNASSIGNED);
    expect((await connect()).status).toBe(403);
  });

  /**
   * The state token IS the authorization: the callback reads `clientId` out of
   * it and attaches the connected account to that client. A refusal that still
   * minted one would have handed over the whole point of the fence.
   */
  it("mints no state token binding a client it refused", async () => {
    as(UNASSIGNED);
    await connect();
    expect(signOAuthState).not.toHaveBeenCalled();
  });

  it.each([
    ["an admin", ADMIN],
    ["an assigned employee", ASSIGNED],
    ["the client's own user", OWN_CLIENT_USER],
  ])("still starts the connect flow for %s", async (_who, user) => {
    as(user);
    await connect();
    expect(signOAuthState).toHaveBeenCalledWith(
      expect.objectContaining({ clientId: "c1", provider: "linkedin" }),
    );
  });
});

/* ──────────────── integrations/linkedin/employee/auth (seat) ──────────────── */

describe("GET /api/integrations/linkedin/employee/auth", () => {
  async function connectSeat() {
    const { GET } = await import("@/app/api/integrations/linkedin/employee/auth/route");
    const { NextRequest } = await import("next/server");
    return GET(
      new NextRequest(
        "https://portal.test/api/integrations/linkedin/employee/auth?clientId=c1&seatId=seat1",
      ),
    );
  }

  it("refuses an unassigned employee", async () => {
    as(UNASSIGNED);
    expect((await connectSeat()).status).toBe(404);
  });

  it("mints no state token for a seat on a client it refused", async () => {
    as(UNASSIGNED);
    await connectSeat();
    expect(signOAuthState).not.toHaveBeenCalled();
  });

  /** The refusal borrows the missing-seat shape, so it is not an existence oracle. */
  it("answers a refused client exactly as it answers a missing seat", async () => {
    as(UNASSIGNED);
    const refused = await (await connectSeat()).json();
    as(ADMIN);
    vi.mocked(data.listEmployeeSeats).mockResolvedValue([] as any);
    const missing = await (await connectSeat()).json();
    expect(refused).toEqual(missing);
  });

  it.each([
    ["an admin", ADMIN],
    ["an assigned employee", ASSIGNED],
    ["the client's own user", OWN_CLIENT_USER],
  ])("still connects the seat for %s", async (_who, user) => {
    as(user);
    await connectSeat();
    expect(signOAuthState).toHaveBeenCalledWith(
      expect.objectContaining({ clientId: "c1", seatId: "seat1" }),
    );
  });
});

/* ───────────────────── the shared asset-media authorizer ───────────────────── */

/**
 * Both `/api/assets/[id]/download` and `/api/assets/[id]/media` delegate here,
 * so this is where the rule lives and where it is asked. It read
 * `!isStaff(user) && user.clientId !== asset.clientId` — which pinned a client
 * to their own assets and let every staff member reach every client's clips and
 * downloads regardless of assignment.
 */
describe("authorizeAssetMedia", () => {
  const ASSET = { id: "a1", clientId: "c1", status: "approved", createdAt: 0 };

  async function authorize() {
    const { authorizeAssetMedia } = await import("@/lib/asset-media");
    return authorizeAssetMedia("a1");
  }

  beforeEach(() => {
    vi.mocked(data.getAsset).mockResolvedValue(ASSET as any);
  });

  it("refuses an unassigned employee", async () => {
    as(UNASSIGNED);
    const access = await authorize();
    expect(access.ok).toBe(false);
    if (!access.ok) expect(access.response.status).toBe(404);
  });

  it("refuses in the shape a missing asset already used", async () => {
    as(UNASSIGNED);
    const refused = await authorize();
    as(ADMIN);
    vi.mocked(data.getAsset).mockResolvedValue(null as any);
    const missing = await authorize();
    expect(refused.ok).toBe(false);
    expect(missing.ok).toBe(false);
    if (!refused.ok && !missing.ok) {
      expect(refused.response.status).toBe(missing.response.status);
      expect(await refused.response.json()).toEqual(await missing.response.json());
    }
  });

  it.each([
    ["an admin", ADMIN],
    ["an assigned employee", ASSIGNED],
    ["the client's own user", OWN_CLIENT_USER],
  ])("still serves %s", async (_who, user) => {
    as(user);
    expect((await authorize()).ok).toBe(true);
  });

  /** A client user reaching another client's asset — the case that already worked. */
  it("still refuses a client user another client's asset", async () => {
    as({ uid: "u-other", role: "CLIENT_USER", clientId: "c2", createdAt: 0 });
    expect((await authorize()).ok).toBe(false);
  });
});
