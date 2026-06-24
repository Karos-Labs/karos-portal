"use client";

import { useState, useTransition } from "react";
import { Card, CardTitle, Button, Label, Textarea, Badge } from "@/components/ui";
import { Icon } from "@/components/icon";
import { seedIntelAgentAction, updateIntelPromptAction } from "@/lib/actions";
import type { Agent } from "@/lib/types";

interface Props {
  agent: Agent | null;
}

export function IntelAgentSection({ agent }: Props) {
  const [open, setOpen] = useState(false);
  const [template, setTemplate] = useState(agent?.systemPrompt ?? "");
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
    if (!template.trim()) {
      setError("Prompt template cannot be empty.");
      return;
    }
    setError(null);
    setSaved(false);
    startSave(async () => {
      try {
        await updateIntelPromptAction(template);
        setSaved(true);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Save failed");
      }
    });
  }

  return (
    <section className="mt-10 border-t border-white/[0.06] pt-8">
      {/* Collapsed header — always visible */}
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-3 text-left"
      >
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] bg-neon-soft">
          <Icon name="BarChart2" className="h-4 w-4 text-neon" />
        </div>
        <div className="flex-1 min-w-0">
          <span className="flex items-center gap-2 text-sm font-semibold">
            Intel Report Agent
            <Badge tone="neutral" className="text-[10px]">System</Badge>
            {!agent && (
              <Badge tone="warning" className="text-[10px]">Not seeded</Badge>
            )}
          </span>
          <p className="text-xs text-muted-2 truncate">
            Automated Digital Intelligence pipeline · Admin-only
          </p>
        </div>
        <Icon
          name="ChevronDown"
          className={`h-4 w-4 shrink-0 text-muted-2 transition-transform duration-200 ${open ? "rotate-180" : ""}`}
        />
      </button>

      {/* Expandable body */}
      {open && (
        <div className="mt-4">
          {!agent ? (
            <Card className="flex flex-col items-center gap-4 py-10 text-center">
              <div className="flex h-14 w-14 items-center justify-center rounded-[16px] bg-neon-soft">
                <Icon name="Zap" className="h-7 w-7 text-neon" />
              </div>
              <div>
                <p className="font-medium">Intel Agent not seeded yet</p>
                <p className="mt-1 text-sm text-muted-2">
                  Click below to seed the Intel Report Agent with the default prompt template. You
                  can customise the prompt after seeding.
                </p>
              </div>
              <Button onClick={handleSeed} loading={seeding}>
                <Icon name="Zap" className="h-4 w-4" />
                Seed Intel Agent
              </Button>
              {error && <p className="text-xs text-danger">{error}</p>}
            </Card>
          ) : (
            <Card className="space-y-4">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <CardTitle>Prompt Template</CardTitle>
                  <p className="mt-0.5 text-xs text-muted-2">
                    Compiled with client variables ({"{COMPANY_NAME}"}, {"{WEBSITE_URL}"},{" "}
                    {"{INDUSTRY}"}, {"{DESCRIPTION}"}) before each Claude API call. Changes take
                    effect on the next report generation.
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {saved && (
                    <span className="flex items-center gap-1 text-xs text-neon">
                      <Icon name="Check" className="h-3.5 w-3.5" />
                      Saved
                    </span>
                  )}
                  <Button size="sm" onClick={handleSave} loading={saving} disabled={saving}>
                    <Icon name="Save" className="h-3.5 w-3.5" />
                    Save template
                  </Button>
                </div>
              </div>

              <div>
                <Label>System Prompt / Methodology Template</Label>
                <Textarea
                  value={template}
                  onChange={(e) => {
                    setTemplate(e.target.value);
                    setSaved(false);
                  }}
                  className="h-[480px] font-mono text-xs leading-relaxed"
                  placeholder="Enter the Markdown prompt template…"
                />
                <p className="mt-1 text-xs text-muted-2">
                  {template.length.toLocaleString()} characters · ~
                  {Math.round(template.length / 4).toLocaleString()} tokens
                </p>
              </div>

              {error && (
                <div className="flex items-center gap-2 rounded-[8px] border border-red-500/30 bg-red-500/10 px-3 py-2">
                  <Icon name="TriangleAlert" className="h-4 w-4 shrink-0 text-red-400" />
                  <p className="text-xs text-red-400">{error}</p>
                </div>
              )}

              <div className="rounded-[10px] border border-neon/20 bg-neon-soft px-4 py-3">
                <p className="text-xs font-medium text-neon">Template variables</p>
                <p className="mt-1 text-xs text-muted-2">
                  Replaced with real client data before each generation:
                </p>
                <div className="mt-2 flex flex-wrap gap-2">
                  {["{COMPANY_NAME}", "{WEBSITE_URL}", "{INDUSTRY}", "{DESCRIPTION}", "{DATE}"].map(
                    (v) => (
                      <code
                        key={v}
                        className="rounded bg-neon/10 px-1.5 py-0.5 font-mono text-[11px] text-neon"
                      >
                        {v}
                      </code>
                    ),
                  )}
                </div>
              </div>
            </Card>
          )}
        </div>
      )}
    </section>
  );
}
