"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Badge, Card, TabButton } from "@/components/ui";
import { updateDynamicAgentSpecAction } from "@/lib/actions";
import type { DynamicAgentInputDef, DynamicAgentSpec, DynamicAgentStepDef } from "@/lib/types";
import { GeneralSettingsForm, type GeneralSettingsDraft } from "./general-settings-form";
import { InputSchemaBuilder } from "./input-schema-builder";
import { StepPipelineBuilder } from "./step-pipeline-builder";
import { GenerateFromTextPanel } from "./generate-from-text-panel";

type Tab = "general" | "inputs" | "pipeline" | "generate";

export function AgentStudioEditor({
  spec,
  clients,
  codeStepsEnabled,
}: {
  spec: DynamicAgentSpec;
  clients: { id: string; name: string }[];
  codeStepsEnabled: boolean;
}) {
  const router = useRouter();
  const [tab, setTab] = useState<Tab>("general");
  const [version, setVersion] = useState(spec.version);
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [pending, startTransition] = useTransition();

  // The editor's own working copy of the input schema / pipeline — starts as
  // the persisted spec, but a generated-and-applied draft (see
  // GenerateFromTextPanel below) overwrites it BEFORE it is ever saved.
  // `draftKey` forces InputSchemaBuilder/StepPipelineBuilder to remount with
  // the new `initial` when a draft is applied — both builders only read
  // `initial` on mount, by design (an admin's in-progress edits must never be
  // clobbered by a server prop refresh).
  const [inputSchema, setInputSchema] = useState<DynamicAgentInputDef[]>(spec.inputSchema);
  const [steps, setSteps] = useState<DynamicAgentStepDef[]>(spec.steps);
  const [draftKey, setDraftKey] = useState(0);

  function applyGeneratedDraft(draft: { inputSchema: DynamicAgentInputDef[]; steps: DynamicAgentStepDef[] }) {
    setInputSchema(draft.inputSchema);
    setSteps(draft.steps);
    setDraftKey((k) => k + 1);
    setError(null);
    setWarning(null);
    setSaved(false);
    setTab("inputs");
  }

  function switchTab(next: Tab) {
    setError(null);
    setSaved(false);
    setTab(next);
  }

  function saveGeneral(draft: GeneralSettingsDraft) {
    setError(null);
    setSaved(false);
    startTransition(async () => {
      const result = await updateDynamicAgentSpecAction(spec.id, { general: draft });
      if (!result.ok) {
        setError(result.error ?? "Could not save general settings.");
        return;
      }
      setVersion(result.version ?? version);
      setSaved(true);
      router.refresh();
    });
  }

  function saveInputSchema(fields: DynamicAgentInputDef[]) {
    setError(null);
    setWarning(null);
    setSaved(false);
    startTransition(async () => {
      const result = await updateDynamicAgentSpecAction(spec.id, { inputSchema: fields });
      if (!result.ok) {
        setError(result.error ?? "Could not save the input schema.");
        return;
      }
      setInputSchema(fields);
      setVersion(result.version ?? version);
      setWarning(result.warning ?? null);
      setSaved(true);
      router.refresh();
    });
  }

  function saveSteps(nextSteps: DynamicAgentStepDef[]) {
    setError(null);
    setWarning(null);
    setSaved(false);
    startTransition(async () => {
      const result = await updateDynamicAgentSpecAction(spec.id, { steps: nextSteps });
      if (!result.ok) {
        setError(result.error ?? "Could not save the pipeline.");
        return;
      }
      setSteps(nextSteps);
      setVersion(result.version ?? version);
      setWarning(result.warning ?? null);
      setSaved(true);
      router.refresh();
    });
  }

  return (
    <Card>
      <div className="mb-4 flex items-center justify-between">
        <div className="flex border-b border-border">
          <TabButton active={tab === "general"} onClick={() => switchTab("general")} icon="Settings">
            General
          </TabButton>
          <TabButton active={tab === "inputs"} onClick={() => switchTab("inputs")} icon="ListChecks">
            Inputs
          </TabButton>
          <TabButton active={tab === "pipeline"} onClick={() => switchTab("pipeline")} icon="Workflow">
            Pipeline
          </TabButton>
          <TabButton active={tab === "generate"} onClick={() => switchTab("generate")} icon="WandSparkles">
            Generate
          </TabButton>
        </div>
        <div className="flex items-center gap-2 text-xs text-muted-2">
          <Badge tone="neutral">v{version}</Badge>
          {saved ? <span className="text-success">Saved</span> : null}
        </div>
      </div>

      {warning ? (
        <p className="mb-3 text-xs text-warning" role="alert">
          {warning}
        </p>
      ) : null}

      {tab === "general" ? (
        <GeneralSettingsForm
          initial={{
            name: spec.name,
            summary: spec.summary ?? "",
            description: spec.description,
            category: spec.category,
            icon: spec.icon,
            creditsCost: spec.creditsCost,
            active: spec.active,
            allowedClientIds: spec.allowedClientIds ?? [],
            dedupeAgainstHistory: spec.dedupeAgainstHistory === true,
          }}
          clients={clients}
          submitLabel="Save general settings"
          pending={pending}
          error={error}
          onSubmit={saveGeneral}
        />
      ) : null}

      {tab === "inputs" ? (
        <InputSchemaBuilder key={draftKey} initial={inputSchema} pending={pending} error={error} onSave={saveInputSchema} />
      ) : null}

      {tab === "pipeline" ? (
        <StepPipelineBuilder
          key={draftKey}
          initial={steps}
          inputSchema={inputSchema}
          codeStepsEnabled={codeStepsEnabled}
          pending={pending}
          error={error}
          onSave={saveSteps}
        />
      ) : null}

      {tab === "generate" ? (
        <GenerateFromTextPanel
          hasExistingContent={inputSchema.length > 0 || steps.length > 0}
          onApply={applyGeneratedDraft}
        />
      ) : null}
    </Card>
  );
}
