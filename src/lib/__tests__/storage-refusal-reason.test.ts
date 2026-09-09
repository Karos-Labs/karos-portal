import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { storageRefusalReason } from "@/lib/media-type";

/**
 * The staff media dropzone PUTs bytes from the browser straight to GCS. That
 * request never touches this server, so the response the browser holds is the
 * only record of a refusal that will ever exist — and the dropzone used to
 * throw it away, reporting a bare "Upload to storage failed for 01.png".
 *
 * Which is how a missing IAM grant went undiagnosed for five days: from
 * 2026-09-02, SCRUM-371/373 moved this service onto a dedicated runtime SA
 * signing via ADC, and the bucket binding in docs/gcs-media-setup.md §3 was
 * never applied. Every URL was signed by a principal with no write access —
 * `sign` returned a clean 200, the PUT was refused 403, and nothing anywhere
 * said why.
 *
 * The bodies below are the real GCS XML documents, not invented shapes.
 */
describe("storageRefusalReason names why storage refused", () => {
  /** Verbatim shape of the document GCS returned for the SCRUM-373 regression. */
  const ACCESS_DENIED = `<?xml version='1.0' encoding='UTF-8'?><Error><Code>AccessDenied</Code><Message>Access denied.</Message><Details>karos-cmo-sa@karoscmo.iam.gserviceaccount.com does not have storage.objects.create access to the Google Cloud Storage object.</Details></Error>`;

  it("names the code and message that would have identified the missing grant", () => {
    const reason = storageRefusalReason({ status: 403, statusText: "Forbidden", body: ACCESS_DENIED });
    expect(reason).toContain("403");
    expect(reason).toContain("AccessDenied");
    // The whole point: a reader can tell this from an expired URL or a bad
    // content type without reading any logs, because there are none to read.
    // `<Details>`, not just `<Message>`: "Access denied." alone says a refusal
    // happened without saying who was refused what. This names the principal
    // and the permission, which IS the fix.
    expect(reason).toContain("karos-cmo-sa@karoscmo.iam.gserviceaccount.com");
    expect(reason).toContain("storage.objects.create");
  });

  it("distinguishes an expired signature from a permission refusal", () => {
    const expired = `<?xml version='1.0' encoding='UTF-8'?><Error><Code>ExpiredToken</Code><Message>The provided token has expired.</Message></Error>`;
    expect(storageRefusalReason({ status: 400, body: expired })).toBe(
      "400 ExpiredToken — The provided token has expired.",
    );
    // Two failures the old message rendered identically. They have different
    // fixes — an IAM binding versus a slow upload outliving a 15-minute URL —
    // so rendering them the same is what made the dropzone undebuggable.
    expect(storageRefusalReason({ status: 400, body: expired })).not.toBe(
      storageRefusalReason({ status: 403, statusText: "Forbidden", body: ACCESS_DENIED }),
    );
  });

  it("names a signature mismatch, the third failure with its own fix", () => {
    const mismatch = `<?xml version='1.0' encoding='UTF-8'?><Error><Code>SignatureDoesNotMatch</Code><Message>Access denied.</Message></Error>`;
    expect(storageRefusalReason({ status: 403, body: mismatch })).toContain("SignatureDoesNotMatch");
  });

  /* ── the floor: a caller that asked why never comes away with nothing ──── */

  it("falls back to the status text when there is no XML at all", () => {
    // A proxy's HTML page, or a CORS-stripped opaque body.
    expect(
      storageRefusalReason({ status: 502, statusText: "Bad Gateway", body: "<html>nope</html>" }),
    ).toBe("502 Bad Gateway");
  });

  it("still answers with the status when the body and status text are both gone", () => {
    // `.text()` rejecting on a torn connection is the caller's empty string.
    expect(storageRefusalReason({ status: 403, body: "" })).toBe("403");
    expect(storageRefusalReason({ status: 403 })).toBe("403");
    expect(storageRefusalReason({ status: 403, statusText: "   ", body: "" })).toBe("403");
  });

  it("does not report an empty reason for a well-formed but empty tag", () => {
    // `[^<]*` matches a well-formed but empty `<Code></Code>`. Joining the
    // parts blind — i.e. without `filter(Boolean)` — yields "403  —  — ",
    // which reads as a bug in the parser rather than an answer about the
    // upload. This is the assertion that pins that filter.
    expect(storageRefusalReason({ status: 403, statusText: "Forbidden", body: "<Error><Code></Code></Error>" })).toBe(
      "403 Forbidden",
    );
    expect(storageRefusalReason({ status: 403, body: "<Error><Code>  </Code></Error>" })).toBe("403");
  });

  it("uses whichever half is present when only one tag is there", () => {
    expect(storageRefusalReason({ status: 403, body: "<Error><Code>AccessDenied</Code></Error>" })).toBe(
      "403 AccessDenied",
    );
    expect(storageRefusalReason({ status: 429, body: "<Error><Message>Rate limited.</Message></Error>" })).toBe(
      "429 Rate limited.",
    );
  });

  it("bounds a pathological body, which lands in React state and a title attribute", () => {
    const huge = `<Error><Code>AccessDenied</Code><Message>${"x".repeat(5000)}</Message></Error>`;
    const reason = storageRefusalReason({ status: 403, body: huge });
    expect(reason.length).toBeLessThanOrEqual(300);
    // Truncated, but the code — the part that identifies the failure — survives
    // because it is joined first.
    expect(reason).toContain("AccessDenied");
  });
});

/**
 * The dropzone must actually USE it. The parser being right is half the fix;
 * the defect was the component discarding the response, and a component that
 * goes back to `throw new Error("Upload to storage failed")` would pass every
 * assertion above while restoring the original bug.
 */
describe("the dropzone keeps the reason instead of discarding it", () => {
  const component = readFileSync(join(process.cwd(), "src/components/media-upload.tsx"), "utf8");

  it("reports the refusal reason on a failed PUT", () => {
    expect(component).toMatch(/storageRefusalReason/);
    expect(component).toMatch(/putFailureReason\(putRes\)/);
    expect(
      component,
      "the PUT's response is discarded again — see storageRefusalReason's comment",
    ).not.toMatch(/if \(!putRes\.ok\) throw new Error\(`Upload to storage failed/);
  });

  it("reads the body before throwing, or there is nothing to report", () => {
    expect(component).toMatch(/await res\.text\(\)\.catch\(\(\) => ""\)/);
  });
});
