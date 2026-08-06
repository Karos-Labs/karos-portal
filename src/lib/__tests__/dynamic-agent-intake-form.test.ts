import { describe, expect, it } from "vitest";
import { validateField, validateFileSize, validateFileType } from "@/components/dynamic-agent-intake-form";
import type { DynamicAgentInputDef } from "@/lib/types";

/**
 * Rule-level coverage for the dynamic client intake form's validation (Phase
 * 4's "submission is blocked with English messages until valid"): required
 * fields, file TYPE against `accept`, file SIZE against `maxSizeMb`.
 *
 * The RENDER is covered separately, per field type, in
 * `dynamic-agent-intake-render.test.tsx` — this repo does have a component
 * render pattern (`renderToStaticMarkup` from react-dom/server, used by ~10
 * existing suites under `environment: "node"`), and an earlier note here
 * claiming it did not was simply wrong.
 */

function field(patch: Partial<DynamicAgentInputDef> = {}): DynamicAgentInputDef {
  return { key: "company_name", type: "text", label: "Company name", required: true, order: 0, ...patch };
}

describe("dynamic-agent-intake-form validateField", () => {
  it("blocks a required text field left empty", () => {
    expect(validateField(field(), "")).toMatch(/required/i);
    expect(validateField(field(), null)).toMatch(/required/i);
  });

  it("allows a required text field with a value", () => {
    expect(validateField(field(), "Acme Inc")).toBeNull();
  });

  it("allows an optional field left empty", () => {
    expect(validateField(field({ required: false }), null)).toBeNull();
  });

  it("blocks a required select field with no choice made", () => {
    expect(validateField(field({ type: "select", options: ["a", "b"] }), "")).toMatch(/required/i);
  });

  it("blocks a required file field with no upload", () => {
    expect(validateField(field({ type: "file", key: "brief_doc", label: "Brief" }), null)).toMatch(/required/i);
  });

  it("allows a required file field once a file reference is present", () => {
    const ref = { id: "ctx1", url: "https://example.com/f.pdf", name: "brief.pdf" };
    expect(validateField(field({ type: "file" }), ref)).toBeNull();
  });

  it("blocks a required multi-file field left with an empty array", () => {
    expect(validateField(field({ type: "file" }), [])).toMatch(/required/i);
  });

  it("uses the field's own label in the message, falling back to the key", () => {
    expect(validateField(field({ label: "" }), null)).toContain("company_name");
    expect(validateField(field({ label: "Company name" }), null)).toContain("Company name");
  });
});

describe("validateFileType — accept matching", () => {
  it("allows anything when the admin set no accept", () => {
    expect(validateFileType(field({ type: "file" }), { name: "x.exe", type: "application/x-msdownload" })).toBeNull();
  });

  it("matches an extension token case-insensitively", () => {
    const f = field({ type: "file", accept: ".pdf" });
    expect(validateFileType(f, { name: "brief.pdf", type: "application/pdf" })).toBeNull();
    expect(validateFileType(f, { name: "BRIEF.PDF", type: "" })).toBeNull();
    expect(validateFileType(f, { name: "brief.docx", type: "" })).toMatch(/not an accepted file type/i);
  });

  it("matches a wildcard MIME type", () => {
    const f = field({ type: "image", accept: "image/*" });
    expect(validateFileType(f, { name: "a.png", type: "image/png" })).toBeNull();
    expect(validateFileType(f, { name: "a.jpg", type: "IMAGE/JPEG" })).toBeNull();
    expect(validateFileType(f, { name: "a.pdf", type: "application/pdf" })).toMatch(/not an accepted/i);
  });

  it("matches an exact MIME type and rejects a near miss", () => {
    const f = field({ type: "file", accept: "application/pdf" });
    expect(validateFileType(f, { name: "a.pdf", type: "application/pdf" })).toBeNull();
    expect(validateFileType(f, { name: "a.pdf", type: "application/pdfx" })).toMatch(/not an accepted/i);
  });

  it("accepts a file matching ANY token in a comma-separated list", () => {
    const f = field({ type: "file", accept: ".pdf, .docx, image/*" });
    expect(validateFileType(f, { name: "a.docx", type: "" })).toBeNull();
    expect(validateFileType(f, { name: "a.png", type: "image/png" })).toBeNull();
    expect(validateFileType(f, { name: "a.zip", type: "application/zip" })).toMatch(/not an accepted/i);
  });

  it("names the field and lists what IS accepted, in English", () => {
    const message = validateFileType(
      field({ type: "image", label: "Brand logo", accept: "image/*" }),
      { name: "virus.exe", type: "application/x-msdownload" },
    );
    expect(message).toContain("Brand logo");
    expect(message).toContain("virus.exe");
    expect(message).toContain("image/*");
  });

  it("does not let an extension token be satisfied by a mid-name coincidence", () => {
    const f = field({ type: "file", accept: ".pdf" });
    expect(validateFileType(f, { name: "notes.pdf.exe", type: "" })).toMatch(/not an accepted/i);
  });
});

describe("validateFileSize — maxSizeMb", () => {
  it("allows a file at exactly the limit and blocks one over it", () => {
    const f = field({ type: "file", maxSizeMb: 1 });
    expect(validateFileSize(f, { name: "ok.bin", size: 1024 * 1024 })).toBeNull();
    expect(validateFileSize(f, { name: "big.bin", size: 1024 * 1024 + 1 })).toMatch(/larger than 1 MB/);
  });

  it("falls back to the shared default when the admin set no maxSizeMb", () => {
    const f = field({ type: "file" });
    expect(validateFileSize(f, { name: "ok.bin", size: 19 * 1024 * 1024 })).toBeNull();
    expect(validateFileSize(f, { name: "big.bin", size: 21 * 1024 * 1024 })).toMatch(/larger than 20 MB/);
  });
});
