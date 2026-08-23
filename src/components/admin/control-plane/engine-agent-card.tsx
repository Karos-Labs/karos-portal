"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { Badge, Button, Label, Select } from "@/components/ui";
import { Icon } from "@/components/icon";
import { dispatchControlPlaneAgentAction } from "@/lib/actions/control-plane-actions";
import type { ControlPlaneOnlyAgent } from "@/lib/agent-engine/catalog-union";
import { controlPlaneAgentHref } from "@/lib/agent-engine/catalog-union";

/**
 * A catalog card for an agent that lives only in the control plane.
 *
 * Two actions, both real. Run dispatches straight to agent-engine — these
 * agents have no lab-repo row, so the legacy submit path could not build a job
 * for them even if it were offered. Edit in Studio opens the console at this
 * agent, where its prompt versions, model and template bindings are.
 *
 * The client picker is on the card rather than behind a dialog because an
 * agent always runs against a client's context, and a Run button that opens a
 * form to ask which one is a Run button that does not run.
 */
export function EngineAgentCard({
  agent,
  clients,
}: {
  agent: ControlPlaneOnlyAgent;
  clients: Array<{ id: string; name: string }>;
}) {
  const [clientId, setClientId] = useState(clients[0]?.id ?? "");
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, startTransition] = useTransition();

  const runnable = agent.status === "active" && clientId !== "";

  return (
    <div className="rounded-lg border border-white/10 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <Icon name={agent.icon ?? "Sparkles"} className="h-4 w-4 opacity-70" />
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

      <div className="mt-3 flex flex-wrap items-end gap-2">
        <div className="min-w-40 flex-1">
          <Label htmlFor={`client-${agent.slug}`}>Client</Label>
          <Select id={`client-${agent.slug}`} value={clientId} onChange={(e) => setClientId(e.target.value)}>
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
              const result = await dispatchControlPlaneAgentAction(agent.slug, { clientId });
              setNotice(
                result.ok
                  ? { ok: true, text: `Dispatched — job ${result.jobId}` }
                  : { ok: false, text: result.error },
              );
            })
          }
        >
          Run
        </Button>
        {/* A link, not a Button-wrapping-a-link: this Button is a real
            <button> with no asChild escape hatch, and nesting an anchor inside
            one is invalid markup that breaks keyboard activation. */}
        <Link
          href={controlPlaneAgentHref(agent.slug)}
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
