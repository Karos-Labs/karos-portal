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
