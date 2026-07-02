"use client";

import { useState, useTransition, useMemo, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { Card, CardTitle, Badge, Button } from "@/components/ui";
import { Icon } from "@/components/icon";
import { cn } from "@/lib/utils";
import { refreshClientContextDocsAction, generateDocSummaryAction } from "@/lib/actions";
import type { ClientContextDoc, ContextDocType, Role } from "@/lib/types";

/* ── Tab config ───────────────────────────────────────────────── */

const TABS: { docType: ContextDocType; label: string; icon: string }[] = [
  { docType: "brand-voice", label: "Brand Voice", icon: "Mic2" },
  { docType: "market-strategy", label: "Market Strategy", icon: "Target" },
  { docType: "competitor-analysis", label: "Competitors", icon: "Users" },
  { docType: "product-information", label: "Product", icon: "Package" },
  { docType: "branding-guidelines", label: "Branding", icon: "Palette" },
];

/* ── Utilities ────────────────────────────────────────────────── */

function extractKeyInsights(content: string): string[] {
  const stripped = content.replace(/^---[\s\S]*?---\n?/, "");
  const insights: string[] = [];
  for (const line of stripped.split("\n")) {
    const m = line.match(/^[-*+]\s+(.+)/);
    if (m?.[1]) {
      const text = m[1]
        .replace(/\*\*/g, "")
        .replace(/\*/g, "")
        .replace(/`/g, "")
        .trim();
      if (
        text.length >= 18 &&
        text.length <= 140 &&
        !/^(data unavailable|n\/a|tbd)/i.test(text)
      ) {
        insights.push(text);
      }
    }
    if (insights.length >= 4) break;
  }
  return insights;
}

/** Render the body of a single document section (no ## headings expected inside). */
function renderSectionBody(md: string): string {
  // Strip horizontal rules that appear as noise
  let out = md.replace(/^---+$/gm, "");

  // Sub-headings (###) → small label pills rather than big headings
  out = out.replace(
    /^###\s+(.+)$/gm,
    '<p class="mt-4 mb-1 text-[10px] font-mono font-medium uppercase tracking-[0.14em] text-muted-2">$1</p>',
  );

  // Bold / italic / inline-code
  out = out
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*(.+?)\*/g, "<em>$1</em>")
    .replace(
      /`(.+?)`/g,
      '<code class="rounded bg-surface-3 px-1 py-0.5 font-mono text-[10px]">$1</code>',
    );

  // Tables — detect header row (row before separator)
  const tableBlockRe = /((?:^\|.+\|\n?){2,})/gm;
  out = out.replace(tableBlockRe, (block) => {
    const rawLines = block.trim().split("\n").map((l) => l.trim()).filter(Boolean);
    const sepIdx = rawLines.findIndex((l) => /^\|[-:\s|]+\|$/.test(l));
    const parseCells = (row: string, tag: "th" | "td") => {
      const cells = row.split("|").slice(1, -1).map((c) => c.replace(/\*\*/g, "").trim());
      const cls =
        tag === "th"
          ? "px-3 py-2 text-left text-[10px] font-mono font-medium uppercase tracking-[0.14em] text-muted-2 border-b border-border"
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
    return `<div class="overflow-x-auto my-3 rounded-md border border-border"><table class="w-full border-collapse">${thead}${tbody}</table></div>\n`;
  });

  // Bullet lists
  out = out.replace(/^[-*+]\s+(.+)$/gm, "<li>$1</li>");
  out = out.replace(
    /(<li>[\s\S]*?<\/li>\n?)+/g,
    (block) =>
      `<ul class="my-2 space-y-1.5 ml-0 [&>li]:flex [&>li]:gap-2 [&>li]:text-sm [&>li]:text-muted [&>li]:leading-[1.65] [&>li]:before:content-['▸'] [&>li]:before:text-muted-2 [&>li]:before:text-[10px] [&>li]:before:mt-[3px] [&>li]:before:shrink-0">${block}</ul>\n`,
  );

  // Numbered lists
  out = out.replace(/^\d+\.\s+(.+)$/gm, "<li>$1</li>");
  out = out.replace(
    /(<li>[\s\S]*?<\/li>\n?)+/g,
    (block) =>
      `<ol class="my-2 space-y-1.5 ml-4 list-decimal [&>li]:text-sm [&>li]:text-muted [&>li]:leading-[1.65] marker:text-muted-2">${block}</ol>\n`,
  );

  // Blockquotes
  out = out.replace(
    /^>\s+(.+)$/gm,
    '<blockquote class="border-l-2 border-border-strong pl-3 py-0.5 text-xs italic text-muted-2 my-2">$1</blockquote>',
  );

  // Plain paragraphs (lines not already wrapped in a tag)
  out = out.replace(
    /^(?!<[a-zA-Z/]|$|\s*$)(.+)$/gm,
    '<p class="text-sm text-muted leading-[1.7] my-1">$1</p>',
  );

  return out.replace(/\n{3,}/g, "\n\n").trim();
}

/** For the PDF export only — flat single-page render (keeps existing behaviour). */
function renderMarkdown(md: string): string {
  const clean = md.replace(/^---[\s\S]*?---\n?/, "").replace(/^# .+\n?/m, "");
  // Split into sections and render each body, joining with h2 labels
  const parts = clean.split(/^##\s+(.+)$/m);
  let out = "";
  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 1) {
      out += `<h2 class="text-sm font-semibold mt-6 mb-2 text-foreground">${parts[i]}</h2>`;
    } else {
      out += renderSectionBody(parts[i]);
    }
  }
  return out;
}

/* ── PDF export ───────────────────────────────────────────────── */

function exportDocToPdf(doc: ClientContextDoc, label: string) {
  const body = renderMarkdown(doc.content);
  const updatedDate = new Date(doc.updatedAt).toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>${label}</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:13px;line-height:1.65;color:#111;padding:48px;max-width:820px;margin:0 auto}
header{border-bottom:2px solid #e5e7eb;padding-bottom:16px;margin-bottom:28px}
header h1{font-size:22px;font-weight:700}
header p{font-size:11px;color:#6b7280;margin-top:4px}
h1.text-base{font-size:16px;font-weight:700;margin:24px 0 8px}
h2.text-sm{font-size:13px;font-weight:600;color:#059669;margin:20px 0 6px}
h3.text-xs{font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.05em;color:#6b7280;margin:14px 0 4px}
p.text-sm{font-size:13px;color:#374151;margin:6px 0}
ul{margin:6px 0 8px 18px}
li{font-size:13px;color:#374151;margin:3px 0}
blockquote{border-left:2px solid #059669;padding-left:12px;font-style:italic;color:#6b7280;font-size:12px;margin:10px 0}
table{width:100%;border-collapse:collapse;margin:10px 0;font-size:12px}
td,th{border:1px solid #e5e7eb;padding:6px 10px;text-align:left}
code{background:#f3f4f6;padding:1px 4px;border-radius:3px;font-size:11px;font-family:monospace}
hr{border:none;border-top:1px solid #e5e7eb;margin:18px 0}
strong{font-weight:600}
@media print{body{padding:24px}@page{margin:20mm}}
</style>
</head>
<body>
<header>
  <h1>${label}</h1>
  <p>v${doc.version} · Updated ${updatedDate} · Karos CMO Intelligence Document</p>
</header>
<main>${body}</main>
</body>
</html>`;

  const win = window.open("", "_blank");
  if (!win) return;
  win.document.write(html);
  win.document.close();
  win.focus();
  win.setTimeout(() => win.print(), 300);
}

/* ── Sources drawer ───────────────────────────────────────────── */

function SourcesDrawer({ sources }: { sources?: string[] }) {
  const [open, setOpen] = useState(false);
  if (!sources || sources.length === 0) return null;

  return (
    <div className="mt-3 border-t border-border pt-3">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 text-xs text-muted-2 transition-colors hover:text-muted"
      >
        <Icon name={open ? "ChevronUp" : "ChevronDown"} className="h-3 w-3" />
        {open ? "Hide" : "View"} sources &amp; methodology
        <span className="rounded-full bg-surface-3 px-1.5 py-0.5 text-[10px]">
          {sources.length}
        </span>
      </button>
      {open && (
        <div className="mt-2 rounded-md border border-border bg-surface-2 p-3">
          <p className="mb-1.5 text-[10px] font-mono font-medium uppercase tracking-[0.14em] text-muted-2">
            Research Sources
          </p>
          <ol className="space-y-1">
            {sources.map((s, i) => (
              <li key={i} className="flex items-start gap-2 text-xs text-muted">
                <span className="mt-0.5 shrink-0 font-mono text-[10px] text-muted-2">
                  {i + 1}.
                </span>
                <span>{s}</span>
              </li>
            ))}
          </ol>
        </div>
      )}
    </div>
  );
}

/* ── Doc section parsing ──────────────────────────────────────── */

interface DocSection {
  heading: string;
  body: string;
}

const PLACEHOLDER_RE = /\b(n\/a|unknown|not\s+provided|not\s+applicable|data\s+unavailable|tbd)\b/gi;

function parseDocSections(content: string): DocSection[] {
  // Remove YAML frontmatter and H1 title
  const clean = content
    .replace(/^---[\s\S]*?---\n?/, "")
    .replace(/^#\s+.+\n?/m, "")
    .trim();

  const parts = clean.split(/^##\s+/m);
  const sections: DocSection[] = [];

  for (const part of parts) {
    if (!part.trim()) continue;
    const nl = part.indexOf("\n");
    const heading = nl > 0 ? part.slice(0, nl).trim() : part.trim();
    const body = nl > 0 ? part.slice(nl + 1).trim() : "";
    // Skip sections whose body is empty or only placeholders
    const stripped = body.replace(PLACEHOLDER_RE, "").replace(/[|\-\s]/g, "").trim();
    if (!stripped || stripped.length < 8) continue;
    sections.push({ heading, body });
  }
  return sections;
}

/* ── Doc viewer ───────────────────────────────────────────────── */

type ViewMode = "summary" | "full";
type SummaryStatus = "idle" | "loading" | "done" | "error";

function DocViewer({
  doc,
  label,
  clientId,
}: {
  doc: ClientContextDoc | null;
  label: string;
  clientId: string;
}) {
  const sections = useMemo(() => (doc ? parseDocSections(doc.content) : []), [doc]);
  const [openSet, setOpenSet] = useState<Set<number>>(() => new Set([0]));
  const [viewMode, setViewMode] = useState<ViewMode>("summary");
  const [summaryStatus, setSummaryStatus] = useState<SummaryStatus>("idle");
  const [summaryBullets, setSummaryBullets] = useState<string[]>([]);
  // Cache summaries by doc.id so tab-switching doesn't re-fetch
  const cache = useRef<Map<string, string[]>>(new Map());

  function toggle(i: number) {
    setOpenSet((prev) => {
      const next = new Set(prev);
      next.has(i) ? next.delete(i) : next.add(i);
      return next;
    });
  }

  // Auto-generate summary when doc changes and we're in summary mode
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional reset of derived UI state when doc changes
    setViewMode("summary");
    setOpenSet(new Set([0]));
    if (!doc) {
      setSummaryBullets([]);
      setSummaryStatus("idle");
      return;
    }
    const cached = cache.current.get(doc.id);
    if (cached) {
      setSummaryBullets(cached);
      setSummaryStatus("done");
      return;
    }
    setSummaryStatus("loading");
    setSummaryBullets([]);
    generateDocSummaryAction(clientId, doc.docType, doc.tier)
      .then((bullets) => {
        cache.current.set(doc.id, bullets);
        setSummaryBullets(bullets);
        setSummaryStatus("done");
      })
      .catch(() => setSummaryStatus("error"));
  }, [doc?.id, clientId]);

  if (!doc) {
    return (
      <div className="flex flex-col items-center gap-2 py-12 text-center">
        <Icon name="FileQuestion" className="h-8 w-8 text-muted-2" />
        <p className="text-sm font-medium">Not generated yet</p>
        <p className="text-xs text-muted-2">
          Run the intelligence report to generate this document.
        </p>
      </div>
    );
  }

  const updatedDate = new Date(doc.updatedAt).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });

  const insights = extractKeyInsights(doc.content);

  return (
    <div className="w-full min-w-0 space-y-4 overflow-x-hidden">
      {/* Meta row */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2 text-[10px] text-muted-2">
          <span>v{doc.version}</span>
          <span>·</span>
          <span>Updated {updatedDate}</span>
          <span>·</span>
          {doc.tier === "client" ? (
            <Badge tone="neon" className="text-[9px]">Client-facing</Badge>
          ) : (
            <Badge tone="neutral" className="text-[9px]">Internal</Badge>
          )}
        </div>
        <div className="flex items-center gap-2">
          {/* View mode toggle */}
          <div className="flex items-center rounded-md border border-border bg-surface-2 p-0.5">
            <button
              onClick={() => setViewMode("summary")}
              className={cn(
                "flex items-center gap-1.5 rounded-[6px] px-2.5 py-1 text-[11px] font-medium transition-colors",
                viewMode === "summary"
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-2 hover:text-foreground",
              )}
            >
              <Icon name="Sparkles" className="h-3 w-3" />
              Summary
            </button>
            <button
              onClick={() => setViewMode("full")}
              className={cn(
                "flex items-center gap-1.5 rounded-[6px] px-2.5 py-1 text-[11px] font-medium transition-colors",
                viewMode === "full"
                  ? "bg-surface-3 text-foreground"
                  : "text-muted-2 hover:text-foreground",
              )}
            >
              <Icon name="FileText" className="h-3 w-3" />
              Full Document
            </button>
          </div>
          <button
            onClick={() => exportDocToPdf(doc, label)}
            className="flex items-center gap-1 rounded-[6px] border border-border bg-surface-2 px-2 py-1 text-[10px] text-muted-2 transition-colors hover:border-border-strong hover:text-foreground"
            title="Export this document to PDF"
          >
            <Icon name="FileDown" className="h-3 w-3" />
            PDF
          </button>
        </div>
      </div>

      {/* ── Summary view ── */}
      {viewMode === "summary" && (
        <div>
          {summaryStatus === "loading" && (
            <div className="flex items-center gap-3 rounded-md border border-border bg-surface-2 px-4 py-6">
              <div className="h-4 w-4 animate-spin rounded-full border-2 border-neon/30 border-t-neon" />
              <p className="text-sm text-muted-2">Generating executive summary…</p>
            </div>
          )}

          {summaryStatus === "done" && summaryBullets.length > 0 && (
            <div className="rounded-md border border-border bg-surface-2/60 p-5">
              <div className="mb-4 flex items-center gap-2">
                <Icon name="Sparkles" className="h-4 w-4 text-foreground/70" />
                <p className="text-xs font-mono font-medium uppercase tracking-[0.14em] text-foreground">
                  Executive Summary
                </p>
              </div>
              <ul className="space-y-3">
                {summaryBullets.map((bullet, i) => (
                  <li key={i} className="flex items-start gap-3">
                    <span className="mt-[3px] flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-surface-3 text-[10px] font-bold text-foreground">
                      {i + 1}
                    </span>
                    <p className="text-sm leading-[1.65] text-foreground">{bullet}</p>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {summaryStatus === "error" && (
            <div className="flex items-center gap-2 rounded-md border border-danger/20 bg-danger/10 px-4 py-3">
              <Icon name="TriangleAlert" className="h-4 w-4 shrink-0 text-danger" />
              <p className="text-xs text-danger">
                Could not generate summary. Switch to Full Document to read the content.
              </p>
            </div>
          )}

          {/* Key insight chips below summary */}
          {summaryStatus === "done" && insights.length > 0 && (
            <div className="mt-3">
              <p className="mb-2 text-[10px] font-mono font-medium uppercase tracking-[0.14em] text-muted-2">
                Key Signals
              </p>
              <div className="flex flex-wrap gap-1.5">
                {insights.map((insight, i) => (
                  <span
                    key={i}
                    className="rounded-full border border-border bg-surface-2 px-2.5 py-1 text-xs leading-tight text-muted"
                  >
                    {insight.length > 90 ? insight.slice(0, 90) + "…" : insight}
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── Full document view (accordion) ── */}
      {viewMode === "full" && (
        <>
          {sections.length === 0 ? (
            <p className="py-6 text-center text-xs text-muted-2">No content sections found.</p>
          ) : (
            <div className="divide-y divide-border overflow-hidden rounded-md border border-border">
              {sections.map((sec, i) => {
                const isOpen = openSet.has(i);
                return (
                  <div key={i}>
                    <button
                      onClick={() => toggle(i)}
                      className={cn(
                        "flex w-full items-center justify-between gap-3 px-4 py-3 text-left transition-colors",
                        isOpen ? "bg-surface-2" : "hover:bg-surface-2/60",
                      )}
                      aria-expanded={isOpen}
                    >
                      <span className={cn("text-sm font-medium", isOpen ? "text-foreground" : "text-muted")}>
                        {sec.heading}
                      </span>
                      <Icon
                        name={isOpen ? "ChevronUp" : "ChevronDown"}
                        className="h-3.5 w-3.5 shrink-0 text-muted-2"
                      />
                    </button>
                    {isOpen && (
                      <div
                        className="w-full min-w-0 overflow-x-hidden break-words px-4 pb-4 pt-3 [&_code]:break-all [&_table]:min-w-0 [&_td]:break-words [&_th]:break-words"
                        dangerouslySetInnerHTML={{ __html: renderSectionBody(sec.body) }}
                      />
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}

      {/* Sources drawer */}
      <SourcesDrawer sources={doc.sources} />
    </div>
  );
}

/* ── Main component ───────────────────────────────────────────── */

interface Props {
  clientId: string;
  contextDocs: ClientContextDoc[];
  currentUserRole: Role;
}

export function ContextDocsSection({
  clientId,
  contextDocs,
  currentUserRole,
}: Props) {
  const router = useRouter();
  const [activeTab, setActiveTab] = useState<ContextDocType>("brand-voice");
  const [refreshing, startRefresh] = useTransition();
  const [refreshError, setRefreshError] = useState<string | null>(null);

  const isStaff =
    currentUserRole === "KAROS_ADMIN" || currentUserRole === "KAROS_EMPLOYEE";

  function getDoc(docType: ContextDocType): ClientContextDoc | null {
    const preferTier = isStaff ? "internal" : "client";
    const fallbackTier = isStaff ? "client" : "internal";
    return (
      contextDocs.find(
        (d) => d.docType === docType && d.tier === preferTier,
      ) ??
      contextDocs.find(
        (d) => d.docType === docType && d.tier === fallbackTier,
      ) ??
      null
    );
  }

  function handleRefresh() {
    setRefreshError(null);
    startRefresh(async () => {
      try {
        await refreshClientContextDocsAction(clientId);
        router.refresh();
      } catch (e) {
        setRefreshError(
          e instanceof Error ? e.message : "Refresh failed. Try again.",
        );
      }
    });
  }

  const activeDoc = getDoc(activeTab);
  const activeTabLabel = TABS.find((t) => t.docType === activeTab)?.label ?? activeTab;
  const hasAnyDocs = contextDocs.length > 0;

  return (
    <div className="w-full min-w-0">
      {/* Section header */}
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <CardTitle>Client Profile Documents</CardTitle>
          <p className="mt-0.5 text-xs text-muted-2">
            {isStaff
              ? "Full internal analyst docs · Client sees the condensed version"
              : "Your brand and strategy profile"}
          </p>
        </div>
        {isStaff && hasAnyDocs && (
          <Button
            size="sm"
            variant="outline"
            loading={refreshing}
            onClick={handleRefresh}
            title="Re-condense internal docs into fresh client-facing versions"
          >
            <Icon name="RefreshCw" className="h-3.5 w-3.5" />
            {refreshing ? "Refreshing…" : "Refresh client docs"}
          </Button>
        )}
      </div>

      {refreshError && (
        <div className="mb-3 flex items-center gap-2 rounded-md border border-danger/30 bg-danger/10 px-3 py-2">
          <Icon name="TriangleAlert" className="h-3.5 w-3.5 shrink-0 text-danger" />
          <p className="text-xs text-danger">{refreshError}</p>
        </div>
      )}

      {/* Tab strip with status dots */}
      <div className="mb-4 flex gap-1 overflow-x-auto pb-1">
        {TABS.map((tab) => {
          const doc = getDoc(tab.docType);
          const hasDoc = !!doc;
          return (
            <button
              key={tab.docType}
              onClick={() => setActiveTab(tab.docType)}
              className={cn(
                "flex shrink-0 items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors",
                activeTab === tab.docType
                  ? "bg-surface-2 text-foreground"
                  : "text-muted-2 hover:bg-surface-2 hover:text-foreground",
              )}
            >
              <Icon name={tab.icon} className="h-3.5 w-3.5 shrink-0" />
              {tab.label}
              <span
                className={cn(
                  "h-1.5 w-1.5 rounded-full transition-colors",
                  hasDoc ? "bg-success" : "bg-border",
                )}
                title={hasDoc ? "Generated" : "Not generated"}
              />
            </button>
          );
        })}
      </div>

      {/* Doc content */}
      <Card className="min-h-[200px]">
        <DocViewer doc={activeDoc} label={activeTabLabel} clientId={clientId} />
      </Card>
    </div>
  );
}
