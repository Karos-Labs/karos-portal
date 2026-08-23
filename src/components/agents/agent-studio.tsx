"use client";

import { useState, useTransition } from "react";
import { Badge, Button, Card, CardTitle, Input, Label, Select, Textarea } from "@/components/ui";
import {
  activatePromptVersionAction,
  bindTemplateAction,
  promoteFeedbackAction,
  requestModelAccessAction,
  savePromptVersionAction,
  setAgentModelAction,
  setStageModelAction,
  setAgentStatusAction,
} from "@/lib/actions/control-plane-actions";
import { feedbackStatusLabel } from "@/lib/feedback-status-copy";
import type {
  MiddlewareAgent,
  MiddlewareFeedback,
  MiddlewareModel,
  MiddlewarePrompt,
  MiddlewareTemplate,
} from "@/lib/agent-engine/middleware-admin";

/**
 * Everything about one agent, in one place.
 *
 * Every mutation goes through a server action that re-checks `requireAdmin()`
 * — the page itself admits employees so they can read what an agent does, and
 * the write fence is server-side because hiding a button is not a permission.
 *
 * Nothing here falls back when the control plane is down. An edit either
 * landed or it did not, and reporting a save that did not happen is worse than
 * reporting the failure.
 */
type Result = { ok: true } | { ok: false; error: string };
type Apply = (run: () => Promise<Result>, success: string) => void;

export function AgentStudio({
  agent,
  activePrompt,
  promptHistory,
  templates,
  models,
  feedback,
}: {
  agent: MiddlewareAgent;
  activePrompt: MiddlewarePrompt | null;
  promptHistory: MiddlewarePrompt[];
  templates: MiddlewareTemplate[];
  models: MiddlewareModel[];
  feedback: MiddlewareFeedback[];
}) {
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, startTransition] = useTransition();

  const apply: Apply = (run, success) => {
    startTransition(async () => {
      const result = await run();
      setNotice(result.ok ? { ok: true, text: success } : { ok: false, text: result.error });
    });
  };

  return (
    <div className="space-y-6">
      {notice && (
        <div
          role="status"
          className={`rounded-lg border px-4 py-3 text-sm ${
            notice.ok
              ? "border-neon/40 bg-neon/10 text-neon"
              : "border-red-500/40 bg-red-500/10 text-red-400"
          }`}
        >
          {notice.text}
        </div>
      )}

      <Card className="p-6">
        <CardTitle>Overview</CardTitle>
        <div className="mt-3 flex flex-wrap items-center gap-3 text-sm">
          <code className="text-xs opacity-60">{agent.slug}</code>
          <Badge tone={agent.status === "active" ? "success" : "neutral"}>{agent.status}</Badge>
          {agent.category && <Badge tone="neutral">{agent.category}</Badge>}
          {agent.creditCost !== null && <span className="text-xs opacity-70">{agent.creditCost} credits per run</span>}
          <Button
            variant="ghost"
            disabled={pending}
            onClick={() =>
              apply(
                () => setAgentStatusAction(agent.slug, agent.status === "active" ? "disabled" : "active"),
                `${agent.name} is now ${agent.status === "active" ? "disabled" : "active"}.`,
              )
            }
          >
            {agent.status === "active" ? "Disable" : "Enable"}
          </Button>
        </div>
      </Card>

      <StagesPanel agent={agent} models={models} pending={pending} apply={apply} />
      <ModelPanel agent={agent} models={models} pending={pending} apply={apply} />
      <PromptPanel agent={agent} activePrompt={activePrompt} history={promptHistory} pending={pending} apply={apply} />
      <TemplatePanel agent={agent} templates={templates} pending={pending} apply={apply} />
      <FeedbackPanel agent={agent} feedback={feedback} pending={pending} apply={apply} />
    </div>
  );
}

/**
 * What the workflow actually runs, in order.
 *
 * Read-only, and labelled so. These stages are TypeScript in agent-engine,
 * extracted from its own sources rather than typed in beside it — a
 * hand-maintained list next to a workflow that changes is how a Studio ends up
 * describing a program that no longer exists. Offering an edit here would
 * change a page and not a program.
 *
 * The ids match a run's step trace on purpose: comparing the two is how
 * someone finds where a run stopped.
 */
function StagesPanel({
  agent,
  models,
  pending,
  apply,
}: {
  agent: MiddlewareAgent;
  models: MiddlewareModel[];
  pending: boolean;
  apply: Apply;
}) {
  if (agent.stages.length === 0) {
    return (
      <Card className="p-6">
        <CardTitle>Stages</CardTitle>
        <p className="mt-2 text-sm opacity-70">
          No stages recorded. Re-run agent-middleware&apos;s scripts/seed_all_agents.py, which reads them from
          agent-engine&apos;s workflow sources.
        </p>
      </Card>
    );
  }

  return (
    <Card className="p-6">
      <CardTitle>
        Stages
        <span className="ml-2 text-sm opacity-60">
          {agent.stages.length}
          {agent.stagesReadOnly ? " · read-only (compiled workflow)" : ""}
        </span>
      </CardTitle>
      <ol className="mt-4 space-y-1">
        {agent.stages.map((stage, i) => (
          <li key={stage.id} className="flex flex-wrap items-center gap-2 rounded border border-white/10 px-3 py-2">
            <span className="w-6 text-xs opacity-50">{i + 1}</span>
            <span className="text-sm">{stage.label}</span>
            <code className="text-xs opacity-50">{stage.id}</code>
            {stage.isGate && <Badge tone="warning">waits for a human</Badge>}
            {stage.kind === "ai" && (
              <StageModelPicker agent={agent} stage={stage} models={models} pending={pending} apply={apply} />
            )}
          </li>
        ))}
      </ol>
    </Card>
  );
}

/**
 * One stage's own model.
 *
 * Rendered only on `"ai"` stages, because a code step has no model to set and
 * a disabled control that explains itself is still a control someone has to
 * read past.
 *
 * "Agent default" is the empty option rather than a repeat of the agent-level
 * model id: the point of leaving a stage unset is that it FOLLOWS the agent,
 * so naming the current default here would make it look pinned, and it would
 * go stale the moment the agent-level model changed.
 *
 * The stage list is read-only above and this is not, which looks like a
 * contradiction and is not: the list is compiled TypeScript, and editing it
 * here would describe a program that does not exist. Which model a stage runs
 * on is configuration the engine reads per run.
 */
function StageModelPicker({
  agent,
  stage,
  models,
  pending,
  apply,
}: {
  agent: MiddlewareAgent;
  stage: MiddlewareAgent["stages"][number];
  models: MiddlewareModel[];
  pending: boolean;
  apply: Apply;
}) {
  return (
    <label className="ml-auto flex items-center gap-2">
      <span className="text-xs opacity-60">Model</span>
      <Select
        aria-label={`Model for ${stage.label}`}
        value={stage.modelId ?? ""}
        disabled={pending}
        onChange={(e) => {
          const next = e.target.value === "" ? null : e.target.value;
          apply(
            () => setStageModelAction(agent.slug, stage.id, next),
            next === null ? `${stage.label} follows the agent default again` : `${stage.label} now runs on ${next}`,
          );
        }}
      >
        <option value="">Agent default</option>
        {models.map((m) => (
          <option key={m.modelId} value={m.modelId} disabled={m.availability !== "available"}>
            {m.displayName}
            {m.availability === "not_enabled" ? " — not enabled here" : ""}
            {m.availability === "retired" ? " — retired" : ""}
          </option>
        ))}
      </Select>
    </label>
  );
}

/**
 * The model dropdown, from the normalized catalog.
 *
 * Models this deployment does not route are listed and DISABLED rather than
 * hidden: a dropdown showing only what works reads as the whole of what Vertex
 * offers, and that is how someone concludes a model is unavailable when it is
 * one config change away.
 */
function ModelPanel({
  agent,
  models,
  pending,
  apply,
}: {
  agent: MiddlewareAgent;
  models: MiddlewareModel[];
  pending: boolean;
  apply: Apply;
}) {
  const [modelId, setModelId] = useState(
    agent.model ?? models.find((m) => m.availability === "available")?.modelId ?? "",
  );
  const [reason, setReason] = useState("");

  const chosen = models.find((m) => m.modelId === modelId);
  const needsAccess = chosen?.availability === "not_enabled";

  if (models.length === 0) {
    return (
      <Card className="p-6">
        <CardTitle>Model</CardTitle>
        <p className="mt-2 text-sm opacity-70">
          The model catalog is empty. Seed it with agent-middleware&apos;s scripts/seed_models.py.
        </p>
      </Card>
    );
  }

  return (
    <Card className="p-6">
      <CardTitle>Model</CardTitle>
      <p className="mt-1 text-sm opacity-70">
        A normalized model id, so what this agent runs on is a lookup rather than a spelling.
      </p>

      <div className="mt-4 flex flex-wrap items-end gap-3">
        <div className="min-w-64 flex-1">
          <Label htmlFor="model-id">Model</Label>
          <Select id="model-id" value={modelId} onChange={(e) => setModelId(e.target.value)}>
            {models.map((m) => (
              <option key={m.modelId} value={m.modelId} disabled={m.availability !== "available"}>
                {m.displayName}
                {m.availability === "not_enabled" ? " — not enabled here" : ""}
                {m.availability === "retired" ? " — retired" : ""}
              </option>
            ))}
          </Select>
        </div>
        <Button
          disabled={pending || !modelId || needsAccess || modelId === agent.model}
          onClick={() =>
            apply(
              () => setAgentModelAction(agent.slug, modelId),
              `${agent.name} now runs on ${chosen?.displayName ?? modelId}.`,
            )
          }
        >
          Save model
        </Button>
      </div>

      {chosen && (
        <p className="mt-3 text-xs opacity-60">
          {chosen.vendor} · sends <code>{chosen.providerModelName}</code>
          {chosen.region ? ` · ${chosen.region}` : ""}
          {chosen.supportsTools ? "" : " · no tool support"}
          {chosen.notes ? ` — ${chosen.notes}` : ""}
        </p>
      )}

      {needsAccess && (
        <div className="mt-4 rounded-lg border border-white/10 p-4">
          <p className="text-sm">
            {chosen?.displayName} is available in Vertex but not routed here. Requesting it records the ask; enabling
            it is a deployment decision someone makes separately.
          </p>
          <div className="mt-3 flex flex-wrap items-end gap-3">
            <div className="min-w-64 flex-1">
              <Label htmlFor="model-reason">Why this agent needs it</Label>
              <Input id="model-reason" value={reason} onChange={(e) => setReason(e.target.value)} />
            </div>
            <Button
              variant="ghost"
              disabled={pending}
              onClick={() =>
                apply(
                  () => requestModelAccessAction(modelId, { reason, agentId: agent.slug }),
                  "Request recorded. Nothing changed yet — someone has to enable it.",
                )
              }
            >
              Request access
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}

/**
 * The prompt editor and its version history.
 *
 * Saving always creates a NEW version — the control plane makes existing ones
 * immutable, which is what lets the version recorded on a run six weeks ago
 * still mean something. `activate: false` stages one without making it live.
 */
function PromptPanel({
  agent,
  activePrompt,
  history,
  pending,
  apply,
}: {
  agent: MiddlewareAgent;
  activePrompt: MiddlewarePrompt | null;
  history: MiddlewarePrompt[];
  pending: boolean;
  apply: Apply;
}) {
  const [content, setContent] = useState(activePrompt?.content ?? "");
  const [notes, setNotes] = useState("");
  const [activate, setActivate] = useState(true);

  const versions = [...history].sort((a, b) => b.version - a.version);

  return (
    <Card className="p-6">
      <CardTitle>
        System prompt
        {activePrompt ? (
          <span className="ml-2 text-sm opacity-60">active: v{activePrompt.version}</span>
        ) : (
          <span className="ml-2 text-sm opacity-60">no prompt yet</span>
        )}
      </CardTitle>
      <p className="mt-1 text-sm opacity-70">
        Saving creates a new version. Existing versions are immutable, which is what keeps the version recorded on a
        past run meaningful.
      </p>

      <div className="mt-4 space-y-4">
        <div>
          <Label htmlFor="prompt-content">Prompt body</Label>
          <Textarea
            id="prompt-content"
            rows={16}
            value={content}
            onChange={(e) => setContent(e.target.value)}
            className="font-mono text-sm"
          />
        </div>
        <div>
          <Label htmlFor="prompt-notes">Changelog</Label>
          <Input
            id="prompt-notes"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="What changed and why"
          />
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={activate} onChange={(e) => setActivate(e.target.checked)} />
          Make this the active version
        </label>
        <Button
          disabled={pending || content.trim().length === 0}
          onClick={() =>
            apply(
              () => savePromptVersionAction(agent.slug, { content, notes, activate }),
              activate ? "Saved and activated a new version." : "Saved a new version without activating it.",
            )
          }
        >
          Save new version
        </Button>
      </div>

      {versions.length > 0 && (
        <div className="mt-6">
          <p className="mb-2 text-xs uppercase tracking-wide opacity-50">Version history</p>
          <div className="space-y-1">
            {versions.map((v) => (
              <div key={v.id} className="flex flex-wrap items-center gap-3 rounded border border-white/10 px-3 py-2">
                <span className="text-sm">v{v.version}</span>
                {v.isActive && <Badge tone="success">active</Badge>}
                <span className="text-xs opacity-60">{v.content.length.toLocaleString()} chars</span>
                {v.notes && <span className="text-xs opacity-70">{v.notes}</span>}
                {v.createdBy && <span className="text-xs opacity-50">{v.createdBy}</span>}
                <div className="ml-auto flex gap-2">
                  <Button variant="ghost" disabled={pending} onClick={() => setContent(v.content)}>
                    Load
                  </Button>
                  {!v.isActive && (
                    <Button
                      variant="ghost"
                      disabled={pending}
                      onClick={() => apply(() => activatePromptVersionAction(agent.slug, v.id), `Activated v${v.version}.`)}
                    >
                      Activate
                    </Button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </Card>
  );
}

function TemplatePanel({
  agent,
  templates,
  pending,
  apply,
}: {
  agent: MiddlewareAgent;
  templates: MiddlewareTemplate[];
  pending: boolean;
  apply: Apply;
}) {
  const [purpose, setPurpose] = useState("");
  const [templateRef, setTemplateRef] = useState(templates[0]?.slug ?? "");

  return (
    <Card className="p-6">
      <CardTitle>Templates</CardTitle>
      <p className="mt-1 text-sm opacity-70">
        One template per purpose — the purpose is the binding&apos;s id, so re-binding replaces rather than duplicates.
      </p>

      <div className="mt-4 flex flex-wrap items-end gap-3">
        <div className="min-w-48 flex-1">
          <Label htmlFor="tpl-purpose">Purpose</Label>
          <Input
            id="tpl-purpose"
            value={purpose}
            onChange={(e) => setPurpose(e.target.value)}
            placeholder="e.g. carousel_slide"
          />
        </div>
        <div className="min-w-48 flex-1">
          <Label htmlFor="tpl-ref">Template</Label>
          <Select id="tpl-ref" value={templateRef} onChange={(e) => setTemplateRef(e.target.value)}>
            {templates.map((t) => (
              <option key={t.id} value={t.slug}>
                {t.name} ({t.kind})
              </option>
            ))}
          </Select>
        </div>
        <Button
          disabled={pending || !purpose.trim() || !templateRef}
          onClick={() =>
            apply(() => bindTemplateAction(agent.slug, purpose, templateRef), `Bound ${templateRef} as "${purpose}".`)
          }
        >
          Bind
        </Button>
      </div>

      {templates.length === 0 && <p className="mt-4 text-sm opacity-60">No templates in the control plane yet.</p>}
    </Card>
  );
}

/**
 * Reviewer feedback, and the one action that changes what the agent does next.
 *
 * Recording a verdict and teaching from it stay two clicks. If a rejection
 * promoted itself, every reaction would silently rewrite the agent and nobody
 * could reject something without also teaching from it.
 */
function FeedbackPanel({
  agent,
  feedback,
  pending,
  apply,
}: {
  agent: MiddlewareAgent;
  feedback: MiddlewareFeedback[];
  pending: boolean;
  apply: Apply;
}) {
  return (
    <Card className="p-6">
      <CardTitle>Review feedback</CardTitle>
      <div className="mt-4 space-y-2">
        {feedback.length === 0 && <p className="text-sm opacity-60">No feedback recorded for this agent yet.</p>}
        {feedback.map((item) => (
          <div key={item.id} className="flex flex-wrap items-center gap-3 rounded-lg border border-white/10 px-4 py-3">
            <Badge tone={item.status === "approved" ? "success" : item.status === "rejected" ? "danger" : "warning"}>
              {feedbackStatusLabel(item.status)}
            </Badge>
            <span className="text-sm">{item.rating}/5</span>
            <code className="text-xs opacity-60">{item.runId}</code>
            {item.correctionNotes && <span className="text-sm opacity-80">{item.correctionNotes}</span>}
            <div className="ml-auto">
              {item.promotedExampleId ? (
                <span className="text-xs opacity-60">promoted</span>
              ) : (
                <Button
                  variant="ghost"
                  disabled={pending || !item.correctedOutput}
                  title={
                    item.correctedOutput
                      ? "Create an active few-shot example from this correction"
                      : "Nothing to promote — this verdict has no corrected output"
                  }
                  onClick={() =>
                    apply(
                      () => promoteFeedbackAction(agent.slug, item.id),
                      "Promoted to a few-shot example — it will shape the next run.",
                    )
                  }
                >
                  Promote to few-shot
                </Button>
              )}
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}
