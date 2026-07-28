"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Badge, Button, Input, Select, Textarea } from "@/components/ui";
import { Icon } from "@/components/icon";
import { ClientAgentLaunchCard } from "./launch-card";
import { ClientAgentLiveCard } from "./live-card";
import { AgentEconomicsCard } from "./agent-economics";
import type { AgentEconomics } from "@/lib/credit-reporting";
import {
  bindClientAgentAction,
  goLiveClientAgentAction,
  saveClientAgentTemplatesAction,
} from "@/lib/actions/client-agent-actions";
import type { ClientAgentTemplateInput } from "@/lib/client-agents";
import { cn } from "@/lib/utils";
import type { ClientAgentCardRow } from "./types";

/**
 * The client-agents section of /clients/[id]/agents.
 *
 * One card per umbrella, and which card it is comes from the launch state: the
 * launch CTA and its guided progress before go-live, the live agent (template
 * streams, week strip, feedback, pace) after. Staff additionally get the
 * curation pane and the bind control that creates an umbrella in the first
 * place.
 *
 * WHICH umbrellas reach a client at all is the page's decision
 * (`umbrellaOwnsClientCard`): a live umbrella with no templates yet keeps
 * today's generic card rather than replacing it with an empty one.
 */
export function ClientAgentsSection({
  agents,
  viewerIsClient,
  viewer,
  bindable,
  economics,
  clientId,
}: {
  agents: ClientAgentCardRow[];
  viewerIsClient: boolean;
  viewer?: { name: string; email: string };
  /** Staff only: enabled lab agents that have no umbrella for this client yet. */
  bindable?: Array<{ id: string; name: string }>;
  /**
   * Staff only (§6.2b): USD spend per bound agent, keyed by customAgentId, with
   * the launch price currently set on the lab agent. Absent for clients — this
   * is cost data, and the client's side of the same question is credits.
   */
  economics?: Record<
    string,
    { economics: AgentEconomics; launchCreditCost: number | null }
  >;
  clientId: string;
}) {
  const visible = agents;
  if (visible.length === 0 && (!bindable || bindable.length === 0)) return null;

  // CD-G8: a section holding nothing but staff plumbing must not reserve a
  // viewport's worth of height. Albert's narrow-width screenshot showed the
  // agents page stacking "AI Agents", a near-empty "Client agents" and "Custom
  // agents" with mt-10 between them — a screen of dead air before any content.
  // The top gutter follows what is actually below it, and is tight on a phone.
  const bare = visible.length === 0;

  return (
    <section className={bare ? "mt-5" : "mt-6 sm:mt-10"}>
      <div
        className={cn(
          "flex flex-wrap items-center justify-between gap-2",
          bare ? "mb-0" : "mb-3 sm:mb-4",
        )}
      >
        {/* CD-G3: "One agent per platform this client buys: set it up once,
            then it produces to its own template set and schedule." is dead.
            Albert read it as a rule about what a client is ALLOWED to have —
            "They should be able to run every single agent if they want to" —
            and it is not one: every current agent is granted to every client.
            The binding is plumbing (it creates the umbrella that holds a
            template set), so it is labelled as plumbing and nothing here
            frames the client's roster at all. Clients simply see their agents. */}
        {viewerIsClient ? <span /> : <h2 className="text-sm text-muted">Agent setup</h2>}
        {!viewerIsClient && bindable && bindable.length > 0 && (
          <BindAgentControl clientId={clientId} agents={bindable} />
        )}
      </div>

      {visible.length > 0 && (
        <div className="grid gap-3 sm:grid-cols-2">
          {visible.map((agent) => (
            <div key={agent.id} className="flex flex-col gap-2">
              {agent.launchState === "live" ? (
                <ClientAgentLiveCard
                  agent={agent}
                  viewerIsClient={viewerIsClient}
                  {...(viewer ? { viewer } : {})}
                />
              ) : (
                <ClientAgentLaunchCard
                  agent={agent}
                  viewerIsClient={viewerIsClient}
                  {...(viewer ? { viewer } : {})}
                />
              )}
              {!viewerIsClient && agent.launchState !== "not_launched" && (
                <CurationPane agent={agent} />
              )}
              {!viewerIsClient && economics?.[agent.customAgentId] && (
                <AgentEconomicsCard
                  customAgentId={agent.customAgentId}
                  agentName={agent.displayName}
                  economics={economics[agent.customAgentId].economics}
                  launchCreditCost={economics[agent.customAgentId].launchCreditCost}
                />
              )}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

/* ─────────────────────────── staff: bind ───────────────────────────── */

function BindAgentControl({
  clientId,
  agents,
}: {
  clientId: string;
  agents: Array<{ id: string; name: string }>;
}) {
  const router = useRouter();
  const [customAgentId, setCustomAgentId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [pending, startTransition] = useTransition();

  const selectedName = agents.find((a) => a.id === customAgentId)?.name ?? "this agent";

  function bind(mode?: "live" | "new") {
    setError(null);
    startTransition(async () => {
      const result = await bindClientAgentAction({
        clientId,
        customAgentId,
        ...(mode === "live" ? { bindAsLive: true } : {}),
        ...(mode === "new" ? { bindAsNew: true } : {}),
      });
      if (result.error) {
        setError(result.error);
        return;
      }
      // The agent is already working for this client — binding it as
      // not-set-up would take its Run button, its schedule row and its run
      // history off the client's page and replace them with "Not set up yet"
      // (W6). Nothing was written; staff choose which of the two they meant.
      if (result.alreadyProducing) {
        setConfirming(true);
        return;
      }
      setConfirming(false);
      setCustomAgentId("");
      router.refresh();
    });
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex items-center gap-2">
        <Select
          value={customAgentId}
          onChange={(e) => {
            setCustomAgentId(e.target.value);
            setConfirming(false);
            setError(null);
          }}
          className="h-8 w-48 text-xs"
          aria-label="Lab agent to bind"
        >
          {/* Honest about what this does: it binds a lab agent so it HAS a
              template set and schedule to be set up. It is not a purchase, a
              grant, or a statement about what this client may run. */}
          <option value="">Bind a lab agent…</option>
          {agents.map((agent) => (
            <option key={agent.id} value={agent.id}>
              {agent.name}
            </option>
          ))}
        </Select>
        <Button
          size="sm"
          variant="subtle"
          disabled={!customAgentId || pending}
          loading={pending}
          onClick={() => bind()}
        >
          <Icon name="Plus" className="h-3.5 w-3.5" /> Bind
        </Button>
      </div>
      {confirming && (
        <div className="max-w-sm rounded-[var(--radius)] border border-warning/30 bg-warning/10 p-2.5 text-right">
          <p className="text-[11px] text-warning">
            {selectedName} is already producing for this client. Binding it as new hides its Run
            button, its schedule row and its run history from the client until you launch it — its
            weekly schedule keeps firing, so pause that too if you mean to stop it.
          </p>
          <div className="mt-1.5 flex justify-end gap-1.5">
            <Button size="sm" variant="ghost" disabled={pending} onClick={() => setConfirming(false)}>
              Cancel
            </Button>
            <Button size="sm" variant="ghost" disabled={pending} onClick={() => bind("new")}>
              Bind as new
            </Button>
            <Button size="sm" variant="accent" disabled={pending} onClick={() => bind("live")}>
              Bind as live
            </Button>
          </div>
        </div>
      )}
      {error && <p className="text-[11px] text-warning">{error}</p>}
    </div>
  );
}

/* ────────────────────── staff: template curation ───────────────────── */

/**
 * Where staff confirm the template set before a client ever sees it (the Q3
 * default: the curation gate survives even once the setup run emits
 * templates.json — it just becomes one click).
 *
 * Keys are the JOIN with Asset.templateKey, so they are validated here and
 * again on the server; a key that drifts silently unhooks every future post
 * from its stream.
 */
function CurationPane({ agent }: { agent: ClientAgentCardRow }) {
  const router = useRouter();
  const [rows, setRows] = useState<ClientAgentTemplateInput[]>(() =>
    agent.templates.map((t) => ({
      key: t.key,
      name: t.name,
      rationale: t.rationale ?? "",
      status: t.status,
    })),
  );
  const [open, setOpen] = useState(agent.launchState === "curating");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function update(index: number, patch: Partial<ClientAgentTemplateInput>) {
    setRows((current) => current.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  }

  function save(then?: "live") {
    setError(null);
    startTransition(async () => {
      const saved = await saveClientAgentTemplatesAction({
        clientAgentId: agent.id,
        templates: rows.filter((row) => row.key.trim() && row.name.trim()),
      });
      if (saved.error) {
        setError(saved.error);
        return;
      }
      if (then === "live") {
        const live = await goLiveClientAgentAction(agent.id);
        if (live.error) {
          setError(live.error);
          return;
        }
      }
      router.refresh();
    });
  }

  return (
    <div className="rounded-[var(--radius)] border border-border bg-surface-2/40 p-3">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-2 text-left"
      >
        <span className="flex items-center gap-2 text-xs text-foreground">
          <Icon name="ListChecks" className="h-3.5 w-3.5 text-muted-2" />
          Templates
          <Badge tone={agent.launchState === "curating" ? "warning" : "neutral"}>
            {agent.launchState === "curating" ? "Needs confirming" : `${rows.length}`}
          </Badge>
        </span>
        <Icon name={open ? "ChevronUp" : "ChevronDown"} className="h-4 w-4 text-muted-2" />
      </button>

      {open && (
        <div className="mt-3 space-y-3">
          {rows.length === 0 && (
            <p className="text-[11px] text-muted-2">
              The setup run proposed no machine-readable template set. Read its deliverables and add
              the streams by hand.
            </p>
          )}
          {rows.map((row, index) => (
            <div key={index} className="space-y-1.5 rounded-[var(--radius)] border border-border p-2.5">
              <div className="flex gap-2">
                <Input
                  value={row.name}
                  onChange={(e) => update(index, { name: e.target.value })}
                  placeholder="By The Numbers"
                  className="h-8 text-xs"
                  aria-label="Template name"
                />
                <Input
                  value={row.key}
                  onChange={(e) => update(index, { key: e.target.value })}
                  placeholder="by-the-numbers"
                  className="h-8 w-44 font-mono text-xs"
                  aria-label="Template key"
                />
                <Select
                  value={row.status ?? "active"}
                  onChange={(e) =>
                    update(index, { status: e.target.value as ClientAgentTemplateInput["status"] })
                  }
                  className="h-8 w-28 text-xs"
                  aria-label="Template status"
                >
                  <option value="active">Active</option>
                  <option value="paused">Paused</option>
                  <option value="retired">Retired</option>
                </Select>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setRows((c) => c.filter((_, i) => i !== index))}
                  aria-label="Remove template"
                >
                  <Icon name="Trash2" className="h-3.5 w-3.5" />
                </Button>
              </div>
              <Textarea
                value={row.rationale ?? ""}
                onChange={(e) => update(index, { rationale: e.target.value })}
                placeholder="Why this format fits this client — the client reads this line."
                rows={2}
                className="text-xs"
                aria-label="Template rationale"
              />
            </div>
          ))}

          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setRows((c) => [...c, { key: "", name: "", rationale: "" }])}
            >
              <Icon name="Plus" className="h-3.5 w-3.5" /> Add template
            </Button>
            <Button size="sm" variant="subtle" onClick={() => save()} disabled={pending}>
              Save
            </Button>
            {agent.launchState !== "live" && (
              <Button
                size="sm"
                variant="accent"
                onClick={() => save("live")}
                disabled={pending}
                loading={pending}
              >
                <Icon name="Zap" className="h-3.5 w-3.5" /> Go live
              </Button>
            )}
          </div>
          {error && <p className="text-[11px] text-warning">{error}</p>}
        </div>
      )}
    </div>
  );
}
