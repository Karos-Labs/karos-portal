"use client";

import { useState, useTransition } from "react";
import { Badge, Button, Card, CardTitle, EmptyState, Input, Label, Select, Textarea } from "@/components/ui";
import {
  activatePromptVersionAction,
  bindTemplateAction,
  promoteFeedbackAction,
  requestModelAccessAction,
  savePromptVersionAction,
  setAgentModelAction,
  setAgentStatusAction,
  submitFeedbackAction,
} from "@/lib/actions/control-plane-actions";
import { feedbackStatusLabel } from "@/lib/feedback-status-copy";
import type {
  MiddlewareAgent,
  MiddlewareFeedback,
  MiddlewareModel,
  MiddlewarePrompt,
  MiddlewareTemplate,
} from "@/lib/agent-engine/middleware-admin";

interface Props {
  agents: MiddlewareAgent[];
  templates: MiddlewareTemplate[];
  models: MiddlewareModel[];
  selectedSlug: string | null;
  activePrompt: MiddlewarePrompt | null;
  feedback: MiddlewareFeedback[];
  loadError: string | null;
}

type Notice = { kind: "ok" | "error"; text: string } | null;

/**
 * The control-plane console.
 *
 * Every mutation goes through a server action that re-checks `requireAdmin()`
 * and talks to `agent-middleware` — nothing here writes Firestore, and nothing
 * here falls back when the control plane is down. An admin edit either landed
 * or it did not, and saying otherwise would be worse than the failure.
 */
export function ControlPlaneConsole({ agents, templates, models, selectedSlug, activePrompt, feedback, loadError }: Props) {
  const [notice, setNotice] = useState<Notice>(null);
  const [pending, startTransition] = useTransition();

  const selected = agents.find((a) => a.slug === selectedSlug) ?? null;

  /** One place that turns an action result into a notice, so no call site invents its own. */
  function apply(run: () => Promise<{ ok: true } | { ok: false; error: string }>, success: string) {
    startTransition(async () => {
      const result = await run();
      setNotice(result.ok ? { kind: "ok", text: success } : { kind: "error", text: result.error });
    });
  }

  if (loadError) {
    return (
      <Card className="p-6">
        <EmptyState title="Could not reach the control plane" description={loadError} />
      </Card>
    );
  }

  if (agents.length === 0) {
    return (
      <Card className="p-6">
        <EmptyState
          title="No agents in the control plane"
          description="Seed them with agent-middleware's scripts/seed_legacy_agents.py, then reload."
        />
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      {notice && (
        <div
          role="status"
          className={`rounded-lg border px-4 py-3 text-sm ${
            notice.kind === "ok"
              ? "border-neon/40 bg-neon/10 text-neon"
              : "border-red-500/40 bg-red-500/10 text-red-400"
          }`}
        >
          {notice.text}
        </div>
      )}

      <AgentPanel agents={agents} selected={selected} pending={pending} apply={apply} />

      {selected && (
        <>
          <ModelPanel agent={selected} models={models} pending={pending} apply={apply} />
          <PromptPanel agent={selected} activePrompt={activePrompt} pending={pending} apply={apply} />
          <TemplatePanel agent={selected} templates={templates} pending={pending} apply={apply} />
          <FeedbackPanel agent={selected} feedback={feedback} pending={pending} apply={apply} />
        </>
      )}
    </div>
  );
}

type Apply = (run: () => Promise<{ ok: true } | { ok: false; error: string }>, success: string) => void;

function AgentPanel({
  agents,
  selected,
  pending,
  apply,
}: {
  agents: MiddlewareAgent[];
  selected: MiddlewareAgent | null;
  pending: boolean;
  apply: Apply;
}) {
  return (
    <Card className="p-6">
      <CardTitle>Agents</CardTitle>
      <div className="mt-4 space-y-2">
        {agents.map((agent) => (
          <div
            key={agent.id}
            className={`flex flex-wrap items-center gap-3 rounded-lg border px-4 py-3 ${
              agent.slug === selected?.slug ? "border-neon/50 bg-neon/5" : "border-white/10"
            }`}
          >
            <a href={`?agent=${encodeURIComponent(agent.slug)}`} className="font-medium hover:text-neon">
              {agent.name}
            </a>
            <code className="text-xs opacity-60">{agent.slug}</code>
            <Badge tone={agent.status === "active" ? "success" : "neutral"}>{agent.status}</Badge>
            {agent.model && <span className="text-xs opacity-60">{agent.model}</span>}
            <div className="ml-auto">
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
          </div>
        ))}
      </div>
    </Card>
  );
}

/**
 * The model dropdown, backed by the normalized catalog.
 *
 * Models this deployment does not route are listed and disabled rather than
 * hidden. A dropdown showing only what works reads as the whole of what Vertex
 * offers, and someone concludes a model is unavailable when it is one config
 * change away — so they appear, greyed, with a way to ask for them.
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
  const [modelId, setModelId] = useState(agent.model ?? models.find((m) => m.availability === "available")?.modelId ?? "");
  const [reason, setReason] = useState("");

  const chosen = models.find((m) => m.modelId === modelId);
  const needsAccess = chosen !== undefined && chosen.availability === "not_enabled";

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
        Stages reference a normalized model id, so what an agent runs on is a lookup rather than a spelling.
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
          onClick={() => apply(() => setAgentModelAction(agent.slug, modelId), `${agent.name} now runs on ${chosen?.displayName ?? modelId}.`)}
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
            {chosen?.displayName} is available in Vertex but not routed in this environment. Requesting it records
            the ask; enabling it is a deployment decision someone makes separately.
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

function PromptPanel({
  agent,
  activePrompt,
  pending,
  apply,
}: {
  agent: MiddlewareAgent;
  activePrompt: MiddlewarePrompt | null;
  pending: boolean;
  apply: Apply;
}) {
  const [content, setContent] = useState(activePrompt?.content ?? "");
  const [notes, setNotes] = useState("");
  const [activate, setActivate] = useState(true);

  return (
    <Card className="p-6">
      <CardTitle>
        System prompt
        {activePrompt && <span className="ml-2 text-sm opacity-60">active: v{activePrompt.version}</span>}
      </CardTitle>
      <p className="mt-1 text-sm opacity-70">
        Saving creates a new version. Existing versions are immutable in the control plane, which is what keeps the
        version recorded on a past run meaningful.
      </p>

      <div className="mt-4 space-y-4">
        <div>
          <Label htmlFor="prompt-content">Prompt body</Label>
          <Textarea
            id="prompt-content"
            rows={14}
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
              activate ? "Saved and activated a new prompt version." : "Saved a new prompt version without activating it.",
            )
          }
        >
          Save new version
        </Button>
      </div>

      {activePrompt && !activePrompt.isActive && (
        <div className="mt-4">
          <Button
            variant="ghost"
            disabled={pending}
            onClick={() =>
              apply(() => activatePromptVersionAction(agent.slug, activePrompt.id), `Activated v${activePrompt.version}.`)
            }
          >
            Activate v{activePrompt.version}
          </Button>
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
        An agent uses one template per purpose — the purpose is the binding&apos;s id, so re-binding replaces rather
        than duplicates.
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
 * The two tiers are deliberately two separate controls.
 *
 * Recording a verdict and changing what the agent does next are different
 * decisions. If a rejection promoted itself, every reviewer reaction would
 * silently rewrite the agent, and nobody could reject something without
 * teaching the model from it.
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
  const [runId, setRunId] = useState("");
  const [rating, setRating] = useState(3);
  const [status, setStatus] = useState<"approved" | "rejected" | "needs_changes">("needs_changes");
  const [correctionNotes, setCorrectionNotes] = useState("");
  const [correctedOutput, setCorrectedOutput] = useState("");

  return (
    <Card className="p-6">
      <CardTitle>Review feedback</CardTitle>

      <div className="mt-4 grid gap-4 md:grid-cols-2">
        <div>
          <Label htmlFor="fb-run">Run id</Label>
          <Input id="fb-run" value={runId} onChange={(e) => setRunId(e.target.value)} placeholder="control-plane run id" />
        </div>
        <div className="flex gap-3">
          <div className="flex-1">
            <Label htmlFor="fb-rating">Rating</Label>
            <Select id="fb-rating" value={String(rating)} onChange={(e) => setRating(Number(e.target.value))}>
              {[1, 2, 3, 4, 5].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </Select>
          </div>
          <div className="flex-1">
            <Label htmlFor="fb-status">Verdict</Label>
            <Select
              id="fb-status"
              value={status}
              onChange={(e) => setStatus(e.target.value as typeof status)}
            >
              <option value="approved">Approve</option>
              <option value="needs_changes">Needs changes</option>
              <option value="rejected">Reject</option>
            </Select>
          </div>
        </div>
        <div className="md:col-span-2">
          <Label htmlFor="fb-notes">What should change</Label>
          <Input id="fb-notes" value={correctionNotes} onChange={(e) => setCorrectionNotes(e.target.value)} />
        </div>
        <div className="md:col-span-2">
          <Label htmlFor="fb-output">Corrected output (this is what promotion turns into an example)</Label>
          <Textarea
            id="fb-output"
            rows={6}
            value={correctedOutput}
            onChange={(e) => setCorrectedOutput(e.target.value)}
            className="font-mono text-sm"
          />
        </div>
      </div>

      <div className="mt-4">
        <Button
          disabled={pending || !runId.trim()}
          onClick={() =>
            apply(
              () =>
                submitFeedbackAction(agent.slug, runId.trim(), {
                  rating,
                  status,
                  correctionNotes,
                  correctedOutput,
                }),
              "Recorded the verdict. Promote it to change what the agent does next.",
            )
          }
        >
          Record verdict
        </Button>
      </div>

      <div className="mt-6 space-y-2">
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
