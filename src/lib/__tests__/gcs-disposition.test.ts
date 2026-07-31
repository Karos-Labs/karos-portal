import { describe, expect, it } from "vitest";

import { dispositionFilename } from "@/lib/gcs-media";

/**
 * The only escaping between a caller-supplied name and the quoted
 * `response-content-disposition` parameter baked into a signed URL. It lives in
 * its own file because the sibling download tests mock `@/lib/gcs-media`
 * wholesale — asserting the sanitizer against that mock would only ever assert
 * the mock's own template, which is how it shipped untested the first time.
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
