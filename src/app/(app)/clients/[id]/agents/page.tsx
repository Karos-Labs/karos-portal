import { notFound, redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import {
  getClient,
  getClientCredits,
  listAssets,
  listCustomAgents,
  listJobs,
  listPlannedScheduledRuns,
} from "@/lib/data";
import { availableCredits, creditBlockReason, CREDIT_COSTS, isBillableClientActor } from "@/lib/credits";
import { EmptyState, PageHeader } from "@/components/ui";
import { Icon } from "@/components/icon";
import { AgentRunHistory } from "@/components/custom-agents";
import { AutoRefresh } from "@/components/auto-refresh";
import { ReplanCalendarButton } from "@/components/replan-calendar-button";
import { LabImportButton } from "@/components/lab-import";
import { BulkUploadClips } from "@/components/bulk-upload-clips";
import { isAgentServiceConfigured } from "@/lib/agent-service/client";
import { agentKeyMatchesClientSlug } from "@/lib/custom-agent-launch";
import { isLabOutputsConfigured } from "@/lib/lab-outputs";
import { clientAgentBlurb } from "@/lib/agent-blurbs";
import { listClientAgents } from "@/lib/data-client-agents";
import { isLaunchInFlight, lastRunFailedAgentIds, rosterStatus } from "@/lib/client-agents";
import { agentsWithDeliveredWork } from "@/lib/agent-detail-archetypes";
import { umbrellaOwnsClientCard } from "@/lib/client-agent-runs";
import { BindAgentControl } from "@/components/client-agents/client-agents-section";
import { ClientAgentRoster, type AgentRosterEntry } from "@/components/client-agents/roster";
import {
  buildAgentSetup,
  scheduleZonesByAgent,
  toClientAgentRows,
  toRunRows,
  toScheduleRows,
  toSummary,
} from "@/lib/client-agent-rows";



/**
 * A client's AI Agents page. Clients can run only the custom agents that an
 * admin granted them; staff can run every enabled custom agent. Neither list
 * may include a per-client agent instance belonging to a different client —
 * its skill is baked under that client's lab folder, so a run here would draft
 * the wrong company. Both branches filter on agentKeyMatchesClientSlug, and
 * the submit core refuses a mismatched pair regardless of how it was launched.
 */
export default async function ClientAgentsPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  const { id } = await params;

  if (user.role === "CLIENT_USER") {
    if (user.clientId !== id) redirect(user.clientId ? `/clients/${user.clientId}` : "/assets");
  } else if (user.role !== "KAROS_ADMIN" && user.role !== "KAROS_EMPLOYEE") {
    redirect("/dashboard");
  }

  const client = await getClient(id);
  if (!client) notFound();

  const isStaff = user.role === "KAROS_ADMIN" || user.role === "KAROS_EMPLOYEE";
  const agentServiceConfigured = isAgentServiceConfigured();

  // Client users: explicitly granted agents plus any agent that has already
  // delivered a successful run for this workspace.
  if (!isStaff) {
    const allowedIds = new Set(client.customAgentIds ?? []);
    // No listContextItems here any more: it fed the generic run dialog's
    // attachment picker, and a client's run gesture has moved to the detail
    // page (CD-G1). The roster reads nothing from it, so the roster no longer
    // pays for it.
    const [allAgents, jobs, credits, scheduledRuns, umbrellas, assets] = await Promise.all([
      listCustomAgents(),
      listJobs({ clientId: id }),
      getClientCredits(id),
      listPlannedScheduledRuns({ clientId: id }),
      listClientAgents({ clientId: id }),
      // The delivered-work read needs assets, not only jobs: a lab-imported
      // deliverable has no job at all (see agentsWithDeliveredWork).
      //
      // WHAT IT COSTS, stated where the call is. `listAssets` is an unbounded
      // `where clientId ==` collection read with an in-process sort (data.ts), so
      // this pulls the client's whole asset history to answer one boolean per
      // agent — and the roster renders nothing from the documents themselves.
      // One query rather than one per agent, and fine at pilot volume, but it
      // grows with the client's history rather than with the roster. The cheaper
      // shapes, when it stops being fine: a projected read (`.select(...)`) of
      // only the fields attribution and the archive filter touch — id, jobId,
      // status, scheduledAt, publishedAt, updatedAt, templateKey and the folder
      // key in `meta` — or a date-bounded query, since a client's archive window
      // is 30 days anyway. Either is a change to the data layer, not to this page.
      listAssets({ clientId: id }),
    ]);
    const agentIdByName = new Map(allAgents.map((agent) => [agent.name, agent.id]));
    // `now` rolls the spend windows on read (a schedule doc read after a week
    // rollover would otherwise still count last week's spend and mis-name the
    // limit) and it is also the clock the delivered-work read and every card's
    // refusal window age against — resolved once so the whole page agrees.
    // eslint-disable-next-line react-hooks/purity -- server component, no re-render concern
    const now = Date.now();
    // Every agent that could ever appear on this roster: enabled, and bound to
    // this client. The binding wins over both routes in below — a grant and an
    // inherited delivered run are equally unable to move an instance off its
    // client — so it is applied before anything else can widen the list.
    const candidateAgents = allAgents.filter(
      (agent) => agent.enabled && agentKeyMatchesClientSlug(agent.key, client.agentsRepoSlug),
    );
    // The same set answers two questions on this page: which agents a client
    // inherits by having been delivered to, and — through rosterStatus — which
    // of them are plainly set up already. It reads JOBS AND ASSETS through the
    // one shared answer the agent's own page reads, because it was a job-only
    // join here: an agent whose only delivered work was a lab import (jobId:
    // null) was missing from this roster altogether while its posts sat in the
    // client's Workspace.
    const completedAgentIds = agentsWithDeliveredWork({
      assets,
      jobs,
      agents: candidateAgents,
      umbrellas,
      clientSlug: client.agentsRepoSlug,
      viewerIsClient: true,
      now,
    });
    // The other half of the same read: which agents' most recent finished run
    // FAILED. A schedule refusal cannot see that — it only records a fire the
    // scheduler turned away before a job existed — so without this a green
    // "Live" badge sits above a run history whose last row says Failed.
    const failedAgentIds = lastRunFailedAgentIds(jobs, agentIdByName, { staff: false });
    const agents = candidateAgents
      .filter((agent) => allowedIds.has(agent.id) || completedAgentIds.has(agent.id))
      .map(toSummary);
    // Impersonating admins see the client view but never spend real credits —
    // show the gate only to billable client actors.
    const spendable = isBillableClientActor(user) ? availableCredits(credits, now) : undefined;
    // Which limit clips that number — computed PER AGENT, because the binding
    // limit depends on the agent's price (F130 gives agents distinct costs): a
    // cheap agent may be blocked by the weekly cap while a pricey one is blocked
    // by the balance, and each must name the limit its own denial would. The
    // card shows it beside a blocked Run button, where "ask for a top-up" is
    // wrong advice for a client who is capped for the week.
    const creditBlockReasons: Record<string, string> = {};
    if (spendable !== undefined) {
      for (const agent of agents) {
        const cost = agent.creditCost ?? CREDIT_COSTS.customAgentRun;
        if (spendable < cost) creditBlockReasons[agent.id] = creditBlockReason(credits, cost, now);
      }
    }
    const agentSetup = await buildAgentSetup(id, agents);
    // ── Card selection: exactly one card per agent ──
    // An umbrella owns its agent's card as soon as it is bound — the launch
    // card while it is being set up, the live card once it is producing. The
    // agent is dropped from the generic run cards below, so a client is never
    // offered a Run button beside a "not set up yet" state, and never sees the
    // same agent twice under two identities.
    //
    // The one exception is deliberate (`umbrellaOwnsClientCard`): a LIVE
    // umbrella with no templates yet — the grandfathered bind of an
    // already-producing agent — keeps today's card, because replacing a working
    // Run button with a card that has no rows in it is the F131 failure with
    // the roles reversed.
    const ownedByUmbrella = umbrellas.filter((u) => umbrellaOwnsClientCard(u));
    const ownedAgentIds = new Set(ownedByUmbrella.map((u) => u.customAgentId));
    const runnableAgents = agents.filter((agent) => !ownedAgentIds.has(agent.id));
    // Client viewers see only runs of agents they're allowed — not the history
    // of staff-fired agents outside their allowlist, and (§4.1 item 3) not the
    // batch rows of an umbrella-owned agent: "ran 2 hours ago · 7 drafts" beside
    // a week of daily slots is the tell that the days are a presentation of a
    // batch. Staff rows are unchanged.
    const runnableNames = new Set(runnableAgents.map((a) => a.name));
    // Still filtered on the STORED name (that is the join to the runnable set);
    // what each row prints is its resolved §7.3 identity (F147).
    const runs = toRunRows(jobs, false, umbrellas).filter((r) => runnableNames.has(r.agentName));
    const clientScheduleRows = toScheduleRows(scheduledRuns, true);
    const clientAgentRows = await toClientAgentRows({
      umbrellas: ownedByUmbrella,
      agentsById: new Map(allAgents.map((a) => [a.id, a])),
      viewerIsClient: true,
      grantedAgentIds: new Set([...allowedIds, ...completedAgentIds]),
      clientSlug: client.agentsRepoSlug,
      agentSetup,
      ...(spendable !== undefined ? { spendable } : {}),
      creditBlockReasons,
      scheduleRows: clientScheduleRows,
      scheduleZones: scheduleZonesByAgent(scheduledRuns),
      jobs,
      viewerUid: user.uid,
      viewerIsStaff: false,
      now,
    });
    // A client run takes 10–20 minutes and the client's rows carry no link, so
    // without this the page never moved again after "Start run". Mounted only
    // while something is actually in flight; it unmounts when the server
    // renders a terminal status. A setup run in flight moves the launch card
    // the same way — it is the same medicine for a longer wait.
    const runInFlight =
      runs.some((run) => run.status === "queued" || run.status === "running") ||
      umbrellas.some((u) => isLaunchInFlight(u.launchState)) ||
      // An umbrella agent has no run row to watch any more, so its in-flight
      // template run has to be what moves the page.
      clientAgentRows.some((row) => row.activeRun !== null);
    // ── The roster (CD-G1) ──
    // One card per GRANTED agent, umbrella-bound or not, carrying a mark, a
    // name, one line of what it gives you and one status word. No Run button
    // anywhere: a client's run gesture lives only inside a detail page, beside
    // the context that explains what it costs and produces.
    //
    // Built from the agent list rather than from the umbrellas, because a
    // client's roster is "the agents I have", not "the agents someone has bound
    // an umbrella for". An agent with no umbrella is not missing from the
    // roster — it is simply not set up yet, and says so.
    const umbrellaByAgentId = new Map(ownedByUmbrella.map((u) => [u.customAgentId, u]));
    const scheduleByAgentId = new Map(clientScheduleRows.map((row) => [row.agentId, row]));
    const rosterEntries: AgentRosterEntry[] = agents.map((agent) => {
      const umbrella = umbrellaByAgentId.get(agent.id) ?? null;
      const schedule = scheduleByAgentId.get(agent.id) ?? null;
      return {
        customAgentId: agent.id,
        identity: `${agent.key} ${agent.name}`,
        icon: agent.icon ?? null,
        displayName: umbrella?.displayName ?? agent.name,
        blurb: clientAgentBlurb({
          key: agent.key,
          name: agent.name,
          clientBlurb: agent.clientBlurb ?? null,
        }),
        status: rosterStatus({
          launchState: umbrella?.launchState ?? null,
          // Already client-redacted by toScheduleRows. A refusal outranks
          // "Live" (F24/F129) — an agent whose every fire is turned away is
          // not live, whatever its umbrella says.
          scheduleRefusal: schedule?.status === "active" ? schedule.lastError : null,
          // …but only while it is still current. It clears in Firestore on the
          // next CLEAN fire, which on a weekly cadence is up to a week away.
          scheduleRefusalAt: schedule?.lastErrorAt ?? null,
          scheduleActive: schedule?.status === "active",
          // "Not set up yet" beside a shelf of delivered work is the card
          // contradicting itself; an agent that has produced says so instead.
          hasDelivered: completedAgentIds.has(agent.id),
          lastRunFailed: failedAgentIds.has(agent.id),
          now,
        }),
      };
    });

    return (
      <>
        {runInFlight && <AutoRefresh />}
        {/* The section below used to repeat this heading and tagline almost
            verbatim ("active AI team" / "always-on AI team"), one in Title Case
            and one in sentence case. This is the surviving one. */}
        <PageHeader
          title="AI agents"
          description="Your always-on AI team. Open an agent to see what it makes and to start a post."
        />
        {/* Two different conditions used to share the never-set-up empty state,
            so an outage or a bad deploy told a client with three live agents
            and a run history that they had never been set up. Only an empty
            allowlist gets that copy now; an unconfigured service keeps the
            agents, schedules and history on screen behind an honest notice. */}
        {agents.length > 0 && !agentServiceConfigured && (
          <p className="mb-4 rounded-[var(--radius)] border border-warning/30 bg-warning/10 px-4 py-3 text-sm text-warning">
            <Icon name="TriangleAlert" className="mr-1.5 inline h-4 w-4" />
            Agent runs are paused right now — starting a new run will not work until this clears.
            Contact your Karos team if you need a run today. Everything below is unaffected.
          </p>
        )}
        {rosterEntries.length > 0 ? (
          <ClientAgentRoster clientId={id} entries={rosterEntries} />
        ) : (
          <EmptyState
            icon={<Icon name="Bot" className="h-7 w-7" />}
            title="No active agents yet"
            description="After your Karos team completes the first agent run, that agent will appear here."
          />
        )}
      </>
    );
  }

  const [jobs, customAgents, scheduledRuns, umbrellas, assets] = await Promise.all([
    listJobs({ clientId: id }),
    listCustomAgents(),
    listPlannedScheduledRuns({ clientId: id }),
    listClientAgents({ clientId: id }),
    // Same reason as the client branch, and the same cost — see the note on that
    // call for what this read is and the cheaper shapes when it stops being fine.
    // Staff additionally keep every asset (no archive window), so this branch
    // scans the client's full history by construction.
    listAssets({ clientId: id }),
  ]);
  // The staff list, and the only one. It carries the SAME binding filter as the
  // client branch above: a per-client instance runs an entry skill baked under
  // one client's lab folder, so offering it here would build a run both submit
  // cores refuse. A second unfiltered list was exactly how that regressed.
  const enabledAgents = customAgents
    .filter((a) => a.enabled && agentKeyMatchesClientSlug(a.key, client.agentsRepoSlug))
    .map(toSummary);

  // (The jobPreviews block that used to live here fed <ManagedProducts />,
  // which nothing imported — it read every managed asset for this client on
  // every page load and handed the result to no one. Removed with F39/F45.
  // origin/main rebuilt it in the same shape and likewise passes it to nobody,
  // so it stays removed: it is one getAsset per managed deliverable per page
  // load, for a value with no reader.)

  // No `intakePanes` here any more, and no listContextItems: both fed the run
  // DIALOG, and CD-I1 moved every staff run gesture to the agent detail page.
  // The roster asks buildAgentSetup for readiness alone — which is what its
  // status word needs — and the detail route builds the panes for the one
  // agent it is about, rather than this page building them for all of them
  // (three full reads of seats, intake, drops and run history, per agent, for
  // a dialog that is no longer on this page).
  const agentSetup = await buildAgentSetup(id, enabledAgents);
  const staffRuns = toRunRows(jobs, true, umbrellas);
  const staffScheduleRows = toScheduleRows(scheduledRuns, false);

  const boundAgentIds = new Set(umbrellas.map((u) => u.customAgentId));
  const bindable = customAgents
    .filter((a) => a.enabled && !boundAgentIds.has(a.id))
    .map((a) => ({ id: a.id, name: a.name }));
  const launchInFlight = umbrellas.some((u) => isLaunchInFlight(u.launchState));
  const nothingToShow = enabledAgents.length === 0 && staffRuns.length === 0;

  // ── The staff roster (CD-I1) ──
  // The same roster + detail model the client has, for the same reason Albert
  // gave for the client's: "they can just click on it, and then it opens… over
  // the whole page." Staff were the only audience still meeting an agent as a
  // card that carried four controls and a status line, which meant the two
  // audiences read the same agent on two different surfaces — and every fix to
  // one had to be remembered for the other.
  //
  // Built from the AGENT list, not the umbrellas: an unbound agent is not
  // missing from a staff roster, it is an agent nobody has set up yet, and the
  // page it opens is where it gets set up.
  const staffUmbrellaByAgentId = new Map(umbrellas.map((u) => [u.customAgentId, u]));
  const staffScheduleByAgentId = new Map(staffScheduleRows.map((row) => [row.agentId, row]));
  // The clock the refusal window is measured against — resolved once for the
  // whole roster so every card ages a refusal from the same instant.
  // eslint-disable-next-line react-hooks/purity -- server component, no re-render concern
  const staffNow = Date.now();
  // Same delivered-work read the client branch makes, through the same function,
  // so the two rosters cannot call one agent "Not set up yet" and the other
  // "Runs on request". `viewerIsClient: false` keeps every asset in scope —
  // staff lose nothing to the client archive window, and the lab imports the
  // job-only join could not see are now in scope for them too.
  const staffAgentIdByName = new Map(customAgents.map((a) => [a.name, a.id]));
  const staffDeliveredAgentIds = agentsWithDeliveredWork({
    assets,
    jobs,
    agents: enabledAgents,
    umbrellas,
    clientSlug: client.agentsRepoSlug,
    viewerIsClient: false,
    now: staffNow,
  });
  // Same failed-last-run read the client branch makes, for the same reason: the
  // two rosters must not disagree about whether an agent needs someone.
  const staffFailedAgentIds = lastRunFailedAgentIds(jobs, staffAgentIdByName, { staff: true });
  // Drafts waiting on staff, per agent — the queue the retired card surfaced
  // as its "N ready" chip. Counted from the jobs already loaded.
  const reviewCountByAgentName = new Map<string, number>();
  for (const job of jobs) {
    if (job.external?.taskType !== "custom" || job.status !== "review") continue;
    if (job.assetIds.length === 0) continue;
    reviewCountByAgentName.set(
      job.agentName,
      (reviewCountByAgentName.get(job.agentName) ?? 0) + job.assetIds.length,
    );
  }
  const staffRosterEntries: AgentRosterEntry[] = enabledAgents.map((agent) => {
    const umbrella = staffUmbrellaByAgentId.get(agent.id) ?? null;
    const schedule = staffScheduleByAgentId.get(agent.id) ?? null;
    const review = reviewCountByAgentName.get(agent.name) ?? 0;
    const setup = agentSetup[agent.id] ?? null;
    // One line of operator state, so the roster still answers "which of these
    // needs me" without becoming a control panel again. Highest-priority fact
    // only — the detail page carries the full ladder.
    const note =
      review > 0
        ? `${review} draft${review === 1 ? "" : "s"} waiting for review`
        : setup && !setup.ready
          ? `${setup.label} is still empty`
          : schedule
            ? `${schedule.postsPerWeek} run${schedule.postsPerWeek === 1 ? "" : "s"}/week · ${schedule.outputsPerRun} output${schedule.outputsPerRun === 1 ? "" : "s"} each`
            : null;
    return {
      customAgentId: agent.id,
      identity: `${agent.key} ${agent.name}`,
      icon: agent.icon ?? null,
      displayName: umbrella?.displayName ?? agent.name,
      blurb: clientAgentBlurb({
        key: agent.key,
        name: agent.name,
        clientBlurb: agent.clientBlurb ?? null,
      }),
      status: rosterStatus({
        launchState: umbrella?.launchState ?? null,
        scheduleRefusal: schedule?.status === "active" ? schedule.lastError : null,
        scheduleRefusalAt: schedule?.lastErrorAt ?? null,
        scheduleActive: schedule?.status === "active",
        hasDelivered: staffDeliveredAgentIds.has(agent.id),
        lastRunFailed: staffFailedAgentIds.has(agent.id),
        now: staffNow,
      }),
      note,
    };
  });

  return (
    <>
      <PageHeader
        title="AI Agents"
        description="Run custom AI agents for this client and track their deliverables."
        action={
          <div className="flex items-center gap-3">
            {isLabOutputsConfigured() && <LabImportButton clientId={id} />}
            <BulkUploadClips clientId={id} bucketName={process.env.GCS_MEDIA_BUCKET} />
            <ReplanCalendarButton clientId={id} />
            <a
              href={`/clients/${id}/settings?tab=channels`}
              className="inline-flex items-center gap-1.5 text-xs text-muted hover:text-foreground"
            >
              Manage integrations →
            </a>
          </div>
        }
      />
      {/* The outage notice, on the STAFF branch too. It was mounted only for
          clients, so an operator opened a roster of enabled Run controls with
          nothing anywhere on the page saying the service was down — they found
          out by pressing one. Same banner, staff wording: they are the people
          who clear it, so it names the cause rather than promising a call. */}
      {enabledAgents.length > 0 && !agentServiceConfigured && (
        <p className="mb-4 rounded-[var(--radius)] border border-warning/30 bg-warning/10 px-4 py-3 text-sm text-warning">
          <Icon name="TriangleAlert" className="mr-1.5 inline h-4 w-4" />
          Agent runs are paused — the agent-service environment is not configured, so submitting a
          run will fail until it is set. Schedules, history and deliverables below are unaffected.
        </p>
      )}
      {/* An unconfigured service must NOT hide the roster. F34's banner says
          "everything below is unaffected", and replacing the whole grid with an
          empty state made that a lie — the client's agents, their schedules and
          their run history simply vanished. The banner carries the outage; the
          roster stays, and the run controls on each agent's page are disabled by
          the same readiness gate that already handles setup and credits. */}
      {nothingToShow && !agentServiceConfigured ? (
        <EmptyState
          icon={<Icon name="Bot" className="h-7 w-7" />}
          title="Agent service not configured"
          description="Run controls are unavailable until the agent-service environment variables are set. Existing deliverables and calendars above are unaffected."
        />
      ) : nothingToShow ? (
        <EmptyState
          icon={<Icon name="Bot" className="h-7 w-7" />}
          title="No agents available for this client yet"
          description={
            client.agentsRepoSlug
              ? "No custom agent in the library is enabled, so there is nothing to run here. Import or enable one on the Agents page."
              : // The slug field is NOT on this client's settings page — it only
                // exists in the Edit dialog on the Clients page, which no link can
                // open. So the sentence says where it is and there is no button
                // promising to take you there.
                "No custom agent in the library is enabled, so there is nothing to run here. Import or enable one on the Agents page — and set this client's lab repo slug in its Edit dialog on the Clients page, or runs go out without their client context."
          }
          action={
            <a href="/agents" className="text-xs text-neon hover:underline">
              Import or enable an agent →
            </a>
          }
        />
      ) : (
        <>
          {(launchInFlight ||
            staffRuns.some((run) => run.status === "queued" || run.status === "running")) && (
            <AutoRefresh />
          )}
          {/* The bind control is roster-level: it answers "which agents does
              this client have", which is exactly the question the roster asks.
              Everything else that used to sit beside it — the launch card, the
              live card, the curation pane, the economics — is on the agent's
              own page now, next to the agent it describes. */}
          <div className="mt-5 flex flex-wrap items-center justify-between gap-2 sm:mt-6">
            <h2 className="text-sm text-muted">Agent setup</h2>
            {bindable.length > 0 && <BindAgentControl clientId={id} agents={bindable} />}
          </div>
          {staffRosterEntries.length > 0 && (
            <ClientAgentRoster clientId={id} entries={staffRosterEntries} />
          )}
          {/* Kept whole, and kept HERE: this is the cross-agent history staff
              had before, and per-agent pages alone would have lost it. Each
              agent's page carries its own slice of the same list. */}
          {staffRuns.length > 0 && (
            <div className="mt-6 sm:mt-8">
              <AgentRunHistory runs={staffRuns} agents={enabledAgents} />
            </div>
          )}
        </>
      )}
    </>
  );
}
