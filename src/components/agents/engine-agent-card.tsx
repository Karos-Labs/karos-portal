"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { Badge, Button, Label, Select, Textarea } from "@/components/ui";
import { Icon, platformLogoFor } from "@/components/icon";
import { RunAttachments, type RunAttachment } from "@/components/agents/run-attachments";
import { dispatchControlPlaneAgentAction } from "@/lib/actions/control-plane-actions";
import { agentStudioHref, type EngineAgentCardModel } from "@/lib/agent-engine/catalog-union";

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
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, startTransition] = useTransition();

  /**
   * Exactly the two workflows that read `mediaAssets`, named rather than
   * pattern-matched.
   *
   * Offering the control anywhere else would be a promise nothing keeps: the
   * file would upload, cost storage, and be silently ignored. `branded-shorts`
   * is the near-miss worth stating — it is a video agent, but it takes its
   * source from the repo-side `brandedShortsIntake`, not from a run attachment.
   */
  const acceptsMedia = agent.slug === "instagram-agent" || agent.slug === "tiktok-agent";

  /**
   * The setup agents are the one place a typed direction has nowhere to go.
   *
   * Their workflows are `wf.step.code` end to end — parse a filled intake form,
   * persist it as the charter the drafting agents later read. There is no model
   * step to honour a sentence, so offering the field would be the same empty
   * promise as an attach control on a blog agent.
   */
  const acceptsDirection = !agent.slug.endsWith("-setup-agent");

  /** Capitalised: it is rendered as a component below, not called. */
  const PlatformLogo = platformLogoFor(agent.slug);

  const runnable = agent.status === "active" && clientId !== "";

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
        {PlatformLogo ? (
          <PlatformLogo className="h-4 w-4 opacity-80" />
        ) : (
          <Icon name={agent.icon ?? "Sparkles"} className="h-4 w-4 opacity-70" />
        )}
        <span className="font-medium">{agent.name}</span>
        <Badge tone={agent.status === "active" ? "success" : "neutral"}>{agent.status}</Badge>
      </div>

      <code className="mt-1 block text-xs opacity-60">{agent.slug}</code>
      {agent.description && <p className="mt-2 text-xs text-muted">{agent.description}</p>}

      <p className="mt-2 text-xs opacity-60">
        {agent.stageCount} stages
        {agent.creditCost !== null ? ` · ${agent.creditCost} credits per run` : ""}
        {agent.model ? ` · ${agent.model}` : ""}
      </p>

      {acceptsDirection && (
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
            Steers this run only. A subject replaces the auto-picked topic; a note about tone or length just guides
            the writing.
          </p>
        </div>
      )}

      {acceptsMedia && (
        <RunAttachments
          clientId={clientId}
          attachments={attachments}
          onChange={setAttachments}
          disabled={pending}
          mode={agent.slug === "tiktok-agent" ? "source-video" : "slides"}
        />
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
              const result = await dispatchControlPlaneAgentAction(agent.slug, {
                clientId,
                // Both omitted when empty rather than sent as ""/[]: the engine
                // reads an empty direction as "use the client's strategy", and
                // sending the empty form would make every scheduled-looking run
                // carry a field that means nothing.
                inputs: {
                  ...(trimmed ? { customPrompt: trimmed } : {}),
                  ...(attachments.length > 0 ? { mediaAssets: attachments } : {}),
                },
              });
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
