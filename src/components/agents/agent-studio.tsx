"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Badge, Button, Card, CardTitle, Input, Label, Select, Textarea } from "@/components/ui";
import { Icon } from "@/components/icon";
import {
  activatePromptVersionAction,
  bindTemplateAction,
  promoteFeedbackAction,
  requestModelAccessAction,
  savePromptVersionAction,
  getStagePromptAction,
  saveStagePromptAction,
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
  unavailable = [],
}: {
  agent: MiddlewareAgent;
  activePrompt: MiddlewarePrompt | null;
  promptHistory: MiddlewarePrompt[];
  templates: MiddlewareTemplate[];
  models: MiddlewareModel[];
  feedback: MiddlewareFeedback[];
  /**
   * Panels whose data the control plane did not return. Named rather than
   * coerced to empty: an empty prompt editor over a real prompt that merely
   * failed to load is a trap, and saving into it replaces the live version.
   */
  unavailable?: readonly string[];
}) {
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  // A server action that THROWS (an employee pressing a control whose action
  // ends in `requireAdmin()`, a network drop) used to surface as Next's generic
  // server-action error, not as a notice; and a successful mutation relied on
  // an incidental revalidation to show its new state. Both are explicit now.
  const apply: Apply = (run, success) => {
    startTransition(async () => {
      let result: Result;
      try {
        result = await run();
      } catch (error) {
        result = { ok: false, error: error instanceof Error && /forbidden/i.test(error.message) ? "Only a Karos admin can change this." : "The control plane did not accept the change. Refresh and try again." };
      }
      setNotice(result.ok ? { ok: true, text: success } : { ok: false, text: result.error });
      if (result.ok) router.refresh();
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
      <ModelsPanel agent={agent} models={models} pending={pending} apply={apply} />
      <PromptPanel agent={agent} activePrompt={activePrompt} history={promptHistory} pending={pending} apply={apply} unavailable={unavailable.includes("active prompt") || unavailable.includes("prompt history")} />
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
            {stage.kind === "agent" && (
              <StageModelPicker agent={agent} stage={stage} models={models} pending={pending} apply={apply} />
            )}
            {stage.skillRef && <StagePromptEditor stage={stage} pending={pending} apply={apply} />}
          </li>
        ))}
      </ol>
    </Card>
  );
}

/**
 * One stage's system prompt, read from and written to the store the engine
 * executes from.
 *
 * Loaded on demand rather than with the page. An agent has up to four model
 * stages and their prompts run to thirteen thousand characters, so fetching
 * them all to render a row of collapsed panels would make the page slow to
 * serve something nobody asked to see.
 *
 * Never renders a blank textarea before the content arrives: an editor that
 * shows empty and then fills in is an editor somebody will type into and save
 * over. It shows the load state until there is real text.
 */
function StagePromptEditor({
  stage,
  pending,
  apply,
}: {
  stage: MiddlewareAgent["stages"][number];
  pending: boolean;
  apply: Apply;
}) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [meta, setMeta] = useState<{ updatedAt: string | null; updatedBy: string | null } | null>(null);

  const skillRef = stage.skillRef!;

  async function load() {
    setLoading(true);
    setLoadError(null);
    const result = await getStagePromptAction(skillRef);
    setLoading(false);
    if (!result.ok) {
      setLoadError(result.error);
      return;
    }
    setLoaded(result.content);
    setDraft(result.content);
    setMeta({ updatedAt: result.updatedAt, updatedBy: result.updatedBy });
  }

  function toggle() {
    const next = !open;
    setOpen(next);
    if (next && loaded === null && !loading) void load();
  }

  const dirty = loaded !== null && draft !== loaded;

  return (
    <div className="mt-2 w-full">
      <button
        type="button"
        onClick={toggle}
        className="flex items-center gap-1.5 text-xs opacity-70 hover:opacity-100"
      >
        <Icon name={open ? "ChevronDown" : "ChevronRight"} className="h-3 w-3" />
        Prompt
        <code className="opacity-60">{skillRef}</code>
        {dirty && <Badge tone="warning">unsaved</Badge>}
      </button>

      {open && (
        <div className="mt-2 rounded border border-white/10 p-3">
          {loading && <p className="text-xs opacity-60">Loading the text this stage will run…</p>}
          {loadError && (
            <p className="text-xs text-red-400">
              {loadError}
              {/* A skillRef pointing at a version nobody published reads as
                  not-found. Saying so is more useful than an empty box. */}
            </p>
          )}
          {loaded !== null && (
            <>
              <Textarea
                aria-label={`System prompt for ${stage.label}`}
                value={draft}
                rows={16}
                spellCheck={false}
                className="font-mono text-xs"
                onChange={(e) => setDraft(e.target.value)}
              />
              <div className="mt-2 flex flex-wrap items-center gap-3">
                <Button
                  size="sm"
                  disabled={pending || !dirty || !draft.trim()}
                  onClick={() =>
                    apply(async () => {
                      const result = await saveStagePromptAction(skillRef, draft);
                      if (result.ok) setLoaded(result.content);
                      return result;
                    }, `${stage.label}'s prompt is what the next run will use`)
                  }
                >
                  Save
                </Button>
                {dirty && (
                  <Button size="sm" variant="outline" disabled={pending} onClick={() => setDraft(loaded)}>
                    Revert
                  </Button>
                )}
                <span className="text-xs opacity-50">
                  {draft.length.toLocaleString()} characters
                  {meta?.updatedBy ? ` · last edited by ${meta.updatedBy}` : ""}
                </span>
              </div>
              <p className="mt-2 text-xs opacity-50">
                Saving replaces version <code>{skillRef.split("@")[1]}</code> in place, because this stage
                loads exactly that version — a new version would not be read until the workflow changed.
              </p>
            </>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Which catalog vendors may serve a stage wired to each engine vendor.
 *
 * The engine selects an adapter from a stage's compiled `ModelPolicy.vendor`
 * alone, never from the model id, and `assertModelCatalogued` refuses a stage
 * override whose model belongs to another vendor. The control plane refuses
 * the same edit (its `ENGINE_VENDOR_TO_CATALOG_VENDORS`); the picker below
 * simply never offers it.
 */
const CATALOG_VENDORS_FOR_ENGINE_VENDOR: Record<string, readonly string[]> = {
  anthropic: ["anthropic"],
  gemini: ["google"],
  "model-garden": ["meta", "other"],
  "openai-compatible": ["other"],
};

/**
 * How each engine vendor is routed, and what happens when the route fails.
 * The per-model `fallback` text in the catalog is the authority; this is the
 * one-line version for a stage whose model has no catalog row.
 */
const ENGINE_VENDOR_ROUTE: Record<string, { label: string; fallback: string }> = {
  anthropic: {
    label: "Claude via Vertex AI",
    fallback: "On a 429 or 404 the same model is retried on Anthropic's direct API, then Gemini 2.5 Flash answers as the last resort.",
  },
  gemini: {
    label: "Gemini via Vertex AI",
    fallback: "None. A failure on Vertex fails the step; no other transport carries Gemini.",
  },
  "model-garden": {
    label: "Vertex Model Garden (MaaS)",
    fallback: "None, and not routed in this deployment.",
  },
  "openai-compatible": {
    label: "OpenAI-compatible endpoint",
    fallback: "None, and not routed in this deployment.",
  },
};

/** The catalog rows a stage may be pointed at: same engine vendor, or every row when the stage's vendor is unknown. */
function modelsForStage(stage: MiddlewareAgent["stages"][number], models: MiddlewareModel[]): MiddlewareModel[] {
  if (!stage.vendor) return models;
  const allowed = CATALOG_VENDORS_FOR_ENGINE_VENDOR[stage.vendor];
  return allowed ? models.filter((m) => allowed.includes(m.vendor)) : models;
}

/** The catalog row whose provider name is the engine's canonical id, e.g. `claude-opus-4-8`. */
function catalogRowForEngineModel(models: MiddlewareModel[], engineModelId: string | null): MiddlewareModel | undefined {
  if (!engineModelId) return undefined;
  return models.find((m) => m.providerModelName === engineModelId || m.modelId === engineModelId);
}

/**
 * What a stage actually runs on right now: its Studio override when one is set,
 * else its compiled engine default. Returned with the catalog row when the
 * catalog has one, so the fallback chain can be quoted from the catalog.
 */
function effectiveModel(
  stage: MiddlewareAgent["stages"][number],
  models: MiddlewareModel[],
): { engineModelId: string | null; row: MiddlewareModel | undefined; overridden: boolean } {
  if (stage.modelId) {
    const row = models.find((m) => m.modelId === stage.modelId);
    return { engineModelId: row?.providerModelName ?? stage.modelId, row, overridden: true };
  }
  return { engineModelId: stage.defaultModel, row: catalogRowForEngineModel(models, stage.defaultModel), overridden: false };
}

function fallbackFor(stage: MiddlewareAgent["stages"][number], row: MiddlewareModel | undefined): string {
  if (row?.fallback) return row.fallback;
  if (stage.vendor && ENGINE_VENDOR_ROUTE[stage.vendor]) return ENGINE_VENDOR_ROUTE[stage.vendor]!.fallback;
  return "Not documented for this model.";
}

/**
 * One stage's own model.
 *
 * Rendered only on `"agent"` stages — the engine's own name for a model step
 * — because a code step has no model to set and a disabled control that
 * explains itself is still a control someone has to read past.
 *
 * The empty option NAMES the compiled default (`Engine default · claude-opus-4-8`)
 * instead of saying "Agent default". Until 2026-09-07 it said the latter, the
 * agent-level model field it implied was seeded as Sonnet for every agent and
 * never read by the engine, and so the Studio read "Sonnet" over stages that
 * run on Opus and on Gemini. The default is now read from the agent class's
 * own `modelPolicy` by the middleware's stage generator, per stage.
 *
 * Only models of the stage's own vendor are offered: the engine refuses a
 * cross-vendor override after the run has started, and an option that fails
 * three layers away is worse than no option.
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
  const effective = effectiveModel(stage, models);
  const route = stage.vendor ? ENGINE_VENDOR_ROUTE[stage.vendor] : undefined;
  return (
    <div className="ml-auto flex flex-col items-end gap-1">
      <label className="flex items-center gap-2">
        <span className="text-xs opacity-60">Model</span>
        <Select
          aria-label={`Model for ${stage.label}`}
          value={stage.modelId ?? ""}
          disabled={pending}
          onChange={(e) => {
            const next = e.target.value === "" ? null : e.target.value;
            apply(
              () => setStageModelAction(agent.slug, stage.id, next),
              next === null
                ? `${stage.label} runs on its engine default again${stage.defaultModel ? ` (${stage.defaultModel})` : ""}`
                : `${stage.label} now runs on ${next}`,
            );
          }}
        >
          <option value="">
            {stage.defaultModel ? `Engine default · ${stage.defaultModel}` : "Engine default (not extracted from the engine source)"}
          </option>
          {modelsForStage(stage, models).map((m) => (
            <option key={m.modelId} value={m.modelId} disabled={m.availability !== "available"}>
              {m.displayName}
              {m.availability === "not_enabled" ? " — not enabled here" : ""}
              {m.availability === "retired" ? " — retired" : ""}
            </option>
          ))}
        </Select>
      </label>
      <span className="max-w-md text-right text-xs opacity-50" title={fallbackFor(stage, effective.row)}>
        {effective.overridden ? "Override" : "Default"}
        {effective.engineModelId ? ` · sends ${effective.engineModelId}` : ""}
        {route ? ` · ${route.label}` : ""}
        {stage.vendor === "gemini" ? " · no fallback" : stage.vendor === "anthropic" ? " · falls back to the Anthropic API, then Gemini Flash" : ""}
      </span>
    </div>
  );
}

/**
 * Every model this agent's stages run on, and every model the catalog knows,
 * with the fallback chain for each. Read-only on purpose.
 *
 * This replaces an agent-level "Model" picker that wrote a field the engine
 * never read. Which model a step runs on is decided per stage (the compiled
 * default above, or a Studio override on that stage), so an agent-wide model
 * was a setting with no effect, presented as if it had one.
 *
 * Models this deployment does not route are listed and marked rather than
 * hidden: a catalog showing only what works reads as the whole of what Vertex
 * offers, and that is how someone concludes a model is unavailable when it is
 * one config change away. Those rows carry a "Request access" action below.
 */
function ModelsPanel({
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
  const modelStages = agent.stages.filter((s) => s.kind === "agent");
  const requestable = models.filter((m) => m.availability === "not_enabled");
  const [requestId, setRequestId] = useState(requestable[0]?.modelId ?? "");
  const [reason, setReason] = useState("");

  if (models.length === 0) {
    return (
      <Card className="p-6">
        <CardTitle>Models and fallbacks</CardTitle>
        <p className="mt-2 text-sm opacity-70">
          The model catalog is empty. Seed it with agent-middleware&apos;s scripts/seed_models.py.
        </p>
      </Card>
    );
  }

  return (
    <Card className="p-6">
      <CardTitle>Models and fallbacks</CardTitle>
      <p className="mt-1 text-sm opacity-70">
        Each model step runs on the model its agent class is compiled with (the engine default), unless a stage above
        points it at another model of the same vendor. Claude steps go to Vertex AI first and fall back to the same
        model on Anthropic&apos;s direct API, then to Gemini 2.5 Flash. Gemini steps go to Vertex AI only: there is no
        second transport, so a failure there fails the step. A stage can never be moved to another vendor from here.
      </p>

      <h3 className="mt-5 text-sm font-medium">What this agent runs</h3>
      {modelStages.length === 0 ? (
        <p className="mt-2 text-sm opacity-70">This workflow has no model steps.</p>
      ) : (
        <div className="mt-2 overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="opacity-60">
              <tr>
                <th className="py-1 pr-3 font-normal">Stage</th>
                <th className="py-1 pr-3 font-normal">Engine default</th>
                <th className="py-1 pr-3 font-normal">Override</th>
                <th className="py-1 pr-3 font-normal">Route</th>
                <th className="py-1 font-normal">Fallback</th>
              </tr>
            </thead>
            <tbody>
              {modelStages.map((stage) => {
                const effective = effectiveModel(stage, models);
                const route = stage.vendor ? ENGINE_VENDOR_ROUTE[stage.vendor] : undefined;
                return (
                  <tr key={stage.id} className="border-t border-white/10 align-top">
                    <td className="py-2 pr-3">
                      {stage.label}
                      <br />
                      <code className="opacity-50">{stage.id}</code>
                    </td>
                    <td className="py-2 pr-3">
                      <code>{stage.defaultModel ?? "not extracted"}</code>
                    </td>
                    <td className="py-2 pr-3">
                      {effective.overridden ? <code>{effective.engineModelId}</code> : <span className="opacity-50">none</span>}
                    </td>
                    <td className="py-2 pr-3">{route?.label ?? stage.vendor ?? "unknown"}</td>
                    <td className="py-2 opacity-80">{fallbackFor(stage, effective.row)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <h3 className="mt-6 text-sm font-medium">Model catalogue</h3>
      <p className="mt-1 text-xs opacity-60">
        Every model agent-engine&apos;s own catalog knows. &ldquo;Sends&rdquo; is the id the engine puts on the wire.
      </p>
      <div className="mt-2 overflow-x-auto">
        <table className="w-full text-left text-xs">
          <thead className="opacity-60">
            <tr>
              <th className="py-1 pr-3 font-normal">Model</th>
              <th className="py-1 pr-3 font-normal">Sends</th>
              <th className="py-1 pr-3 font-normal">Vendor</th>
              <th className="py-1 pr-3 font-normal">Status</th>
              <th className="py-1 font-normal">Fallback and notes</th>
            </tr>
          </thead>
          <tbody>
            {models.map((m) => (
              <tr key={m.modelId} className="border-t border-white/10 align-top">
                <td className="py-2 pr-3">
                  {m.displayName}
                  {m.description ? <p className="mt-1 opacity-60">{m.description}</p> : null}
                </td>
                <td className="py-2 pr-3">
                  <code>{m.providerModelName}</code>
                  {m.region ? <p className="opacity-50">{m.region}</p> : null}
                </td>
                <td className="py-2 pr-3">{m.vendor}</td>
                <td className="py-2 pr-3">
                  <Badge tone={m.availability === "available" ? "success" : m.availability === "retired" ? "neutral" : "warning"}>
                    {m.availability === "available" ? "routed" : m.availability === "retired" ? "retired" : "not enabled"}
                  </Badge>
                  {!m.supportsTools && <p className="mt-1 opacity-60">no tool support</p>}
                </td>
                <td className="py-2 opacity-80">
                  {m.fallback ?? "Fallback not documented for this row."}
                  {m.notes ? <p className="mt-1 opacity-60">{m.notes}</p> : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {requestable.length > 0 && (
        <div className="mt-4 rounded-lg border border-white/10 p-4">
          <p className="text-sm">
            A model marked &ldquo;not enabled&rdquo; is known to the engine but not routed here. Requesting it records
            the ask; enabling it is a deployment decision someone makes separately.
          </p>
          <div className="mt-3 flex flex-wrap items-end gap-3">
            <div className="min-w-56">
              <Label htmlFor="model-request-id">Model</Label>
              <Select id="model-request-id" value={requestId} onChange={(e) => setRequestId(e.target.value)}>
                {requestable.map((m) => (
                  <option key={m.modelId} value={m.modelId}>
                    {m.displayName}
                  </option>
                ))}
              </Select>
            </div>
            <div className="min-w-64 flex-1">
              <Label htmlFor="model-reason">Why this agent needs it</Label>
              <Input id="model-reason" value={reason} onChange={(e) => setReason(e.target.value)} />
            </div>
            <Button
              variant="ghost"
              disabled={pending || !requestId}
              onClick={() =>
                apply(
                  () => requestModelAccessAction(requestId, { reason, agentId: agent.slug }),
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
  unavailable = false,
}: {
  agent: MiddlewareAgent;
  activePrompt: MiddlewarePrompt | null;
  history: MiddlewarePrompt[];
  pending: boolean;
  apply: Apply;
  /** The control plane did not answer for this panel; the editor must not pose as "no prompt yet". */
  unavailable?: boolean;
}) {
  const [content, setContent] = useState(activePrompt?.content ?? "");
  const [notes, setNotes] = useState("");
  const [activate, setActivate] = useState(true);
  // After every hook, so the hook order is the same on each render.
  if (unavailable) {
    return (
      <Card className="p-6">
        <CardTitle>System prompt</CardTitle>
        <p className="mt-2 text-sm text-red-400">
          The control plane did not return this agent&apos;s prompt. Refresh before editing; saving now would replace a
          version that exists but could not be loaded.
        </p>
      </Card>
    );
  }

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
