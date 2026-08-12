"use client";

import { useMemo, useState } from "react";
import { Badge, Button, Input, Label, Select, Textarea } from "@/components/ui";
import { Icon } from "@/components/icon";
import type { DynamicAgentInputDef, DynamicAgentModelAlias, DynamicAgentStepDef } from "@/lib/types";

const MODEL_OPTIONS: { value: DynamicAgentModelAlias; label: string }[] = [
  { value: "opus", label: "Opus — highest capability" },
  { value: "sonnet", label: "Sonnet — balanced" },
  { value: "haiku", label: "Haiku — fast & cheap" },
];

/**
 * `step_${order + 1}` collides once a step has been deleted: e.g. step_1/
 * step_2/step_3, delete step_2 (leaving step_1/step_3 re-ordered to 0/1), add
 * one more — `order + 1` is 2, reproducing `step_3` verbatim. Walk past every
 * id already in use instead of trusting the next array length to be unused.
 */
function nextStepId(existingIds: string[]): string {
  const used = new Set(existingIds);
  let n = existingIds.length + 1;
  while (used.has(`step_${n}`)) n += 1;
  return `step_${n}`;
}

function blankAiStep(order: number, existingIds: string[]): DynamicAgentStepDef {
  return {
    id: nextStepId(existingIds),
    type: "ai",
    label: "",
    model: "sonnet",
    prompt: "",
    order,
    // Both grants default OFF for a new step — default deny, never default
    // allow. See dynamic-agent-validation.ts's normalizeSteps for why absent
    // and explicit-false are treated identically everywhere else.
    allowNetwork: false,
    allowClientData: false,
  };
}

function blankCodeStep(order: number, existingIds: string[]): DynamicAgentStepDef {
  return {
    id: nextStepId(existingIds),
    type: "code",
    label: "",
    language: "node",
    code: "",
    timeoutMs: 30_000,
    order,
  };
}

/** Context keys available to a step at `index`: every client input, plus every preceding step's own id (its `outputs.<stepId>`). */
function availableContextKeys(inputs: DynamicAgentInputDef[], steps: DynamicAgentStepDef[], index: number): string[] {
  const inputKeys = inputs.map((i) => `inputs.${i.key || "…"}`);
  const outputKeys = steps.slice(0, index).map((s) => `outputs.${s.id || "…"}`);
  return [...inputKeys, ...outputKeys];
}

/**
 * Agent Studio's Pipeline & Step Builder (Phase 5): add / delete / reorder
 * steps, an AI step editor (Markdown prompt + model alias select) and a Code
 * step editor (language + code, gated behind `codeStepsEnabled`), plus a
 * compact visual chain and a live list of the context keys available at each
 * step's position.
 */
export function StepPipelineBuilder({
  initial,
  inputSchema,
  codeStepsEnabled,
  pending,
  error,
  onSave,
}: {
  initial: DynamicAgentStepDef[];
  inputSchema: DynamicAgentInputDef[];
  codeStepsEnabled: boolean;
  pending: boolean;
  error: string | null;
  onSave: (steps: DynamicAgentStepDef[]) => void;
}) {
  const [steps, setSteps] = useState<DynamicAgentStepDef[]>([...initial].sort((a, b) => a.order - b.order));

  function update(index: number, next: DynamicAgentStepDef) {
    setSteps((current) => current.map((s, i) => (i === index ? next : s)));
  }

  function addStep(type: "ai" | "code") {
    setSteps((current) => {
      const existingIds = current.map((s) => s.id);
      return [
        ...current,
        type === "ai" ? blankAiStep(current.length, existingIds) : blankCodeStep(current.length, existingIds),
      ];
    });
  }

  function removeStep(index: number) {
    setSteps((current) => current.filter((_, i) => i !== index).map((s, i) => ({ ...s, order: i })));
  }

  function move(index: number, direction: -1 | 1) {
    setSteps((current) => {
      const target = index + direction;
      if (target < 0 || target >= current.length) return current;
      const next = [...current];
      [next[index], next[target]] = [next[target], next[index]];
      return next.map((s, i) => ({ ...s, order: i }));
    });
  }

  const chain = useMemo(() => steps.map((s) => (s.label || s.id || "Untitled")), [steps]);

  return (
    <div className="space-y-4">
      {steps.length > 0 ? (
        <div className="flex flex-wrap items-center gap-1.5 rounded-md border border-dashed border-border bg-foreground/[0.02] px-3 py-2 text-xs text-muted-2">
          {chain.map((label, i) => {
            const step = steps[i];
            const hasGrant = step.type === "ai" && (step.allowNetwork || step.allowClientData);
            return (
              <span key={i} className="flex items-center gap-1.5">
                <Badge tone={step.type === "ai" ? "info" : "warning"}>{step.type === "ai" ? "AI" : "Code"}</Badge>
                {label}
                {hasGrant ? (
                  <span
                    className="flex items-center gap-0.5"
                    title={[
                      step.type === "ai" && step.allowNetwork ? "Network access" : null,
                      step.type === "ai" && step.allowClientData ? "Client data access" : null,
                    ]
                      .filter(Boolean)
                      .join(", ")}
                  >
                    {step.type === "ai" && step.allowNetwork ? <Icon name="Globe" className="h-3 w-3" /> : null}
                    {step.type === "ai" && step.allowClientData ? <Icon name="FileText" className="h-3 w-3" /> : null}
                  </span>
                ) : null}
                {i < chain.length - 1 ? <Icon name="ArrowRight" className="h-3 w-3" /> : null}
              </span>
            );
          })}
        </div>
      ) : (
        <p className="text-xs text-muted-2">No steps yet. Add at least one AI or Code step below.</p>
      )}

      <div className="space-y-3">
        {steps.map((step, index) => (
          <div key={index} className="rounded-md border border-border bg-surface-2 p-3">
            <div className="mb-3 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Badge tone={step.type === "ai" ? "info" : "warning"}>{step.type === "ai" ? "AI step" : "Code step"}</Badge>
                <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-muted-2">Step {index + 1}</span>
              </div>
              <div className="flex items-center gap-1">
                <Button type="button" size="icon" variant="ghost" disabled={index === 0} onClick={() => move(index, -1)} aria-label="Move up">
                  <Icon name="ChevronUp" className="h-4 w-4" />
                </Button>
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  disabled={index === steps.length - 1}
                  onClick={() => move(index, 1)}
                  aria-label="Move down"
                >
                  <Icon name="ChevronDown" className="h-4 w-4" />
                </Button>
                <Button type="button" size="icon" variant="ghost" onClick={() => removeStep(index)} aria-label="Delete step">
                  <Icon name="Trash2" className="h-4 w-4" />
                </Button>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label htmlFor={`sp-id-${index}`}>Step id</Label>
                <Input
                  id={`sp-id-${index}`}
                  value={step.id}
                  onChange={(e) => update(index, { ...step, id: e.target.value.trim() })}
                />
              </div>
              <div>
                <Label htmlFor={`sp-label-${index}`}>Label</Label>
                <Input
                  id={`sp-label-${index}`}
                  value={step.label}
                  onChange={(e) => update(index, { ...step, label: e.target.value })}
                />
              </div>
            </div>

            <p className="mt-2 text-[11px] leading-snug text-muted-2">
              Available context at this step:{" "}
              {availableContextKeys(inputSchema, steps, index).length === 0
                ? "none yet"
                : availableContextKeys(inputSchema, steps, index).map((k) => (
                    <code key={k} className="mr-1 rounded bg-foreground/[0.06] px-1 py-0.5 font-mono">
                      {k}
                    </code>
                  ))}
            </p>

            {step.type === "ai" ? (
              <div className="mt-3 space-y-3">
                <div>
                  <Label htmlFor={`sp-model-${index}`}>Model</Label>
                  <Select
                    id={`sp-model-${index}`}
                    value={step.model}
                    onChange={(e) => update(index, { ...step, model: e.target.value as DynamicAgentModelAlias })}
                  >
                    {MODEL_OPTIONS.map((m) => (
                      <option key={m.value} value={m.value}>
                        {m.label}
                      </option>
                    ))}
                  </Select>
                </div>
                <div>
                  <Label htmlFor={`sp-prompt-${index}`}>Prompt (Markdown)</Label>
                  <Textarea
                    id={`sp-prompt-${index}`}
                    className="min-h-[160px] font-mono text-xs"
                    value={step.prompt}
                    onChange={(e) => update(index, { ...step, prompt: e.target.value })}
                    placeholder={"Reference client answers and prior step output by key, e.g. {{inputs.company_name}} or {{outputs.research}}."}
                  />
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <label className="flex items-center gap-2 text-sm text-foreground">
                    <input
                      type="checkbox"
                      className="accent-neon"
                      checked={step.allowNetwork === true}
                      onChange={(e) => update(index, { ...step, allowNetwork: e.target.checked })}
                    />
                    Network access
                  </label>
                  <label className="flex items-center gap-2 text-sm text-foreground">
                    <input
                      type="checkbox"
                      className="accent-neon"
                      checked={step.allowClientData === true}
                      onChange={(e) => update(index, { ...step, allowClientData: e.target.checked })}
                    />
                    Client data access
                  </label>
                </div>
                <p className="text-[11px] leading-snug text-muted-2">
                  Network access: this step may fetch from the network. Egress is restricted to the allowlist.
                  <br />
                  Client data access: this step may read this client&apos;s documents from the portal.
                </p>
                {step.allowNetwork && step.allowClientData ? (
                  <div className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 px-3 py-2">
                    <Icon name="CircleAlert" className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" />
                    <p className="text-xs leading-snug text-warning">
                      This step has both network access and client data access. That combination can move this
                      client&apos;s data off the platform — make sure the prompt above needs both before saving.
                    </p>
                  </div>
                ) : null}
              </div>
            ) : (
              <div className="mt-3 space-y-3">
                {!codeStepsEnabled ? (
                  <div className="flex items-center gap-2 rounded-md border border-dashed border-border bg-foreground/[0.02] px-3 py-2">
                    <Badge tone="neutral">Coming soon</Badge>
                    <p className="text-xs text-muted-2">
                      Code steps are not enabled on this environment yet (DYNAMIC_CODE_STEPS_ENABLED is off). This
                      step is saved but will be refused at run time until it is turned on.
                    </p>
                  </div>
                ) : null}
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <Label htmlFor={`sp-lang-${index}`}>Language</Label>
                    <Select
                      id={`sp-lang-${index}`}
                      disabled={!codeStepsEnabled}
                      value={step.language}
                      onChange={(e) => update(index, { ...step, language: e.target.value as "python" | "node" })}
                    >
                      <option value="node">Node.js</option>
                      <option value="python">Python</option>
                    </Select>
                  </div>
                  <div>
                    <Label htmlFor={`sp-timeout-${index}`}>Timeout (ms)</Label>
                    <Input
                      id={`sp-timeout-${index}`}
                      type="number"
                      disabled={!codeStepsEnabled}
                      min={1}
                      max={120_000}
                      value={step.timeoutMs ?? 30_000}
                      onChange={(e) => update(index, { ...step, timeoutMs: Number(e.target.value) || 30_000 })}
                    />
                  </div>
                </div>
                <div>
                  <Label htmlFor={`sp-code-${index}`}>Code</Label>
                  <p className="mb-1 text-[11px] leading-snug text-muted-2">
                    The script receives <code className="font-mono">context</code> as JSON on stdin and must write a
                    JSON object to stdout.
                  </p>
                  <Textarea
                    id={`sp-code-${index}`}
                    disabled={!codeStepsEnabled}
                    className="min-h-[160px] font-mono text-xs"
                    value={step.code}
                    onChange={(e) => update(index, { ...step, code: e.target.value })}
                  />
                </div>
              </div>
            )}
          </div>
        ))}
      </div>

      <div className="flex gap-2">
        <Button type="button" variant="outline" onClick={() => addStep("ai")}>
          <Icon name="Plus" className="h-3.5 w-3.5" />
          Add AI step
        </Button>
        <Button type="button" variant="outline" onClick={() => addStep("code")}>
          <Icon name="Plus" className="h-3.5 w-3.5" />
          Add code step
        </Button>
      </div>

      {error ? <p className="text-xs text-danger" role="alert">{error}</p> : null}

      <div>
        <Button type="button" disabled={pending} loading={pending} onClick={() => onSave(steps)}>
          Save pipeline
        </Button>
      </div>
    </div>
  );
}
