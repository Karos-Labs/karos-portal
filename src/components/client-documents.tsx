"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { Icon } from "@/components/icon";
import { cn } from "@/lib/utils";
import {
  isSafeHref,
  LINK_RE,
  parseDocSections,
  renderFullDoc,
  renderSectionBody,
  stripDocPreamble,
  stripHeadingNumber,
} from "@/lib/doc-render";
import {
  generateDocSummaryAction,
  generateIntelReportAction,
  updateIntelScheduleAction,
} from "@/lib/actions";
import { CorrectInfoModal } from "@/components/correct-info-modal";
import {
  computeFirstIntelScheduleRun,
  describeIntelSchedule,
  MIN_INTERVAL_MONTHS,
  MAX_INTERVAL_MONTHS,
  MIN_DAY_OF_MONTH,
  MAX_DAY_OF_MONTH,
  type IntelScheduleInfo,
} from "@/lib/intel-schedule";
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

/** What the nav should show for one doc type: a readable doc, or a placeholder row. */
type DocPick =
  | { kind: "doc"; doc: ClientContextDoc }
  | { kind: "rebuilding" }
  | { kind: "none" };

/**
 * Prefer the client-facing tier.
 *
 * `allowInternalFallback` is the tier boundary, not a preference: the internal
 * tier is analyst-grade copy (methodology notes, sourcing workflow, competitor
 * labels) that types.ts restricts to admin/employee. Only the staff sidebar may
 * pass it. For a client viewer a missing or degraded client-tier copy resolves
 * to a "being rebuilt" row — never to the internal document. Internal-only tier
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
    return internalTier ? { kind: "rebuilding" } : { kind: "none" };
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
 * dropped it — the templates carry ~110 angle-bracket placeholder slots, so any
 * section the model left unfilled silently lost its text in the one file a
 * client is most likely to forward — and a stray script or image tag reaching a
 * document would have executed in the print window.
 */
function renderForPrint(markdown: string): string {
  let out = esc(markdown)
    // Separator lines
    .replace(/^---+$/gm, "")
    // H4+ sub-headings — the Market Strategy template's persona headings
    .replace(/^#{4,6}\s+(.+)$/gm, "<h4>$1</h4>")
    // H2 headings — legacy literal numbers stripped; documents generated before
    // the numbers came out of the templates still carry them.
    .replace(/^##\s+(.+)$/gm, (_m, h: string) => `<h2>${stripHeadingNumber(h)}</h2>`)
    // H3 sub-headings
    .replace(/^###\s+(.+)$/gm, "<h3>$1</h3>")
    // Bold / italic / code
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*(.+?)\*/g, "<em>$1</em>")
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

  // Blockquotes — matches the ESCAPED marker: esc() above has already turned a
  // leading ">" into "&gt;", so a `^>` rule here could never fire and every
  // quoted line would keep its arrow on the page. Same rule as doc-render.ts.
  out = out.replace(/^&gt;\s+(.+)$/gm, "<blockquote>$1</blockquote>");

  // Remaining plain lines → paragraphs
  out = out.replace(/^(?!<[a-zA-Z/]|$|\s*$)(.+)$/gm, "<p>$1</p>");

  // Links, last — same rule and same scheme guard as the on-screen renderer, so
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
            <Icon name="File" className="h-3.5 w-3.5 shrink-0 text-muted-2" />
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

/* ── Full-document slide-over (50% width) ─────────────────────────────── */

/** Any body text sitting before the first `##` heading — parseDocSections drops it. */
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

function DocOverlay({
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
  const [correcting, setCorrecting] = useState(false);
  const [summary, setSummary] = useState<string[] | null>(null);
  // renderFullDoc("") returns "" — with no branch here the panel used to open
  // onto a completely blank body with no message and no explanation.
  const body = renderFullDoc(doc.content);
  // parseDocSections gives heading/body pairs AND drops sections whose body is
  // nothing but "Unknown" / "Not provided" / "TBD" — both were already written
  // and had no callers. Below two sections there is nothing to index, so those
  // documents keep the single-pass render.
  const sections = parseDocSections(doc.content);
  const indexed = sections.length >= 2;
  const lead = leadIn(doc.content);

  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && !correcting) onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prev;
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose, correcting]);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
  }, [doc.id]);

  // Executive summary: already built on the server, with caching keyed on the
  // document version and its own usage logging, and no screen had ever called
  // it. Non-blocking and best-effort — the document reads fine without it, and
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

  return createPortal(
    <>
      <div
        className="fixed inset-0 z-[10000] flex justify-end"
        style={{ background: "rgba(0,0,0,0.6)", backdropFilter: "blur(3px)" }}
        onClick={(e) => {
          if (e.target === e.currentTarget) onClose();
        }}
      >
        <div className="flex h-full w-full max-w-[92%] flex-col border-l border-border bg-surface shadow-2xl animate-slide-in-right md:max-w-[50%]">
          <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border px-6 py-3.5">
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold text-foreground">{label}</p>
              {/* "Is this current?" is the first question a document with a
                  recurring regeneration schedule has to answer. */}
              {/* Carries a date and a version number, so it takes the readable
                  tone — muted-2 is for labels (QA F119). */}
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
              <button
                onClick={onClose}
                className="flex h-8 w-8 items-center justify-center rounded-[8px] text-muted transition-colors hover:bg-surface-2 hover:text-foreground"
                aria-label="Close document"
              >
                <Icon name="X" className="h-4 w-4" />
              </button>
            </div>
          </div>

          <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-6 py-6 md:px-8">
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
                This document has not been generated yet — ask your Karos team to regenerate it.
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
                  {/* Narrow panels get the index as a scrollable chip row — a
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

      <CorrectInfoModal
        documentId={doc.id}
        docLabel={label}
        correctionPricing={correctionPricing}
        open={correcting}
        onClose={() => setCorrecting(false)}
        onSuccess={() => {
          setCorrecting(false);
          onClose();
          onDocUpdated?.();
        }}
      />
    </>,
    document.body,
  );
}

/* ── Regenerate modal ─────────────────────────────────────────────────── */

function RegenerateModal({
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
          <p className="rounded-[8px] border border-warning/20 bg-warning/10 px-3 py-2 text-xs text-warning">
            This replaces all documents. Corrections applied since the last run will be lost.
          </p>
          <p className="text-sm text-muted">
            Optionally add run-specific context for this regeneration. These instructions apply
            to{" "}
            <span className="font-medium text-foreground">this run only</span> and take the
            highest priority if they conflict with global settings.
          </p>
          <p className="text-xs text-muted-2">
            The run takes a few minutes and continues in the background — you can close this and
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
            className="flex items-center gap-2 rounded-[10px] bg-neon px-4 py-2 text-sm font-semibold text-[#03110b] transition-opacity hover:opacity-90 disabled:opacity-60"
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

/* ── Schedule modal ───────────────────────────────────────────────────── */

function formatDate(ms: number | null): string {
  if (!ms) return "Never";
  return new Date(ms).toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" });
}

function ScheduleModal({
  clientId,
  schedule,
  open,
  onClose,
  onSuccess,
}: {
  clientId: string;
  schedule: IntelScheduleInfo;
  open: boolean;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const [enabled, setEnabled] = useState(schedule.enabled);
  const [intervalMonths, setIntervalMonths] = useState(schedule.intervalMonths);
  const [dayOfMonth, setDayOfMonth] = useState(schedule.dayOfMonth);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setEnabled(schedule.enabled);
      setIntervalMonths(schedule.intervalMonths);
      setDayOfMonth(schedule.dayOfMonth);
      setError(null);
      setRunning(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && !running) onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, running, onClose]);

  async function handleSave() {
    setRunning(true);
    setError(null);
    try {
      const result = await updateIntelScheduleAction(clientId, { enabled, intervalMonths, dayOfMonth });
      if ("error" in result && result.error) {
        setError(result.error);
        return;
      }
      onSuccess();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save the schedule. Please try again.");
    } finally {
      setRunning(false);
    }
  }

  if (!open) return null;

  // The saved next run and the preview only agree at a one-month interval: the
  // cron advances by adding the interval to the slot that just fired, while the
  // preview is the next calendar occurrence of dayOfMonth. So show the SAVED
  // date until something is edited, and relabel it once it is — the modal is the
  // only place a schedule can be inspected, and "Next run" was the one number an
  // admin opens it to check.
  const edited =
    enabled !== schedule.enabled ||
    intervalMonths !== schedule.intervalMonths ||
    dayOfMonth !== schedule.dayOfMonth;
  // A schedule saved with no stored next run has nothing to report but the
  // preview, so it gets the preview's label too rather than a bare date.
  const previewing = edited || schedule.nextRunAt === null;
  const nextRunLabel = previewing ? "Next run after saving" : "Next run";
  const nextRunAt = enabled
    ? previewing
      ? computeFirstIntelScheduleRun(dayOfMonth)
      : schedule.nextRunAt
    : null;

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
              <Icon name="CalendarClock" className="h-3.5 w-3.5 text-neon" />
            </div>
            <p className="font-semibold text-foreground">Regeneration Schedule</p>
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
          <p className="text-sm text-muted">
            Automatically re-run the Intel Report + SEO/GEO pipeline on a recurring cadence.
            This is the only automatic re-trigger besides creating the client — otherwise it
            only runs when an admin clicks Regenerate.
          </p>

          <label className="flex items-center justify-between gap-3 rounded-[10px] border border-border bg-surface-2 px-3 py-2.5">
            <span className="text-sm font-medium text-foreground">Enable recurring regeneration</span>
            <button
              type="button"
              role="switch"
              aria-checked={enabled}
              onClick={() => setEnabled((v) => !v)}
              disabled={running}
              className={cn(
                "relative h-5 w-9 shrink-0 rounded-full transition-colors disabled:opacity-50",
                enabled ? "bg-neon" : "bg-surface",
              )}
            >
              <span
                className={cn(
                  "absolute top-0.5 left-0.5 h-4 w-4 rounded-full bg-white transition-transform",
                  enabled && "translate-x-4",
                )}
              />
            </button>
          </label>

          <div className={cn("grid grid-cols-2 gap-3", !enabled && "pointer-events-none opacity-40")}>
            <div className="space-y-1.5">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-2">
                Repeat every
              </p>
              <div className="flex items-center gap-2">
                <input
                  type="number"
                  min={MIN_INTERVAL_MONTHS}
                  max={MAX_INTERVAL_MONTHS}
                  value={intervalMonths}
                  onChange={(e) => setIntervalMonths(Number(e.target.value) || MIN_INTERVAL_MONTHS)}
                  disabled={running || !enabled}
                  className="w-full rounded-[10px] border border-border bg-surface-2 px-3 py-2 text-sm text-foreground focus:border-neon focus:outline-none disabled:opacity-50"
                />
                <span className="shrink-0 text-sm text-muted">
                  {intervalMonths === 1 ? "month" : "months"}
                </span>
              </div>
            </div>
            <div className="space-y-1.5">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-2">
                On day of month
              </p>
              <input
                type="number"
                min={MIN_DAY_OF_MONTH}
                max={MAX_DAY_OF_MONTH}
                value={dayOfMonth}
                onChange={(e) => setDayOfMonth(Number(e.target.value) || MIN_DAY_OF_MONTH)}
                disabled={running || !enabled}
                className="w-full rounded-[10px] border border-border bg-surface-2 px-3 py-2 text-sm text-foreground focus:border-neon focus:outline-none disabled:opacity-50"
              />
            </div>
          </div>

          <div className="space-y-1 rounded-[10px] border border-border px-3 py-2.5 text-xs">
            <p className="text-muted">
              <span className="text-muted-2">Cadence: </span>
              {enabled ? describeIntelSchedule({ intervalMonths, dayOfMonth }) : "Off"}
            </p>
            {enabled && nextRunAt && (
              <p className="text-muted">
                <span className="text-muted-2">{nextRunLabel}: </span>
                {formatDate(nextRunAt)}
              </p>
            )}
            <p className="text-muted">
              <span className="text-muted-2">Last generated: </span>
              {formatDate(schedule.lastIntelReportAt)}
            </p>
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
            onClick={handleSave}
            disabled={running}
            className="flex items-center gap-2 rounded-[10px] bg-neon px-4 py-2 text-sm font-semibold text-[#03110b] transition-opacity hover:opacity-90 disabled:opacity-60"
          >
            <Icon name="CalendarClock" className={cn("h-3.5 w-3.5", running && "animate-pulse")} />
            {running ? "Saving…" : "Save Schedule"}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/* ── Documents list ───────────────────────────────────────────────────── */

export function ClientDocuments({
  contextDocs,
  isAdmin,
  clientId,
  isAiProcessing,
  aiProcessingError,
  intelSchedule,
  allowInternalFallback = false,
  correctionPricing,
}: {
  contextDocs: ClientContextDoc[];
  isAdmin?: boolean;
  clientId?: string;
  /** True while a background AI generation cycle is running — locks the Regenerate button. */
  isAiProcessing?: boolean;
  /** Set when the last generation cycle failed — the empty state says so (QA F69). */
  aiProcessingError?: string | null;
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
   * and passed only for billable client viewers — omitted on the staff shell,
   * whose corrections are agency overhead and cost the client nothing.
   */
  correctionPricing?: { cost: number; blockReason?: string };
}) {
  const router = useRouter();
  const [openDoc, setOpenDoc] = useState<{ doc: ClientContextDoc; label: string } | null>(null);
  const [regenModalOpen, setRegenModalOpen] = useState(false);
  const [scheduleModalOpen, setScheduleModalOpen] = useState(false);

  const available = DOC_TABS.map((t) => ({
    ...t,
    pick: pickDoc(contextDocs, t.docType, allowInternalFallback),
  })).filter((i) => i.pick.kind !== "none");

  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between gap-1">
        <p className="px-1 text-[10px] font-semibold uppercase tracking-wider text-muted-2">
          Documents
        </p>
        {isAdmin && clientId && (
          <div className="flex items-center gap-0.5">
            <button
              onClick={() => setScheduleModalOpen(true)}
              title="Configure recurring Intel Report + SEO/GEO regeneration"
              className="flex items-center gap-1 rounded-[5px] px-1.5 py-0.5 text-[10px] font-medium text-muted-2 transition-colors hover:bg-surface-2 hover:text-foreground"
            >
              <Icon name="CalendarClock" className="h-3 w-3" />
              Schedule
            </button>
            <button
              onClick={() => setRegenModalOpen(true)}
              disabled={isAiProcessing}
              title={
                isAiProcessing
                  ? "Karos Agents are already building this workspace — please wait for it to finish"
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
        // and a failed run said the same thing (QA F69).
        <p className="px-1 py-1.5 text-xs text-muted-2">
          {isAiProcessing
            ? "Karos Agents are writing your documents now — this takes a few minutes."
            : aiProcessingError
              ? "Generation stopped early. Your Karos team is on it."
              : "Your brand and strategy documents will appear here once onboarding completes."}
        </p>
      ) : (
        <ul>
          {available.map((item) =>
            item.pick.kind === "doc" ? (
              <li key={item.docType}>
                <button
                  onClick={() =>
                    setOpenDoc({
                      doc: (item.pick as { kind: "doc"; doc: ClientContextDoc }).doc,
                      label: item.label,
                    })
                  }
                  /* Compact rows: the rail is a no-scroll fixed layout (CD-E3),
                     and seven of these were its single tallest block. */
                  className="group flex w-full items-center gap-2.5 rounded-md px-2 py-1 text-left transition-colors hover:bg-surface-2"
                >
                  <Icon name="File" className="h-4 w-4 shrink-0 text-muted-2 group-hover:text-foreground" />
                  <span className="flex-1 truncate text-[13px] leading-5 text-muted group-hover:text-foreground">
                    {item.label}
                  </span>
                </button>
              </li>
            ) : (
              <li key={item.docType}>
                <div
                  className="flex w-full items-center gap-2.5 rounded-md px-2 py-1 text-left"
                  title="This document is being rebuilt — check back shortly."
                >
                  <Icon name="File" className="h-4 w-4 shrink-0 text-muted-2/60" />
                  <span className="flex-1 truncate text-[13px] leading-5 text-muted-2">{item.label}</span>
                  <span className="shrink-0 text-[11px] text-muted-2">Rebuilding</span>
                </div>
              </li>
            ),
          )}
        </ul>
      )}

      {/* An "Agent-specific documents" section used to sit here (X / LinkedIn
          agent data), mounted only when clientId was set — so it appeared and
          disappeared as you moved around the portal, and it competed with the
          real documents list for the rail's fixed height. Agent data intake is
          reachable where it belongs: the AI Agents cards link it per agent
          (buildAgentSetup in clients/[id]/agents/page.tsx), which is also the
          only place that knows whether the client HAS that agent (CD-E1). */}

      {openDoc && (
        <DocOverlay
          doc={openDoc.doc}
          label={openDoc.label}
          clientId={clientId}
          correctionPricing={correctionPricing}
          onClose={() => setOpenDoc(null)}
          onDocUpdated={() => {
            setOpenDoc(null);
            router.refresh();
          }}
        />
      )}

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

      {clientId && (
        <ScheduleModal
          clientId={clientId}
          schedule={
            intelSchedule ?? {
              enabled: false,
              intervalMonths: MIN_INTERVAL_MONTHS,
              dayOfMonth: MIN_DAY_OF_MONTH,
              nextRunAt: null,
              lastIntelReportAt: null,
            }
          }
          open={scheduleModalOpen}
          onClose={() => setScheduleModalOpen(false)}
          onSuccess={() => {
            setScheduleModalOpen(false);
            router.refresh();
          }}
        />
      )}
    </div>
  );
}
