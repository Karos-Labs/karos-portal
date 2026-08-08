"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Badge, Card, TabButton } from "@/components/ui";
import { updateDynamicAgentSpecAction } from "@/lib/actions";
import type { DynamicAgentInputDef, DynamicAgentSpec, DynamicAgentStepDef } from "@/lib/types";
import { GeneralSettingsForm, type GeneralSettingsDraft } from "./general-settings-form";
import { InputSchemaBuilder } from "./input-schema-builder";
import { StepPipelineBuilder } from "./step-pipeline-builder";

type Tab = "general" | "inputs" | "pipeline";

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
  const [saved, setSaved] = useState(false);
  const [pending, startTransition] = useTransition();

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
    setSaved(false);
    startTransition(async () => {
      const result = await updateDynamicAgentSpecAction(spec.id, { inputSchema: fields });
      if (!result.ok) {
        setError(result.error ?? "Could not save the input schema.");
        return;
      }
      setVersion(result.version ?? version);
      setSaved(true);
      router.refresh();
    });
  }

  function saveSteps(steps: DynamicAgentStepDef[]) {
    setError(null);
    setSaved(false);
    startTransition(async () => {
      const result = await updateDynamicAgentSpecAction(spec.id, { steps });
      if (!result.ok) {
        setError(result.error ?? "Could not save the pipeline.");
        return;
      }
      setVersion(result.version ?? version);
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
        </div>
        <div className="flex items-center gap-2 text-xs text-muted-2">
          <Badge tone="neutral">v{version}</Badge>
          {saved ? <span className="text-success">Saved</span> : null}
        </div>
      </div>

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
          }}
          clients={clients}
          submitLabel="Save general settings"
          pending={pending}
          error={error}
          onSubmit={saveGeneral}
        />
      ) : null}

      {tab === "inputs" ? (
        <InputSchemaBuilder initial={spec.inputSchema} pending={pending} error={error} onSave={saveInputSchema} />
      ) : null}

      {tab === "pipeline" ? (
        <StepPipelineBuilder
          initial={spec.steps}
          inputSchema={spec.inputSchema}
          codeStepsEnabled={codeStepsEnabled}
          pending={pending}
          error={error}
          onSave={saveSteps}
        />
      ) : null}
    </Card>
  );
}
