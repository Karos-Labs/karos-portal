/**
 * A stable short fingerprint of a parsed bundle, so the Ops Import page can
 * tell "you already imported this" from "you imported this, and the file has
 * changed since".
 *
 * Deliberately NOT a cryptographic hash. Nothing here is a security boundary —
 * the question is only whether an operator's file moved between two imports,
 * and both sides of that comparison are files we already trust enough to read.
 * FNV-1a over canonical JSON keeps this module pure, dependency-free and
 * testable anywhere, which `node:crypto` would not.
 *
 * Fingerprinting the PARSED value rather than the raw text is the point:
 * reformatting a proposal, or re-exporting it with different indentation, is
 * not a change to what it would write. Key order is preserved by JSON.parse,
 * so a genuine edit still moves the fingerprint.
 */

/** FNV-1a, 32-bit, rendered as 8 lowercase hex chars. */
function fnv1a(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    // The FNV prime (16777619) via shifts — plain multiplication overflows the
    // 32-bit range JS bitwise ops assume.
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/**
 * Canonical JSON: object keys sorted at every level, so two files that differ
 * only in key order fingerprint the same. Arrays keep their order — in a
 * proposal, order is meaning (dominanceRank follows array position).
 */
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
}

/** Short, stable identity for a parsed bundle. */
export function bundleFingerprint(parsed: unknown): string {
  return fnv1a(canonical(parsed));
}
