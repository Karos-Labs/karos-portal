/**
 * Is a fetched response the media, or an error document wearing a media URL?
 * Pure and client-safe so the check can be unit-tested on its own.
 *
 * Two different questions, deliberately not one:
 *
 *  • Clips use an ALLOWLIST (`isVideoContentType`). That is the path with
 *    measured evidence — an expired V4 signature answers `403` with
 *    `content-type: application/xml` and an `<Error>` body — and it is also the
 *    newest path, with no existing data behind it to break.
 *
 *  • Photos use a DENYLIST (`isErrorDocumentContentType`). Photos have years of
 *    existing objects behind them, served from Firebase Storage, GCS and
 *    agent-service alike. An allowlist there would reject two shapes that are
 *    common and legitimate: `binary/octet-stream`, the legacy GCS XML-API
 *    default on older objects, and a 200 carrying no `Content-Type` header at
 *    all. Rejecting either would delete a working photo download — and inside a
 *    zip it would do it silently. Only the error-document types are refused;
 *    anything else, including no header, is treated as the file.
 */

/** Normalized essence of a Content-Type header: lowercased, parameters dropped. */
function essence(contentType: string | null): string {
  return (contentType ?? "").split(";")[0].trim().toLowerCase();
}

/**
 * The content types a storage host uses for an error document rather than a
 * file: GCS's XML `<Error>` body, a sign-in page or 404 page, a JSON error
 * envelope. Saving one of these under a `.jpg` or `.mp4` name is the file that
 * will not open.
 */
const ERROR_DOCUMENT_TYPES = new Set([
  "application/xml",
  "text/xml",
  "text/html",
  "application/json",
]);

/**
 * Denylist for the photo paths — true only when the bytes are positively an
 * error document. A missing or unrecognised content type is NOT an error
 * document: a missing header must never remove a photo from a zip.
 */
export function isErrorDocumentContentType(contentType: string | null): boolean {
  return ERROR_DOCUMENT_TYPES.has(essence(contentType));
}

/**
 * Allowlist for the clip path. `application/octet-stream` and its legacy
 * spelling `binary/octet-stream` pass: bucket objects uploaded without a
 * declared content type get one of those, and those bytes really are the file.
 * A response with no content type at all does not pass here — the only clips
 * that still stream through this server are the ones we could not re-sign, and
 * on that narrow path we can afford to insist.
 */
export function isVideoContentType(contentType: string | null): boolean {
  const type = essence(contentType);
  if (!type) return false;
  return (
    type.startsWith("video/") ||
    type === "application/octet-stream" ||
    type === "binary/octet-stream"
  );
}

/**
 * The only escaping between a caller-supplied name and the quoted
 * `response-content-disposition` parameter inside a signed URL. Exported so it
 * is asserted by CALLING it on adversarial input rather than by trusting the
 * shape of a mock.
 */
export function dispositionFilename(filename: string): string {
  const cleaned = filename.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return cleaned.slice(0, 120) || "download";
}

/**
 * Why a storage host refused a request, in short human text.
 *
 * ── WHY THIS EXISTS AT ALL ───────────────────────────────────────────────
 *
 * The staff media dropzone (`components/media-upload.tsx`) PUTs bytes from the
 * browser STRAIGHT to GCS through a signed URL. Nothing about that request or
 * its refusal passes through this server: the `sign` call that minted the URL
 * logs a clean 200, and Cloud Run never sees the PUT. The browser holding the
 * response is the only witness there will ever be, so discarding it — which
 * the dropzone did, throwing a bare "Upload to storage failed for X" — is not
 * a terse message, it is the destruction of the only evidence.
 *
 * That cost five days. From 2026-09-02 (revision karos-cmo-00159) every upload
 * failed `403 AccessDenied`: SCRUM-371/373 moved this service onto a dedicated
 * runtime SA signing via ADC, and the bucket binding that switch required
 * (docs/gcs-media-setup.md §3) was never applied — so URLs were signed by a
 * principal with no write access. Signing worked; the PUT could not. The
 * status code alone would have named it in one look.
 *
 * ── SHAPE ────────────────────────────────────────────────────────────────
 *
 * GCS answers with the XML `<Error>` document `ERROR_DOCUMENT_TYPES` above
 * already knows about, carrying `<Code>`, `<Message>` and often `<Details>`.
 * Read with a regex rather than DOMParser: this runs inside an error path, the
 * document is small and machine-generated, and a truncated or empty body has
 * to degrade to the bare status instead of throwing a second error over the
 * first one.
 *
 * `<Details>` IS INCLUDED, and it is the field worth having. On the refusal
 * above, `<Message>` is the useless "Access denied." while `<Details>` reads
 * "karos-cmo-sa@… does not have storage.objects.create access to the Google
 * Cloud Storage object" — the principal and the exact missing permission, i.e.
 * the whole diagnosis. Dropping it would have left a message that says a
 * refusal happened without saying who was refused what.
 *
 * EVERY PART IS OPTIONAL and the status is the floor. A reason is best effort —
 * an opaque body, a proxy's HTML, no body at all — but a caller that asked why
 * must never come away with nothing.
 */
export function storageRefusalReason(opts: {
  status: number;
  statusText?: string;
  body?: string;
}): string {
  const body = opts.body ?? "";
  const tag = (name: string) =>
    new RegExp(`<${name}>([^<]*)</${name}>`).exec(body)?.[1]?.trim();
  // `filter(Boolean)` is load-bearing, not tidiness: `[^<]*` matches a
  // well-formed but EMPTY `<Code></Code>`, and joining that blind produces the
  // string "403  —  — " — a reason that reads as a bug in this function rather
  // than as an answer about the upload.
  const named = [tag("Code"), tag("Message"), tag("Details")].filter(Boolean).join(" — ");
  // Bounded: this lands in React state and in a title attribute, and a
  // pathological or non-XML body (an HTML sign-in page from a proxy, say) has
  // no length limit of its own. Ordered code-first so that when a long
  // `<Details>` is what gets cut, the part that identifies the failure is the
  // part that survives.
  if (named) return `${opts.status} ${named}`.slice(0, 300);
  const statusText = opts.statusText?.trim();
  return statusText ? `${opts.status} ${statusText}` : `${opts.status}`;
}
