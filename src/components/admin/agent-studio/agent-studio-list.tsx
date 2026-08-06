"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Badge, Button, Card, CardTitle, EmptyState } from "@/components/ui";
import { Icon } from "@/components/icon";
import {
  createDynamicAgentSpecAction,
  deleteDynamicAgentSpecAction,
  setDynamicAgentSpecActiveAction,
} from "@/lib/actions";
import type { DynamicAgentSpec } from "@/lib/types";
import { GeneralSettingsForm, type GeneralSettingsDraft } from "./general-settings-form";
import { Modal } from "@/components/modal";

const BLANK_DRAFT: GeneralSettingsDraft = {
  name: "",
  summary: "",
  description: "",
  category: "",
  icon: "Sparkles",
  creditsCost: 0,
  active: false,
  allowedClientIds: [],
};

export function AgentStudioList({
  specs,
  clients,
}: {
  specs: DynamicAgentSpec[];
  clients: { id: string; name: string }[];
}) {
  const router = useRouter();
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function handleCreate(draft: GeneralSettingsDraft) {
    setError(null);
    startTransition(async () => {
      const result = await createDynamicAgentSpecAction(draft);
      if (!result.ok || !result.id) {
        setError(result.error ?? "Could not create the agent.");
        return;
      }
      setCreating(false);
      router.push(`/admin/agents/builder/${result.id}`);
    });
  }

  function handleToggleActive(spec: DynamicAgentSpec) {
    startTransition(async () => {
      const result = await setDynamicAgentSpecActiveAction(spec.id, !spec.active);
      if (result.ok) router.refresh();
    });
  }

  function handleDelete(spec: DynamicAgentSpec) {
    startTransition(async () => {
      const result = await deleteDynamicAgentSpecAction(spec.id);
      if (result.ok) router.refresh();
    });
  }

  return (
    <>
      <Card className="mb-4">
        <div className="flex items-center justify-between">
          <CardTitle>Agents</CardTitle>
          <Button size="sm" onClick={() => setCreating(true)}>
            <Icon name="Plus" className="h-3.5 w-3.5" />
            New agent
          </Button>
        </div>

        {specs.length === 0 ? (
          <EmptyState
            icon={<Icon name="Sparkles" className="h-6 w-6" />}
            title="No dynamic agents yet"
            description="Build one visually — general settings, an input schema, and a step pipeline. No deploy required."
          />
        ) : (
          <div className="mt-4 space-y-2">
            {specs.map((spec) => (
              <div
                key={spec.id}
                className="flex items-center justify-between gap-3 rounded-md border border-border bg-surface-2 px-3 py-2.5"
              >
                <div className="flex min-w-0 items-center gap-2.5">
                  <Icon name={spec.icon || "Sparkles"} className="h-4 w-4 shrink-0 text-muted-2" />
                  <div className="min-w-0">
                    <a
                      href={`/admin/agents/builder/${spec.id}`}
                      className="truncate text-sm font-medium text-foreground hover:underline"
                    >
                      {spec.name || "Untitled agent"}
                    </a>
                    {/* The one-liner this list exists for, falling back to the
                        full description so a spec written before `summary`
                        existed still says what it does. */}
                    {(spec.summary || spec.description) && (
                      <p className="truncate text-xs text-muted">{spec.summary || spec.description}</p>
                    )}
                    <p className="truncate text-xs text-muted-2">
                      {spec.category || "Uncategorized"} · {spec.steps.length} step
                      {spec.steps.length === 1 ? "" : "s"} · {spec.creditsCost} credit
                      {spec.creditsCost === 1 ? "" : "s"}
                    </p>
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <Badge tone={spec.active ? "success" : "neutral"}>{spec.active ? "Active" : "Inactive"}</Badge>
                  <Button size="sm" variant="outline" disabled={pending} onClick={() => handleToggleActive(spec)}>
                    {spec.active ? "Deactivate" : "Activate"}
                  </Button>
                  <Button size="sm" variant="ghost" disabled={pending} onClick={() => handleDelete(spec)}>
                    <Icon name="Trash2" className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>

      <Modal
        open={creating}
        onClose={() => setCreating(false)}
        title="New agent"
        description="General settings only for now — you'll build the input schema and pipeline after this is created."
      >
        <GeneralSettingsForm
          initial={BLANK_DRAFT}
          clients={clients}
          submitLabel="Create agent"
          pending={pending}
          error={error}
          onSubmit={handleCreate}
        />
      </Modal>
    </>
  );
}
