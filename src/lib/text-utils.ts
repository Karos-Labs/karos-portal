/**
 * Shared text transformation utilities.
 * No server-only or Firebase dependencies — safe to import from any context.
 */

/**
 * Strips AI model output preamble before storing markdown in Firestore.
 * Handles four patterns in order:
 *   1. Code fences  (```markdown ... ```)
 *   2. YAML frontmatter  (--- … ---)
 *   3. H1 title line  (# Title)
 *   4. Leading instruction blockquotes  (> HOW the brand speaks…)
 *
 * The frontmatter window is capped at 400 chars to avoid treating document-body
 * --- separators (e.g. competitor sections) as frontmatter delimiters.
 */
export function stripPreamble(text: string): string {
  let s = text.trim();

  // 1. Code fence — search beyond position 0 in case model prepends a preamble sentence
  const fenceIdx = s.search(/```[a-zA-Z]*\r?\n/);
  if (fenceIdx !== -1) {
    s = s
      .slice(fenceIdx)
      .replace(/^```[a-zA-Z]*\r?\n/, "")
      .replace(/\r?\n```\s*$/, "")
      .trim();
  }

  // 2. YAML frontmatter — window-limited to avoid matching body --- separators
  const fmSearchWindow = s.slice(0, 400);
  const fmStart = fmSearchWindow.search(/^---\r?\n/m);
  if (fmStart > 0) s = s.slice(fmStart);
  const fmMatch = s.match(/^---\r?\n[\s\S]*?\r?\n---[ \t]*(\r?\n|$)/);
  if (fmMatch) {
    s = s.slice(fmMatch[0].length).trim();
  } else if (s.startsWith("---")) {
    s = s.replace(/^---[ \t]*\r?\n/, "").trim();
  }

  // 3. H1 title line (# Title — not ## which is a section heading)
  s = s.replace(/^#[^#][^\n]*(\r?\n|$)/m, "").trim();

  // 4. Leading instruction blockquotes
  s = s.replace(/^(>\s*[^\n]*(\r?\n|$))+/, "").trim();

  return s;
}

/**
 * Escape HTML special characters for safe embedding in HTML strings.
 * Use for all user-controlled or AI-generated strings embedded in HTML —
 * prevents XSS in email bodies and report HTML.
 * Escapes: & < > "
 */
export function escapeHtml(s: unknown): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
