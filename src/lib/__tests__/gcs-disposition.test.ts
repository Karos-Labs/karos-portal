import { describe, expect, it } from "vitest";

import { dispositionFilename } from "@/lib/media-type";

/**
 * The only escaping between a caller-supplied name and the quoted
 * `response-content-disposition` parameter baked into a signed URL. It lives in
 * the pure media-type module, not beside the signer: `gcs-media` imports
 * `server-only`, so a test cannot load it, and the sibling download tests mock
 * that module wholesale — asserting the sanitizer there would only ever assert
 * the mock's own template, which is exactly how it shipped untested.
 */
describe("dispositionFilename escapes what reaches the signed URL", () => {
  it("strips the characters that would break out of the quoted parameter", () => {
    expect(dispositionFilename('cut".mp4')).not.toContain('"');
    expect(dispositionFilename("a;b.mp4")).not.toContain(";");
    expect(dispositionFilename("a\r\nb.mp4")).not.toMatch(/[\r\n]/);
  });

  it("keeps ordinary names readable", () => {
    expect(dispositionFilename("podcast-cut-3.mp4")).toBe("podcast-cut-3.mp4");
  });

  it("caps the length and never returns an empty name", () => {
    expect(dispositionFilename(`${"x".repeat(400)}.mp4`).length).toBeLessThanOrEqual(120);
    expect(dispositionFilename("///")).toBe("download");
    expect(dispositionFilename("")).toBe("download");
  });
});
