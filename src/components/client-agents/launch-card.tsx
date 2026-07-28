"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Badge, Button } from "@/components/ui";
import { Icon } from "@/components/icon";
import { AgentIdentity } from "@/components/agent-identity";
import { ContactUsButton } from "@/components/contact-us-modal";
import {
  CLIENT_LAUNCH_PHASE_COPY,
  LAUNCH_ESTIMATE,
  clientLaunchPhase,
  type ClientLaunchPhase,
} from "@/lib/client-agents";
import {
  resetClientAgentLaunchAction,
  submitClientAgentLaunchAction,
} from "@/lib/actions/client-agent-actions";
import type { ClientAgentCardRow } from "./types";
import { cn } from "@/lib/utils";

/**
 * The client-agent card before the agent is live (Phase 3 §7.1 cards 1–3).
 *
 * Its whole job is to make the launch a thing the client can DO — "I want to
 * launch my Instagram agent" → press → watch it happen — without ever offering
 * a press the server would refuse. Every gated state renders the button
 * DISABLED with its reason painted underneath (F25): the Button primitive sets
 * `disabled:pointer-events-none`, so a `title` on a disabled control can never
 * be read, and a reason nobody can read is the same as no reason.
 *
 * Lives in its own directory rather than inside custom-agents.tsx, which other
 * work is actively editing; the agents page decides which card an agent gets.
 */
export function ClientAgentLaunchCard({
  agent,
  viewerIsClient,
  viewer,
}: {
  agent: ClientAgentCardRow;
  viewerIsClient: boolean;
  viewer?: { name: string; email: string };
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const phase = clientLaunchPhase(agent.launchState, { startedAt: agent.launchStartedAt });
  const inFlight = phase === "researching" || phase === "designing";
  const failed = agent.launchState === "launch_failed";

  function launch() {
    setError(null);
    startTransition(async () => {
      const result = await submitClientAgentLaunchAction({
        clientId: agent.clientId,
        clientAgentId: agent.id,
      });
      if (result.error) setError(result.error);
      else router.refresh();
    });
  }

  function reset() {
    setError(null);
    startTransition(async () => {
      const result = await resetClientAgentLaunchAction(agent.id);
      if (result.error) setError(result.error);
      else router.refresh();
    });
  }

  return (
    <div className="card-grad group relative flex min-h-52 flex-col overflow-hidden rounded-[var(--radius)] border border-border p-5 transition-all duration-200 hover:border-border-strong">
      <span
        className="absolute inset-x-0 top-0 h-0.5 bg-foreground/40 opacity-45 transition-opacity group-hover:opacity-80"
        aria-hidden="true"
      />
      <div className="flex items-start gap-3">
        <AgentIdentity identity={agent.identity} icon={agent.icon} />
        <div className="min-w-0 flex-1">
          <p className="mb-1 font-mono text-[9px] uppercase tracking-[0.16em] text-muted-2">
            AI agent
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <p className="truncate text-base font-medium">{agent.displayName}</p>
            {inFlight ? (
              <Badge tone="info">
                <span
                  className="h-1.5 w-1.5 rounded-full bg-info animate-pulse-neon"
                  aria-hidden="true"
                />
                Setting up
              </Badge>
            ) : failed ? (
              <Badge tone="warning">Needs another pass</Badge>
            ) : agent.launchState === "live" ? (
              <Badge tone="success">Live</Badge>
            ) : (
              <Badge tone="neutral">Not set up yet</Badge>
            )}
          </div>
          {agent.blurb && (
            <p className="mt-0.5 line-clamp-3 text-xs leading-relaxed text-muted">{agent.blurb}</p>
          )}
        </div>
      </div>

      <div className="mt-4 flex-1">
        {inFlight ? (
          <LaunchProgress phase={phase} />
        ) : failed ? (
          <FailureNote agent={agent} viewerIsClient={viewerIsClient} />
        ) : agent.launchState === "live" ? (
          <TemplateSummary agent={agent} />
        ) : (
          <WhatLaunchDoes />
        )}
      </div>

      {agent.launchState !== "live" && !inFlight && (
        <div className="mt-auto pt-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs text-muted-2">
              {agent.launchCost != null
                ? `${agent.launchCost} credits, one time · ${LAUNCH_ESTIMATE}`
                : `One-time setup · ${LAUNCH_ESTIMATE}`}
            </p>
            <div className="flex gap-1.5">
              {!viewerIsClient && failed && (
                <Button size="sm" variant="ghost" onClick={reset} disabled={pending}>
                  <Icon name="RotateCcw" className="h-3.5 w-3.5" /> Reset
                </Button>
              )}
              <Button
                size="sm"
                variant="accent"
                onClick={launch}
                disabled={!agent.gate.allowed || pending}
                loading={pending}
              >
                <Icon name="Rocket" className="h-3.5 w-3.5" />
                {failed ? "Try setup again" : `Launch ${agent.displayName}`}
              </Button>
            </div>
          </div>

          {/* The reason the button is off, PAINTED — not a tooltip on a control
              that cannot receive a pointer. */}
          {!agent.gate.allowed && agent.gate.reason && (
            <div className="mt-2 space-y-1 border-t border-border/60 pt-2">
              <p className="text-[11px] text-warning">{agent.gate.reason}</p>
              {agent.gate.code === "intake_required" && agent.setupHref && (
                <Link
                  href={agent.setupHref}
                  className="inline-flex items-center gap-1 text-[11px] text-neon hover:underline"
                >
                  Open {agent.setupLabel ?? "the setup page"}
                  <Icon name="ArrowRight" className="h-3 w-3" />
                </Link>
              )}
              {agent.gate.code === "credits_short" && viewer && (
                <div className="-mx-3">
                  <ContactUsButton variant="row" userName={viewer.name} userEmail={viewer.email} />
                </div>
              )}
            </div>
          )}

          {error && <p className="mt-2 text-[11px] text-warning">{error}</p>}
        </div>
      )}
    </div>
  );
}

/** What the client is buying, before they buy it. */
function WhatLaunchDoes() {
  return (
    <ul className="space-y-1.5 text-xs text-muted">
      {[
        "We research your brand, your audience, and your market.",
        "Then we design the set of post formats this agent will produce for you.",
        "Your Karos team confirms them, and the agent starts posting to its schedule.",
      ].map((line) => (
        <li key={line} className="flex gap-2">
          <Icon name="Check" className="mt-0.5 h-3.5 w-3.5 shrink-0 text-success" />
          <span>{line}</span>
        </li>
      ))}
    </ul>
  );
}

const PHASE_ORDER: ClientLaunchPhase[] = ["researching", "designing", "live"];

/**
 * The guided progress a client watches while the setup runs. Three phases, and
 * the copy never claims work it cannot see: until the service emits progress
 * events, "designing" is a time-based narrative stage, not a report that the
 * research finished.
 */
function LaunchProgress({ phase }: { phase: ClientLaunchPhase }) {
  const activeIndex = PHASE_ORDER.indexOf(phase);
  return (
    <div className="space-y-2.5">
      {PHASE_ORDER.map((step, index) => {
        const copy = CLIENT_LAUNCH_PHASE_COPY[step as keyof typeof CLIENT_LAUNCH_PHASE_COPY];
        const done = index < activeIndex;
        const active = index === activeIndex;
        return (
          <div key={step} className="flex gap-2.5">
            <span
              className={cn(
                "mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border",
                done && "border-success/40 bg-success/15 text-success",
                active && "border-info/40 bg-info/15 text-info",
                !done && !active && "border-border text-muted-2",
              )}
              aria-hidden="true"
            >
              {done ? (
                <Icon name="Check" className="h-2.5 w-2.5" />
              ) : active ? (
                <span className="h-1.5 w-1.5 animate-pulse-neon rounded-full bg-info" />
              ) : null}
            </span>
            <div className="min-w-0">
              <p className={cn("text-xs", active ? "text-foreground" : "text-muted")}>
                {copy.title}
              </p>
              {active && <p className="mt-0.5 text-[11px] text-muted-2">{copy.detail}</p>}
            </div>
          </div>
        );
      })}
      <p className="pt-1 text-[11px] text-muted-2">
        This takes {LAUNCH_ESTIMATE}. You can leave this page — it keeps running.
      </p>
    </div>
  );
}

/**
 * A failed setup, said neutrally. A client-billed launch is refunded by the
 * webhook before this ever renders, so the copy states it rather than leaving
 * them to wonder; the stored error itself is staff-only (it is redacted server
 * side for client viewers, so there is nothing to leak here either way).
 */
function FailureNote({
  agent,
  viewerIsClient,
}: {
  agent: ClientAgentCardRow;
  viewerIsClient: boolean;
}) {
  return (
    <div className="space-y-1.5 text-xs text-muted">
      <p>
        Setup needs another pass.
        {agent.launchRefunded ? " Your credits were returned." : " Your Karos team is on it."}
      </p>
      {!viewerIsClient && agent.launchError && (
        <p className="rounded-[var(--radius)] border border-border bg-surface-2 px-2.5 py-1.5 font-mono text-[11px] text-muted-2">
          {agent.launchError}
        </p>
      )}
    </div>
  );
}

function TemplateSummary({ agent }: { agent: ClientAgentCardRow }) {
  const active = agent.templates.filter((t) => t.status === "active");
  if (active.length === 0) {
    return <p className="text-xs text-muted">No template streams registered yet.</p>;
  }
  return (
    <div className="flex flex-wrap gap-1.5">
      {active.map((template) => (
        <span
          key={template.key}
          className="rounded-full border border-border bg-surface-2 px-2 py-0.5 text-[11px] text-muted"
        >
          {template.name}
        </span>
      ))}
    </div>
  );
}
