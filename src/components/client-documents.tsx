"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Icon } from "@/components/icon";
import { renderFullDoc } from "@/lib/doc-render";
import type { ClientContextDoc, ContextDocType } from "@/lib/types";

/** Documents surfaced to the client, in display order. Shown only when generated. */
const DOC_TABS: { docType: ContextDocType; label: string }[] = [
  { docType: "brand-voice", label: "Brand Voice" },
  { docType: "market-strategy", label: "Market Strategy" },
  { docType: "competitor-analysis", label: "Competitor Analysis" },
  { docType: "product-information", label: "Product Information" },
  { docType: "branding-guidelines", label: "Branding Guidelines" },
  { docType: "client-guidelines", label: "Guidelines" },
];

/** Prefer the client-facing tier, fall back to internal (never internal-only). */
function pickDoc(docs: ClientContextDoc[], docType: ContextDocType): ClientContextDoc | null {
  return (
    docs.find((d) => d.docType === docType && d.tier === "client") ??
    docs.find((d) => d.docType === docType && d.tier === "internal") ??
    null
  );
}

/* ── Full-document slide-over (50% width) ─────────────────────────────── */

function DocOverlay({
  doc,
  label,
  onClose,
}: {
  doc: ClientContextDoc;
  label: string;
  onClose: () => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prev;
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  // Reset scroll to top whenever the displayed document changes.
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
  }, [doc.id]);

  return createPortal(
    <div
      className="fixed inset-0 z-[10000] flex justify-end"
      style={{ background: "rgba(0,0,0,0.6)", backdropFilter: "blur(3px)" }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="flex h-full w-full max-w-[92%] flex-col border-l border-border bg-surface shadow-2xl animate-slide-in-right md:max-w-[50%]">
        {/* Minimal header — just the title + close; the doc starts where it starts */}
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border px-6 py-3.5">
          <p className="text-sm font-semibold text-foreground">{label}</p>
          <button
            onClick={onClose}
            className="flex h-8 w-8 items-center justify-center rounded-[8px] text-muted transition-colors hover:bg-surface-2 hover:text-foreground"
            aria-label="Close document"
          >
            <Icon name="X" className="h-4 w-4" />
          </button>
        </div>

        {/* Body */}
        <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-6 py-6 md:px-8">
          <div
            className="mx-auto w-full max-w-2xl break-words [&_code]:break-all [&_table]:min-w-0"
            dangerouslySetInnerHTML={{ __html: renderFullDoc(doc.content) }}
          />
        </div>
      </div>
    </div>,
    document.body,
  );
}

/* ── Documents list ───────────────────────────────────────────────────── */

export function ClientDocuments({ contextDocs }: { contextDocs: ClientContextDoc[] }) {
  const [openDoc, setOpenDoc] = useState<{ doc: ClientContextDoc; label: string } | null>(null);

  const available = DOC_TABS.map((t) => ({ ...t, doc: pickDoc(contextDocs, t.docType) })).filter(
    (i) => i.doc,
  );

  return (
    <div>
      <p className="mb-1.5 px-1 text-[10px] font-semibold uppercase tracking-wider text-muted-2">
        Documents
      </p>
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

      {openDoc && (
        <DocOverlay doc={openDoc.doc} label={openDoc.label} onClose={() => setOpenDoc(null)} />
      )}
    </div>
  );
}
