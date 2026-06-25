"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Card, CardTitle, Button, Badge, EmptyState } from "@/components/ui";
import { Icon } from "@/components/icon";
import { cn, initials } from "@/lib/utils";
import { AddCompetitorModal } from "@/components/add-competitor-modal";
import { BrandingModal } from "@/components/branding-modal";
import {
  deleteCompetitorAction,
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
    <div className="rounded-[16px] border border-border bg-surface p-5">
      {/* Header */}
      <div className="mb-4 flex items-start gap-3.5">
        <div
          className="flex h-12 w-12 shrink-0 items-center justify-center rounded-[12px] text-base font-bold"
          style={{
            background: (client.accentColor ?? "#2dff9e") + "1f",
            color: client.accentColor ?? "#2dff9e",
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
        <div className="mb-4 rounded-[10px] border border-border bg-surface-2 px-4 py-3">
          <p className="mb-0.5 text-[10px] font-semibold uppercase tracking-wider text-muted-2">
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
        <div className="rounded-[10px] border border-border bg-surface-2 p-3">
          <p className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-muted-2">
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
        <div className="rounded-[10px] border border-border bg-surface-2 p-3">
          <p className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-muted-2">
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
        <div className="rounded-[10px] border border-border bg-surface-2 p-3">
          <p className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-muted-2">
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

function CompetitorTracker({
  competitors,
  onAdd,
}: {
  competitors: ClientCompetitor[];
  onAdd: () => void;
  clientId: string;
}) {
  const router = useRouter();
  const [deletePending, startDelete] = useTransition();

  function remove(id: string) {
    startDelete(async () => {
      await deleteCompetitorAction(id);
      router.refresh();
    });
  }

  const threatBadge = (level?: string) => {
    if (!level) return null;
    const tone =
      level === "HIGH" ? "danger" : level === "MEDIUM" ? "warning" : ("neutral" as const);
    return <Badge tone={tone}>{level}</Badge>;
  };

  return (
    <div>
      <div className="mb-3 flex items-center justify-between gap-2">
        <CardTitle>Competitor Tracker</CardTitle>
        <Button size="sm" variant="outline" onClick={onAdd}>
          <Icon name="Plus" className="h-3.5 w-3.5" />
          Add
        </Button>
      </div>

      {competitors.length === 0 ? (
        <EmptyState
          icon={<Icon name="Users" className="h-6 w-6" />}
          title="No competitors tracked"
          description="Generate a report or add competitors manually."
          action={
            <Button size="sm" onClick={onAdd}>
              <Icon name="Plus" className="h-4 w-4" /> Add competitor
            </Button>
          }
        />
      ) : (
        <Card className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border">
                  {["Company", "Tier", "Overlap", "Threat", "Source"].map((h) => (
                    <th
                      key={h}
                      className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-muted-2"
                    >
                      {h}
                    </th>
                  ))}
                  <th className="w-10 px-4 py-3" />
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {competitors.map((c) => (
                  <tr key={c.id} className="group">
                    <td className="px-4 py-3">
                      <p className="font-medium">{c.company}</p>
                      {c.url && (
                        <a
                          href={c.url.startsWith("http") ? c.url : `https://${c.url}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-xs text-muted-2 hover:text-neon"
                        >
                          {c.url}
                        </a>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <Badge
                        tone={
                          c.marketTier === "Leader"
                            ? "neon"
                            : c.marketTier === "Challenger"
                              ? "info"
                              : "neutral"
                        }
                      >
                        {c.marketTier}
                      </Badge>
                    </td>
                    <td className="px-4 py-3 text-sm text-muted">{c.overlap}</td>
                    <td className="px-4 py-3">{threatBadge(c.threatLevel)}</td>
                    <td className="px-4 py-3">
                      <span className="text-xs text-muted-2">{c.source}</span>
                    </td>
                    <td className="px-4 py-3">
                      <button
                        onClick={() => remove(c.id)}
                        disabled={deletePending}
                        className="text-muted-2 opacity-0 transition-opacity hover:text-danger group-hover:opacity-100 disabled:opacity-50"
                        aria-label="Remove"
                      >
                        <Icon name="Trash2" className="h-3.5 w-3.5" />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}

/* ── Branding section ────────────────────────────────────────── */

function BrandingSection({
  guidelines,
  brandingDoc,
  onEdit,
  onGenerate,
  generating,
}: {
  guidelines?: Client["brandingGuidelines"];
  brandingDoc: ClientContextDoc | null;
  onEdit: () => void;
  onGenerate: () => void;
  generating: boolean;
}) {
  const brandInsights = brandingDoc
    ? (() => {
        const stripped = brandingDoc.content.replace(/^---[\s\S]*?---\n?/, "");
        const chips: string[] = [];
        for (const line of stripped.split("\n")) {
          const m = line.match(/^[-*+]\s+(.+)/);
          if (m?.[1]) {
            const text = m[1].replace(/\*\*/g, "").replace(/\*/g, "").trim();
            if (text.length >= 15 && text.length <= 100) chips.push(text);
          }
          if (chips.length >= 3) break;
        }
        return chips;
      })()
    : [];

  if (!guidelines) {
    return (
      <Card className="border-dashed">
        <div className="flex flex-col items-center gap-3 py-4 text-center">
          <div className="flex h-10 w-10 items-center justify-center rounded-[10px] bg-neon-soft">
            <Icon name="Palette" className="h-5 w-5 text-neon" />
          </div>
          <div>
            <p className="font-medium">No branding guidelines set</p>
            <p className="mt-1 text-sm text-muted-2">
              Add guidelines so AI agents can produce on-brand content.
            </p>
          </div>
          <div className="flex gap-2">
            <Button size="sm" onClick={onEdit}>
              <Icon name="Pencil" className="h-4 w-4" /> Set guidelines
            </Button>
            <Button size="sm" variant="outline" loading={generating} onClick={onGenerate}>
              <Icon name="Sparkles" className="h-4 w-4" /> Generate automatically
            </Button>
          </div>
        </div>
      </Card>
    );
  }

  return (
    <Card>
      <div className="mb-3 flex items-center justify-between gap-2">
        <CardTitle>Branding Guidelines</CardTitle>
        <Button size="sm" variant="outline" onClick={onEdit}>
          <Icon name="Pencil" className="h-3.5 w-3.5" /> Edit
        </Button>
      </div>

      {/* Agent-usable structured data */}
      <div className="flex flex-wrap gap-4">
        {(guidelines.primaryColor || guidelines.secondaryColor) && (
          <div className="flex gap-2">
            {guidelines.primaryColor && (
              <div className="flex items-center gap-2">
                <div
                  className="h-6 w-6 rounded-full border border-border"
                  style={{ background: guidelines.primaryColor }}
                />
                <span className="font-mono text-xs text-muted-2">{guidelines.primaryColor}</span>
              </div>
            )}
            {guidelines.secondaryColor && (
              <div className="flex items-center gap-2">
                <div
                  className="h-6 w-6 rounded-full border border-border"
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
          <p className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-muted-2">
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
  const [addCompOpen, setAddCompOpen] = useState(false);
  const [brandingOpen, setBrandingOpen] = useState(false);
  const [generating, startGenerating] = useTransition();
  const [regenerating, startRegenerate] = useTransition();
  const [regenError, setRegenError] = useState<string | null>(null);

  const isStaff = currentUserRole === "admin" || currentUserRole === "employee";

  function handleGenerateBranding() {
    startGenerating(async () => {
      try {
        await generateBrandingAction(client.id);
        router.refresh();
      } catch {
        // silently ignore
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
          <div className="flex items-center gap-2 rounded-[8px] border border-red-500/30 bg-red-500/10 px-3 py-2">
            <Icon name="TriangleAlert" className="h-4 w-4 shrink-0 text-red-400" />
            <p className="text-xs text-red-400">{regenError}</p>
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

      {/* Competitor Tracker */}
      <CompetitorTracker
        competitors={competitors}
        onAdd={() => setAddCompOpen(true)}
        clientId={client.id}
      />

      {/* Branding Guidelines (integrates with branding context doc) */}
      <BrandingSection
        guidelines={client.brandingGuidelines}
        brandingDoc={brandingDoc}
        onEdit={() => setBrandingOpen(true)}
        onGenerate={handleGenerateBranding}
        generating={generating}
      />

      {/* Modals */}
      <AddCompetitorModal
        open={addCompOpen}
        onClose={() => setAddCompOpen(false)}
        clientId={client.id}
      />
      <BrandingModal
        open={brandingOpen}
        onClose={() => setBrandingOpen(false)}
        clientId={client.id}
        existing={client.brandingGuidelines}
      />
    </div>
  );
}
