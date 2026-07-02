"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Card, CardTitle, Button, Badge, EmptyState } from "@/components/ui";
import { Icon } from "@/components/icon";
import { cn, initials } from "@/lib/utils";
import { BrandingModal } from "@/components/branding-modal";
import { CompetitorManager } from "@/components/competitor-manager";
import {
  generateBrandingAction,
  generateIntelReportAction,
} from "@/lib/actions";
import { ContextDocsSection } from "@/components/context-docs-section";
import type {
  Client,
  ClientContextDoc,
  ClientReport,
  ClientCompetitor,
  ContextDocType,
  Role,
} from "@/lib/types";

/* ── Context-doc utilities ────────────────────────────────────── */

const SOCIAL_PLATFORMS = [
  "Instagram", "LinkedIn", "TikTok", "Facebook", "YouTube",
  "Pinterest", "WhatsApp", "Telegram", "Snapchat",
];

function extractValueProp(docs: ClientContextDoc[]): string | null {
  const doc =
    docs.find((d) => d.docType === "brand-voice" && d.tier === "client") ??
    docs.find((d) => d.docType === "brand-voice");
  if (!doc) return null;

  const content = doc.content.replace(/^---[\s\S]*?---\n?/, "").trim();
  const vpMatch = content.match(
    /##?\s*(?:value prop(?:osition)?|core pos(?:itioning)?|what we do|our mission)[^\n]*\n+([\s\S]{30,300}?)(?:\n##|\n---|\n\n\n|$)/i,
  );
  if (vpMatch?.[1]) {
    return vpMatch[1]
      .replace(/^[-*#>\s]+/gm, "")
      .replace(/\*\*/g, "")
      .trim()
      .slice(0, 200);
  }
  for (const line of content.split("\n")) {
    const clean = line.replace(/^[#\-*>|]+\s*/, "").replace(/\*\*/g, "").trim();
    if (clean.length >= 40 && !clean.startsWith("---")) {
      return clean.slice(0, 200);
    }
  }
  return null;
}

function detectChannels(docs: ClientContextDoc[], hasWebsite: boolean): string[] {
  const found: string[] = hasWebsite ? ["Website"] : [];
  const content = docs.map((d) => d.content).join(" ").toLowerCase();
  if (content.includes("twitter") || content.includes("x.com")) found.push("X / Twitter");
  for (const p of SOCIAL_PLATFORMS) {
    if (content.includes(p.toLowerCase())) found.push(p);
  }
  return [...new Set(found)].slice(0, 6);
}

function extractInsights(docs: ClientContextDoc[], docType: ContextDocType): string[] {
  const doc =
    docs.find((d) => d.docType === docType && d.tier === "client") ??
    docs.find((d) => d.docType === docType);
  if (!doc) return [];
  const stripped = doc.content.replace(/^---[\s\S]*?---\n?/, "");
  const insights: string[] = [];
  for (const line of stripped.split("\n")) {
    const m = line.match(/^[-*+]\s+(.+)/);
    if (m?.[1]) {
      const text = m[1].replace(/\*\*/g, "").replace(/\*/g, "").trim();
      if (text.length >= 15 && text.length <= 120) insights.push(text);
    }
    if (insights.length >= 3) break;
  }
  return insights;
}

/* ── Quick Insights extraction helpers ───────────────────────── */

function extractTargetAudience(contextDocs: ClientContextDoc[]): string | null {
  const doc =
    contextDocs.find((d) => d.docType === "market-strategy") ??
    contextDocs.find((d) => d.docType === "brand-voice");
  if (!doc) return null;
  const content = doc.content.replace(/^---[\s\S]*?---\n?/, "");
  const patterns = [
    /(?:target\s+audience|ideal\s+customer|icp|customer\s+profile|who\s+(?:we|they)\s+serve)[^:\n]*[:\s]+([^\n]{10,80})/i,
    /\*\*(?:target|audience|icp|customer)[^*]*\*\*[:\s]+([^\n]{10,80})/i,
  ];
  for (const pat of patterns) {
    const m = pat.exec(content);
    if (m?.[1]) return m[1].replace(/^[-*]\s*/, "").replace(/\*\*/g, "").trim().slice(0, 65);
  }
  for (const line of content.split("\n")) {
    const m = line.match(/^[-*+]\s+(.{20,80})/);
    if (m) return m[1].replace(/\*\*/g, "").trim().slice(0, 65);
  }
  return null;
}

const CHANNEL_DIMENSIONS = new Set([
  "Social Media & Community",
  "Content & Messaging",
  "SEO & Discoverability",
  "GEO & AI Discoverability",
]);

const DIMENSION_TO_CHANNEL: Record<string, string> = {
  "Social Media & Community": "Social Media",
  "Content & Messaging": "Content Marketing",
  "SEO & Discoverability": "Organic SEO",
  "GEO & AI Discoverability": "AI Search",
};

function extractTopChannel(report: ClientReport | null): string | null {
  if (!report?.dimensionScores?.length) return null;
  const top = [...report.dimensionScores]
    .filter((d) => CHANNEL_DIMENSIONS.has(d.dimension))
    .sort((a, b) => b.score - a.score)[0];
  return top ? (DIMENSION_TO_CHANNEL[top.dimension] ?? top.dimension) : null;
}

function extractPainPoint(report: ClientReport | null, contextDocs: ClientContextDoc[]): string | null {
  const weakness = report?.swot?.weaknesses?.find((w) => w.length > 5);
  if (weakness) return weakness.slice(0, 80);
  const doc =
    contextDocs.find((d) => d.docType === "competitor-analysis") ??
    contextDocs.find((d) => d.docType === "market-strategy");
  if (doc) {
    const stripped = doc.content.replace(/^---[\s\S]*?---\n?/, "");
    for (const line of stripped.split("\n")) {
      const m = line.match(/^[-*+]\s+(.{15,80})/);
      if (m && /pain|challenge|problem|barrier|cost|difficult|gap|issue/i.test(m[1]))
        return m[1].replace(/\*\*/g, "").trim().slice(0, 80);
    }
  }
  return null;
}

function extractOpportunity(report: ClientReport | null): string | null {
  const opp = report?.swot?.opportunities?.find((o) => o.length > 5);
  if (opp) return opp.slice(0, 80);
  return report?.whitespaceOpportunities?.[0]?.slice(0, 80) ?? null;
}

/* ── Quick Insights hero cards ────────────────────────────────── */

interface InsightCard {
  icon: Parameters<typeof Icon>[0]["name"];
  label: string;
  value: string;
  iconClass: string;
  bgClass: string;
}

function QuickInsights({
  report,
  contextDocs,
}: {
  report: ClientReport | null;
  contextDocs: ClientContextDoc[];
}) {
  const raw: (InsightCard | null)[] = [
    (() => {
      const v = extractTargetAudience(contextDocs);
      return v
        ? { icon: "Users", label: "Target Audience", value: v, iconClass: "text-neon", bgClass: "bg-neon-soft" }
        : null;
    })(),
    (() => {
      const v = extractTopChannel(report);
      return v
        ? { icon: "TrendingUp", label: "Top Channel", value: v, iconClass: "text-foreground/70", bgClass: "bg-foreground/[0.05]" }
        : null;
    })(),
    (() => {
      const v = extractPainPoint(report, contextDocs);
      return v
        ? { icon: "TriangleAlert", label: "Key Challenge", value: v, iconClass: "text-warning", bgClass: "bg-warning/10" }
        : null;
    })(),
    (() => {
      const v = extractOpportunity(report);
      return v
        ? { icon: "Target", label: "Market Opportunity", value: v, iconClass: "text-foreground/70", bgClass: "bg-foreground/[0.05]" }
        : null;
    })(),
  ];

  const cards = raw.filter((c): c is InsightCard => c !== null);
  if (cards.length === 0) return null;

  const gridCols =
    cards.length === 1
      ? "sm:grid-cols-1"
      : cards.length === 2
        ? "sm:grid-cols-2"
        : cards.length === 3
          ? "sm:grid-cols-3"
          : "sm:grid-cols-2 lg:grid-cols-4";

  return (
    <div className={cn("grid gap-3", gridCols)}>
      {cards.map((card) => (
        <div
          key={card.label}
          className="card-grad flex flex-col gap-3 rounded-md border border-border p-4 transition-all duration-200 hover:-translate-y-0.5 hover:border-border-strong hover:shadow-[0_8px_24px_rgba(0,0,0,0.35)]"
        >
          <div className={cn("flex h-8 w-8 items-center justify-center rounded-md", card.bgClass)}>
            <Icon name={card.icon} className={cn("h-4 w-4", card.iconClass)} />
          </div>
          <div>
            <p className="text-[10px] font-mono font-medium uppercase tracking-[0.14em] text-muted-2">
              {card.label}
            </p>
            <p className="mt-1 text-sm font-medium leading-snug text-foreground">
              {card.value}
            </p>
          </div>
        </div>
      ))}
    </div>
  );
}

/* ── Company Profile Snapshot ─────────────────────────────────── */

function CompanyProfileSnapshot({
  client,
  report,
  competitors,
  contextDocs,
}: {
  client: Client;
  report: ClientReport | null;
  competitors: ClientCompetitor[];
  contextDocs: ClientContextDoc[];
}) {
  const valueProp = extractValueProp(contextDocs) ?? client.description;
  const channels = detectChannels(contextDocs, !!client.website);
  const isOnboarded = contextDocs.length > 0;

  const topComps = [...competitors]
    .sort((a, b) => {
      const ord: Record<string, number> = { HIGH: 0, MEDIUM: 1, LOW: 2 };
      return (ord[a.threatLevel ?? ""] ?? 3) - (ord[b.threatLevel ?? ""] ?? 3);
    })
    .slice(0, 3);

  const displayUrl = client.website
    ? client.website.replace(/^https?:\/\//, "").replace(/\/$/, "")
    : null;

  return (
    <div className="card-grad rounded-md border border-border p-5 shadow-[0_2px_8px_rgba(0,0,0,0.3)]">
      {/* Header */}
      <div className="mb-4 flex items-start gap-3.5">
        <div
          className="flex h-12 w-12 shrink-0 items-center justify-center rounded-md text-base font-bold"
          style={{
            background: (client.accentColor ?? "#FF6B2C") + "1f",
            color: client.accentColor ?? "#FF6B2C",
          }}
        >
          {initials(client.name)}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-base font-semibold">{client.name}</span>
            {isOnboarded && (
              <Badge tone="neon" className="gap-1 text-[10px]">
                <Icon name="Zap" className="h-2.5 w-2.5" />
                Onboarded
              </Badge>
            )}
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-muted-2">
            {client.industry && <span>{client.industry}</span>}
            {client.industry && displayUrl && <span>·</span>}
            {displayUrl && (
              <a
                href={
                  client.website!.startsWith("http")
                    ? client.website!
                    : `https://${client.website}`
                }
                target="_blank"
                rel="noopener noreferrer"
                className="max-w-[220px] truncate transition-colors hover:text-neon"
              >
                {displayUrl}
              </a>
            )}
          </div>
        </div>
      </div>

      {/* Value proposition */}
      {valueProp && (
        <div className="mb-4 rounded-md border border-border bg-surface-2 px-4 py-3">
          <p className="mb-0.5 text-[10px] font-mono font-medium uppercase tracking-[0.14em] text-muted-2">
            Core Positioning
          </p>
          <p className="line-clamp-2 text-sm leading-relaxed text-foreground">
            {valueProp}
          </p>
        </div>
      )}

      {/* Stats grid */}
      <div className="grid gap-3 sm:grid-cols-3">
        {/* Competitors */}
        <div className="rounded-md border border-border bg-surface-2 p-3">
          <p className="mb-2 text-[10px] font-mono font-medium uppercase tracking-[0.14em] text-muted-2">
            Main Competitors
          </p>
          {topComps.length > 0 ? (
            <div className="space-y-1.5">
              {topComps.map((c) => (
                <div key={c.id} className="flex items-center justify-between gap-2">
                  <span className="truncate text-xs font-medium">{c.company}</span>
                  {c.threatLevel && (
                    <Badge
                      tone={
                        c.threatLevel === "HIGH"
                          ? "danger"
                          : c.threatLevel === "MEDIUM"
                            ? "warning"
                            : "neutral"
                      }
                      className="shrink-0 text-[9px]"
                    >
                      {c.threatLevel}
                    </Badge>
                  )}
                </div>
              ))}
              {competitors.length > 3 && (
                <p className="text-[11px] text-muted-2">+{competitors.length - 3} more</p>
              )}
            </div>
          ) : (
            <p className="text-xs text-muted-2">None tracked yet</p>
          )}
        </div>

        {/* Channels */}
        <div className="rounded-md border border-border bg-surface-2 p-3">
          <p className="mb-2 text-[10px] font-mono font-medium uppercase tracking-[0.14em] text-muted-2">
            Active Channels
          </p>
          {channels.length > 0 ? (
            <div className="flex flex-wrap gap-1.5">
              {channels.map((ch) => (
                <span
                  key={ch}
                  className="rounded-full bg-surface-3 px-2 py-0.5 text-[11px] text-muted"
                >
                  {ch}
                </span>
              ))}
            </div>
          ) : (
            <p className="text-xs text-muted-2">
              {isOnboarded ? "—" : "Generate report to detect channels"}
            </p>
          )}
        </div>

        {/* Quick facts */}
        <div className="rounded-md border border-border bg-surface-2 p-3">
          <p className="mb-2 text-[10px] font-mono font-medium uppercase tracking-[0.14em] text-muted-2">
            Quick Facts
          </p>
          {report?.businessType || report?.founded || report?.techStack ? (
            <div className="space-y-1">
              {report.businessType && (
                <p className="text-xs">
                  <span className="text-muted-2">Type · </span>
                  <span className="font-medium">{report.businessType}</span>
                </p>
              )}
              {report.founded && (
                <p className="text-xs">
                  <span className="text-muted-2">Founded · </span>
                  <span className="font-medium">{report.founded}</span>
                </p>
              )}
              {report.techStack && (
                <p className="text-xs">
                  <span className="text-muted-2">Tech · </span>
                  <span className="font-medium">{report.techStack}</span>
                </p>
              )}
            </div>
          ) : (
            <p className="text-xs text-muted-2">
              {isOnboarded ? "—" : "Generate report to see facts"}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

/* ── Competitor tracker ───────────────────────────────────────── */

/* ── Branding section ────────────────────────────────────────── */

const VISUAL_STYLE_ICONS: Record<string, string> = {
  "Dark Mode": "Moon",
  "Minimalist": "Minus",
  "High-Tech": "Cpu",
  "Corporate": "Briefcase",
  "Vibrant": "Zap",
  "Luxury": "Crown",
};

function BrandingSection({
  guidelines,
  brandingDoc,
  hasWebsite,
  isStaff,
  onEdit,
  onGenerate,
  generating,
  genFeedback,
}: {
  guidelines?: Client["brandingGuidelines"];
  brandingDoc: ClientContextDoc | null;
  hasWebsite: boolean;
  isStaff: boolean;
  onEdit: () => void;
  onGenerate: () => void;
  generating: boolean;
  genFeedback?: { source: "ai_generated"; primaryColor?: string; visualStyle?: string } | null;
}) {
  const brandInsights: string[] = [];
  if (brandingDoc) {
    const stripped = brandingDoc.content.replace(/^---[\s\S]*?---\n?/, "");
    for (const line of stripped.split("\n")) {
      const m = line.match(/^[-*+]\s+(.+)/);
      if (m?.[1]) {
        const text = m[1].replace(/\*\*/g, "").replace(/\*/g, "").trim();
        if (text.length >= 15 && text.length <= 100) brandInsights.push(text);
      }
      if (brandInsights.length >= 3) break;
    }
  }

  const generateLabel = generating ? "Generating…" : "Generate with AI";

  if (!guidelines) {
    return (
      <Card className="border-dashed">
        <div className="flex flex-col items-center gap-3 py-4 text-center">
          <div className="flex h-10 w-10 items-center justify-center rounded-md bg-neon-soft">
            <Icon name="Palette" className="h-5 w-5 text-neon" />
          </div>
          <div>
            <p className="font-medium">No branding guidelines set</p>
            <p className="mt-1 text-sm text-muted-2">
              Karos uses AI domain knowledge to generate colors, fonts, and brand voice for this client.
            </p>
          </div>
          {genFeedback && (
            <div className="flex items-center gap-2 rounded-md border border-neon/30 bg-neon-soft/30 px-3 py-2 text-xs text-neon">
              <Icon name="CheckCircle" className="h-3.5 w-3.5 shrink-0" />
              {`AI Generated from Domain Knowledge${genFeedback.visualStyle ? ` · ${genFeedback.visualStyle}` : ""}`}
            </div>
          )}
          <div className="flex flex-wrap justify-center gap-2">
            <Button size="sm" onClick={onEdit}>
              <Icon name="Pencil" className="h-4 w-4" /> Set manually
            </Button>
            {isStaff && (
              <Button size="sm" variant="outline" loading={generating} onClick={onGenerate}>
                <Icon name="Sparkles" className="h-4 w-4" />
                {generateLabel}
              </Button>
            )}
          </div>
        </div>
      </Card>
    );
  }

  return (
    <Card>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <CardTitle>Branding Guidelines</CardTitle>
          {guidelines.visualStyle && (
            <span className="flex items-center gap-1 rounded-full border border-border bg-surface-2 px-2 py-0.5 text-[10px] font-medium text-muted">
              <Icon
                name={(VISUAL_STYLE_ICONS[guidelines.visualStyle] ?? "Layers") as Parameters<typeof Icon>[0]["name"]}
                className="h-2.5 w-2.5"
              />
              {guidelines.visualStyle}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {isStaff && (
            <Button size="sm" variant="outline" loading={generating} onClick={onGenerate} title="Regenerate brand profile with AI">
              <Icon name="RefreshCw" className="h-3.5 w-3.5" />
              {generating ? "Generating…" : "Regenerate"}
            </Button>
          )}
          <Button size="sm" variant="outline" onClick={onEdit}>
            <Icon name="Pencil" className="h-3.5 w-3.5" /> Edit
          </Button>
        </div>
      </div>

      {/* Generation feedback pill */}
      {genFeedback && (
        <div className="mb-3 flex items-center gap-2 rounded-md border border-neon/30 bg-neon-soft/30 px-3 py-2 text-xs text-neon">
          <Icon name="CheckCircle" className="h-3.5 w-3.5 shrink-0" />
          {`AI Generated from Domain Knowledge${genFeedback.visualStyle ? ` · ${genFeedback.visualStyle}` : ""}${genFeedback.primaryColor ? ` · ${genFeedback.primaryColor}` : ""}`}
        </div>
      )}

      {/* Agent-usable structured data */}
      <div className="flex flex-wrap gap-4">
        {(guidelines.primaryColor || guidelines.secondaryColor) && (
          <div className="flex gap-2">
            {guidelines.primaryColor && (
              <div className="flex items-center gap-2">
                <div
                  className="h-6 w-6 shrink-0 rounded-full border border-border"
                  style={{ background: guidelines.primaryColor }}
                />
                <span className="font-mono text-xs text-muted-2">{guidelines.primaryColor}</span>
              </div>
            )}
            {guidelines.secondaryColor && (
              <div className="flex items-center gap-2">
                <div
                  className="h-6 w-6 shrink-0 rounded-full border border-border"
                  style={{ background: guidelines.secondaryColor }}
                />
                <span className="font-mono text-xs text-muted-2">{guidelines.secondaryColor}</span>
              </div>
            )}
          </div>
        )}
        {(guidelines.fontHeading || guidelines.fontBody) && (
          <div className="flex gap-3 text-xs text-muted-2">
            {guidelines.fontHeading && <span>Heading: {guidelines.fontHeading}</span>}
            {guidelines.fontBody && <span>Body: {guidelines.fontBody}</span>}
          </div>
        )}
      </div>

      {(guidelines.toneKeywords ?? []).length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {(guidelines.toneKeywords ?? []).map((t) => (
            <span
              key={t}
              className="rounded-full border border-neon/30 bg-neon-soft px-2.5 py-0.5 text-xs font-medium text-neon"
            >
              {t}
            </span>
          ))}
        </div>
      )}

      {guidelines.guidelines && (
        <p className="mt-3 line-clamp-3 text-xs text-muted-2">{guidelines.guidelines}</p>
      )}

      {/* Context doc insights (from new pipeline) */}
      {brandInsights.length > 0 && (
        <div className="mt-4 border-t border-border pt-4">
          <p className="mb-2 text-[10px] font-mono font-medium uppercase tracking-[0.14em] text-muted-2">
            From Brand Analysis
          </p>
          <div className="flex flex-wrap gap-1.5">
            {brandInsights.map((insight, i) => (
              <span
                key={i}
                className="rounded-full border border-border bg-surface-2 px-2.5 py-1 text-xs text-muted"
              >
                {insight}
              </span>
            ))}
          </div>
        </div>
      )}
    </Card>
  );
}

/* ── Main export ──────────────────────────────────────────────── */

interface Props {
  client: Client;
  report: ClientReport | null;
  competitors: ClientCompetitor[];
  contextDocs: ClientContextDoc[];
  currentUserRole: Role;
}

export function IntelligenceTab({
  client,
  report,
  competitors,
  contextDocs,
  currentUserRole,
}: Props) {
  const router = useRouter();
  const [brandingOpen, setBrandingOpen] = useState(false);
  const [generating, startGenerating] = useTransition();
  const [regenerating, startRegenerate] = useTransition();
  const [regenError, setRegenError] = useState<string | null>(null);
  const [brandingFeedback, setBrandingFeedback] = useState<{
    source: "ai_generated";
    primaryColor?: string;
    visualStyle?: string;
  } | null>(null);

  const isStaff = currentUserRole === "KAROS_ADMIN" || currentUserRole === "KAROS_EMPLOYEE";

  function handleGenerateBranding() {
    setBrandingFeedback(null);
    startGenerating(async () => {
      try {
        const result = await generateBrandingAction(client.id);
        setBrandingFeedback(result);
        router.refresh();
      } catch {
        // silently ignore — scraping is best-effort
      }
    });
  }

  function handleGenerateReport() {
    setRegenError(null);
    startRegenerate(async () => {
      try {
        await generateIntelReportAction(client.id);
        router.refresh();
      } catch (e) {
        setRegenError(e instanceof Error ? e.message : "Generation failed. Try again.");
      }
    });
  }

  const brandingDoc =
    contextDocs.find((d) => d.docType === "branding-guidelines") ?? null;

  return (
    <div className="w-full min-w-0 space-y-8 overflow-x-hidden">
      {/* Quick Insights hero cards — only rendered when data is available */}
      <QuickInsights report={report} contextDocs={contextDocs} />

      {/* Company Profile Snapshot */}
      <CompanyProfileSnapshot
        client={client}
        report={report}
        competitors={competitors}
        contextDocs={contextDocs}
      />

      {/* Actions bar */}
      <div className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-3">
          {report?.reportDate ? (
            <p className="text-xs text-muted-2">
              Last generated:{" "}
              <span className="font-medium text-foreground">{report.reportDate}</span>
            </p>
          ) : (
            <span />
          )}
          {isStaff && (
            <Button
              variant="outline"
              size="sm"
              loading={regenerating}
              onClick={handleGenerateReport}
              title="Re-run the AI pipeline to update context documents and report"
            >
              <Icon name="RefreshCw" className="h-3.5 w-3.5" />
              {regenerating ? "Generating…" : "Regenerate"}
            </Button>
          )}
        </div>
        {regenError && (
          <div className="flex items-center gap-2 rounded-md border border-danger/30 bg-danger/10 px-3 py-2">
            <Icon name="TriangleAlert" className="h-4 w-4 shrink-0 text-danger" />
            <p className="text-xs text-danger">{regenError}</p>
          </div>
        )}
      </div>

      {/* Client Profile Documents (new pipeline) */}
      {(contextDocs.length > 0 || isStaff) && (
        <ContextDocsSection
          clientId={client.id}
          contextDocs={contextDocs}
          currentUserRole={currentUserRole}
        />
      )}

      {/* Inline nudge when no docs yet */}
      {contextDocs.length === 0 && !isStaff && (
        <EmptyState
          icon={<Icon name="FileSearch" className="h-6 w-6" />}
          title="Profile documents being prepared"
          description="Your brand and strategy documents are being generated. Check back shortly."
        />
      )}

      {/* Competitor Intelligence */}
      <CompetitorManager
        competitors={competitors}
        clientId={client.id}
        hasReport={report !== null}
        isStaff={isStaff}
      />

      {/* Branding Guidelines (integrates with branding context doc) */}
      <BrandingSection
        guidelines={client.brandingGuidelines}
        brandingDoc={brandingDoc}
        hasWebsite={!!client.website}
        isStaff={isStaff}
        onEdit={() => setBrandingOpen(true)}
        onGenerate={handleGenerateBranding}
        generating={generating}
        genFeedback={brandingFeedback}
      />

      {/* Modals */}
      <BrandingModal
        open={brandingOpen}
        onClose={() => setBrandingOpen(false)}
        clientId={client.id}
        existing={client.brandingGuidelines}
        hasWebsite={isStaff && !!client.website}
      />
    </div>
  );
}
