"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { Badge, Button, Label, Select, Textarea } from "@/components/ui";
import { Icon, PlatformLogo } from "@/components/icon";
import { RunAttachments, type RunAttachment } from "@/components/agents/run-attachments";
import { dispatchControlPlaneAgentAction } from "@/lib/actions/control-plane-actions";
import { agentStudioHref, type EngineAgentCardModel } from "@/lib/agent-engine/catalog-union";
import {
  agentEngineProductAcceptsMediaAssets,
  attachmentModeForEngineProduct,
  clientOnlyMediaIsRequired,
  mediaSourceHint,
  MEDIA_SOURCE_DEFAULT,
  type MediaSource,
} from "@/lib/custom-agent-launch";

/**
 * A catalog card for one agent-engine workflow.
 *
 * Two actions, both real. Run dispatches straight to agent-engine — these
 * agents have no lab-repo row, so the legacy submit path could not build a job
 * for them even if it were offered. Edit in Studio opens the agent's own
 * Studio page, where its stages, prompt versions, model and template bindings
 * are.
 *
 * The client picker is on the card rather than behind a dialog because an
 * agent always runs against a client's context, and a Run button that opens a
 * form to ask which one is a Run button that does not run.
 */
export function EngineAgentCard({
  agent,
  clients,
}: {
  agent: EngineAgentCardModel;
  clients: Array<{ id: string; name: string }>;
}) {
  const [clientId, setClientId] = useState(clients[0]?.id ?? "");
  const [customPrompt, setCustomPrompt] = useState("");
  const [attachments, setAttachments] = useState<RunAttachment[]>([]);
  const [mediaSource, setMediaSource] = useState<MediaSource>(MEDIA_SOURCE_DEFAULT);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, startTransition] = useTransition();

  /**
   * The workflows that read `mediaAssets`, from the ONE predicate the client
   * run dialog and the copilot chat also use (`agentEngineProductAcceptsMediaAssets`),
   * so the three surfaces cannot disagree about which agents take media.
   *
   * Offering the control anywhere else would be a promise nothing keeps: the
   * file would upload, cost storage, and be silently ignored.
   */
  const acceptsMedia = agentEngineProductAcceptsMediaAssets(agent.slug);
  const attachmentMode = attachmentModeForEngineProduct(agent.slug) ?? "slides";
  // "Only media I upload" on an agent with no text fallback needs a file.
  const mediaMissing = acceptsMedia && mediaSource === "client" && clientOnlyMediaIsRequired(agent.slug) && attachments.length === 0;

  const runnable = agent.status === "active" && clientId !== "" && !mediaMissing;

  /**
   * Switching client drops what was already uploaded.
   *
   * An attachment lands under `clients/<id>/run-attachments/`, the prefix chosen
   * when its upload started. Keeping it after the picker moves would dispatch a
   * run for client B that reads an object out of client A's folder — which the
   * engine's service account can do, and which nobody asked for.
   */
  function selectClient(next: string) {
    if (next !== clientId && attachments.length > 0) setAttachments([]);
    setClientId(next);
  }

  return (
    <div className="rounded-lg border border-white/10 p-4">
      <div className="flex flex-wrap items-center gap-2">
        {/* The channel's own logo when it has one, else whatever the control
            plane named. A catalog this size is far faster to scan by logo than
            by a generic stand-in glyph. */}
        <PlatformLogo
          slug={agent.slug}
          className="h-4 w-4 opacity-80"
          fallback={<Icon name={agent.icon ?? "Sparkles"} className="h-4 w-4 opacity-70" />}
        />
        <span className="font-medium">{agent.name}</span>
        <Badge tone={agent.status === "active" ? "success" : "neutral"}>{agent.status}</Badge>
      </div>

      <code className="mt-1 block text-xs opacity-60">{agent.slug}</code>
      {agent.description && <p className="mt-2 text-xs text-muted">{agent.description}</p>}

      <p className="mt-2 text-xs opacity-60">
        {agent.stageCount} stages
        {agent.creditCost !== null ? ` · ${agent.creditCost} credits per run` : ""}
        {agent.models.length > 0 ? ` · ${agent.models.join(", ")}` : ""}
      </p>

      {/* Offered on every agent in the catalog. The one exception used to be the
          two setup agents, whose workflows were `wf.step.code` end to end with
          no model step to honour a sentence — they are no longer products, so
          nothing in the catalog reads a direction and ignores it. */}
      <div className="mt-3">
        <Label htmlFor={`direction-${agent.slug}`}>Direction for this run (optional)</Label>
        <Textarea
          id={`direction-${agent.slug}`}
          rows={2}
          value={customPrompt}
          onChange={(e) => setCustomPrompt(e.target.value)}
          placeholder="e.g. Focus on the product launch — keep it factual"
        />
        <p className="mt-1 text-xs text-muted">
          Steers this run only. A subject replaces the auto-picked topic; a note about tone or length just guides the
          writing.
        </p>
      </div>

      {acceptsMedia && (
        <div className="mt-3 space-y-1 rounded-lg border border-white/10 p-3">
          <Label htmlFor={`media-source-${agent.slug}`}>Media for this run</Label>
          <Select
            id={`media-source-${agent.slug}`}
            value={mediaSource}
            onChange={(e) => setMediaSource(e.target.value === "client" ? "client" : "system")}
          >
            <option value="system">Karos sources or generates the visuals</option>
            <option value="client">Only media uploaded for this job</option>
          </Select>
          <RunAttachments
            clientId={clientId}
            attachments={attachments}
            onChange={setAttachments}
            disabled={pending}
            mode={attachmentMode}
            hint={mediaSourceHint(agent.slug, mediaSource)}
          />
          {mediaMissing && (
            <p className="text-xs text-red-400">Attach the media this run should use, or let Karos source the visuals.</p>
          )}
        </div>
      )}

      <div className="mt-3 flex flex-wrap items-end gap-2">
        <div className="min-w-40 flex-1">
          <Label htmlFor={`client-${agent.slug}`}>Client</Label>
          <Select id={`client-${agent.slug}`} value={clientId} onChange={(e) => selectClient(e.target.value)}>
            {clients.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
        </div>
        <Button
          disabled={pending || !runnable}
          onClick={() =>
            startTransition(async () => {
              const trimmed = customPrompt.trim();
              let result: Awaited<ReturnType<typeof dispatchControlPlaneAgentAction>>;
              try {
                result = await dispatchControlPlaneAgentAction(agent.slug, {
                clientId,
                // Both omitted when empty rather than sent as ""/[]: the engine
                // reads an empty direction as "use the client's strategy", and
                // sending the empty form would make every scheduled-looking run
                // carry a field that means nothing.
                inputs: {
                  ...(trimmed ? { customPrompt: trimmed } : {}),
                  ...(attachments.length > 0 ? { mediaAssets: attachments } : {}),
                  // Sent only when it departs from the engine's default, so a
                  // plain run's envelope is byte-identical to before this control.
                  ...(acceptsMedia && mediaSource !== MEDIA_SOURCE_DEFAULT ? { mediaSource } : {}),
                },
              });
              } catch (error) {
                // An action that throws (an employee on an admin-only action, a
                // network drop) is a notice here, not Next's generic error.
                result = { ok: false, error: error instanceof Error && /forbidden/i.test(error.message) ? "Only a Karos admin can dispatch from here." : "The run could not be dispatched. Refresh and try again." };
              }
              setNotice(
                result.ok
                  ? { ok: true, text: `Dispatched — job ${result.jobId}` }
                  : { ok: false, text: result.error },
              );
              // Cleared on success only. A second click would otherwise re-attach
              // the same photos to a different run without anyone choosing that.
              if (result.ok) {
                setAttachments([]);
                setCustomPrompt("");
                setMediaSource(MEDIA_SOURCE_DEFAULT);
              }
            })
          }
        >
          Run
        </Button>
        {/* A link, not a Button-wrapping-a-link: this Button is a real
            <button> with no asChild escape hatch, and nesting an anchor inside
            one is invalid markup that breaks keyboard activation. */}
        <Link
          href={agentStudioHref(agent.slug)}
          className="rounded-md border border-white/15 px-3 py-2 text-sm transition hover:border-neon/50"
        >
          Edit in Studio
        </Link>
      </div>

      {notice && (
        <p className={`mt-2 text-xs ${notice.ok ? "text-neon" : "text-red-400"}`}>{notice.text}</p>
      )}
    </div>
  );
}
