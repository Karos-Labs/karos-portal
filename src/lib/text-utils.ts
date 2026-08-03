/**
 * Shared text transformation utilities.
 * No server-only or Firebase dependencies — safe to import from any context.
 */

/** True when `line` is a bare `---` fence/rule line (CRLF tolerant). */
function isFenceLine(line: string): boolean {
  return /^---[ \t]*$/.test(line.replace(/\r$/, ""));
}

/**
 * True when the lines between two `---` fences read as YAML frontmatter
 * (`key: value` pairs, list items, indented continuations) rather than document
 * prose.
 *
 * Deliberately strict: a false negative only leaves visible frontmatter in the
 * document, while a false positive deletes every section above a body `---`
 * rule — the 2026-07 fleet corruption. When in doubt, reject.
 */
function looksLikeYamlBlock(lines: string[]): boolean {
  let sawKey = false;
  for (const raw of lines) {
    const line = raw.replace(/\r$/, "");
    if (!line.trim()) continue;
    // Markdown heading / table row / blockquote — document body, not frontmatter.
    if (/^\s*[#|>]/.test(line)) return false;
    if (/^\s*[A-Za-z_][A-Za-z0-9_.-]*\s*:(\s|$)/.test(line)) {
      sawKey = true;
      continue;
    }
    if (/^\s*-(\s|$)/.test(line)) continue; // YAML list item
    if (/^\s{2,}\S/.test(line)) continue; // indented continuation / block scalar
    return false; // bare prose line — not frontmatter
  }
  return sawKey;
}

/**
 * Strips AI model output preamble before storing markdown in Firestore.
 * Handles four patterns in order:
 *   1. Whole-document code fence  (```markdown ... ```)
 *   2. YAML frontmatter  (--- … ---) at the very start of the document
 *   3. H1 title line  (# Title) at the very start of the document
 *   4. Leading instruction blockquotes  (> HOW the brand speaks…)
 *
 * Every step is anchored to the START of the document. Earlier revisions
 * searched the whole string for a fence or a `---` line and sliced to it, which
 * silently deleted every section above the first body code block or horizontal
 * rule. The function must be idempotent: running it on its own output is a
 * no-op, so a retry pass can never strip twice.
 */
export function stripPreamble(text: string): string {
  let s = text.trim();

  // 1. Code fence — only unwrap when the model wrapped the WHOLE document
  //    (optionally after a one-line prose preamble). A fence deeper in the body
  //    is a legitimate code block; slicing to it would delete the sections above.
  const fenceMatch = s.match(/^(?:([^\n]{0,200})(?:\r?\n)+)?```[a-zA-Z]*[ \t]*\r?\n/);
  if (fenceMatch) {
    const preamble = (fenceMatch[1] ?? "").trim();
    // A preamble is only discardable if it is plain prose ("Here is the doc:").
    // Anything starting with markdown structure is content — leave it alone.
    const preambleIsProse = preamble === "" || /^[A-Za-z"'(]/.test(preamble);
    // Proof the fence wraps the document: it closes at the very end. The one
    // exception is a truncated wrapper — a lone opening fence with no partner,
    // where removing the marker line cannot lose anything. A document that
    // merely OPENS with a real code block has a second fence mid-body and is
    // therefore left untouched.
    const hasClosingFence = /\r?\n```[ \t]*$/.test(s);
    const isLoneFence = (s.match(/^```/gm) ?? []).length === 1;
    if (preambleIsProse && (hasClosingFence || (preamble === "" && isLoneFence))) {
      s = s
        .slice(fenceMatch[0].length)
        .replace(/\r?\n```[ \t]*$/, "")
        .trim();
    }
  }

  // 2. YAML frontmatter — ONLY a fence pair at the very start of the document.
  //    A `---` in the body is a horizontal rule, never a closing delimiter.
  if (isFenceLine(s.split("\n", 1)[0] ?? "")) {
    const lines = s.split("\n");
    let close = -1;
    for (let i = 1; i < lines.length; i++) {
      if (isFenceLine(lines[i])) {
        close = i;
        break;
      }
    }
    if (close > 0 && looksLikeYamlBlock(lines.slice(1, close))) {
      s = lines.slice(close + 1).join("\n").trim();
    } else {
      // Leading `---` that is not frontmatter: a bare horizontal rule or an
      // unterminated fence. Drop that single line only — never body content.
      s = lines.slice(1).join("\n").trim();
    }
  }

  // 3. H1 title line, at the very top only (## is a section heading, and an
  //    H1-looking line deeper in the body may be a hashtag such as #BrandTag).
  s = s.replace(/^#[^#\n][^\n]*(?:\r?\n|$)/, "").trim();

  // 4. Leading instruction blockquotes
  s = s.replace(/^(>\s*[^\n]*(\r?\n|$))+/, "").trim();

  return s;
}

/**
 * Model-voice openings seen leaking into stored documents. Each is anchored to
 * the start of a TRAILING paragraph and phrased so it cannot plausibly open a
 * real section of a strategy document.
 */
const META_COMMENTARY_PATTERNS: RegExp[] = [
  /^(?:the|this) document (?:is|has been|was) (?:complete|already|now|fully|unchanged|as written)\b/i,
  /^(?:the|this) (?:condensed|client-facing|final) (?:version|document|output)\b/i,
  /^this version (?:preserves|retains|keeps|maintains|removes|reduces|condenses|is approximately)\b/i,
  /^if you (?:intended|meant|wanted|were expecting|need|require|have|would like|'d like)\b/i,
  /^(?:i|i've|i have|i'll|i will|i'm) (?:condensed|removed|kept|preserved|maintained|retained|noticed|noted|assumed|hope|can|could|should|did not|didn't|do not|don't|am|was|have)\b/i,
  /^let me know (?:if|whether|what|how)\b/i,
  /^(?:would|should|do) you (?:like|prefer|want|need)\b/i,
  /^feel free to\b/i,
  /^no (?:changes|edits|content|sections) (?:were|was|have been|has been)\b/i,
  /^(?:all|every) (?:section|sections|headings?) (?:from|of|in) the (?:original|internal|source)\b/i,
];

/**
 * True when a trailing block is unmistakably the model talking to the operator.
 * Structural markdown (headings, tables, lists, quotes, rules, code) is always
 * treated as document content.
 */
function isMetaCommentaryBlock(block: string): boolean {
  const t = block.trim();
  // Commentary is a short closing note; anything long is document content.
  if (!t || t.length > 600) return false;
  if (/^(?:#{1,6}\s|>|\||```|-{3,}|\*{3,}|_{3,}|[-*+]\s|\d+[.)]\s)/.test(t)) return false;
  // A block that contains a heading or a table row is content regardless of how
  // it opens.
  if (/\n\s*(?:#{1,6}\s|\|)/.test(t)) return false;
  const probe = t
    .replace(/^[*_`"'\s]+/, "") // unwrap *italic* / **bold** / "quoted" notes
    .replace(/^(?:note|nb)\s*[:—–-]\s*/i, "");
  return META_COMMENTARY_PATTERNS.some((re) => re.test(probe));
}

/** Index + length of the last blank-line paragraph separator, or null. */
function lastBlankSeparator(s: string): { index: number; length: number } | null {
  const re = /\r?\n[ \t]*(?:\r?\n[ \t]*)+/g;
  let last: { index: number; length: number } | null = null;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    last = { index: m.index, length: m[0].length };
  }
  return last;
}

/**
 * Removes trailing LLM meta-commentary appended after a generated document
 * ("The document is complete as written…", "If you intended a different
 * template…").
 *
 * Conservative by construction: it only ever removes whole trailing paragraphs
 * that are short, structurally plain, and match a model-voice opening. A
 * legitimate closing section — anything under a heading, in a table, in a list,
 * or simply not matching — is always kept. When unsure, keep.
 */
export function stripTrailingMetaCommentary(text: string): string {
  let s = text.replace(/[ \t\r\n]+$/, "");
  let removedAny = false;

  // Bounded: models append one or two notes, never a dozen.
  for (let i = 0; i < 4; i++) {
    const sep = lastBlankSeparator(s);
    if (!sep) break;
    const block = s.slice(sep.index + sep.length);
    if (!isMetaCommentaryBlock(block)) break;
    s = s.slice(0, sep.index).replace(/[ \t\r\n]+$/, "");
    removedAny = true;
  }

  if (removedAny) {
    // Drop the separator rule the model left dangling above its commentary.
    s = s
      .replace(/(?:\r?\n)[ \t]*(?:-{3,}|\*{3,}|_{3,})[ \t]*$/, "")
      .replace(/[ \t\r\n]+$/, "");
  }

  return s;
}

/** Matches a fenced code block or an inline code span — left untouched by normalizeDashes. */
const CODE_SPAN_OR_FENCE = /(```[\s\S]*?```|`[^`\n]*`)/g;

/**
 * Normalize the double-hyphen / em-dash habit AI output tends toward
 * ("word -- word", "word—word") into a single plain hyphen, so it reads
 * consistently with the rest of the UI's typography.
 *
 * Two rules, applied only OUTSIDE code spans/fences (a spaced `--` is a real
 * separator in shell syntax — e.g. `npm run test -- --watch` — and collapsing
 * it there would break the command, not just its looks):
 *   - An em dash is always replaced (it never appears in real code/CLI flags).
 *   - A double hyphen is replaced ONLY when it stands alone, bounded by
 *     whitespace or the string edges on both sides. That leaves a CLI flag
 *     like `--verbose` (no trailing space) and a markdown horizontal rule
 *     `---` (a third dash immediately follows) untouched.
 *
 * Idempotent — running it twice is a no-op.
 */
export function normalizeDashes(text: string): string {
  if (!text) return text;
  return text
    .split(CODE_SPAN_OR_FENCE)
    .map((segment, i) =>
      i % 2 === 1
        ? segment // odd indices are the captured code spans/fences — untouched
        : segment.replace(/—/g, "-").replace(/(^|\s)--(?!-)(?=\s|$)/g, "$1-"),
    )
    .join("");
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
