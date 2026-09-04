"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { Icon } from "@/components/icon";
import { cn } from "@/lib/utils";
import {
  GENERATED_BLOCK_LINE_RE,
  isSafeHref,
  LINK_RE,
  parseDocSections,
  renderFullDoc,
  renderSectionBody,
  stripDocPreamble,
  stripHeadingNumber,
  stripPipelineMarkers,
} from "@/lib/doc-render";
import { generateDocSummaryAction, generateIntelReportAction, markActionDoneAction } from "@/lib/actions";
import { CorrectInfoModal } from "@/components/correct-info-modal";
import { docListEmptyLine, docsPipelineState, unavailableDocCopy } from "@/lib/doc-rail-copy";
import type { IntelScheduleInfo } from "@/lib/intel-schedule";
import type { ClientContextDoc, ContextDocType } from "@/lib/types";

/** Documents surfaced to the client, in display order. Shown only when generated. */
const DOC_TABS: { docType: ContextDocType; label: string }[] = [
  { docType: "brand-voice", label: "Brand Voice" },
  { docType: "market-strategy", label: "Market Strategy" },
  { docType: "competitor-analysis", label: "Competitor Analysis" },
  { docType: "product-information", label: "Product Information" },
  { docType: "branding-guidelines", label: "Branding Guidelines" },
  { docType: "target-audience", label: "Target Audience" },
  { docType: "client-guidelines", label: "Guidelines" },
];

function countSections(content: string): number {
  return (content.match(/^## /gm) ?? []).length;
}

/**
 * What the nav should show for one doc type: a readable doc, a placeholder row,
 * or nothing at all.
 *
 * `unavailable` states a FACT and makes no claim about activity: this doc type
 * exists internally and has no client-readable copy. It was called `rebuilding`,
 * and that was the defect — the name was the row's copy, so a row whose only
 * possible cause was a condensation that had already finished (or already
 * failed) told the client work was in progress and to "check back shortly".
 * Nothing on this path had ever asked whether anything was running. What the row
 * SAYS is decided at the render, from `isAiProcessing` / `aiProcessingFailed`,
 * which are the only two inputs that can answer it.
 */
type DocPick =
  | { kind: "doc"; doc: ClientContextDoc }
  | { kind: "unavailable" }
  | { kind: "none" };

/**
 * Prefer the client-facing tier.
 *
 * `allowInternalFallback` is the tier boundary, not a preference: the internal
 * tier is analyst-grade copy (methodology notes, sourcing workflow, competitor
 * labels) that types.ts restricts to admin/employee. Only the staff sidebar may
 * pass it. For a client viewer a missing or degraded client-tier copy resolves
 * to an `unavailable` row — never to the internal document. Internal-only tier
 * is never surfaced on either path.
 */
/**
 * A document whose generation came back empty is not a document. The condense
 * step returns `{ content: "" }` for an empty source and a failed model stream
 * resolves with whatever partial text arrived, so a blank row could be written
 * and then rendered as a nav item that opens onto nothing.
 */
function hasBody(doc: ClientContextDoc | undefined): doc is ClientContextDoc {
  return !!doc && stripDocPreamble(doc.content).length > 40;
}

function pickDoc(
  docs: ClientContextDoc[],
  docType: ContextDocType,
  allowInternalFallback: boolean,
): DocPick {
  const clientTier = docs.filter((d) => d.docType === docType && d.tier === "client").find(hasBody);
  const internalTier = docs
    .filter((d) => d.docType === docType && d.tier === "internal")
    .find(hasBody);

  if (!allowInternalFallback) {
    if (clientTier) return { kind: "doc", doc: clientTier };
    // An internal twin with no client-facing copy means condensation has not
    // produced (or has lost) the client version — say so instead of leaking it.
    //
    // "Has lost" covers the `hasBody` case too: a client-tier row under 40
    // characters is a blank document rather than a short one, and it reaches
    // this branch exactly like a missing one. Both are the same fact — there is
    // nothing here a client can read — and neither is evidence that anything is
    // being rebuilt right now.
    return internalTier ? { kind: "unavailable" } : { kind: "none" };
  }

  if (!clientTier) return internalTier ? { kind: "doc", doc: internalTier } : { kind: "none" };
  if (!internalTier) return { kind: "doc", doc: clientTier };

  // Staff only: a client copy with fewer ## sections means condensation dropped
  // one, so show the complete internal document instead.
  if (countSections(clientTier.content) < countSections(internalTier.content)) {
    return { kind: "doc", doc: internalTier };
  }

  return { kind: "doc", doc: clientTier };
}

/* ── Print / export helpers ───────────────────────────────────────────── */

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/**
 * Converts cleaned markdown to print-safe HTML with inline styles.
 * A standalone, Tailwind-free renderer used only for the PDF print window.
 *
 * Escapes FIRST, for the same reason doc-render.ts does: every tag below is
 * generated after this point, so any `<...>` in the document body is text, not
 * markup. Without it the browser parsed angle-bracketed text as a tag and
 * dropped it - the templates carry ~110 angle-bracket placeholder slots, so any
 * section the model left unfilled silently lost its text in the one file a
 * client is most likely to forward - and a stray script or image tag reaching a
 * document would have executed in the print window.
 */
function renderForPrint(markdown: string): string {
  // Markers before the escape, same as the on-screen renderer: once `<!-- … -->`
  // has become `&lt;!-- … --&gt;` nothing downstream recognises it, and the PDF
  // is the copy a client is most likely to forward.
  let out = esc(stripPipelineMarkers(markdown))
    // Separator lines. A rule is a real separator, so it prints as one - the
    // screen has rendered it since the asset-renderer fix and a PDF that
    // silently drops it does not match the document the client just read.
    // Trailing spaces are matched too; without that they left a literal "---".
    .replace(/^---+[ \t]*$/gm, "<hr />")
    // H4+ sub-headings - the Market Strategy template's persona headings
    .replace(/^#{4,6}\s+(.+)$/gm, "<h4>$1</h4>")
    // H2 headings - legacy literal numbers stripped; documents generated before
    // the numbers came out of the templates still carry them.
    .replace(/^##\s+(.+)$/gm, (_m, h: string) => `<h2>${stripHeadingNumber(h)}</h2>`)
    // H3 sub-headings
    .replace(/^###\s+(.+)$/gm, "<h3>$1</h3>")
    // H1 LAST of the heading rules. buildPrintWindow prints per section, so a
    // `#` title that ended up inside a section body (the brand sync block is
    // injected above the document title, which pushes the title down into the
    // first section) reached this renderer and printed its hash mark.
    .replace(/^#\s+(.+)$/gm, "<h2>$1</h2>")
    // Bold / italic / code. The underscore forms are guarded at word boundaries
    // so the rule cannot open inside snake_case; without them `_Last updated: …_`
    // printed its underscores.
    .replace(/(?<!\w)__([^_\n]+)__(?!\w)/g, "<strong>$1</strong>")
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*(.+?)\*/g, "<em>$1</em>")
    .replace(/(?<!\w)_([^_\n]+)_(?!\w)/g, "<em>$1</em>")
    .replace(/`(.+?)`/g, "<code>$1</code>");

  // Tables
  const tableRe = /((?:^\|.+\|\n?){2,})/gm;
  out = out.replace(tableRe, (block) => {
    const lines = block.trim().split("\n").map((l) => l.trim()).filter(Boolean);
    const sepIdx = lines.findIndex((l) => /^\|[-:\s|]+\|$/.test(l));
    const cells = (row: string, tag: "th" | "td") =>
      row
        .split("|")
        .slice(1, -1)
        .map((c) => `<${tag}>${c.replace(/\*\*/g, "").trim()}</${tag}>`)
        .join("");
    let html = "<table>";
    if (sepIdx > 0) {
      html += "<thead>" + lines.slice(0, sepIdx).map((r) => `<tr>${cells(r, "th")}</tr>`).join("") + "</thead>";
      html += "<tbody>" + lines.slice(sepIdx + 1).map((r) => `<tr>${cells(r, "td")}</tr>`).join("") + "</tbody>";
    } else {
      html += "<tbody>" + lines.filter((r) => !/^\|[-:\s|]+\|$/.test(r)).map((r) => `<tr>${cells(r, "td")}</tr>`).join("") + "</tbody>";
    }
    return html + "</table>\n";
  });

  // Bullet lists (sentinel to avoid nested re-match). Leading whitespace is
  // allowed so an indented sub-bullet joins the list instead of printing a bare
  // dash as a paragraph; \x06 marks it for the indent class.
  out = out.replace(/^([ \t]+)?[-*+]\s+(.+)$/gm, (_m, indent: string | undefined, text: string) =>
    indent ? `\x02\x06${text}\x03` : `\x02${text}\x03`,
  );
  out = out.replace(/(\x02[\s\S]*?\x03\n?)+/g, (block) => {
    const items = block
      .replace(/\x02\x06([\s\S]*?)\x03/g, '<li class="indent">$1</li>')
      .replace(/\x02([\s\S]*?)\x03/g, "<li>$1</li>");
    return `<ul>${items}</ul>\n`;
  });

  // Ordered lists
  out = out.replace(/^([ \t]+)?\d+\.\s+(.+)$/gm, (_m, indent: string | undefined, text: string) =>
    indent ? `\x04\x06${text}\x05` : `\x04${text}\x05`,
  );
  out = out.replace(/(\x04[\s\S]*?\x05\n?)+/g, (block) => {
    const items = block
      .replace(/\x04\x06([\s\S]*?)\x05/g, '<li class="indent">$1</li>')
      .replace(/\x04([\s\S]*?)\x05/g, "<li>$1</li>");
    return `<ol>${items}</ol>\n`;
  });

  // Blockquotes - matches the ESCAPED marker: esc() above has already turned a
  // leading ">" into "&gt;", so a `^>` rule here could never fire and every
  // quoted line would keep its arrow on the page. Same rule as doc-render.ts.
  out = out.replace(/^&gt;\s+(.+)$/gm, "<blockquote>$1</blockquote>");

  // Remaining plain lines → paragraphs. Skips only the BLOCK tags generated
  // above, not any tag: the inline passes run first, so a `**Label:** value`
  // line already starts with `<strong>` and used to fall out of this pass
  // entirely - printing at the browser default instead of the 11pt body size.
  out = out.replace(/^(?!\s*$).+$/gm, (line) =>
    GENERATED_BLOCK_LINE_RE.test(line) ? line : `<p>${line}</p>`,
  );

  // Links, last - same rule and same scheme guard as the on-screen renderer, so
  // the PDF matches the screen instead of printing bracket-and-parenthesis text.
  out = out.replace(LINK_RE, (whole, text: string, href: string) =>
    isSafeHref(href) ? `<a href="${href}">${text}</a>` : whole,
  );

  return out.replace(/\n{3,}/g, "\n\n").trim();
}

function buildPrintWindow(content: string, title: string): void {
  const clean = stripDocPreamble(content);
  // Built from the SAME section list the drawer indexes, so the PDF's section
  // numbers cannot disagree with the ones on screen (parseDocSections drops
  // placeholder sections, and a renderer counting its own headings would number
  // them differently).
  const sections = parseDocSections(content);
  const body =
    sections.length >= 2
      ? [
          renderForPrint(leadIn(content)),
          ...sections.map(
            (s, i) =>
              `<h2>${esc(`${i + 1}. ${stripHeadingNumber(s.heading)}`)}</h2>\n${renderForPrint(s.body)}`,
          ),
        ]
          .filter(Boolean)
          .join("\n")
      : renderForPrint(clean);

  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <title>${esc(title)}</title>
  <style>
    @page { margin: 1in; size: letter; }
    *, *::before, *::after { box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
      font-size: 11pt; line-height: 1.65; color: #111; background: #fff;
      max-width: 700px; margin: 0 auto; padding: 32px;
    }
    h1 { font-size: 20pt; font-weight: 700; margin: 0 0 24px; color: #000;
         border-bottom: 2px solid #111; padding-bottom: 12px; }
    h2 { font-size: 13pt; font-weight: 600; margin: 28px 0 8px; color: #111;
         page-break-after: avoid; }
    h3 { font-size: 10pt; font-weight: 600; text-transform: uppercase;
         letter-spacing: 0.08em; color: #555; margin: 16px 0 4px; }
    h4 { font-size: 11pt; font-weight: 600; color: #111; margin: 12px 0 4px; }
    p  { margin: 5px 0; font-size: 11pt; color: #222; }
    a  { color: #0b5fa5; }
    ul, ol { margin: 6px 0; padding-left: 22px; }
    li { margin: 3px 0; font-size: 11pt; }
    li.indent { margin-left: 18px; }
    ul li::marker { color: #888; }
    table { width: 100%; border-collapse: collapse; margin: 12px 0;
            page-break-inside: avoid; font-size: 10pt; }
    th { background: #f0f0f0; padding: 6px 10px; text-align: left;
         border-bottom: 2px solid #ccc; font-size: 9pt;
         text-transform: uppercase; letter-spacing: 0.04em; }
    td { padding: 6px 10px; border-bottom: 1px solid #e5e5e5; vertical-align: top; }
    blockquote { border-left: 3px solid #ccc; margin: 8px 0; padding: 4px 14px;
                 color: #555; font-style: italic; }
    code { font-family: "Courier New", monospace; font-size: 9pt;
           background: #f5f5f5; padding: 1px 4px; border-radius: 2px; }
    strong { font-weight: 600; }
    em { font-style: italic; }
    hr { border: 0; border-top: 1px solid #ddd; margin: 18px 0; }
    @media print {
      body { padding: 0; max-width: none; }
    }
  </style>
</head>
<body>
  <h1>${esc(title)}</h1>
  ${body}
  <script>window.addEventListener("load", function() { window.print(); });<\/script>
</body>
</html>`;

  const win = window.open("", "_blank");
  if (!win) {
    alert("Allow pop-ups for this site to export as PDF, then try again.");
    return;
  }
  win.document.write(html);
  win.document.close();
}

function downloadMarkdown(content: string, label: string): void {
  // stripDocPreamble already drops pipeline markers, so the .md a client keeps
  // does not carry the sync sentinels either - they are invisible in a markdown
  // preview but plain text in any editor, which is where the file gets opened.
  const clean = stripDocPreamble(content);
  const titled = `# ${label}\n\n${clean}`;
  const slug = label.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");
  const blob = new Blob([titled], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${slug}.md`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/* ── Export dropdown ───────────────────────────────────────────────────── */

function ExportMenu({
  doc,
  label,
}: {
  doc: ClientContextDoc;
  label: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    function handler(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        className={cn(
          "flex items-center gap-1.5 rounded-[8px] px-2.5 py-1.5 text-xs font-medium transition-colors",
          open
            ? "bg-surface-2 text-foreground"
            : "text-muted hover:bg-surface-2 hover:text-foreground",
        )}
        title="Export document"
      >
        <Icon name="Download" className="h-3.5 w-3.5" />
        Export
        <Icon name="ChevronDown" className={cn("h-3 w-3 transition-transform", open && "rotate-180")} />
      </button>

      {open && (
        <div className="absolute right-0 top-full z-10 mt-1 w-44 overflow-hidden rounded-[10px] border border-border bg-surface shadow-xl">
          <button
            onClick={() => {
              setOpen(false);
              buildPrintWindow(doc.content, label);
            }}
            className="flex w-full items-center gap-2.5 px-3 py-2.5 text-left text-xs text-muted transition-colors hover:bg-surface-2 hover:text-foreground"
          >
            <Icon name="FileText" className="h-3.5 w-3.5 shrink-0 text-muted-2" />
            <div>
              <p className="font-medium text-foreground">Export PDF</p>
              <p className="text-[11px] text-muted-2">Opens print dialog</p>
            </div>
          </button>
          <div className="h-px bg-border" />
          <button
            onClick={() => {
              setOpen(false);
              downloadMarkdown(doc.content, label);
            }}
            className="flex w-full items-center gap-2.5 px-3 py-2.5 text-left text-xs text-muted transition-colors hover:bg-surface-2 hover:text-foreground"
          >
            <Icon name="FileCode" className="h-3.5 w-3.5 shrink-0 text-muted-2" />
            <div>
              <p className="font-medium text-foreground">Export Markdown</p>
              <p className="text-[11px] text-muted-2">Downloads .md file</p>
            </div>
          </button>
        </div>
      )}
    </div>
  );
}

/* ── Full-document reader — an EXPANDED PANEL on the Documents tab ──────
   (flow audit 2026-09, R13.)

   It was a 50%-width slide-over rendered through a portal, with the
   "Correct Info" dialog stacked on top of it: page → tab → slide-over →
   modal, four levels of disclosure for one document. And the reader failed
   three of the four "use a page, not an overlay" tests outright — it has its
   own scrolling, its own table of contents and its own export menu, which is
   a second navigation system inside an overlay.

   So it renders in place of the list now, on the tab it belongs to, with a
   "All documents" control back. Nothing about the route changes; "Correct
   Info" stays a modal, and is now the ONLY one. ── */

/** Any body text sitting before the first `##` heading - parseDocSections drops it. */
function leadIn(content: string): string {
  const clean = stripDocPreamble(content);
  const idx = clean.search(/^##\s+/m);
  return idx > 0 ? clean.slice(0, idx).trim() : "";
}

/** Stable, unique anchor id for a section heading. */
function sectionId(heading: string, i: number): string {
  const slug = heading.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return `doc-section-${i}-${slug || "untitled"}`;
}

function DocPanel({
  doc,
  label,
  clientId,
  correctionPricing,
  onClose,
  onDocUpdated,
}: {
  doc: ClientContextDoc;
  label: string;
  clientId?: string;
  correctionPricing?: { cost: number; blockReason?: string };
  onClose: () => void;
  onDocUpdated?: () => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [correcting, setCorrecting] = useState(false);
  const [summary, setSummary] = useState<string[] | null>(null);
  /**
   * The correction this reader just paid for, kept on screen (flow audit
   * 2026-09, R13). "Apply Correction" used to close the modal AND the
   * document, dropping the client back on the list with no diff and no
   * acknowledgement of a billable AI rewrite. The action returns no diff to
   * render, so this shows the two things that are actually known: what they
   * asked for, verbatim, and that the document moved a version.
   */
  const [applied, setApplied] = useState<{ text: string; fromVersion: number } | null>(null);
  // renderFullDoc("") returns "" - with no branch here the panel used to open
  // onto a completely blank body with no message and no explanation.
  const body = renderFullDoc(doc.content);
  // parseDocSections gives heading/body pairs AND drops sections whose body is
  // nothing but "Unknown" / "Not provided" / "TBD" - both were already written
  // and had no callers. Below two sections there is nothing to index, so those
  // documents keep the single-pass render.
  const sections = parseDocSections(doc.content);
  const indexed = sections.length >= 2;
  const lead = leadIn(doc.content);

  // No body-scroll lock any more: this is a panel on the page, not an overlay
  // over it, and freezing the page behind a panel that IS the page is what made
  // the old reader feel like a fourth level. Escape still returns to the list —
  // the habit is cheap to keep and costs nothing here.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && !correcting) onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose, correcting]);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
    // …and take focus with it. The panel REPLACES the list rather than opening
    // over it, so the button that was pressed is gone from the DOM and focus
    // would otherwise fall back to <body>: a screen reader announces nothing
    // and the next Tab restarts from the top of the page. `preventScroll`
    // because the line above has just decided where this panel starts.
    headingRef.current?.focus({ preventScroll: true });
  }, [doc.id]);

  // Executive summary: already built on the server, with caching keyed on the
  // document version and its own usage logging, and no screen had ever called
  // it. Non-blocking and best-effort - the document reads fine without it, and
  // a repeat open of an unchanged version is served from cache with no model
  // call.
  useEffect(() => {
    if (!clientId) return;
    let live = true;
    generateDocSummaryAction(clientId, doc.docType, doc.tier)
      .then((bullets) => {
        if (live && bullets.length) setSummary(bullets);
      })
      .catch(() => {});
    return () => {
      live = false;
      setSummary(null);
    };
  }, [clientId, doc.docType, doc.tier, doc.version]);

  return (
    <>
      <div className="rounded-[var(--radius)] border border-border bg-surface">
        {/* `relative` is here for the absolutely-positioned bits inside this
            box, NOT for the sticky header below it (review wave, 2026-09):
            `position: sticky` is resolved against the nearest scrolling
            ancestor, which is the page, and no containing block changes that. */}
        <div className="relative flex flex-col">
          {/* STICKY INSIDE THE SCROLLER (flow audit 2026-09, R13 follow-up).
              The slide-over pinned its header above a flex-1 body; a panel in
              the page flow has no such column, so on a phone — where the panel
              is the whole screen and the reader scrolls a long document — the
              header, the way back and "Correct Info" all scrolled away. Sticky
              keeps every one of them one thumb away at any scroll depth, and
              `bg-surface` keeps the document from showing through it. */}
          <div className="sticky top-0 z-10 flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-border bg-surface px-6 py-3.5">
            <div className="min-w-0">
              {/* The way back, named. The slide-over's only exit was a bare X
                  (and the backdrop), which says "put this away" and not "return
                  to the list" — flow audit 2026-09, R13. */}
              <button
                onClick={onClose}
                className="mb-1 inline-flex items-center gap-1.5 rounded-md text-[11px] font-medium text-muted transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-foreground/25"
              >
                <Icon name="ChevronLeft" className="h-3.5 w-3.5" />
                All documents
              </button>
              {/* The focus target for the list -> panel swap below, and a real
                  heading rather than a styled paragraph: the panel replaces the
                  list in place, so without this a screen reader is left where
                  the pressed row used to be and a keyboard reader's next Tab
                  starts from the top of the page. */}
              <h2
                ref={headingRef}
                tabIndex={-1}
                className="truncate text-sm font-semibold text-foreground focus:outline-none"
              >
                {label}
              </h2>
              {/* "Is this current?" is the first question a document with a
                  recurring regeneration schedule has to answer. */}
              {/* Carries a date and a version number, so it takes the readable
                  tone - muted-2 is for labels (QA F119). */}
              <p className="mt-0.5 text-[11px] text-muted">
                Updated {formatDate(doc.updatedAt)} · v{doc.version}
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <ExportMenu doc={doc} label={label} />
              <button
                onClick={() => setCorrecting(true)}
                className="flex items-center gap-1.5 rounded-[8px] px-2.5 py-1.5 text-xs font-medium text-muted transition-colors hover:bg-surface-2 hover:text-foreground"
                title="Correct wrong information in this document"
              >
                <Icon name="PenLine" className="h-3.5 w-3.5" />
                Correct Info
              </button>
            </div>
          </div>

          {/* What the correction actually did (flow audit 2026-09, R13).
              `role="status"` because this appears without the reader moving:
              the modal above it closes and this arrives in its place, which is
              a change nobody is looking at unless it is announced. */}
          {applied && (
            <div role="status" className="border-b border-neon/20 bg-neon-soft/30 px-6 py-3">
              <p className="text-xs font-medium text-neon">
                {doc.version > applied.fromVersion
                  ? `Correction applied. This document is now v${doc.version}.`
                  : "Correction applied."}
              </p>
              <p className="mt-1 text-xs text-muted">
                You asked us to correct: “{applied.text}”. Only the facts you named changed;
                everything else is identical.
              </p>
            </div>
          )}

          {/* A capped height rather than the viewport: the document keeps its
              own scroll (it is long, and it has a table of contents pinned
              beside it) without swallowing the tab it sits on. */}
          <div ref={scrollRef} className="max-h-[70vh] min-h-0 flex-1 overflow-y-auto px-6 py-6 md:px-8">
            {body && summary && (
              <div className="mx-auto mb-6 w-full max-w-3xl rounded-[10px] border border-border bg-surface-2 px-4 py-3">
                <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-2">
                  In short
                </p>
                <ul className="space-y-1">
                  {summary.map((line) => (
                    <li key={line} className="flex gap-2 text-xs leading-[1.6] text-muted">
                      <span className="mt-[3px] shrink-0 text-[10px] text-neon/50">▸</span>
                      {line}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {!body ? (
              <p className="mx-auto w-full max-w-2xl text-sm text-muted">
                This document has not been generated yet. Ask your Karos team to regenerate it.
              </p>
            ) : indexed ? (
              <div className="mx-auto flex w-full max-w-3xl gap-6">
                <nav
                  aria-label="Sections"
                  className="sticky top-0 hidden w-44 shrink-0 self-start md:block"
                >
                  <p className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-muted-2">
                    Contents
                  </p>
                  <ul className="space-y-0.5">
                    {sections.map((s, i) => (
                      <li key={sectionId(s.heading, i)}>
                        <button
                          onClick={() =>
                            document
                              .getElementById(sectionId(s.heading, i))
                              ?.scrollIntoView({ behavior: "smooth", block: "start" })
                          }
                          className="w-full rounded-md px-2 py-1 text-left text-xs leading-snug text-muted transition-colors hover:bg-surface-2 hover:text-foreground"
                        >
                          {i + 1}. {stripHeadingNumber(s.heading)}
                        </button>
                      </li>
                    ))}
                  </ul>
                </nav>

                <div className="min-w-0 flex-1 break-words [&_code]:break-all [&_table]:min-w-0">
                  {/* Narrow panels get the index as a scrollable chip row - a
                      44px column would leave no room for the document itself. */}
                  <div className="mb-4 -mx-1 flex gap-1.5 overflow-x-auto pb-1 md:hidden">
                    {sections.map((s, i) => (
                      <button
                        key={sectionId(s.heading, i)}
                        onClick={() =>
                          document
                            .getElementById(sectionId(s.heading, i))
                            ?.scrollIntoView({ behavior: "smooth", block: "start" })
                        }
                        className="shrink-0 rounded-full border border-border px-2.5 py-1 text-[11px] text-muted transition-colors hover:bg-surface-2 hover:text-foreground"
                      >
                        {i + 1}. {stripHeadingNumber(s.heading)}
                      </button>
                    ))}
                  </div>

                  {lead && (
                    <div dangerouslySetInnerHTML={{ __html: renderSectionBody(lead) }} />
                  )}
                  {sections.map((s, i) => (
                    <section key={sectionId(s.heading, i)} id={sectionId(s.heading, i)}>
                      <h2 className="mt-7 mb-2.5 scroll-mt-4 text-base font-semibold text-neon/90">
                        {i + 1}. {stripHeadingNumber(s.heading)}
                      </h2>
                      <div dangerouslySetInnerHTML={{ __html: renderSectionBody(s.body) }} />
                    </section>
                  ))}
                </div>
              </div>
            ) : (
              <div
                className="mx-auto w-full max-w-2xl break-words [&_code]:break-all [&_table]:min-w-0"
                dangerouslySetInnerHTML={{ __html: body }}
              />
            )}
          </div>
        </div>
      </div>

      {/* The one modal a CLIENT meets in this flow now (flow audit 2026-09,
          R13): a short, user-initiated, billable decision — the case a dialog
          is actually for — over a document that is no longer itself an
          overlay. It is not the only dialog this component mounts:
          RegenerateModal is still here, on the list behind an `isAdmin &&
          clientId` gate, and staff keep it. What went is the STACK — page ->
          tab -> slide-over -> modal is now page -> tab -> panel -> modal
          minus a level, and no dialog opens over another. */}
      <CorrectInfoModal
        documentId={doc.id}
        docLabel={label}
        correctionPricing={correctionPricing}
        open={correcting}
        onClose={() => setCorrecting(false)}
        onSuccess={(correction) => {
          // The document STAYS OPEN. It used to close both layers and land the
          // client on the list with nothing to show for a paid rewrite.
          setCorrecting(false);
          setApplied({ text: correction, fromVersion: doc.version });
          onDocUpdated?.();
        }}
      />
    </>
  );
}

/* ── Regenerate modal ─────────────────────────────────────────────────── */

/* Exported for the staff dashboard's Regenerate entry point (CD-G5) - the flow
   lives here because this is where it was born, and it must exist exactly once. */
export function RegenerateModal({
  clientId,
  open,
  onClose,
  onSuccess,
}: {
  clientId: string;
  open: boolean;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const [context, setContext] = useState("");
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (open) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setContext("");
      setError(null);
      setRunning(false);
      // Defer focus so the portal has time to mount
      const id = setTimeout(() => textareaRef.current?.focus(), 60);
      return () => clearTimeout(id);
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && !running) onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, running, onClose]);

  async function handleConfirm() {
    setRunning(true);
    setError(null);
    try {
      await generateIntelReportAction(clientId, context.trim() || undefined);
      onSuccess();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Regeneration failed. Please try again.");
    } finally {
      setRunning(false);
    }
  }

  if (!open) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[10000] flex items-center justify-center p-4"
      style={{ background: "rgba(0,0,0,0.72)", backdropFilter: "blur(4px)" }}
      onClick={(e) => {
        if (e.target === e.currentTarget && !running) onClose();
      }}
    >
      <div className="w-full max-w-md overflow-hidden rounded-[16px] border border-border bg-surface shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-border px-5 py-4">
          <div className="flex items-center gap-2.5">
            <div className="flex h-7 w-7 items-center justify-center rounded-[8px] bg-neon-soft neon-glow">
              <Icon name="RefreshCw" className="h-3.5 w-3.5 text-neon" />
            </div>
            <p className="font-semibold text-foreground">Regenerate Intel Report</p>
          </div>
          <button
            onClick={onClose}
            disabled={running}
            className="flex h-7 w-7 items-center justify-center rounded-[8px] text-muted transition-colors hover:bg-surface-2 hover:text-foreground disabled:opacity-40"
          >
            <Icon name="X" className="h-4 w-4" />
          </button>
        </div>

        {/* Body */}
        <div className="space-y-4 px-5 py-4">
          {/* Corrections are NOT lost any more: runOnboardPipeline reads them back
              through listClientDocCorrections and buildCorrectionsBlock re-injects
              them into every doc prompt as ground truth. The old copy predated that. */}
          <p className="rounded-[8px] border border-warning/20 bg-warning/10 px-3 py-2 text-xs text-warning">
            This rebuilds every document from scratch. Corrections you&apos;ve applied are
            carried into the new versions.
          </p>
          <p className="text-sm text-muted">
            Optionally add run-specific context for this regeneration. These instructions apply
            to{" "}
            <span className="font-medium text-foreground">this run only</span> and take the
            highest priority if they conflict with global settings.
          </p>
          <p className="text-xs text-muted-2">
            The run takes a few minutes and continues in the background. You can close this and
            keep working. Regenerate stays locked until it finishes.
          </p>
          <div className="space-y-1.5">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-2">
              Run-Specific Context{" "}
              <span className="font-normal normal-case text-muted-2">(optional)</span>
            </p>
            <textarea
              ref={textareaRef}
              value={context}
              onChange={(e) => setContext(e.target.value)}
              disabled={running}
              rows={5}
              placeholder={`e.g. "Lean heavily into social media assets and downplay SEO. Focus the competitor analysis on emerging brands, not industry giants."`}
              className="w-full resize-none rounded-[10px] border border-border bg-surface-2 px-3 py-2.5 text-sm text-foreground placeholder:text-muted-2 focus:border-neon focus:outline-none disabled:opacity-50"
            />
          </div>
          {error && (
            <p className="rounded-[8px] border border-danger/20 bg-danger/10 px-3 py-2 text-xs text-danger">
              {error}
            </p>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2.5 border-t border-border px-5 py-4">
          <button
            onClick={onClose}
            disabled={running}
            className="rounded-[8px] px-4 py-2 text-sm font-medium text-muted transition-colors hover:bg-surface-2 hover:text-foreground disabled:opacity-40"
          >
            Cancel
          </button>
          <button
            onClick={handleConfirm}
            disabled={running}
            className="flex items-center gap-2 rounded-[10px] bg-neon px-4 py-2 text-sm font-semibold text-accent-ink transition-opacity hover:opacity-90 disabled:opacity-60"
          >
            <Icon
              name="RefreshCw"
              className={cn("h-3.5 w-3.5", running && "animate-spin")}
            />
            {running ? "Starting…" : "Confirm & Run"}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function formatDate(ms: number | null): string {
  if (!ms) return "Never";
  return new Date(ms).toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" });
}

/* ── Documents list ───────────────────────────────────────────────────── */


/** Maps a doc row's open event onto the action-list id it counts toward, when any. */
const ACTION_ID_BY_DOC_TYPE: Partial<Record<ContextDocType, string>> = {
  "brand-voice": "21",
  "target-audience": "22",
  "competitor-analysis": "23",
};

export function ClientDocuments({
  contextDocs,
  isAdmin,
  clientId,
  isAiProcessing,
  aiProcessingFailed,
  // Kept on the signature for callers (client-rail.tsx); the sidebar's schedule
  // button/modal that read this was removed.
  intelSchedule: _intelSchedule,
  allowInternalFallback = false,
  correctionPricing,
  viewerIsClient = false,
}: {
  contextDocs: ClientContextDoc[];
  isAdmin?: boolean;
  clientId?: string;
  /** True while a background AI generation cycle is running - locks the Regenerate button. */
  isAiProcessing?: boolean;
  /**
   * True when the last generation cycle failed - the empty state says so (QA
   * F69). A BOOLEAN, not the reason: this rail mounts for client viewers, and
   * all it ever did with the raw provider error was test it for truthiness.
   */
  aiProcessingFailed?: boolean;
  /** Admin-only recurring regeneration schedule. Only meaningful (and only ever rendered) when isAdmin. */
  intelSchedule?: IntelScheduleInfo;
  /**
   * Staff-only escape hatch: show the internal-tier document when the
   * client-facing copy is missing or looks under-condensed. Defaults to false so
   * a client-facing mount can never opt in by omission.
   */
  allowInternalFallback?: boolean;
  /**
   * Price of a targeted correction, for the Correct Info modal. Server-resolved
   * and passed only for billable client viewers - omitted on the staff shell,
   * whose corrections are agency overhead and cost the client nothing.
   */
  correctionPricing?: { cost: number; blockReason?: string };
  /**
   * The REAL client-role flag, not `!isAdmin` — a KAROS_EMPLOYEE viewer also
   * has `isAdmin: false` but is not a client, and the action-list ids 21/22/23
   * this component fires on doc-open must only ever be marked done for the
   * client whose checklist they belong to.
   */
  viewerIsClient?: boolean;
}) {
  const router = useRouter();
  /**
   * The doc TYPE being read, not a snapshot of the document (flow audit
   * 2026-09, R13). The reader stays open across a correction now, and a
   * correction rewrites the document — so holding the object here would leave
   * the panel rendering the pre-correction copy after `router.refresh()`
   * delivered the new one. The type is stable; the document is re-picked from
   * the fresh props below.
   */
  // Typed as the union it actually holds (review wave, 2026-09): every value
  // put in it comes from DOC_TABS, and `string` let a typo compile into a
  // reader that silently opens nothing.
  const [openDocType, setOpenDocType] = useState<ContextDocType | null>(null);
  const [regenModalOpen, setRegenModalOpen] = useState(false);

  const available = DOC_TABS.map((t) => ({
    ...t,
    pick: pickDoc(contextDocs, t.docType, allowInternalFallback),
  })).filter((i) => i.pick.kind !== "none");

  const openItem = openDocType ? available.find((i) => i.docType === openDocType) : undefined;
  const openDoc =
    openItem && openItem.pick.kind === "doc"
      ? { doc: (openItem.pick as { kind: "doc"; doc: ClientContextDoc }).doc, label: openItem.label }
      : null;

  // Asked ONCE, here, and read by both the empty state and every unavailable
  // row — so the list and the rows in it cannot disagree about whether anything
  // is happening.
  const pipeline = docsPipelineState({ isAiProcessing, aiProcessingFailed });
  const unavailable = unavailableDocCopy(pipeline);

  // THE READER REPLACES THE LIST rather than floating over it (flow audit
  // 2026-09, R13) — one thing on the tab at a time, and "All documents" inside
  // the panel is the way back.
  if (openDoc) {
    return (
      <div>
        <DocPanel
          doc={openDoc.doc}
          label={openDoc.label}
          clientId={clientId}
          correctionPricing={correctionPricing}
          onClose={() => setOpenDocType(null)}
          onDocUpdated={() => router.refresh()}
        />
      </div>
    );
  }

  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between gap-1">
        <p className="px-1 text-[10px] font-semibold uppercase tracking-wider text-muted-2">
          Documents
        </p>
        {isAdmin && clientId && (
          <div className="flex items-center gap-0.5">
            <button
              onClick={() => setRegenModalOpen(true)}
              disabled={isAiProcessing}
              title={
                isAiProcessing
                  ? "Karos Agents are already building this workspace. Please wait for it to finish"
                  : "Re-run the Intel Report pipeline to regenerate all documents"
              }
              className="flex items-center gap-1 rounded-[5px] px-1.5 py-0.5 text-[10px] font-medium text-muted-2 transition-colors hover:bg-surface-2 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-muted-2"
            >
              <Icon name="RefreshCw" className="h-3 w-3" />
              Regenerate
            </button>
          </div>
        )}
      </div>

      {available.length === 0 ? (
        // One line used to cover three different situations, so a client who
        // finished onboarding half an hour ago was told to finish onboarding —
        // and a failed run said the same thing (QA F69). Both this line and the
        // row below read `pipeline`, the ONE answer to whether anything is
        // running, so the list cannot contradict a row inside it.
        <p className="px-1 py-1.5 text-xs text-muted-2">{docListEmptyLine(pipeline)}</p>
      ) : (
        <ul>
          {available.map((item) =>
            item.pick.kind === "doc" ? (
              <li key={item.docType}>
                <button
                  onClick={() => {
                    setOpenDocType(item.docType);
                    // Event-tracked action-list ids (21/22/23, lib/action-list.ts) —
                    // these three docs have nothing to query for "has the client
                    // looked at this" beyond the moment they open it.
                    const actionId = ACTION_ID_BY_DOC_TYPE[item.docType];
                    if (viewerIsClient && clientId && actionId) {
                      void markActionDoneAction(clientId, actionId);
                    }
                  }}
                  /* Compact rows: the rail is a no-scroll fixed layout (CD-E3),
                     and seven of these were its single tallest block. */
                  className="group flex w-full items-center gap-2.5 rounded-md px-2 py-1 text-left transition-colors hover:bg-surface-2"
                >
                  <Icon name="FileText" className="h-4 w-4 shrink-0 text-muted-2 group-hover:text-foreground" />
                  <span className="flex-1 truncate text-[13px] leading-5 text-muted group-hover:text-foreground">
                    {item.label}
                  </span>
                </button>
              </li>
            ) : (
              /* The row a client gets when this doc type exists internally and
                 has no copy they can read. It is not a control and cannot be
                 made one — only Regenerate clears it, and that is `isAdmin &&
                 clientId`. So the sentence carries the end instead, and it is
                 RENDERED rather than hidden in a `title`: a tooltip is not an
                 affordance on touch, which is where most of this rail is read. */
              <li key={item.docType}>
                <div
                  className="flex w-full flex-col gap-0.5 rounded-md px-2 py-1 text-left"
                  title={unavailable.hint}
                >
                  <div className="flex w-full items-center gap-2.5">
                    <Icon name="FileText" className="h-4 w-4 shrink-0 text-muted-2/60" />
                    <span className="flex-1 truncate text-[13px] leading-5 text-muted-2">{item.label}</span>
                    <span className="shrink-0 text-[11px] text-muted-2">{unavailable.state}</span>
                  </div>
                  <p className="pl-[26px] text-[11px] leading-snug text-muted-2/80">
                    {unavailable.hint}
                  </p>
                </div>
              </li>
            ),
          )}
        </ul>
      )}

      {/* An "Agent-specific documents" section used to sit here (X / LinkedIn
          agent data), mounted only when clientId was set - so it appeared and
          disappeared as you moved around the portal, and it competed with the
          real documents list for the rail's fixed height. Agent data intake is
          reachable where it belongs: the AI Agents cards link it per agent
          (buildAgentSetup in clients/[id]/agents/page.tsx), which is also the
          only place that knows whether the client HAS that agent (CD-E1). */}


      {clientId && (
        <RegenerateModal
          clientId={clientId}
          open={regenModalOpen}
          onClose={() => setRegenModalOpen(false)}
          onSuccess={() => {
            setRegenModalOpen(false);
            router.refresh();
          }}
        />
      )}
    </div>
  );
}
