"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Card, CardTitle, Button, Badge, EmptyState } from "@/components/ui";
import { Icon } from "@/components/icon";
import { cn } from "@/lib/utils";
import { SubjectModal } from "@/components/subject-modal";
import { ImportReportModal } from "@/components/import-report-modal";
import { AddCompetitorModal } from "@/components/add-competitor-modal";
import { BrandingModal } from "@/components/branding-modal";
import { deleteCompetitorAction, generateBrandingAction, generateIntelReportAction } from "@/lib/actions";
import type { Client, ClientReport, ClientCompetitor, Role, DimensionScore } from "@/lib/types";

/* ── Dimension config ─────────────────────────────────────────────── */

const DIMENSIONS = [
  { key: "content", label: "Content & Messaging", icon: "FileText", analysisField: "contentAnalysis" },
  { key: "conversion", label: "Conversion Optimization", icon: "TrendingUp", analysisField: "conversionAnalysis" },
  { key: "seo", label: "SEO & Discoverability", icon: "Search", analysisField: "seoAnalysis" },
  { key: "geo", label: "GEO & AI Discoverability", icon: "Globe", analysisField: "geoAnalysis" },
  { key: "positioning", label: "Competitive Positioning", icon: "Target", analysisField: "positioningAnalysis" },
  { key: "brand", label: "Brand & Trust", icon: "Shield", analysisField: "brandAnalysis" },
  { key: "growth", label: "Growth & Strategy", icon: "Rocket", analysisField: "growthAnalysis" },
] as const;

/* ── Score helpers ────────────────────────────────────────────────── */

function gradeColor(grade: string) {
  if (["A", "A+", "A-"].includes(grade)) return "text-neon";
  if (grade === "B") return "text-blue-400";
  if (grade === "C") return "text-yellow-400";
  return "text-red-400";
}

function scoreBarColor(score: number) {
  if (score >= 70) return "bg-neon";
  if (score >= 50) return "bg-yellow-400";
  return "bg-red-400";
}

/* ── Sub-components ───────────────────────────────────────────────── */

function ProfileField({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-[11px] font-medium uppercase tracking-wider text-muted-2">{label}</p>
      <p className="mt-0.5 text-sm text-foreground">{value}</p>
    </div>
  );
}

function ScoreOverview({ report }: { report: ClientReport }) {
  return (
    <div className="grid gap-4 lg:grid-cols-[200px_1fr]">
      {/* Overall score */}
      <Card className="flex flex-col items-center justify-center gap-1 py-6 text-center">
        <p className="text-6xl font-bold tabular-nums">{report.overallScore}</p>
        <p className="text-sm text-muted-2">out of 100</p>
        <span
          className={cn(
            "mt-2 rounded-[8px] px-3 py-1 text-xl font-bold",
            gradeColor(report.overallGrade),
          )}
        >
          {report.overallGrade}
        </span>
        {report.competitorRankings.length > 0 && (
          <p className="mt-1 text-xs text-muted-2">
            Ranked #{report.competitorRankings.find((r) => r.score === report.overallScore)?.rank ?? "—"} of{" "}
            {report.competitorRankings.length}
          </p>
        )}
      </Card>

      {/* Dimension bars */}
      <Card className="space-y-3">
        <CardTitle className="text-xs uppercase tracking-wider text-muted-2">
          Dimension Breakdown
        </CardTitle>
        {report.dimensionScores.map((d) => (
          <div key={d.dimension}>
            <div className="mb-1 flex items-center justify-between gap-2">
              <span className="text-xs text-foreground">{d.dimension}</span>
              <span className="text-xs font-semibold tabular-nums">{d.score}/100</span>
            </div>
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-3">
              <div
                className={cn("h-full rounded-full transition-all", scoreBarColor(d.score))}
                style={{ width: `${d.score}%` }}
              />
            </div>
          </div>
        ))}
      </Card>
    </div>
  );
}

function SubjectCard({
  label,
  icon,
  score,
  onClick,
}: {
  label: string;
  icon: string;
  score?: number;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="group flex flex-col gap-3 rounded-[14px] border border-border bg-surface p-4 text-left transition-all hover:border-border-strong hover:bg-surface-2"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex h-9 w-9 items-center justify-center rounded-[10px] bg-neon-soft">
          <Icon name={icon} className="h-4 w-4 text-neon" />
        </div>
        {score !== undefined && (
          <span
            className={cn(
              "text-lg font-bold tabular-nums",
              score >= 70 ? "text-neon" : score >= 50 ? "text-yellow-400" : "text-red-400",
            )}
          >
            {score}
          </span>
        )}
      </div>
      <div>
        <p className="text-sm font-medium leading-tight">{label}</p>
        <p className="mt-1 flex items-center gap-1 text-xs text-muted-2 transition-colors group-hover:text-muted">
          View analysis <Icon name="ArrowRight" className="h-3 w-3" />
        </p>
      </div>
    </button>
  );
}

function CompetitorTracker({
  competitors,
  onAdd,
  clientId,
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
          description="Import a report or add competitors manually."
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
                  <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-muted-2">
                    Company
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-muted-2">
                    Tier
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-muted-2">
                    Overlap
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-muted-2">
                    Threat
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-muted-2">
                    Source
                  </th>
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

function BrandingSection({
  guidelines,
  onEdit,
  onGenerate,
  generating,
}: {
  guidelines?: Client["brandingGuidelines"];
  onEdit: () => void;
  onGenerate: () => void;
  generating: boolean;
}) {
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
            <Button
              size="sm"
              variant="outline"
              loading={generating}
              onClick={onGenerate}
            >
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

      <div className="flex flex-wrap gap-4">
        {/* Color swatches */}
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

        {/* Fonts */}
        {(guidelines.fontHeading || guidelines.fontBody) && (
          <div className="flex gap-3 text-xs text-muted-2">
            {guidelines.fontHeading && <span>Heading: {guidelines.fontHeading}</span>}
            {guidelines.fontBody && <span>Body: {guidelines.fontBody}</span>}
          </div>
        )}
      </div>

      {/* Tone keywords */}
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

      {/* Guidelines preview */}
      {guidelines.guidelines && (
        <p className="mt-3 line-clamp-3 text-xs text-muted-2">{guidelines.guidelines}</p>
      )}
    </Card>
  );
}

/* ── Brand Voice Comparison ───────────────────────────────────────── */

function BrandVoiceSection({ report }: { report: ClientReport }) {
  const rows = report.brandVoiceRows ?? [];
  const archetypes = report.brandVoiceArchetypes ?? [];
  if (rows.length === 0 && archetypes.length === 0) return null;

  const companies = rows[0] ? Object.keys(rows[0].scores) : archetypes.map((a) => a.company);

  return (
    <Card>
      <CardTitle className="mb-4">Brand Voice Comparison</CardTitle>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border">
              <th className="pb-2 text-left text-xs font-semibold text-muted-2">Dimension</th>
              {companies.map((c) => (
                <th key={c} className="pb-2 text-center text-xs font-semibold text-muted-2">{c}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rows.map((row) => (
              <tr key={row.dimension}>
                <td className="py-2 pr-4 text-xs text-muted">{row.dimension}</td>
                {companies.map((c) => (
                  <td key={c} className="py-2 text-center text-xs font-medium tabular-nums">
                    {row.scores[c] ?? "—"}
                  </td>
                ))}
              </tr>
            ))}
            {archetypes.length > 0 && (
              <tr>
                <td className="py-2 pr-4 text-xs font-semibold text-muted">Primary Archetype</td>
                {companies.map((c) => {
                  const a = archetypes.find((x) => x.company === c);
                  return (
                    <td key={c} className="py-2 text-center">
                      <span className="rounded-full border border-neon/30 bg-neon-soft px-2 py-0.5 text-[10px] font-medium text-neon">
                        {a?.archetype ?? "—"}
                      </span>
                    </td>
                  );
                })}
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {report.brandVoiceTerritory && (
        <div className="mt-4 rounded-[10px] border border-neon/20 bg-neon-soft p-3">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-neon">Voice Territory Opportunity</p>
          <p className="mt-1 text-sm text-foreground">{report.brandVoiceTerritory}</p>
        </div>
      )}
    </Card>
  );
}

/* ── Customer Sentiment ───────────────────────────────────────────── */

function ratingColor(rating?: string): string {
  if (!rating) return "text-muted-2";
  const n = parseFloat(rating);
  if (n >= 8) return "text-neon";
  if (n >= 6) return "text-warning";
  return "text-danger";
}

function CustomerSentimentSection({ report }: { report: ClientReport }) {
  const entries = report.customerSentiment ?? [];
  const whitespace = report.whitespaceOpportunities ?? [];
  if (entries.length === 0 && whitespace.length === 0) return null;

  return (
    <Card>
      <CardTitle className="mb-4">Customer Sentiment</CardTitle>
      {entries.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border">
                {["Brand", "Rating", "Response Time", "Would Return"].map((h) => (
                  <th key={h} className="pb-2 text-left text-xs font-semibold text-muted-2 pr-4">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {entries.map((e) => (
                <tr key={e.company}>
                  <td className="py-2 pr-4 text-xs font-medium">{e.company}</td>
                  <td className="py-2 pr-4">
                    {e.rating ? (
                      <span className={cn("text-xs font-semibold tabular-nums", ratingColor(e.rating))}>
                        {e.rating}{e.ratingLabel ? ` (${e.ratingLabel})` : ""}
                      </span>
                    ) : (
                      <span className="text-xs text-muted-2">—</span>
                    )}
                  </td>
                  <td className="py-2 pr-4 text-xs text-muted-2">{e.responseTime ?? "—"}</td>
                  <td className="py-2 text-xs text-muted-2">{e.wouldReturn ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {whitespace.length > 0 && (
        <div className={entries.length > 0 ? "mt-4 border-t border-border pt-4" : ""}>
          <p className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-muted-2">Whitespace Opportunities</p>
          <ol className="space-y-1.5">
            {whitespace.map((item, i) => (
              <li key={i} className="flex items-start gap-2 text-sm">
                <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-surface-3 text-[9px] font-semibold text-muted-2">
                  {i + 1}
                </span>
                {item}
              </li>
            ))}
          </ol>
        </div>
      )}
    </Card>
  );
}

/* ── Recommendations ──────────────────────────────────────────────── */

function RecommendationsSection({ report }: { report: ClientReport }) {
  const priorities = [...new Set(report.recommendations.map((r) => r.priority))].sort();
  return (
    <div>
      <CardTitle className="mb-4">Recommendations</CardTitle>
      <div className="space-y-6">
        {priorities.map((p) => {
          const group = report.recommendations.filter((r) => r.priority === p);
          const label = group[0]?.priorityLabel ?? `Priority ${p}`;
          return (
            <div key={p}>
              <p className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-muted-2">
                Priority {p} — {label}
              </p>
              <div className="space-y-2">
                {group.map((rec) => (
                  <div
                    key={rec.number}
                    className="flex items-start gap-3 rounded-[10px] border border-border p-3"
                  >
                    <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-surface-3 text-[10px] font-semibold text-muted-2">
                      {rec.number}
                    </span>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium leading-snug">{rec.title}</p>
                      {rec.description && (
                        <p className="mt-0.5 text-xs text-muted-2">{rec.description}</p>
                      )}
                    </div>
                    {rec.tag && (
                      <Badge tone="neutral" className="shrink-0">
                        {rec.tag}
                      </Badge>
                    )}
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ── Main export ──────────────────────────────────────────────────── */

interface Props {
  client: Client;
  report: ClientReport | null;
  competitors: ClientCompetitor[];
  currentUserRole: Role;
}

export function IntelligenceTab({ client, report, competitors, currentUserRole }: Props) {
  const router = useRouter();
  const [subjectKey, setSubjectKey] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [addCompOpen, setAddCompOpen] = useState(false);
  const [brandingOpen, setBrandingOpen] = useState(false);
  const [generating, startGenerating] = useTransition();
  const [regenerating, startRegenerate] = useTransition();
  const [regenError, setRegenError] = useState<string | null>(null);

  const isAdmin = currentUserRole === "admin";
  const isStaff = currentUserRole === "admin" || currentUserRole === "employee";

  function handleGenerateBranding() {
    startGenerating(async () => {
      try {
        await generateBrandingAction(client.id);
        router.refresh();
      } catch {
        // silently ignore — user can try Set Guidelines manually
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

  /* ── Empty state ── */
  if (!report) {
    return (
      <div className="space-y-4">
        <EmptyState
          icon={<Icon name="BarChart2" className="h-7 w-7" />}
          title="No intelligence report yet"
          description={
            isStaff
              ? "Generate a report automatically with AI, or import a Markdown report manually."
              : "Your intelligence report is being prepared."
          }
          action={
            isStaff ? (
              <div className="flex flex-wrap gap-2">
                <Button loading={regenerating} onClick={handleGenerateReport}>
                  <Icon name="Sparkles" className="h-4 w-4" />
                  {regenerating ? "Generating…" : "Generate with AI"}
                </Button>
                {isAdmin && (
                  <Button variant="outline" onClick={() => setImportOpen(true)}>
                    <Icon name="Upload" className="h-4 w-4" /> Import report
                  </Button>
                )}
              </div>
            ) : undefined
          }
        />
        {regenError && (
          <div className="flex items-center gap-2 rounded-[10px] border border-red-500/30 bg-red-500/10 px-4 py-3">
            <Icon name="TriangleAlert" className="h-4 w-4 shrink-0 text-red-400" />
            <p className="text-sm text-red-400">{regenError}</p>
          </div>
        )}
        <ImportReportModal
          open={importOpen}
          onClose={() => setImportOpen(false)}
          clientId={client.id}
        />
      </div>
    );
  }

  /* ── Actions bar ── */
  const actionsBar = (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs text-muted-2">
          Report date:{" "}
          <span className="font-medium text-foreground">{report.reportDate || "—"}</span>
        </p>
        <div className="flex flex-wrap items-center gap-2">
          {isAdmin && (
            <Button variant="outline" size="sm" onClick={() => setImportOpen(true)}>
              <Icon name="Upload" className="h-3.5 w-3.5" />
              Overwrite report
            </Button>
          )}
          {isStaff && (
            <Button
              variant="outline"
              size="sm"
              loading={regenerating}
              onClick={handleGenerateReport}
              title="Re-run the AI pipeline to update this report"
            >
              <Icon name="RefreshCw" className="h-3.5 w-3.5" />
              {regenerating ? "Generating…" : "Regenerate"}
            </Button>
          )}
          {report.reportHtml || report.pdfUrl ? (
            <a
              href={report.reportHtml ? `/api/clients/${client.id}/report` : report.pdfUrl!}
              target="_blank"
              rel="noopener noreferrer"
            >
              <Button size="sm">
                <Icon name="Download" className="h-3.5 w-3.5" />
                Open report
              </Button>
            </a>
          ) : (
            <Button size="sm" disabled title="No report file stored yet">
              <Icon name="Download" className="h-3.5 w-3.5" />
              Open report
            </Button>
          )}
        </div>
      </div>
      {regenError && (
        <div className="flex items-center gap-2 rounded-[8px] border border-red-500/30 bg-red-500/10 px-3 py-2">
          <Icon name="TriangleAlert" className="h-4 w-4 shrink-0 text-red-400" />
          <p className="text-xs text-red-400">{regenError}</p>
        </div>
      )}
    </div>
  );

  /* ── Company profile card ── */
  const profileFields = [
    ["URL", report.url],
    ["Business type", report.businessType],
    ["Founded", report.founded],
    ["Authorization", report.authorization],
    ["CNPJ", report.cnpj],
    ["Min. investment", report.minInvestment],
    ["Tech stack", report.techStack],
    ["Status", report.reportStatus],
  ].filter(([, v]) => Boolean(v)) as [string, string][];

  /* ── Active dimension for modal ── */
  const activeDimension = DIMENSIONS.find((d) => d.key === subjectKey);
  const getDimScore = (label: string) =>
    report.dimensionScores.find((d) => d.dimension === label);

  return (
    <div className="space-y-8">
      {actionsBar}

      {/* Company Profile */}
      {profileFields.length > 0 && (
        <Card>
          <CardTitle className="mb-4">Company Profile</CardTitle>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {profileFields.map(([label, value]) => (
              <ProfileField key={label} label={label} value={value} />
            ))}
          </div>
        </Card>
      )}

      {/* Score Overview */}
      {(report.overallScore > 0 || report.dimensionScores.length > 0) && (
        <ScoreOverview report={report} />
      )}

      {/* Subject Analysis Grid */}
      <div>
        <CardTitle className="mb-4">Analysis Breakdown</CardTitle>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {DIMENSIONS.map((d) => {
            const dimScore = getDimScore(d.label);
            return (
              <SubjectCard
                key={d.key}
                label={d.label}
                icon={d.icon}
                score={dimScore?.score}
                onClick={() => setSubjectKey(d.key)}
              />
            );
          })}
          {/* SWOT card */}
          <SubjectCard
            label="SWOT Analysis"
            icon="Grid2x2"
            onClick={() => setSubjectKey("swot")}
          />
        </div>
      </div>

      {/* Competitor Tracker */}
      <CompetitorTracker
        competitors={competitors}
        onAdd={() => setAddCompOpen(true)}
        clientId={client.id}
      />

      {/* Brand Voice Comparison */}
      <BrandVoiceSection report={report} />

      {/* Customer Sentiment */}
      <CustomerSentimentSection report={report} />

      {/* Branding Guidelines */}
      <BrandingSection
        guidelines={client.brandingGuidelines}
        onEdit={() => setBrandingOpen(true)}
        onGenerate={handleGenerateBranding}
        generating={generating}
      />

      {/* Recommendations */}
      {report.recommendations.length > 0 && <RecommendationsSection report={report} />}

      {/* ── Modals ── */}
      {/* Analysis section modals */}
      {DIMENSIONS.map((d) => {
        const dimScore = getDimScore(d.label);
        const content = report[d.analysisField as keyof ClientReport] as string;
        return (
          <SubjectModal
            key={d.key}
            open={subjectKey === d.key}
            onClose={() => setSubjectKey(null)}
            title={d.label}
            icon={d.icon}
            score={dimScore?.score}
            weight={dimScore?.weight}
            content={content}
          />
        );
      })}

      {/* SWOT modal */}
      <SubjectModal
        open={subjectKey === "swot"}
        onClose={() => setSubjectKey(null)}
        title="SWOT Analysis"
        icon="Grid2x2"
        swot={report.swot}
      />

      <ImportReportModal
        open={importOpen}
        onClose={() => setImportOpen(false)}
        clientId={client.id}
      />
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
