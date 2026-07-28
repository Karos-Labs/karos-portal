import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import {
  getClient,
  getClientCredits,
  getCustomAgent,
  listAssets,
  listClientIntegrations,
  listContextItems,
  listJobs,
  listPlannedScheduledRuns,
} from "@/lib/data";
import { availableCredits, creditBlockReason, CREDIT_COSTS, isBillableClientActor } from "@/lib/credits";
import { Badge, EmptyState, PageHeader } from "@/components/ui";
import { Icon } from "@/components/icon";
import { AgentIdentity } from "@/components/agent-identity";
import { AutoRefresh } from "@/components/auto-refresh";
import { isAgentServiceConfigured } from "@/lib/agent-service/client";
import { clientAgentBlurb } from "@/lib/agent-blurbs";
import { listClientAgents } from "@/lib/data-client-agents";
import { isLaunchInFlight, rosterStatus } from "@/lib/client-agents";
import { resolveContentIdentity } from "@/lib/agent-identity-map";
import { sanitizeIntegrations } from "@/lib/integrations/sanitize";
import { integrationNeedsReconnect } from "@/lib/integration-status";
import { platformLabel } from "@/lib/integrations/platforms";
import { clientDeliveryStamp, getClientArchiveAssets } from "@/lib/asset-visibility";
import { ClientAgentLaunchCard } from "@/components/client-agents/launch-card";
import { AgentDetailPanel } from "@/components/client-agents/agent-detail-panel";
import { LegacyAgentPanel } from "@/components/client-agents/legacy-agent-panel";
import { evaluateLegacyRunGate } from "@/lib/client-agent-runs";
import {
  buildAgentSetup,
  scheduleZonesByAgent,
  toClientAgentRows,
  toScheduleRows,
  toSummary,
} from "@/lib/client-agent-rows";
import { relativeTime } from "@/lib/utils";

/**
 * One agent's home page (CD-G1).
 *
 * Albert: "they can just click on it, and then it opens… over the whole page.
 * That whole page should be like the Instagram Agent." The roster answers "is
 * this working for me"; this page answers everything else — what the agent
 * produces, whether it is live, the formats it writes, how to make a post now,
 * how to steer it, what it has already delivered, what data and connections it
 * runs on.
 *
 * REDACTION HAPPENS HERE, at the RSC boundary, never at render. Every field
 * below is serialized into the payload the browser receives, so a raw internal
 * string handed to a client component is readable whether or not it is ever
 * painted. That is why the row projection is shared with the roster
 * (client-agent-rows.ts) rather than rebuilt: one place decides what a client
 * viewer may receive about an agent, and both routes go through it.
 *
 * The launch states (§7.1 states 1–3) render as this page's HERO for a
 * non-live umbrella. The roster card upstream shows only the status word —
 * a CTA, a progress narration and a failure with a Contact-us row are all
 * explanations, and explanations belong on the page you opened to get them.
 */
export default async function ClientAgentDetailPage({
  params,
}: {
  params: Promise<{ id: string; agentId: string }>;
}) {
  const user = await requireUser();
  const { id, agentId } = await params;

  if (user.role === "CLIENT_USER") {
    if (user.clientId !== id) redirect(user.clientId ? `/clients/${user.clientId}` : "/assets");
  } else if (user.role !== "KAROS_ADMIN" && user.role !== "KAROS_EMPLOYEE") {
    redirect("/dashboard");
  }

  const client = await getClient(id);
  if (!client) notFound();

  const isStaff = user.role === "KAROS_ADMIN" || user.role === "KAROS_EMPLOYEE";
  const viewerIsClient = !isStaff;

  const agent = await getCustomAgent(agentId);
  if (!agent || !agent.enabled) notFound();

  const [jobs, credits, scheduledRuns, umbrellas, assets, integrations, contextItems] =
    await Promise.all([
    listJobs({ clientId: id }),
    getClientCredits(id),
    listPlannedScheduledRuns({ clientId: id }),
    listClientAgents({ clientId: id }),
    listAssets({ clientId: id }),
    listClientIntegrations(id),
    // The run dialog's attachment picker (CD-H8) — the legacy branch offers
    // the standard run gesture, and the standard gesture can attach context.
    listContextItems({ clientId: id }),
  ]);

  // A client may only open an agent they were granted — or one that has already
  // delivered for them, the same rule the roster uses to decide what to list.
  // Same answer for "not granted" and "does not exist": a client probing ids
  // must not learn which agents the lab has.
  if (viewerIsClient) {
    const successful = new Set(["review", "approved", "delivered"]);
    const earned = jobs.some(
      (job) =>
        job.external?.taskType === "custom" &&
        successful.has(job.status) &&
        (job.customAgentId === agent.id || job.agentName === agent.name),
    );
    if (!(client.customAgentIds ?? []).includes(agent.id) && !earned) notFound();
  }

  const summary = toSummary(agent);
  const now = Date.now();
  const spendable = isBillableClientActor(user) ? availableCredits(credits, now) : undefined;
  const cost = agent.creditCost ?? CREDIT_COSTS.customAgentRun;
  const creditBlockReasons: Record<string, string> =
    spendable !== undefined && spendable < cost
      ? { [agent.id]: creditBlockReason(credits, cost, now) }
      : {};

  const agentSetup = await buildAgentSetup(id, [summary]);
  const scheduleRows = toScheduleRows(scheduledRuns, viewerIsClient);
  const umbrella = umbrellas.find((u) => u.customAgentId === agent.id) ?? null;
  const rows = umbrella
    ? await toClientAgentRows({
        umbrellas: [umbrella],
        agentsById: new Map([[agent.id, agent]]),
        viewerIsClient,
        grantedAgentIds: null,
        agentSetup,
        ...(spendable !== undefined ? { spendable } : {}),
        creditBlockReasons,
        scheduleRows,
        scheduleZones: scheduleZonesByAgent(scheduledRuns),
        jobs,
        viewerUid: user.uid,
        viewerIsStaff: isStaff,
        now,
      })
    : [];
  const row = rows[0] ?? null;

  const schedule = scheduleRows.find((s) => s.agentId === agent.id) ?? null;
  const status = rosterStatus({
    launchState: umbrella?.launchState ?? null,
    scheduleRefusal: schedule?.status === "active" ? schedule.lastError : null,
    scheduleActive: schedule?.status === "active",
  });
  const blurb = clientAgentBlurb({
    key: agent.key,
    name: agent.name,
    clientBlurb: agent.clientBlurb ?? null,
  });

  // ── What this agent has already delivered (§7.3 identity) ──
  // Attribution runs through resolveContentIdentity, the one helper that knows
  // how an asset, its job and an umbrella relate — Asset has no clientAgentId
  // of its own, so a hand-rolled join here would be a second, subtly different
  // answer to "who made this".
  const jobById = new Map(jobs.map((job) => [job.id, job]));
  // DELIVERED WORK ONLY for a client (A3/A4). getClientLibraryAssets was the
  // wrong helper here: it MAPS a future-dated asset through redactLockedAsset
  // rather than dropping it, and the placeholder keeps createdAt and
  // templateName. Under a heading reading "What it has made for you" that
  // rendered seven batch-generated posts as "Upcoming post · 3 hours ago" —
  // the batch tell in its purest form, since the timestamps show a week of
  // "daily" posts all created within the same minute.
  //
  // getClientArchiveAssets is the set that is actually true to the heading: no
  // launch deliverables, no drafts, nothing still locked. Staff keep everything.
  const visibleAssets = viewerIsClient ? getClientArchiveAssets(assets, { now }) : assets;
  const produced = visibleAssets
    .filter((asset) => {
      const job = asset.jobId ? (jobById.get(asset.jobId) ?? null) : null;
      // The direct link, when one exists: this agent's own job, or a job the
      // umbrella owns.
      if (job && (job.customAgentId === agent.id || (umbrella && job.clientAgentId === umbrella.id))) {
        return true;
      }
      const identity = resolveContentIdentity({ asset, job }, umbrellas);
      if (umbrella) return identity.clientAgentId === umbrella.id;
      // CD-H8, the legacy shape: a live schedule and no umbrella doc, which is
      // the flagship Instagram Agent. There is no umbrella id for the helper to
      // resolve to, so attribution falls to the ONE NAME it resolves — its
      // fourth rung, which exists precisely for content produced before
      // umbrellas and carrying no agent link at all. Without this the page
      // showed a live, producing agent as having made nothing.
      return identity.label === agent.name;
    })
    .slice(0, 8);

  const setup = agentSetup[agent.id] ?? null;
  const connections = sanitizeIntegrations(integrations);
  const launchInFlight = umbrella ? isLaunchInFlight(umbrella.launchState) : false;
  const agentServiceConfigured = isAgentServiceConfigured();

  // CD-H8. The run gate for the legacy shape, evaluated HERE for the same
  // reason every other gate on this surface is: a control may only offer a
  // press the server would accept (F131), and its reason has to arrive with it
  // already resolved so it can be painted rather than hidden in a tooltip on a
  // pointer-events-none button (F25). Same ladder the generic card walks —
  // service, then intake, then credits — so the two cannot disagree.
  const legacyGate = evaluateLegacyRunGate({
    serviceConfigured: agentServiceConfigured,
    setup,
    cost,
    ...(spendable !== undefined ? { availableCredits: spendable } : {}),
    creditBlockReason: creditBlockReasons[agent.id] ?? null,
  });

  // F31. The legacy branch had no run state at all: a client pressed "Create a
  // new post", the page did not change, and nothing on it refreshed — so the
  // twenty minutes the run takes were indistinguishable from the press having
  // done nothing. Resolved here rather than in the panel for the usual reason:
  // only an id and a phase cross the boundary, never the job's prompt, events
  // or asset ids.
  //
  // Attribution matches the "what it has made" join above — customAgentId is
  // authoritative, agentName keeps runs fired before that field existed. Launch
  // runs are excluded by construction: this shape has no umbrella to launch.
  //
  // ONLY A RUN THIS VIEWER STARTED. The banner this feeds says "Making your
  // next post now" and offers a Cancel whose confirm promises the credits back,
  // and it was matching ANY in-flight run on the agent — including a SCHEDULED
  // fire. Two things were wrong with that. The copy: a cron tick is not
  // something the reader just asked for, and the umbrella card next door has
  // always held the opposite line ("the one run the card acknowledges: a 'Run
  // now' the viewer just pressed" — client-agent-rows.ts), which is also the
  // A3/A4 rule that scheduled production stays invisible. And the money: a
  // scheduled fire charges the client only when the SCHEDULE was theirs
  // (run-scheduled/route.ts bills on `billClientCredits` and acts as the
  // schedule's creator), so for a staff-set schedule nothing was charged and
  // the refund promise was simply false.
  //
  // `createdBy === user.uid` answers both at once: the manual press is theirs,
  // and their own schedule's fire is theirs and IS billed, while a staff-set
  // schedule's fire is not shown to them at all.
  const legacyRun = umbrella
    ? null
    : (jobs
        .filter(
          (job) =>
            job.external?.taskType === "custom" &&
            (job.status === "queued" || job.status === "running") &&
            job.runType !== "launch" &&
            job.createdBy === user.uid &&
            (job.customAgentId === agent.id ||
              (!job.customAgentId && job.agentName === agent.name)),
        )
        .sort((a, b) => b.createdAt - a.createdAt)[0] ?? null);

  return (
    <>
      {(launchInFlight || row?.activeRun || legacyRun) && <AutoRefresh />}
      <div className="mb-4">
        <Link
          href={`/clients/${id}/agents`}
          className="inline-flex items-center gap-1.5 text-xs text-muted hover:text-foreground"
        >
          <Icon name="ChevronLeft" className="h-3.5 w-3.5" /> All agents
        </Link>
      </div>

      <PageHeader
        title={umbrella?.displayName ?? agent.name}
        description={blurb}
        action={
          <div className="flex items-center gap-2">
            <AgentIdentity
              identity={`${agent.key} ${agent.name}`}
              {...(agent.icon ? { icon: agent.icon } : {})}
            />
            <StatusBadge label={status.label} tone={status.tone} />
          </div>
        }
      />

      {!agentServiceConfigured && (
        <p className="mb-4 rounded-[var(--radius)] border border-warning/30 bg-warning/10 px-4 py-3 text-sm text-warning">
          <Icon name="TriangleAlert" className="mr-1.5 inline h-4 w-4" />
          Agent runs are paused right now — starting a new post will not work until this clears. Your
          Karos team has been notified. Everything below is unaffected.
        </p>
      )}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="min-w-0 space-y-6">
          {/* Hero: the launch card for a non-live umbrella (§7.1 states 1–3),
              the working agent once it is live. An agent with no umbrella at
              all has neither — it is simply not set up, and says so rather
              than offering controls the server would refuse. */}
          {row && umbrella?.launchState === "live" ? (
            <AgentDetailPanel
              agent={row}
              viewerIsClient={viewerIsClient}
              viewer={{ name: user.name, email: user.email }}
            />
          ) : row ? (
            <ClientAgentLaunchCard
              agent={row}
              viewerIsClient={viewerIsClient}
              viewer={{ name: user.name, email: user.email }}
            />
          ) : status.tone === "live" ? (
            /* The legacy shape (CD-H8): no umbrella was ever bound, but a weekly
               schedule is firing — so this agent genuinely IS producing, and the
               roster and header badge it Live. It is also the flagship case, not
               an edge one: Karos Labs' own Instagram Agent predates the umbrella
               model. It used to render one sentence and nothing else, which made
               the most-looked-at agent in the portal the one with no way to make
               a post, no way to change its pace, and no sign of anything it had
               ever made. It now gets the two gestures that need no umbrella;
               templates, the week strip and notes stay umbrella-gated because
               faking them would invent streams this agent does not have. */
            <LegacyAgentPanel
              clientId={id}
              agent={summary}
              cost={spendable !== undefined ? cost : null}
              gate={legacyGate}
              schedule={schedule}
              {...(setup ? { setup } : {})}
              contextItems={contextItems}
              viewerIsClient={viewerIsClient}
              viewer={{ name: user.name, email: user.email }}
              {...(spendable !== undefined ? { availableCredits: spendable } : {})}
              activeRun={
                legacyRun
                  ? {
                      id: legacyRun.id,
                      status: legacyRun.status === "running" ? "running" : "queued",
                      // Whether stopping it actually returns credits. `spendable`
                      // is resolved only for a billable actor, so it IS the
                      // "was this viewer charged" answer, already computed.
                      refunds: spendable !== undefined,
                    }
                  : null
              }
            />
          ) : (
            <EmptyState
              icon={<Icon name="Bot" className="h-7 w-7" />}
              title="Not set up yet"
              description="Your Karos team sets this agent up for your brand before it starts producing. They will let you know when it is ready."
            />
          )}

          <section>
            <SectionHeading title="What it has made for you" />
            {produced.length === 0 ? (
              <p className="rounded-[var(--radius)] border border-border bg-surface-2/50 px-4 py-3 text-xs text-muted-2">
                Nothing yet. Finished work appears here once your Karos team has approved it.
              </p>
            ) : (
              <ul className="space-y-1.5">
                {produced.map((asset) => (
                  <li
                    key={asset.id}
                    className="flex items-center justify-between gap-3 rounded-[var(--radius)] border border-border bg-surface-2/50 px-3 py-2"
                  >
                    <span className="min-w-0 flex-1 truncate text-xs text-foreground">
                      {asset.title || "Untitled"}
                    </span>
                    {asset.templateName && <Badge tone="neutral">{asset.templateName}</Badge>}
                    {/* The set above is already delivered-work-only for a
                        client; the STAMP has to match. `createdAt` is the
                        generation instant a whole batch shares, so eight rows
                        under "What it has made for you" all read "3 hours ago"
                        — the same batch tell the asset filter three screens up
                        was added to close. Staff keep the generation time. */}
                    <span className="shrink-0 text-[11px] text-muted-2">
                      {relativeTime(
                        viewerIsClient ? clientDeliveryStamp(asset) : asset.createdAt,
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            <Link
              href={`/clients/${id}/assets`}
              className="mt-2 inline-flex items-center gap-1 text-xs text-neon hover:underline"
            >
              Open your Workspace <Icon name="ArrowRight" className="h-3 w-3" />
            </Link>
          </section>
        </div>

        <aside className="space-y-6">
          {/* ── The data this agent runs on ── */}
          <section>
            <SectionHeading title="What it knows about you" />
            {setup ? (
              <div className="rounded-[var(--radius)] border border-border bg-surface-2/50 p-3">
                <div className="flex items-center gap-2">
                  <p className="flex-1 text-xs text-foreground">{setup.label}</p>
                  <Badge tone={setup.ready ? "success" : "warning"}>
                    {setup.ready ? "Saved" : "Needed"}
                  </Badge>
                </div>
                <p className="mt-1 text-[11px] text-muted-2">
                  {setup.ready
                    ? "This agent writes from what you saved here. Update it any time."
                    : "This agent needs this before it can write for you."}
                </p>
                <Link
                  href={setup.href}
                  className="mt-2 inline-flex items-center gap-1 text-xs text-neon hover:underline"
                >
                  {setup.ready ? "Review it" : "Set it up"} <Icon name="ArrowRight" className="h-3 w-3" />
                </Link>
              </div>
            ) : (
              <p className="rounded-[var(--radius)] border border-border bg-surface-2/50 px-3 py-2.5 text-[11px] text-muted-2">
                This agent writes from your brand profile and the documents in your Workspace.
              </p>
            )}
          </section>

          {/* ── Connectors ── read-only chips. Connecting and reconnecting are
              settings actions, so this states the fact and links there rather
              than growing a second place to change them. */}
          <section>
            <SectionHeading title="Connected accounts" />
            {connections.length === 0 ? (
              <p className="rounded-[var(--radius)] border border-border bg-surface-2/50 px-3 py-2.5 text-[11px] text-muted-2">
                No accounts connected yet. Posts are delivered to your Workspace for you to publish.
              </p>
            ) : (
              <ul className="space-y-1.5">
                {connections.map((connection) => (
                  <li
                    key={connection.id}
                    className="flex items-center justify-between gap-2 rounded-[var(--radius)] border border-border bg-surface-2/50 px-3 py-2"
                  >
                    <span className="min-w-0 flex-1 truncate text-xs text-foreground">
                      {platformLabel(connection.platform)}
                      {connection.accountName && (
                        <span className="text-muted-2"> · {connection.accountName}</span>
                      )}
                    </span>
                    {integrationNeedsReconnect(connection) ? (
                      <Badge tone="warning">
                        <Icon name="TriangleAlert" className="h-3 w-3" /> Reconnect
                      </Badge>
                    ) : (
                      <Badge tone="neon">
                        <Icon name="CircleCheck" className="h-3 w-3" /> Connected
                      </Badge>
                    )}
                  </li>
                ))}
              </ul>
            )}
            <Link
              href={`/clients/${id}/settings`}
              className="mt-2 inline-flex items-center gap-1 text-xs text-muted hover:text-foreground"
            >
              Manage connections <Icon name="ArrowRight" className="h-3 w-3" />
            </Link>
          </section>
        </aside>
      </div>
    </>
  );
}

function SectionHeading({ title }: { title: string }) {
  return (
    <h2 className="mb-2.5 font-mono text-[10px] uppercase tracking-[0.08em] text-muted">{title}</h2>
  );
}

function StatusBadge({ label, tone }: { label: string; tone: string }) {
  if (tone === "live") {
    return (
      <Badge tone="success">
        <span className="h-1.5 w-1.5 rounded-full bg-success animate-pulse-neon" aria-hidden="true" />
        {label}
      </Badge>
    );
  }
  if (tone === "attention") return <Badge tone="warning">{label}</Badge>;
  if (tone === "progress") return <Badge tone="info">{label}</Badge>;
  return <Badge tone="neutral">{label}</Badge>;
}
