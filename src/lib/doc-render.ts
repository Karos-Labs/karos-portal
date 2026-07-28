/** Client-safe Markdown → styled HTML helpers for rendering client context docs. */

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export interface DocSection {
  heading: string;
  body: string;
}

const PLACEHOLDER_RE =
  /\b(n\/a|unknown|not\s+provided|not\s+applicable|data\s+unavailable|tbd)\b/gi;

/**
 * Strip a leading YAML frontmatter block (module/client/version/status/etc.) and
 * the H1 title. Tolerant of leading whitespace / BOM so the block never leaks
 * into the rendered document.
 */
export function stripDocPreamble(content: string): string {
  return content
    .replace(/^﻿/, "")
    .replace(/^\s*---[\s\S]*?\n---[ \t]*\r?\n?/, "")
    .replace(/^\s*#\s+.+\r?\n?/, "")
    .trim();
}

/**
 * Does this text carry Markdown structure worth rendering?
 *
 * Guard for surfaces that show arbitrary agent output (asset content) where
 * most items are plain captions: a caption must keep its exact line breaks and
 * must not be reflowed, but a structured deliverable must never reach a client
 * with its hash marks, pipes and asterisks on screen. Deliberately narrow —
 * block-level marks plus `**bold**`, tables and inline code. Single-asterisk
 * emphasis is NOT a signal (captions use `*` as a literal character far more
 * often than as markup).
 */
export function looksLikeMarkdown(text: string | null | undefined): boolean {
  if (!text) return false;
  return (
    /^#{1,6}\s+\S/m.test(text) || // headings
    /^[-*+]\s+\S/m.test(text) || // bullet list
    /^\d+\.\s+\S[\s\S]*?^\d+\.\s+\S/m.test(text) || // ordered list (2+ items: a
    // lone "2026. What a year" opening a caption is not a list)
    /^>\s+\S/m.test(text) || // blockquote
    /^\|.*\|\s*$/m.test(text) || // table row
    /^---+\s*$/m.test(text) || // horizontal rule / frontmatter fence
    /\*\*[^\n*]+\*\*/.test(text) || // bold
    /`[^\n`]+`/.test(text) // inline code
  );
}

/** Split a context doc into `## heading` sections, dropping empty/placeholder ones. */
export function parseDocSections(content: string): DocSection[] {
  const clean = stripDocPreamble(content);

  const parts = clean.split(/^##\s+/m);
  const sections: DocSection[] = [];

  for (const part of parts) {
    if (!part.trim()) continue;
    const nl = part.indexOf("\n");
    const heading = nl > 0 ? part.slice(0, nl).trim() : part.trim();
    const body = nl > 0 ? part.slice(nl + 1).trim() : "";
    const stripped = body.replace(PLACEHOLDER_RE, "").replace(/[|\-\s]/g, "").trim();
    if (!stripped || stripped.length < 8) continue;
    sections.push({ heading, body });
  }
  return sections;
}

/** Render a single section body (no `##` headings expected inside) to HTML. */
export function renderSectionBody(md: string): string {
  // HTML-escape the raw Markdown before processing so any user-supplied < > & "
  // in the source text cannot break out into the surrounding HTML structure.
  let out = esc(md).replace(/^---+$/gm, "");

  out = out.replace(
    /^###\s+(.+)$/gm,
    '<p class="mt-4 mb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-2">$1</p>',
  );

  out = out
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*(.+?)\*/g, "<em>$1</em>")
    .replace(
      /`(.+?)`/g,
      '<code class="rounded bg-surface-3 px-1 py-0.5 font-mono text-[10px]">$1</code>',
    );

  const tableBlockRe = /((?:^\|.+\|\n?){2,})/gm;
  out = out.replace(tableBlockRe, (block) => {
    const rawLines = block.trim().split("\n").map((l) => l.trim()).filter(Boolean);
    const sepIdx = rawLines.findIndex((l) => /^\|[-:\s|]+\|$/.test(l));
    const parseCells = (row: string, tag: "th" | "td") => {
      const cells = row.split("|").slice(1, -1).map((c) => c.replace(/\*\*/g, "").trim());
      const cls =
        tag === "th"
          ? "px-3 py-2 text-left text-[10px] font-semibold uppercase tracking-wider text-muted-2 border-b border-border"
          : "px-3 py-2 text-xs text-muted align-top border-b border-border last:border-0";
      return cells.map((c) => `<${tag} class="${cls}">${c}</${tag}>`).join("");
    };
    let thead = "";
    let tbody = "";
    if (sepIdx > 0) {
      thead = `<thead class="bg-surface-3">${rawLines.slice(0, sepIdx).map((r) => `<tr>${parseCells(r, "th")}</tr>`).join("")}</thead>`;
      tbody = `<tbody>${rawLines.slice(sepIdx + 1).map((r) => `<tr class="hover:bg-surface-2/50">${parseCells(r, "td")}</tr>`).join("")}</tbody>`;
    } else {
      tbody = `<tbody>${rawLines.filter((r) => !/^\|[-:\s|]+\|$/.test(r)).map((r) => `<tr class="hover:bg-surface-2/50">${parseCells(r, "td")}</tr>`).join("")}</tbody>`;
    }
    return `<div class="overflow-x-auto my-3 rounded-[8px] border border-border"><table class="w-full border-collapse">${thead}${tbody}</table></div>\n`;
  });

  // Bullet lists — sentinel bytes \x02/\x03 keep these items isolated from the ordered-list
  // pass below. Without sentinels the second wrap regex re-matches the <li> elements already
  // inside <ul>, producing invalid <ul><ol><li>…</li></ol></ul> that browsers parse by moving
  // the <ol> out, leaving an empty <ul> and hiding all bullet content.
  out = out.replace(/^[-*+]\s+(.+)$/gm, "\x02$1\x03");
  out = out.replace(
    /(\x02[\s\S]*?\x03\n?)+/g,
    (block) => {
      const items = block.replace(/\x02([\s\S]*?)\x03/g, "<li>$1</li>");
      return `<ul class="my-2 space-y-1.5 ml-0 [&>li]:flex [&>li]:gap-2 [&>li]:text-sm [&>li]:text-muted [&>li]:leading-[1.65] [&>li]:before:content-['▸'] [&>li]:before:text-neon/50 [&>li]:before:text-[10px] [&>li]:before:mt-[3px] [&>li]:before:shrink-0">${items}</ul>\n`;
    },
  );

  // Ordered lists — sentinel bytes \x04/\x05, distinct from the bullet sentinels above.
  out = out.replace(/^\d+\.\s+(.+)$/gm, "\x04$1\x05");
  out = out.replace(
    /(\x04[\s\S]*?\x05\n?)+/g,
    (block) => {
      const items = block.replace(/\x04([\s\S]*?)\x05/g, "<li>$1</li>");
      return `<ol class="my-2 space-y-1.5 ml-4 list-decimal [&>li]:text-sm [&>li]:text-muted [&>li]:leading-[1.65] marker:text-neon/50">${items}</ol>\n`;
    },
  );

  out = out.replace(
    /^>\s+(.+)$/gm,
    '<blockquote class="border-l-2 border-border-strong pl-3 py-0.5 text-xs italic text-muted-2 my-2">$1</blockquote>',
  );

  out = out.replace(
    /^(?!<[a-zA-Z/]|$|\s*$)(.+)$/gm,
    '<p class="text-sm text-muted leading-[1.7] my-1">$1</p>',
  );

  return out.replace(/\n{3,}/g, "\n\n").trim();
}

/** Full-document HTML: `## headings` become labelled sections. */
export function renderFullDoc(content: string): string {
  const clean = stripDocPreamble(content);
  const headingRe = /^##\s+(.+)$/gm;
  let out = "";
  let cursor = 0;
  let match: RegExpExecArray | null;

  while ((match = headingRe.exec(clean)) !== null) {
    // Body text before this heading
    if (match.index > cursor) {
      out += renderSectionBody(clean.slice(cursor, match.index));
    }
    out += `<h2 class="text-base font-semibold mt-7 mb-2.5 text-neon/90">${esc(match[1])}</h2>`;
    cursor = match.index + match[0].length;
  }

  // Remaining body after last heading (or the whole doc if no headings)
  if (cursor < clean.length) {
    out += renderSectionBody(clean.slice(cursor));
  }

  return out;
}
