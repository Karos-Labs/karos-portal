"use client";

import { useState, useTransition } from "react";
import { Card, CardTitle, Button, Label, Textarea, Badge } from "@/components/ui";
import { Icon } from "@/components/icon";
import { cn } from "@/lib/utils";
import { seedIntelAgentAction, updateIntelPromptAction } from "@/lib/actions";
import type { Agent } from "@/lib/types";

interface Props {
  agent: Agent | null;
  lockedRules?: { researchEngine: string; metrics: string };
}

/* ── Locked rule preview block ────────────────────────────────── */

function LockedRuleBlock({
  title,
  description,
  content,
  charCount,
}: {
  title: string;
  description: string;
  content?: string;
  charCount?: number;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-[10px] border border-border bg-surface-2 p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-2.5">
          <div className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-surface-3">
            <Icon name="Lock" className="h-3 w-3 text-muted-2" />
          </div>
          <div>
            <p className="text-sm font-medium">{title}</p>
            <p className="mt-0.5 text-xs text-muted-2">{description}</p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {charCount != null && (
            <span className="font-mono text-[10px] text-muted-2">
              ~{charCount.toLocaleString()} ch
            </span>
          )}
          {content && (
            <button
              onClick={() => setOpen((v) => !v)}
              className="flex items-center gap-1 text-[11px] text-muted-2 transition-colors hover:text-muted"
            >
              <Icon
                name={open ? "ChevronUp" : "ChevronDown"}
                className="h-3 w-3"
              />
              {open ? "Hide" : "View"}
            </button>
          )}
        </div>
      </div>
      {open && content && (
        <pre className="mt-3 max-h-[300px] overflow-auto rounded-[8px] border border-border bg-surface p-3 font-mono text-[11px] leading-relaxed text-muted-2">
          {content}
        </pre>
      )}
    </div>
  );
}

/* ── Pipeline visualization ───────────────────────────────────── */

function PipelineViz() {
  const stages = [
    { label: "5 Research Agents", sub: "Social · Content · Competitive · Strategy · Sentiment", icon: "Bot" },
    { label: "7 Internal Docs", sub: "Brand voice, market strategy, competitors + more", icon: "FileText" },
    { label: "Condensation", sub: "5 client-facing versions generated", icon: "Layers" },
    { label: "Firestore", sub: "Stored in clientContextDocs collection", icon: "Database" },
  ];

  return (
    <div className="rounded-[10px] border border-neon/20 bg-neon-soft p-4">
      <p className="mb-3 text-[10px] font-semibold uppercase tracking-wider text-neon">
        Pipeline Flow
      </p>
      <div className="flex flex-wrap items-center gap-2">
        {stages.map((s, i) => (
          <div key={i} className="flex items-center gap-2">
            <div className="rounded-[8px] border border-neon/30 bg-surface px-2.5 py-1.5">
              <div className="flex items-center gap-1.5">
                <Icon name={s.icon} className="h-3 w-3 text-neon" />
                <span className="text-xs font-semibold text-foreground">
                  {s.label}
                </span>
              </div>
              <p className="mt-0.5 text-[10px] text-muted-2">{s.sub}</p>
            </div>
            {i < stages.length - 1 && (
              <Icon name="ArrowRight" className="h-3.5 w-3.5 shrink-0 text-neon/60" />
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

/* ── Main component ───────────────────────────────────────────── */

export function IntelAgentSection({ agent, lockedRules }: Props) {
  const [open, setOpen] = useState(false);
  const [instructions, setInstructions] = useState(
    // Strip legacy default prompt if present — show only the custom part
    agent?.systemPrompt?.startsWith("You are the Karos Intel AI")
      ? ""
      : (agent?.systemPrompt ?? ""),
  );
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [seeding, startSeed] = useTransition();
  const [saving, startSave] = useTransition();

  function handleSeed() {
    startSeed(async () => {
      try {
        await seedIntelAgentAction();
        setSaved(false);
        setError(null);
        window.location.reload();
      } catch (e) {
        setError(e instanceof Error ? e.message : "Seeding failed");
      }
    });
  }

  function handleSave() {
    setError(null);
    setSaved(false);
    startSave(async () => {
      try {
        // Save as short custom instructions (the pipeline handles prefixing core rules)
        await updateIntelPromptAction(instructions.trim());
        setSaved(true);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Save failed");
      }
    });
  }

  return (
    <section className="mt-10 border-t border-white/[0.06] pt-8">
      {/* Collapsed header */}
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-3 text-left"
      >
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] bg-neon-soft">
          <Icon name="BarChart2" className="h-4 w-4 text-neon" />
        </div>
        <div className="min-w-0 flex-1">
          <span className="flex items-center gap-2 text-sm font-semibold">
            Intel Report Agent
            <Badge tone="neutral" className="text-[10px]">
              System
            </Badge>
            {!agent && (
              <Badge tone="warning" className="text-[10px]">
                Not seeded
              </Badge>
            )}
          </span>
          <p className="truncate text-xs text-muted-2">
            Multi-agent onboarding pipeline · Admin-only configuration
          </p>
        </div>
        <Icon
          name="ChevronDown"
          className={cn(
            "h-4 w-4 shrink-0 text-muted-2 transition-transform duration-200",
            open && "rotate-180",
          )}
        />
      </button>

      {/* Expandable body */}
      {open && (
        <div className="mt-5 space-y-5">
          {!agent ? (
            /* ── Not seeded ── */
            <Card className="flex flex-col items-center gap-4 py-10 text-center">
              <div className="flex h-14 w-14 items-center justify-center rounded-[16px] bg-neon-soft">
                <Icon name="Zap" className="h-7 w-7 text-neon" />
              </div>
              <div>
                <p className="font-medium">Intel Agent not seeded yet</p>
                <p className="mt-1 text-sm text-muted-2">
                  Seed the Intel Report Agent to enable the multi-agent onboarding
                  pipeline. You can add custom instructions after seeding.
                </p>
              </div>
              <Button onClick={handleSeed} loading={seeding}>
                <Icon name="Zap" className="h-4 w-4" />
                Seed Intel Agent
              </Button>
              {error && <p className="text-xs text-danger">{error}</p>}
            </Card>
          ) : (
            <>
              {/* ── Prompt Assembly Architecture ── */}
              <Card className="space-y-4">
                <div>
                  <CardTitle>Prompt Assembly</CardTitle>
                  <p className="mt-0.5 text-xs text-muted-2">
                    Every agent call in the pipeline receives these layers in order.
                    Locked rules cannot be overridden — they enforce core quality invariants.
                  </p>
                </div>

                {/* Layer 1 — Research Engine Rules (locked) */}
                <LockedRuleBlock
                  title="Research Engine Rules"
                  description={`"No guessed numbers" invariant · source citation requirements · social metrics definitions`}
                  content={lockedRules?.researchEngine}
                  charCount={lockedRules?.researchEngine.length ?? 620}
                />

                {/* Layer 2 — Metrics Rules (locked) */}
                <LockedRuleBlock
                  title="Social Metrics Rules (Metrics-V1)"
                  description="social_content vertical · null taxonomy · onboarding scope boundaries"
                  content={lockedRules?.metrics}
                  charCount={lockedRules?.metrics.length ?? 430}
                />

                {/* Layer 3 — Custom instructions (editable) */}
                <div className="rounded-[10px] border border-neon/40 bg-neon-soft p-3">
                  <div className="flex items-start gap-2.5">
                    <div className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-md border border-neon/50 bg-neon/10">
                      <Icon name="Pencil" className="h-3 w-3 text-neon" />
                    </div>
                    <div>
                      <p className="text-sm font-medium text-neon">
                        Your Custom Instructions
                      </p>
                      <p className="mt-0.5 text-xs text-neon/70">
                        Appended after locked rules · editable below · changes take effect on next run
                      </p>
                    </div>
                  </div>
                </div>

                {/* Pipeline visualization */}
                <PipelineViz />
              </Card>

              {/* ── Editable Instructions ── */}
              <Card className="space-y-4">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <CardTitle>Custom Instructions</CardTitle>
                    <p className="mt-0.5 text-xs text-muted-2">
                      Appended to the locked core rules for every agent in the pipeline.
                      Use this to add focus areas, client-specific context, or output
                      preferences — not to override invariants.
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    {saved && (
                      <span className="flex items-center gap-1 text-xs text-neon">
                        <Icon name="Check" className="h-3.5 w-3.5" />
                        Saved
                      </span>
                    )}
                    <Button
                      size="sm"
                      onClick={handleSave}
                      loading={saving}
                      disabled={saving}
                    >
                      <Icon name="Save" className="h-3.5 w-3.5" />
                      Save
                    </Button>
                  </div>
                </div>

                <div>
                  <Label>Additional Instructions</Label>
                  <Textarea
                    value={instructions}
                    onChange={(e) => {
                      setInstructions(e.target.value);
                      setSaved(false);
                    }}
                    className="min-h-[200px] font-mono text-xs leading-relaxed"
                    placeholder={
                      `Optional — leave blank to use only the locked core rules.\n\nExamples:\n• Focus analysis on the LATAM market\n• Prioritize Instagram and TikTok metrics\n• Client operates in franchise model — adjust scoring accordingly`
                    }
                  />
                  <p className="mt-1.5 text-xs text-muted-2">
                    {instructions.length.toLocaleString()} characters
                    {instructions.length > 0
                      ? ` · ~${Math.round(instructions.length / 4).toLocaleString()} tokens`
                      : ""}
                  </p>
                </div>

                {error && (
                  <div className="flex items-center gap-2 rounded-[8px] border border-red-500/30 bg-red-500/10 px-3 py-2">
                    <Icon
                      name="TriangleAlert"
                      className="h-4 w-4 shrink-0 text-red-400"
                    />
                    <p className="text-xs text-red-400">{error}</p>
                  </div>
                )}

                <div className="rounded-[10px] border border-border bg-surface-2 px-4 py-3">
                  <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-2">
                    Available client variables
                  </p>
                  <p className="mt-1 text-xs text-muted-2">
                    Substituted automatically in the legacy report prompt:
                  </p>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {[
                      "{COMPANY_NAME}",
                      "{WEBSITE_URL}",
                      "{INDUSTRY}",
                      "{DESCRIPTION}",
                      "{DATE}",
                    ].map((v) => (
                      <code
                        key={v}
                        className="rounded bg-neon/10 px-1.5 py-0.5 font-mono text-[11px] text-neon"
                      >
                        {v}
                      </code>
                    ))}
                  </div>
                </div>
              </Card>
            </>
          )}
        </div>
      )}
    </section>
  );
}
