"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { Icon, XLogo } from "@/components/icon";
import { cn } from "@/lib/utils";
import { renderFullDoc, stripDocPreamble } from "@/lib/doc-render";
import { generateIntelReportAction } from "@/lib/actions";
import { CorrectInfoModal } from "@/components/correct-info-modal";
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
 * Prefer the client-facing tier. Fall back to internal when the client tier has fewer
 * ## sections — catches condensation runs that silently dropped a leading section.
 * Never surfaces internal-only tier.
 */
function pickDoc(docs: ClientContextDoc[], docType: ContextDocType): ClientContextDoc | null {
  const clientTier = docs.find((d) => d.docType === docType && d.tier === "client");
  const internalTier = docs.find((d) => d.docType === docType && d.tier === "internal");

  if (!clientTier) return internalTier ?? null;
  if (!internalTier) return clientTier;

  if (countSections(clientTier.content) < countSections(internalTier.content)) {
    return internalTier;
  }

  return clientTier;
}

/* ── Print / export helpers ───────────────────────────────────────────── */

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/**
 * Converts cleaned markdown to print-safe HTML with inline styles.
 * A standalone, Tailwind-free renderer used only for the PDF print window.
 */
function renderForPrint(markdown: string): string {
  let out = markdown
    // Separator lines
    .replace(/^---+$/gm, "")
    // H2 headings
    .replace(/^##\s+(.+)$/gm, "<h2>$1</h2>")
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

  // Bullet lists (sentinel to avoid nested re-match)
  out = out.replace(/^[-*+]\s+(.+)$/gm, "\x02$1\x03");
  out = out.replace(/(\x02[\s\S]*?\x03\n?)+/g, (block) => {
    const items = block.replace(/\x02([\s\S]*?)\x03/g, "<li>$1</li>");
    return `<ul>${items}</ul>\n`;
  });

  // Ordered lists
  out = out.replace(/^\d+\.\s+(.+)$/gm, "\x04$1\x05");
  out = out.replace(/(\x04[\s\S]*?\x05\n?)+/g, (block) => {
    const items = block.replace(/\x04([\s\S]*?)\x05/g, "<li>$1</li>");
    return `<ol>${items}</ol>\n`;
  });

  // Blockquotes
  out = out.replace(/^>\s+(.+)$/gm, "<blockquote>$1</blockquote>");

  // Remaining plain lines → paragraphs
  out = out.replace(/^(?!<[a-zA-Z/]|$|\s*$)(.+)$/gm, "<p>$1</p>");

  return out.replace(/\n{3,}/g, "\n\n").trim();
}

function buildPrintWindow(content: string, title: string): void {
  const clean = stripDocPreamble(content);
  const body = renderForPrint(clean);

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
    p  { margin: 5px 0; font-size: 11pt; color: #222; }
    ul, ol { margin: 6px 0; padding-left: 22px; }
    li { margin: 3px 0; font-size: 11pt; }
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
            <Icon name="FileText" className="h-3.5 w-3.5 shrink-0 text-muted-2" />
            <div>
              <p className="font-medium text-foreground">Export PDF</p>
              <p className="text-[10px] text-muted-2">Opens print dialog</p>
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
              <p className="text-[10px] text-muted-2">Downloads .md file</p>
            </div>
          </button>
        </div>
      )}
    </div>
  );
}

/* ── Full-document slide-over (50% width) ─────────────────────────────── */

function DocOverlay({
  doc,
  label,
  onClose,
  onDocUpdated,
}: {
  doc: ClientContextDoc;
  label: string;
  clientId?: string;
  onClose: () => void;
  onDocUpdated?: () => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [correcting, setCorrecting] = useState(false);

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
            <p className="text-sm font-semibold text-foreground">{label}</p>
            <div className="flex items-center gap-2">
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
            <div
              className="mx-auto w-full max-w-2xl break-words [&_code]:break-all [&_table]:min-w-0"
              dangerouslySetInnerHTML={{ __html: renderFullDoc(doc.content) }}
            />
          </div>
        </div>
      </div>

      <CorrectInfoModal
        documentId={doc.id}
        docLabel={label}
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
          <p className="text-sm text-muted">
            Optionally add run-specific context for this regeneration. These instructions apply
            to{" "}
            <span className="font-medium text-foreground">this run only</span> and take the
            highest priority if they conflict with global settings.
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
            {running ? "Running pipeline…" : "Confirm & Run"}
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
}: {
  contextDocs: ClientContextDoc[];
  isAdmin?: boolean;
  clientId?: string;
  /** True while a background AI generation cycle is running — locks the Regenerate button. */
  isAiProcessing?: boolean;
}) {
  const router = useRouter();
  const [openDoc, setOpenDoc] = useState<{ doc: ClientContextDoc; label: string } | null>(null);
  const [regenModalOpen, setRegenModalOpen] = useState(false);

  const available = DOC_TABS.map((t) => ({ ...t, doc: pickDoc(contextDocs, t.docType) })).filter(
    (i) => i.doc,
  );

  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between gap-1">
        <p className="px-1 text-[10px] font-semibold uppercase tracking-wider text-muted-2">
          Documents
        </p>
        {isAdmin && clientId && (
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
        )}
      </div>

      {available.length === 0 ? (
        <p className="px-1 py-1.5 text-xs text-muted-2">
          Your brand and strategy documents will appear here once onboarding completes.
        </p>
      ) : (
        <ul>
          {available.map((item) => (
            <li key={item.docType}>
              <button
                onClick={() => setOpenDoc({ doc: item.doc!, label: item.label })}
                className="group flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-surface-2"
              >
                <Icon name="FileText" className="h-4 w-4 shrink-0 text-muted-2 group-hover:text-foreground" />
                <span className="flex-1 truncate text-sm text-muted group-hover:text-foreground">
                  {item.label}
                </span>
                <Icon name="ChevronRight" className="h-3.5 w-3.5 shrink-0 text-muted-2" />
              </button>
            </li>
          ))}
        </ul>
      )}

      {clientId && (
        <>
          <p className="mb-1.5 mt-4 px-1 text-[10px] font-semibold uppercase tracking-wider text-muted-2">
            Agent-specific documents
          </p>
          <ul>
            <li>
              <a
                href={`/clients/${clientId}/x-agent`}
                className="group flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-surface-2"
              >
                <XLogo className="h-3.5 w-3.5 shrink-0 text-muted-2 group-hover:text-foreground" />
                <span className="flex-1 truncate text-sm text-muted group-hover:text-foreground">
                  X agent data
                </span>
                <Icon name="ChevronRight" className="h-3.5 w-3.5 shrink-0 text-muted-2" />
              </a>
            </li>
          </ul>
        </>
      )}

      {openDoc && (
        <DocOverlay
          doc={openDoc.doc}
          label={openDoc.label}
          clientId={clientId}
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
    </div>
  );
}
