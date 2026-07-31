/**
 * Does a fetched response carry media, or an error document wearing a media
 * URL? Pure and client-safe so the check can be unit-tested on its own.
 *
 * A dead storage link is the common case: GCS answers an expired V4 signature
 * with `403` and an XML `<Error>` body, and a re-host that landed on a sign-in
 * page returns HTML. Saving either under a `.mp4` or `.jpg` name produces a
 * file that will not open — the download route checks this before it sets any
 * `Content-Disposition: attachment`, and fails with a 502 instead.
 *
 * `application/octet-stream` passes: bucket objects uploaded without a declared
 * content type get it, and those bytes really are the file. A response with no
 * content type at all does not pass — we cannot vouch for bytes nobody typed.
 */
export function isMediaContentType(contentType: string | null, kind: "image" | "video"): boolean {
  const type = (contentType ?? "").split(";")[0].trim().toLowerCase();
  if (!type) return false;
  return type.startsWith(`${kind}/`) || type === "application/octet-stream";
}
