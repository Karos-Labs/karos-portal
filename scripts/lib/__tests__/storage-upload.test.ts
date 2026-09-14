import { afterEach, describe, expect, it, vi } from "vitest";

import { uploadIfAbsent } from "../storage-upload";

/**
 * scripts/import-lab-client.ts uploaded with an unconditional multipart POST:
 * no ifGenerationMatch, and a fresh download token every time. Prep and
 * production share one bucket and its paths are not unique to a database (the
 * logo is keyed by slug), so a client's first import into the second database
 * replaced the object the first database's client record points at. That
 * record's URL still carries the old token, and Firebase Storage answers it
 * with "Permission denied" from then on. uploadIfAbsent is the script-side port
 * of src/lib/storage.ts's `ifAbsent`.
 *
 * The fake bucket keeps GCS's rules for the two calls uploadIfAbsent makes: a
 * POST with ifGenerationMatch=0 gets 412 when an object exists, and any other
 * POST replaces the object with a new generation and the token it carries. A
 * download URL resolves only while its token is one the live object carries,
 * which is the check Firebase Storage makes.
 */

const BUCKET = "fixture-bucket.firebasestorage.app";
const LOGO_PATH = "client-logos/lab-geektime/geektime-profile-disc.png";
const logo = {
  bytes: Buffer.from("profile disc"),
  path: LOGO_PATH,
  contentType: "image/png",
  bucket: BUCKET,
  accessToken: "fixture-access-token",
};
const logoUrlWith = (token: string) =>
  `https://firebasestorage.googleapis.com/v0/b/${BUCKET}/o/${encodeURIComponent(LOGO_PATH)}?alt=media&token=${token}`;

interface StoredObject {
  generation: number;
  /** firebaseStorageDownloadTokens, comma-separated; absent = the object carries none. */
  token?: string;
}

/** The JSON metadata part of a multipart upload body. */
function uploadedMetadata(body: unknown): { name: string; metadata: { firebaseStorageDownloadTokens: string } } {
  const json = Buffer.from(body as Uint8Array)
    .toString("utf8")
    .match(/charset=UTF-8\r\n\r\n(.*?)\r\n/)?.[1];
  if (!json) throw new Error("upload body has no metadata part");
  return JSON.parse(json);
}

function fakeBucket(seed: Record<string, StoredObject> = {}) {
  const objects = new Map(Object.entries(seed));
  let lastGeneration = Math.max(0, ...[...objects.values()].map((o) => o.generation));
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    if (init?.method === "POST") {
      const { name, metadata } = uploadedMetadata(init.body);
      if (url.searchParams.get("ifGenerationMatch") === "0" && objects.has(name)) {
        return new Response("conditionNotMet", { status: 412 });
      }
      objects.set(name, { generation: ++lastGeneration, token: metadata.firebaseStorageDownloadTokens });
      return Response.json({ name, generation: String(lastGeneration) });
    }
    const name = url.pathname.match(/^\/storage\/v1\/b\/[^/]+\/o\/([^/]+)$/)?.[1];
    const object = name ? objects.get(decodeURIComponent(name)) : undefined;
    if (!object) return new Response("No such object", { status: 404 });
    return Response.json({
      metadata: object.token === undefined ? {} : { firebaseStorageDownloadTokens: object.token },
    });
  });
  return {
    fetchMock,
    objects,
    /** Whether Firebase Storage would serve this download URL. */
    resolves(downloadUrl: string): boolean {
      const url = new URL(downloadUrl);
      const tokens = objects.get(decodeURIComponent(url.pathname.split("/o/")[1] ?? ""))?.token?.split(",") ?? [];
      return tokens.includes(url.searchParams.get("token") ?? "");
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("uploadIfAbsent: the second database's import never kills the first database's URL", () => {
  it("hands the second import the object the first one put there, and the first URL stays live", async () => {
    const bucket = fakeBucket();
    vi.stubGlobal("fetch", bucket.fetchMock);

    const production = await uploadIfAbsent(logo); // the first import, e.g. Geektime into production
    const prep = await uploadIfAbsent(logo); // the same client's first import into prep

    expect(bucket.resolves(production.url)).toBe(true);
    expect(prep.url).toBe(production.url);
    expect([production.reused, prep.reused]).toEqual([false, true]);
    expect(bucket.objects.get(LOGO_PATH)?.generation).toBe(1);
  });

  it("keeps the object even when the file being imported now differs from it", async () => {
    // The trade-off, decided: the other record may point at these bytes, so a
    // changed lab file does not replace them.
    const bucket = fakeBucket();
    vi.stubGlobal("fetch", bucket.fetchMock);

    const first = await uploadIfAbsent(logo);
    const second = await uploadIfAbsent({ ...logo, bytes: Buffer.from("profile disc, redrawn") });

    expect(second).toEqual({ url: first.url, path: LOGO_PATH, reused: true });
    expect(bucket.resolves(first.url)).toBe(true);
    expect(bucket.objects.get(LOGO_PATH)?.generation).toBe(1);
  });
});

describe("uploadIfAbsent: the requests", () => {
  it("asks GCS to write only if nothing is at the path, and returns the token it wrote", async () => {
    const bucket = fakeBucket();
    vi.stubGlobal("fetch", bucket.fetchMock);

    const uploaded = await uploadIfAbsent(logo);

    expect(bucket.fetchMock).toHaveBeenCalledTimes(1);
    const [input, init] = bucket.fetchMock.mock.calls[0]!;
    const url = new URL(String(input));
    expect(`${url.origin}${url.pathname}`).toBe(`https://storage.googleapis.com/upload/storage/v1/b/${BUCKET}/o`);
    expect(url.searchParams.get("uploadType")).toBe("multipart");
    expect(url.searchParams.get("ifGenerationMatch")).toBe("0");
    expect(init?.method).toBe("POST");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer fixture-access-token");

    const written = uploadedMetadata(init?.body).metadata.firebaseStorageDownloadTokens;
    expect(uploaded).toEqual({ url: logoUrlWith(written), path: LOGO_PATH, reused: false });
    expect(bucket.resolves(uploaded.url)).toBe(true);
  });

  it("after a 412, reads back the existing object's own first token and writes nothing", async () => {
    const bucket = fakeBucket({ [LOGO_PATH]: { generation: 7, token: "live-token,older-token" } });
    vi.stubGlobal("fetch", bucket.fetchMock);

    const uploaded = await uploadIfAbsent(logo);

    expect(uploaded).toEqual({ url: logoUrlWith("live-token"), path: LOGO_PATH, reused: true });
    expect(bucket.fetchMock).toHaveBeenCalledTimes(2);
    const [readBackUrl, readBackInit] = bucket.fetchMock.mock.calls[1]!;
    expect(String(readBackUrl)).toBe(
      `https://storage.googleapis.com/storage/v1/b/${BUCKET}/o/${encodeURIComponent(LOGO_PATH)}`,
    );
    expect(readBackInit?.method).toBeUndefined(); // a GET
    expect(bucket.objects.get(LOGO_PATH)).toEqual({ generation: 7, token: "live-token,older-token" });
  });
});

describe("uploadIfAbsent: it fails closed", () => {
  it("refuses an existing object that carries no download token rather than minting one onto it", async () => {
    const bucket = fakeBucket({ [LOGO_PATH]: { generation: 1 } });
    vi.stubGlobal("fetch", bucket.fetchMock);

    await expect(uploadIfAbsent(logo)).rejects.toThrow(
      `Storage object "${LOGO_PATH}" already exists but carries no download token.`,
    );
    expect(bucket.objects.get(LOGO_PATH)).toEqual({ generation: 1 });
  });

  it("throws when the existing object cannot be read back", async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) =>
      init?.method === "POST"
        ? new Response("conditionNotMet", { status: 412 })
        : new Response("Forbidden", { status: 403 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(uploadIfAbsent(logo)).rejects.toThrow(
      /reported as already existing \(412\) but could not be read back: 403 Forbidden/,
    );
  });

  it("throws on any other failed upload, without reading anything back", async () => {
    const fetchMock = vi.fn(async () => new Response("The specified bucket does not exist.", { status: 404 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(uploadIfAbsent(logo)).rejects.toThrow(
      "Storage upload failed (404): The specified bucket does not exist.",
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
