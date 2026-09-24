/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  BRAND_LOGO_ACCEPT,
  BRAND_LOGO_MAX_BYTES,
  checkBrandLogoFile,
  engineBrandLogoUrl,
} from "@/lib/brand-logo-file";

/**
 * The logo upload (owner request 2026-09-24: "add an option in the portal to
 * add logo files"). Three things have to be true for an uploaded logo to be on
 * a post, and each was false in a different way before this:
 *
 *   1. the file is one agent-engine will download — its size cap is
 *      4,000,000 bytes and its whitelist includes WebP; ours was 4 MiB and
 *      refused WebP;
 *   2. the stored https URL reaches `client/brand.json` — the projection read
 *      only `brandingGuidelines.logoUrl`, which nothing in the portal writes
 *      (see context-doc-projection.test.ts);
 *   3. Remove actually removes — `updateClient({ logoUrl: undefined })` is a
 *      no-op under `ignoreUndefinedProperties`.
 */

describe("checkBrandLogoFile — the engine's own rules", () => {
  it("uses agent-engine's exact byte cap, not 4 MiB", () => {
    expect(BRAND_LOGO_MAX_BYTES).toBe(4_000_000);
    expect(checkBrandLogoFile({ name: "logo.png", type: "image/png", size: 4_000_000 })).toEqual({ ok: true, contentType: "image/png" });
    // Between 4,000,000 and 4 MiB: uploaded fine before, then refused by the
    // engine on every slide.
    const over = checkBrandLogoFile({ name: "logo.png", type: "image/png", size: 4_000_001 });
    expect(over).toMatchObject({ ok: false, status: 413 });
    expect(checkBrandLogoFile({ name: "logo.png", type: "image/png", size: 4 * 1024 * 1024 })).toMatchObject({ ok: false, status: 413 });
  });

  it.each([
    ["logo.svg", "image/svg+xml", "image/svg+xml"],
    ["logo.png", "image/png", "image/png"],
    ["logo.jpg", "image/jpeg", "image/jpeg"],
    ["logo.jpg", "image/jpg", "image/jpeg"],
    ["logo.webp", "image/webp", "image/webp"],
  ])("accepts %s (%s) and stores it as %s", (name, type, contentType) => {
    expect(checkBrandLogoFile({ name, type, size: 1200 })).toEqual({ ok: true, contentType });
  });

  it.each([
    ["logo.gif", "image/gif"],
    ["logo.pdf", "application/pdf"],
    ["logo.heic", "image/heic"],
    ["logo.svg", "text/html"],
  ])("refuses %s (%s) with a 415", (name, type) => {
    expect(checkBrandLogoFile({ name, type, size: 1200 })).toMatchObject({ ok: false, status: 415 });
  });

  it("reads the extension when the browser sends no type, instead of calling everything a PNG", () => {
    expect(checkBrandLogoFile({ name: "Mark.SVG", type: "", size: 900 })).toEqual({ ok: true, contentType: "image/svg+xml" });
    expect(checkBrandLogoFile({ name: "mark.webp", type: "", size: 900 })).toEqual({ ok: true, contentType: "image/webp" });
    expect(checkBrandLogoFile({ name: "mark", type: "", size: 900 })).toMatchObject({ ok: false, status: 415 });
    expect(checkBrandLogoFile({ name: "mark.exe", type: "", size: 900 })).toMatchObject({ ok: false, status: 415 });
  });

  it("refuses an empty file", () => {
    expect(checkBrandLogoFile({ name: "logo.png", type: "image/png", size: 0 })).toMatchObject({ ok: false, status: 400 });
  });

  it("offers the picker every accepted type", () => {
    for (const token of ["image/svg+xml", "image/png", "image/jpeg", "image/webp", ".svg", ".webp"]) {
      expect(BRAND_LOGO_ACCEPT.split(",")).toContain(token);
    }
  });
});

describe("engineBrandLogoUrl — the logo brand.json carries", () => {
  it("prefers the portal upload over the guidelines' own field", () => {
    expect(
      engineBrandLogoUrl({ logoUrl: "https://firebasestorage.googleapis.com/v0/b/x/o/new.png?alt=media&token=t", brandingGuidelines: { logoUrl: "https://acme.test/old.svg" } }),
    ).toBe("https://firebasestorage.googleapis.com/v0/b/x/o/new.png?alt=media&token=t");
  });

  it("falls back to the guidelines' field when nothing was uploaded", () => {
    expect(engineBrandLogoUrl({ brandingGuidelines: { logoUrl: "https://acme.test/logo.svg" } })).toBe("https://acme.test/logo.svg");
  });

  it("never hands the engine a URL it refuses to fetch", () => {
    expect(engineBrandLogoUrl({ logoUrl: "gs://bucket/clients/c1/logos/a.png" })).toBeUndefined();
    expect(engineBrandLogoUrl({ logoUrl: "http://acme.test/logo.png" })).toBeUndefined();
    // A bad upload URL does not hide a good guidelines one.
    expect(engineBrandLogoUrl({ logoUrl: "gs://bucket/a.png", brandingGuidelines: { logoUrl: "https://acme.test/logo.svg" } })).toBe("https://acme.test/logo.svg");
    expect(engineBrandLogoUrl({ logoUrl: "   " })).toBeUndefined();
    expect(engineBrandLogoUrl({})).toBeUndefined();
  });
});

/* ─────────────────────────── the route itself ─────────────────────────── */

vi.mock("server-only", () => ({}));
vi.mock("@/lib/data");
vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return { ...actual, getCurrentUser: vi.fn() };
});
vi.mock("@/lib/storage", () => ({ uploadBytes: vi.fn(), deleteObject: vi.fn() }));
vi.mock("@/lib/agent-engine/project-on-save", () => ({ projectClientOnSaveInBackground: vi.fn() }));

import * as data from "@/lib/data";
import { getCurrentUser } from "@/lib/auth";
import { deleteObject, uploadBytes } from "@/lib/storage";
import { projectClientOnSaveInBackground } from "@/lib/agent-engine/project-on-save";

const OWNER = { uid: "u-client", role: "CLIENT_USER", clientId: "c1", createdAt: 0 };
const CLIENT = { id: "c1", name: "Acme", status: "active", createdAt: 0, assignedEmployeeIds: [], logoUrl: "https://cdn.test/old.png", logoStoragePath: "clients/c1/logos/old.png" };
const params = { params: Promise.resolve({ id: "c1" }) };
const NEW_URL = "https://firebasestorage.googleapis.com/v0/b/bkt/o/clients%2Fc1%2Flogos%2Fx-logo.webp?alt=media&token=t";

async function post(file: File) {
  const { POST } = await import("@/app/api/clients/[id]/logo/route");
  const form = new FormData();
  form.set("file", file);
  return POST(new Request("http://t/x", { method: "POST", body: form }), params);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getCurrentUser).mockResolvedValue(OWNER as any);
  vi.mocked(data.getClient).mockResolvedValue(CLIENT as any);
  vi.mocked(data.updateClient).mockResolvedValue(undefined);
  vi.mocked(data.clearClientLogo).mockResolvedValue(undefined);
  vi.mocked(uploadBytes).mockImplementation(async ({ path }) => ({ url: NEW_URL, path }));
  vi.mocked(deleteObject).mockResolvedValue(undefined);
});

describe("POST /api/clients/[id]/logo", () => {
  it("stores a WebP logo and saves its https URL as the client's logoUrl", async () => {
    const res = await post(new File([new Uint8Array(2048)], "logo.webp", { type: "image/webp" }));
    expect(res.status).toBe(200);
    expect(vi.mocked(uploadBytes).mock.calls[0]![0]).toMatchObject({ contentType: "image/webp" });
    expect(data.updateClient).toHaveBeenCalledWith("c1", expect.objectContaining({ logoUrl: NEW_URL }));
    expect(NEW_URL.startsWith("https://")).toBe(true);
  });

  it("re-projects the client so brand.json carries the new logo before the next run", async () => {
    await post(new File([new Uint8Array(2048)], "logo.png", { type: "image/png" }));
    expect(projectClientOnSaveInBackground).toHaveBeenCalledWith("c1", "logo-uploaded");
  });

  it("deletes the previous file only after the new one is stored and recorded", async () => {
    const order: string[] = [];
    vi.mocked(uploadBytes).mockImplementation(async ({ path }) => {
      order.push("upload");
      return { url: NEW_URL, path };
    });
    vi.mocked(data.updateClient).mockImplementation(async () => {
      order.push("record");
    });
    vi.mocked(deleteObject).mockImplementation(async () => {
      order.push("delete-old");
    });
    await post(new File([new Uint8Array(2048)], "logo.png", { type: "image/png" }));
    expect(order).toEqual(["upload", "record", "delete-old"]);
    expect(deleteObject).toHaveBeenCalledWith("clients/c1/logos/old.png");
  });

  it("keeps the previous logo when the upload fails", async () => {
    vi.mocked(uploadBytes).mockRejectedValue(new Error("storage down"));
    await expect(post(new File([new Uint8Array(2048)], "logo.png", { type: "image/png" }))).rejects.toThrow("storage down");
    expect(deleteObject).not.toHaveBeenCalled();
    expect(data.updateClient).not.toHaveBeenCalled();
  });

  it("refuses a file over the engine's 4,000,000-byte cap before storing anything", async () => {
    const res = await post(new File([new Uint8Array(4_000_001)], "logo.png", { type: "image/png" }));
    expect(res.status).toBe(413);
    expect(uploadBytes).not.toHaveBeenCalled();
    expect(data.updateClient).not.toHaveBeenCalled();
    expect(projectClientOnSaveInBackground).not.toHaveBeenCalled();
  });

  it("refuses a type the engine will not draw", async () => {
    const res = await post(new File([new Uint8Array(20)], "logo.gif", { type: "image/gif" }));
    expect(res.status).toBe(415);
    expect(uploadBytes).not.toHaveBeenCalled();
  });
});

describe("DELETE /api/clients/[id]/logo", () => {
  it("clears the field for real and re-projects, so brand.json stops carrying a deleted file", async () => {
    const { DELETE } = await import("@/app/api/clients/[id]/logo/route");
    const res = await DELETE(new Request("http://t/x", { method: "DELETE" }), params);
    expect(res.status).toBe(200);
    expect(deleteObject).toHaveBeenCalledWith("clients/c1/logos/old.png");
    expect(data.clearClientLogo).toHaveBeenCalledWith("c1");
    expect(data.updateClient).not.toHaveBeenCalled();
    expect(projectClientOnSaveInBackground).toHaveBeenCalledWith("c1", "logo-removed");
  });
});
