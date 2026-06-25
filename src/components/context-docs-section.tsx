"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Card, CardTitle, Badge, Button } from "@/components/ui";
import { Icon } from "@/components/icon";
import { cn } from "@/lib/utils";
import { refreshClientContextDocsAction } from "@/lib/actions";
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

function renderMarkdown(md: string): string {
  return md
    .replace(/^---[\s\S]*?---\n?/, "")
    .replace(/^# (.+)$/gm, '<h1 class="text-base font-bold mt-4 mb-2">$1</h1>')
    .replace(
      /^## (.+)$/gm,
      '<h2 class="text-sm font-semibold mt-4 mb-1.5 text-neon/80">$1</h2>',
    )
    .replace(
      /^### (.+)$/gm,
      '<h3 class="text-xs font-semibold mt-3 mb-1 text-muted uppercase tracking-wider">$1</h3>',
    )
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*(.+?)\*/g, "<em>$1</em>")
    .replace(
      /`(.+?)`/g,
      '<code class="rounded bg-surface-3 px-1 py-0.5 font-mono text-[11px]">$1</code>',
    )
    .replace(/^---$/gm, '<hr class="my-3 border-border" />')
    .replace(/^\|(.+)\|$/gm, (row) => {
      const cells = row
        .split("|")
        .slice(1, -1)
        .map((c) => c.trim());
      const isSep = cells.every((c) => /^[-:]+$/.test(c));
      if (isSep) return "";
      const tag = "td";
      return `<tr>${cells.map((c) => `<${tag} class="border border-border px-2 py-1 text-xs">${c.replace(/\*\*/g, "")}</${tag}>`).join("")}</tr>`;
    })
    .replace(
      /((<tr>.+<\/tr>\n?)+)/g,
      '<div class="overflow-x-auto my-2"><table class="w-full border-collapse text-xs">$1</table></div>',
    )
    .replace(
      /^- (.+)$/gm,
      '<li class="ml-4 list-disc text-sm text-muted">$1</li>',
    )
    .replace(
      /((<li[^>]*>.+<\/li>\n?)+)/g,
      '<ul class="space-y-0.5 my-1.5">$1</ul>',
    )
    .replace(
      /^\d+\. (.+)$/gm,
      '<li class="ml-4 list-decimal text-sm text-muted">$1</li>',
    )
    .replace(
      /^> (.+)$/gm,
      '<blockquote class="border-l-2 border-neon/40 pl-3 text-xs italic text-muted-2 my-2">$1</blockquote>',
    )
    .replace(
      /^(?!<[a-z]|$)(.+)$/gm,
      '<p class="text-sm text-muted leading-relaxed">$1</p>',
    )
    .replace(/\n{2,}/g, "\n");
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
        <div className="mt-2 rounded-[8px] border border-border bg-surface-2 p-3">
          <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-2">
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

/* ── Doc viewer ───────────────────────────────────────────────── */

function DocViewer({ doc, label }: { doc: ClientContextDoc | null; label: string }) {
  const [expanded, setExpanded] = useState(false);

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
    <div className="w-full min-w-0 max-w-full overflow-hidden space-y-4">
      {/* Meta row */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2 text-[10px] text-muted-2">
          <span>v{doc.version}</span>
          <span>·</span>
          <span>Updated {updatedDate}</span>
          <span>·</span>
          {doc.tier === "client" ? (
            <Badge tone="neon" className="text-[9px]">
              Client-facing
            </Badge>
          ) : (
            <Badge tone="neutral" className="text-[9px]">
              Internal
            </Badge>
          )}
        </div>
        <button
          onClick={() => exportDocToPdf(doc, label)}
          className="flex items-center gap-1 rounded-[6px] border border-border bg-surface-2 px-2 py-1 text-[10px] text-muted-2 transition-colors hover:border-border-strong hover:text-foreground"
          title="Export this document to PDF"
        >
          <Icon name="FileDown" className="h-3 w-3" />
          Export PDF
        </button>
      </div>

      {/* Key insight chips */}
      {insights.length > 0 && (
        <div>
          <p className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-muted-2">
            Key Insights
          </p>
          <div className="flex flex-wrap gap-1.5">
            {insights.map((insight, i) => (
              <span
                key={i}
                className="rounded-full border border-border bg-surface-2 px-2.5 py-1 text-xs leading-tight text-muted"
              >
                {insight.length > 80 ? insight.slice(0, 80) + "…" : insight}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Full document — progressive disclosure */}
      <div>
        <button
          onClick={() => setExpanded((v) => !v)}
          className="mb-3 flex items-center gap-1.5 rounded-[8px] border border-border bg-surface-2 px-3 py-1.5 text-xs font-medium text-muted transition-colors hover:border-border-strong hover:text-foreground"
        >
          <Icon
            name={expanded ? "ChevronUp" : "FileText"}
            className="h-3.5 w-3.5"
          />
          {expanded ? "Collapse document" : "Read full document"}
        </button>

        {expanded && (
          <div className="w-full max-w-full overflow-x-auto break-words rounded-[8px] border border-border bg-surface-2 p-4 text-sm text-foreground [&_code]:break-all [&_pre]:overflow-x-auto [&_table]:min-w-0 [&_td]:break-words [&_th]:break-words">
            <div
              className="w-full min-w-0"
              dangerouslySetInnerHTML={{ __html: renderMarkdown(doc.content) }}
            />
          </div>
        )}
      </div>

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
    currentUserRole === "admin" || currentUserRole === "employee";

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
        <div className="mb-3 flex items-center gap-2 rounded-[8px] border border-red-500/30 bg-red-500/10 px-3 py-2">
          <Icon name="TriangleAlert" className="h-3.5 w-3.5 shrink-0 text-red-400" />
          <p className="text-xs text-red-400">{refreshError}</p>
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
                "flex shrink-0 items-center gap-1.5 rounded-[8px] px-3 py-1.5 text-xs font-medium transition-colors",
                activeTab === tab.docType
                  ? "bg-neon-soft text-neon"
                  : "text-muted-2 hover:bg-surface-2 hover:text-foreground",
              )}
            >
              <Icon name={tab.icon} className="h-3.5 w-3.5 shrink-0" />
              {tab.label}
              <span
                className={cn(
                  "h-1.5 w-1.5 rounded-full transition-colors",
                  hasDoc ? "bg-neon" : "bg-border",
                )}
                title={hasDoc ? "Generated" : "Not generated"}
              />
            </button>
          );
        })}
      </div>

      {/* Doc content */}
      <Card className="min-h-[200px]">
        <DocViewer doc={activeDoc} label={activeTabLabel} />
      </Card>
    </div>
  );
}
