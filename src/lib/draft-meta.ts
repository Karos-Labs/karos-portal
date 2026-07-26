/**
 * The meta bullets under a draft ("Source: …", "In reply to: …") are written
 * the same way in the X and LinkedIn deliverables, so both readers share this.
 * Pure and client-safe: a reader component cannot be imported by a test (its
 * server-action import pulls in the Admin SDK), so the logic lives here.
 */

/** One run of a meta bullet: plain words, or a URL to link. */
export interface MetaSegment {
  text: string;
  /** Set when the run is a link. */
  href?: string;
}

/**
 * Meta bullets carry bare URLs (sources, reply and quote targets). Split a
 * bullet into runs so a reader can link them without losing the words around
 * them.
 */
export function splitMetaLinks(meta: string): MetaSegment[] {
  const segments: MetaSegment[] = [];
  const urls = /https?:\/\/[^\s<>()[\]"']+/g;
  let cursor = 0;
  for (let m = urls.exec(meta); m; m = urls.exec(meta)) {
    if (m.index > cursor) segments.push({ text: meta.slice(cursor, m.index) });
    // Sentence punctuation after a URL belongs to the words, not the link.
    const url = m[0].replace(/[.,;:!?—–]+$/, "");
    segments.push({ text: url, href: url });
    cursor = m.index + url.length;
  }
  if (cursor < meta.length) segments.push({ text: meta.slice(cursor) });
  return segments;
}
