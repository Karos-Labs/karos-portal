import { redirect } from "next/navigation";
import { requireUser, requireVisibleClient } from "@/lib/auth";
import {
  listAssets,
  listCustomAgents,
  listJobs,
  listPlannedScheduledRuns,
  listScheduledRuns,
} from "@/lib/data";
import { Badge, EmptyState, PageHeader } from "@/components/ui";
import { MoreActionsMenu } from "@/components/more-actions-menu";
import { Icon } from "@/components/icon";
import { AgentRunHistory } from "@/components/custom-agents";
import { AutoRefresh } from "@/components/auto-refresh";
import { ReplanCalendarButton } from "@/components/replan-calendar-button";
import { LabImportButton } from "@/components/lab-import";
import { MediaUploadButton } from "@/components/media-upload";
import { isAgentServiceConfigured } from "@/lib/agent-service/client";
import { shouldShowEngineHealthBanner } from "@/lib/agent-engine/health";
import { EngineHealthBanner } from "@/components/engine-health-banner";
import {
  agentKeyMatchesClientSlug,
  isUnlistedAgent,
} from "@/lib/custom-agent-launch";
import { isLabOutputsConfigured } from "@/lib/lab-outputs";
import { clientAgentBlurb } from "@/lib/agent-blurbs";
import { selectAgentSchedules } from "@/lib/agent-schedule-selection";
import { listClientAgents } from "@/lib/data-client-agents";
import { isLaunchInFlight, lastRunFailedAgentIds, rosterStatus } from "@/lib/client-agents";
import { agentsWithDeliveredWork, agentsWithUpcomingContent } from "@/lib/agent-detail-archetypes";
import { umbrellaOwnsClientCard } from "@/lib/client-agent-runs";
import { BindAgentControl } from "@/components/client-agents/client-agents-section";
import { StaffOnlySection } from "@/components/staff-only-section";
import { ClientAgentRoster, type AgentRosterEntry } from "@/components/client-agents/roster";
import {
  bindableAgents,
  buildAgentSetup,
  hasActiveTemplateRun,
  toRunRows,
  toScheduleRows,
  toSummary,
} from "@/lib/client-agent-rows";



/**
 * The ONE sentence under "AI agents", for whoever is reading (parity pass
 * 2026-09).
 *
 * The staff branch used to print "Run custom AI agents for this client and
 * track their deliverables" — an operator's description of the machinery — so
 * an account manager previewing a client's workspace read a header that client
 * never sees. The product owner's ruling is that staff read the CLIENT's page
 * and that staff extras are additive, marked blocks; a header sentence is not
 * an extra, it is the shared one. Hoisted to a const so the two branches cannot
 * drift apart again the way they did.
 */
const AGENTS_PAGE_DESCRIPTION =
  "Your always-on AI team. Open an agent to see what it makes and to start a post.";

/**
 * A client's AI agents page. Clients can run only the custom agents that an
 * admin granted them; staff can run every enabled custom agent. Neither list
 * may include a per-client agent instance belonging to a different client -
 * its skill is baked under that client's lab folder, so a run here would draft
 * the wrong company. Both branches filter on agentKeyMatchesClientSlug — as
 * does the staff bind dropdown, through bindableAgents (#131) — and the submit
 * core refuses a mismatched pair regardless of how it was launched.
 */
export default async function ClientAgentsPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  const { id } = await params;

  if (user.role === "CLIENT_USER") {
    if (user.clientId !== id) redirect(user.clientId ? `/clients/${user.clientId}` : "/assets");
  } else if (user.role !== "KAROS_ADMIN" && user.role !== "KAROS_EMPLOYEE") {
    redirect("/dashboard");
  }

  const client = await requireVisibleClient(user, id);

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
    //
    // No getClientCredits here either, and for the same reason: the spend gate
    // it fed (#130) belonged to run controls that live on the agent's own page
    // now. This roster quotes no price and offers no press, so it does not pay
    // for the balance.
    const [allAgents, jobs, scheduledRuns, umbrellas, assets] = await Promise.all([
      listCustomAgents(),
      listJobs({ clientId: id }),
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
    // The clock the delivered-work read and every roster entry's refusal window
    // age against — resolved once so the whole page agrees. (It used to roll the
    // credit spend windows too; that read left with #130.)
    // eslint-disable-next-line react-hooks/purity -- server component, no re-render concern
    const now = Date.now();
    // Every agent that could ever appear on this roster: enabled, and bound to
    // this client. The binding wins over both routes in below — a grant and an
    // inherited delivered run are equally unable to move an instance off its
    // client — so it is applied before anything else can widen the list.
    const candidateAgents = allAgents.filter(
      (agent) =>
        agent.enabled &&
        // A step of another agent is never its own card — the LinkedIn setup and
        // manager are fired by the LinkedIn agent's own surface. Structural, off
        // the document's parentKey.
        !isUnlistedAgent(agent) &&
        agentKeyMatchesClientSlug(agent.key, client.agentsRepoSlug),
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
    // AF-5. The third half of the same read: which agents have content sitting on
    // this client's calendar for a day that has not happened. It reads the assets
    // already in hand (no extra query) and returns ids only, so what reaches this
    // page is one boolean per agent and nothing about the items themselves.
    const producingAgentIds = agentsWithUpcomingContent({
      assets,
      jobs,
      agents: candidateAgents,
      umbrellas,
      clientSlug: client.agentsRepoSlug,
      now,
    });
    const agents = candidateAgents
      .filter((agent) => allowedIds.has(agent.id) || completedAgentIds.has(agent.id))
      .map(toSummary);
    // A8 (parity pass 2026-09). NEITHER roster branch passed `readyToRun`, so a
    // configured agent that had simply never been asked yet read "Not set up
    // yet" on its card and "Runs on request" on the page that card opens — the
    // one state where the phrase is actively wrong, because the reader HAS
    // finished setting it up. Resolved through the same `buildAgentSetup` the
    // detail route and the staff branch below use, so the three surfaces answer
    // readiness off one object rather than three derivations. No panes: those
    // belong to the run dialog, which is not on this page for either role.
    const clientAgentSetup = await buildAgentSetup(id, agents);
    // Paused agents stay ON the roster as their own card, badged "Coming Soon"
    // (rosterStatus's enabled:false short-circuit), rather than vanishing and
    // leaving the client wondering where an agent they were told about went.
    // Kept OUT of `agents` above: they never enter the interactive
    // umbrella/credit/setup pipeline, so there is no Run or launch affordance
    // to gate. Delivered-work is asked of the SAME shared join, over the
    // disabled set — `candidateAgents` filters on enabled, so the main
    // completedAgentIds cannot answer for these.
    const disabledBound = allAgents.filter(
      (agent) =>
        !agent.enabled &&
        !isUnlistedAgent(agent) &&
        agentKeyMatchesClientSlug(agent.key, client.agentsRepoSlug),
    );
    const disabledDeliveredIds = agentsWithDeliveredWork({
      assets,
      jobs,
      agents: disabledBound,
      umbrellas,
      clientSlug: client.agentsRepoSlug,
      viewerIsClient: true,
      now,
    });
    const disabledAgents = disabledBound
      .filter((agent) => allowedIds.has(agent.id) || disabledDeliveredIds.has(agent.id))
      .map(toSummary);
    // ── Card selection: exactly one card per agent ──
    // An umbrella owns its agent's card as soon as it is bound - the launch
    // card while it is being set up, the live card once it is producing. The
    // agent is dropped from the generic run cards below, so a client is never
    // offered a Run button beside a "not set up yet" state, and never sees the
    // same agent twice under two identities.
    //
    // The one exception is deliberate (`umbrellaOwnsClientCard`): a LIVE
    // umbrella with no templates yet - the grandfathered bind of an
    // already-producing agent - keeps today's card, because replacing a working
    // Run button with a card that has no rows in it is the F131 failure with
    // the roles reversed.
    const ownedByUmbrella = umbrellas.filter((u) => umbrellaOwnsClientCard(u));
    const ownedAgentIds = new Set(ownedByUmbrella.map((u) => u.customAgentId));
    const runnableAgents = agents.filter((agent) => !ownedAgentIds.has(agent.id));
    // Client viewers see only runs of agents they're allowed - not the history
    // of staff-fired agents outside their allowlist, and (§4.1 item 3) not the
    // batch rows of an umbrella-owned agent: "ran 2 hours ago · 7 drafts" beside
    // a week of daily slots is the tell that the days are a presentation of a
    // batch. Staff rows are unchanged.
    const runnableNames = new Set(runnableAgents.map((a) => a.name));
    // Still filtered on the STORED name (that is the join to the runnable set);
    // what each row prints is its resolved §7.3 identity (F147).
    const runs = toRunRows(jobs, false, umbrellas).filter((r) => runnableNames.has(r.agentName));
    const clientScheduleRows = toScheduleRows(scheduledRuns, true);
    // A client run takes 10–20 minutes and the client's rows carry no link, so
    // without this the page never moved again after "Start run". Mounted only
    // while something is actually in flight; it unmounts when the server
    // renders a terminal status. A setup run in flight moves the launch card
    // the same way — it is the same medicine for a longer wait.
    //
    // The third clause used to be `clientAgentRows.some(row => row.activeRun
    // !== null)` — the whole card projection, awaited for one boolean and then
    // thrown away (#130). This branch renders no card at all: it renders the
    // CD-G1 roster below, whose entries carry a mark, a name, a blurb and a
    // status word, and not one of them comes from that projection — the week
    // strip, the template gates, today's option texts and the feedback list
    // belong to the agent's own page. `hasActiveTemplateRun` asks the same
    // question of the same two lists, both already in hand, with no query.
    const runInFlight =
      runs.some((run) => run.status === "queued" || run.status === "running") ||
      umbrellas.some((u) => isLaunchInFlight(u.launchState)) ||
      // An umbrella agent has no run row to watch any more, so its in-flight
      // template run has to be what moves the page.
      hasActiveTemplateRun({
        umbrellas: ownedByUmbrella,
        agentsById: new Map(allAgents.map((a) => [a.id, a])),
        jobs,
        viewerIsClient: true,
        viewerUid: user.uid,
      });
    // ── The roster (CD-G1) ──
    // One card per GRANTED agent, umbrella-bound or not, carrying a mark, a
    // name, one line of what it gives you and one status word. No Run button
    // anywhere: a client's run gesture lives only inside a detail page, beside
    // the context that explains what it costs and produces.
    //
    // Built from the agent list rather than from the umbrellas, because a
    // client's roster is "the agents I have", not "the agents someone has bound
    // an umbrella for". An agent with no umbrella is not missing from the
    // roster - it is simply not set up yet, and says so.
    const umbrellaByAgentId = new Map(ownedByUmbrella.map((u) => [u.customAgentId, u]));
    const scheduleByAgentId = new Map(clientScheduleRows.map((row) => [row.agentId, row]));
    const rosterEntries: AgentRosterEntry[] = agents.map((agent) => {
      const umbrella = umbrellaByAgentId.get(agent.id) ?? null;
      const schedule = scheduleByAgentId.get(agent.id) ?? null;
      const setup = clientAgentSetup[agent.id] ?? null;
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
          // Already client-redacted by toScheduleRows, and passed RAW: a
          // refusal outranks "Live" (F24/F129), but WHEN it stops counting —
          // aged out, or answered by a pause — is `rosterStatus`'s rule, not
          // this page's. The `status === "active" ? … : null` that used to sit
          // here was the same rule written at each of three call sites.
          scheduleRefusal: schedule?.lastError ?? null,
          scheduleRefusalAt: schedule?.lastErrorAt ?? null,
          scheduleActive: schedule?.status === "active",
          // "Not set up yet" beside a shelf of delivered work is the card
          // contradicting itself; an agent that has produced says so instead.
          hasDelivered: completedAgentIds.has(agent.id),
          // A8: the second readiness proof, the same conjunction the detail
          // page passes. Omitted (not `false`) when this agent runs on no
          // intake — `rosterStatus` reads absent as "do not know", and an
          // unknown must not read as ready.
          ...(setup ? { readyToRun: setup.ready && setup.standUpDone } : {}),
          // Resolved, and then deliberately not acted on: `viewerIsStaff` is
          // false on this branch, so the rung is skipped (AF-14). The value is
          // still passed rather than dropped, because the flag is what decides
          // and a caller that stopped computing it would hide the decision.
          lastRunFailed: failedAgentIds.has(agent.id),
          viewerIsStaff: false,
          // AF-5: an agent whose posts we produce internally has no schedule of
          // its own to read Live from, and the client can see its work filling
          // next week's calendar. The staff note the rung also returns is not
          // painted here — this is the client's roster.
          hasUpcomingContent: producingAgentIds.has(agent.id),
          now,
        }),
      };
    });
    // Paused agents ride the SAME card component, just with rosterStatus's
    // enabled:false short-circuit (-> "Coming Soon", every other input moot).
    const disabledRosterEntries: AgentRosterEntry[] = disabledAgents.map((agent) => ({
      customAgentId: agent.id,
      identity: `${agent.key} ${agent.name}`,
      icon: agent.icon ?? null,
      displayName: agent.name,
      blurb: clientAgentBlurb({ key: agent.key, name: agent.name, clientBlurb: agent.clientBlurb ?? null }),
      status: rosterStatus({ launchState: null, enabled: false }),
    }));
    const allRosterEntries = [...rosterEntries, ...disabledRosterEntries];

    return (
      <>
        {runInFlight && <AutoRefresh />}
        {/* The section below used to repeat this heading and tagline almost
            verbatim ("active AI team" / "always-on AI team"), one in Title Case
            and one in sentence case. This is the surviving one. */}
        <PageHeader title="AI agents" description={AGENTS_PAGE_DESCRIPTION} />
        {/* Two different conditions used to share the never-set-up empty state,
            so an outage or a bad deploy told a client with three live agents
            and a run history that they had never been set up. Only an empty
            allowlist gets that copy now; an unconfigured service keeps the
            agents, schedules and history on screen behind an honest notice. */}
        {agents.length > 0 && !agentServiceConfigured && (
          <p className="mb-4 rounded-[var(--radius)] border border-warning/30 bg-warning/10 px-4 py-3 text-sm text-warning">
            <Icon name="TriangleAlert" className="mr-1.5 inline h-4 w-4" />
            Agent runs are paused right now. Starting a new run will not work until this clears.
            Contact your Karos team if you need a run today. Everything below is unaffected.
          </p>
        )}
        {/* SCRUM-264: a client cut over to agent-engine got no warning of any
            kind when it broke - agentServiceConfigured above has nothing to
            say about it, since these runs never touch agent-service. */}
        {shouldShowEngineHealthBanner(client.agentsRepoSlug, agents.map((a) => a.key)) && (
          <EngineHealthBanner viewerIsClient />
        )}
        {allRosterEntries.length > 0 ? (
          <ClientAgentRoster clientId={id} entries={allRosterEntries} />
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

  const [jobs, customAgents, scheduledRuns, legacyScheduledRuns, umbrellas, assets] = await Promise.all([
    listJobs({ clientId: id }),
    listCustomAgents(),
    listPlannedScheduledRuns({ clientId: id }),
    // THE OTHER SCHEDULING SYSTEM. `scheduledRuns` (the legacy collection, fired
    // by /api/scheduler) writes to its own docs, submits with `charge: null`, and
    // is created from — and until now listed only on — the client's settings
    // card. So a second recurring generator could be pointed at an agent while
    // this page, the page staff come to to ask "what is this agent doing",
    // showed no sign of it. Read here to say so; nothing on this page can
    // create, edit or fire one.
    listScheduledRuns({ clientId: id }),
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
    .filter(
      (a) =>
        a.enabled &&
        !isUnlistedAgent(a) &&
        agentKeyMatchesClientSlug(a.key, client.agentsRepoSlug),
    )
    .map(toSummary);
  // Paused agents stay ON the roster too (same reasoning as the client branch
  // above) rather than just disappearing from the operator's view the moment
  // they're toggled off - an admin needs to see it's actually there, paused,
  // not wonder if the toggle silently deleted it.
  const disabledStaffAgents = customAgents
    .filter(
      (a) =>
        !a.enabled &&
        !isUnlistedAgent(a) &&
        agentKeyMatchesClientSlug(a.key, client.agentsRepoSlug),
    )
    .map(toSummary);

  // (The jobPreviews block that used to live here fed <ManagedProducts />,
  // which nothing imported - it read every managed asset for this client on
  // every page load and handed the result to no one. Removed with F39/F45.
  // origin/main rebuilt it in the same shape and likewise passes it to nobody,
  // so it stays removed: it is one getAsset per managed deliverable per page
  // load, for a value with no reader.)

  // No `intakePanes` here any more, and no listContextItems: both fed the run
  // DIALOG, and CD-I1 moved every staff run gesture to the agent detail page.
  // The roster asks buildAgentSetup for readiness alone - which is what its
  // status word needs - and the detail route builds the panes for the one
  // agent it is about, rather than this page building them for all of them
  // (three full reads of seats, intake, drops and run history, per agent, for
  // a dialog that is no longer on this page).
  const agentSetup = await buildAgentSetup(id, enabledAgents);
  const staffRuns = toRunRows(jobs, true, umbrellas);
  const staffScheduleRows = toScheduleRows(scheduledRuns, false);

  const boundAgentIds = new Set(umbrellas.map((u) => u.customAgentId));
  // THE BINDING FILTER BELONGS HERE TOO (#131). This list used to ask only
  // "enabled, and not already bound", which offered per-client instances baked
  // under ANOTHER client's lab folder — the very agents the roster rendered
  // directly below it had already dropped, and the very pair
  // `bindClientAgentAction` refuses outright. Two lists on one screen disagreed
  // about which agents exist for this client, and choosing the extra one
  // returned an error paragraph and wrote nothing. `bindableAgents` asks the
  // same `agentKeyMatchesClientSlug` question the action does, so the dropdown
  // cannot offer what the action refuses.
  const bindable = bindableAgents({
    agents: customAgents,
    clientSlug: client.agentsRepoSlug,
    boundAgentIds,
  });
  const launchInFlight = umbrellas.some((u) => isLaunchInFlight(u.launchState));
  const nothingToShow =
    enabledAgents.length === 0 && disabledStaffAgents.length === 0 && staffRuns.length === 0;

  // ── The staff roster (CD-I1) ──
  // The same roster + detail model the client has, for the same reason Albert
  // gave for the client's: "they can just click on it, and then it opens… over
  // the whole page." Staff were the only audience still meeting an agent as a
  // card that carried four controls and a status line, which meant the two
  // audiences read the same agent on two different surfaces - and every fix to
  // one had to be remembered for the other.
  //
  // Built from the AGENT list, not the umbrellas: an unbound agent is not
  // missing from a staff roster, it is an agent nobody has set up yet, and the
  // page it opens is where it gets set up.
  const staffUmbrellaByAgentId = new Map(umbrellas.map((u) => [u.customAgentId, u]));
  const staffScheduleByAgentId = new Map(staffScheduleRows.map((row) => [row.agentId, row]));
  // The rows `toScheduleRows` did NOT pick. It returns one governing row per
  // agent (see selectAgentSchedules) — which is what stops two surfaces showing
  // two different schedules — so without this the extras would simply be gone
  // from staff's view as well as the client's, and the point of picking one is
  // that somebody is told there were two.
  const staffScheduleSelection = selectAgentSchedules(scheduledRuns);
  // The legacy generator, indexed by the agent it fires. Its rows key the agent
  // on `agentId` (the planned rows use `customAgentId`) — same collection of
  // custom agents, different field name.
  const legacyByAgentId = new Map<string, typeof legacyScheduledRuns>();
  for (const run of legacyScheduledRuns) {
    const bucket = legacyByAgentId.get(run.agentId);
    if (bucket) bucket.push(run);
    else legacyByAgentId.set(run.agentId, [run]);
  }
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
  // AF-5, and deliberately the SAME call the client branch makes — no viewer
  // argument. The word is the client-facing one by ruling, so a staff roster that
  // asked a staff-flavoured version of the question would call an agent idle on
  // one screen and live on the other. What staff get extra is the note below.
  const staffProducingAgentIds = agentsWithUpcomingContent({
    assets,
    jobs,
    agents: enabledAgents,
    umbrellas,
    clientSlug: client.agentsRepoSlug,
    now: staffNow,
  });
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
  // A4 (parity pass 2026-09). The staff roster is a SUPERSET of the client's —
  // every enabled bound agent, granted or not — and nothing on it said which
  // cards the client would actually see. An operator previewing an account read
  // a fuller grid as if it were the client's own. The set is kept (staff need
  // to see what is available to grant) and each extra card now says so.
  const grantedAgentIds = new Set(client.customAgentIds ?? []);
  const staffRosterEntries: AgentRosterEntry[] = enabledAgents.map((agent) => {
    const umbrella = staffUmbrellaByAgentId.get(agent.id) ?? null;
    const schedule = staffScheduleByAgentId.get(agent.id) ?? null;
    const review = reviewCountByAgentName.get(agent.name) ?? 0;
    const setup = agentSetup[agent.id] ?? null;
    // One line of operator state, so the roster still answers "which of these
    // needs me" without becoming a control panel again. Highest-priority fact
    // only — the detail page carries the full ladder.
    //
    // A DUPLICATE SCHEDULE OUTRANKS ALL OF IT. Two live rows for one client and
    // one agent is not a state anyone chose: nothing refuses to create the
    // second, every surface renders only the one `selectAgentSchedules` picks,
    // and the other keeps firing and billing where nobody can see or pause it.
    // Ranked above the review queue because a queue is work and this is a
    // defect that produced some of it.
    const extraSchedules = staffScheduleSelection.get(agent.id)?.duplicates.length ?? 0;
    const note =
      extraSchedules > 0
        ? `${extraSchedules + 1} schedules for this agent. Only the next to fire is shown here or editable`
        : review > 0
          ? `${review} draft${review === 1 ? "" : "s"} waiting for review`
          : setup && !setup.ready
            ? `${setup.label} is still empty`
            : schedule
              ? `${schedule.postsPerWeek} run${schedule.postsPerWeek === 1 ? "" : "s"}/week · ${schedule.outputsPerRun} output${schedule.outputsPerRun === 1 ? "" : "s"} each`
              : null;
    // APPENDED, NOT RANKED. The legacy generator is a different fact from every
    // rung above — it names a SECOND system firing this agent, not a competing
    // status — so ranking it would mean either hiding it behind a review count
    // or hiding the review count behind it. It says "not billed" out loud
    // because that is the whole reason it is easy to forget: its fires cost the
    // client nothing, appear in no credit ledger, and still spend real money at
    // the model.
    const legacy = legacyByAgentId.get(agent.id) ?? [];
    const legacyNote =
      legacy.length > 0
        ? `${legacy.length} settings-page schedule${legacy.length === 1 ? "" : "s"} (${legacy.filter((r) => r.enabled).length} on). Not billed to the client`
        : null;
    const status = rosterStatus({
      launchState: umbrella?.launchState ?? null,
      // Raw refusal + raw status — the pause and freshness rules are the
      // helper's (see the client branch above).
      scheduleRefusal: schedule?.lastError ?? null,
      scheduleRefusalAt: schedule?.lastErrorAt ?? null,
      scheduleActive: schedule?.status === "active",
      hasDelivered: staffDeliveredAgentIds.has(agent.id),
      lastRunFailed: staffFailedAgentIds.has(agent.id),
      // The rung the client's branch skips. This is the surface it was written
      // for: a green badge above a run history whose last row reads Failed.
      viewerIsStaff: true,
      hasUpcomingContent: staffProducingAgentIds.has(agent.id),
      now: staffNow,
    });
    // LEADS the note (AF-5). When the badge says Live and the schedule row under
    // it says nothing is firing, "why" is the first question an operator has —
    // ahead of a review queue or a duplicate-schedule warning, both of which are
    // still true and still appended. `status.staffNote` is set only on the rung
    // that creates the discrepancy, so on every other agent this line adds
    // nothing.
    const fullNote =
      [status.staffNote ?? null, note, legacyNote].filter(Boolean).join(" · ") || null;
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
      status,
      note: fullNote,
      // A4. Not a status word — the agent's status is whatever it is — but a
      // fact about THIS client's view of it, which is why it is its own flag
      // and its own neutral badge rather than another `rosterStatus` rung.
      notGranted: !grantedAgentIds.has(agent.id),
    };
  });
  // Same enabled:false short-circuit as the client branch - every other
  // rosterStatus input is moot once an agent is paused.
  const disabledStaffRosterEntries: AgentRosterEntry[] = disabledStaffAgents.map((agent) => ({
    customAgentId: agent.id,
    identity: `${agent.key} ${agent.name}`,
    icon: agent.icon ?? null,
    displayName: agent.name,
    blurb: clientAgentBlurb({ key: agent.key, name: agent.name, clientBlurb: agent.clientBlurb ?? null }),
    status: rosterStatus({ launchState: null, enabled: false }),
    notGranted: !grantedAgentIds.has(agent.id),
  }));
  const allStaffRosterEntries = [...staffRosterEntries, ...disabledStaffRosterEntries];

  return (
    <>
      {/* Sentence case, matching the client branch above and every nav label
          that leads here — the rail's item and the staff shell's client-context
          twin. One route rendered two headings and the label disagreed with
          both (#141); this is the one spelling. The DESCRIPTION is now shared
          outright (AGENTS_PAGE_DESCRIPTION) for the same reason one level up.

          EVERY STAFF ERRAND BEHIND ONE TRIGGER (parity pass 2026-09).

          A previous pass had already folded three of the four controls into a
          menu and left "Bulk upload clips" out as the primary. That is still
          one button more than the client's header has, and the client's header
          is the one both roles are supposed to read: a primary button beside
          the title changes the shape of the row, not just its contents. So the
          media upload joins the others and the trigger names what the whole
          group is — staff tools — rather than the neutral "More actions",
          which said nothing about who the menu is for.

          Nothing is removed and nothing moves surface: the same four controls,
          one press further in. Running an agent happens on the roster cards
          below and binding one happens in the staff-only block under them, so
          none of these four was ever part of this page's journey anyway. */}
      <PageHeader
        title="AI agents"
        description={AGENTS_PAGE_DESCRIPTION}
        action={
          <MoreActionsMenu label="Staff tools">
            <MediaUploadButton clientId={id} bucketName={process.env.GCS_MEDIA_BUCKET} menuItem />
            {isLabOutputsConfigured() && <LabImportButton clientId={id} menuItem />}
            <ReplanCalendarButton clientId={id} menuItem />
            <a
              href={`/clients/${id}/settings?tab=settings`}
              className="inline-flex h-8 items-center gap-1.5 rounded-md px-3 text-xs text-muted transition-colors hover:bg-surface-2 hover:text-foreground"
            >
              <Icon name="Plug" className="h-3.5 w-3.5" />
              Manage integrations
            </a>
          </MoreActionsMenu>
        }
      />
      {/* The outage notice, on the STAFF branch too. It was mounted only for
          clients, so an operator opened a roster of enabled Run controls with
          nothing anywhere on the page saying the service was down - they found
          out by pressing one. Same banner, staff wording: they are the people
          who clear it, so it names the cause rather than promising a call. */}
      {enabledAgents.length > 0 && !agentServiceConfigured && (
        <p className="mb-4 rounded-[var(--radius)] border border-warning/30 bg-warning/10 px-4 py-3 text-sm text-warning">
          <Icon name="TriangleAlert" className="mr-1.5 inline h-4 w-4" />
          Agent runs are paused. The agent-service environment is not configured, so submitting a
          run will fail until it is set. Schedules, history and deliverables below are unaffected.
        </p>
      )}
      {/* SCRUM-264: agent-service's counterpart above has nothing to say about
          a client cut over to agent-engine - this roster showed enabled Run
          controls with no sign the engine's own transport was unconfigured.
          Only renders when THIS client actually routes through agent-engine
          (shouldShowEngineHealthBanner), so a client still fully on
          agent-service never sees it. */}
      {shouldShowEngineHealthBanner(client.agentsRepoSlug, enabledAgents.map((a) => a.key)) && (
        <EngineHealthBanner viewerIsClient={false} />
      )}
      {/* An unconfigured service must NOT hide the roster. F34's banner says
          "everything below is unaffected", and replacing the whole grid with an
          empty state made that a lie - the client's agents, their schedules and
          their run history simply vanished. The banner carries the outage; the
          roster stays, and the run controls on each agent's page are disabled by
          the same readiness gate that already handles setup and credits. */}
      {nothingToShow && !agentServiceConfigured ? (
        /* A6 (parity pass 2026-09). This state is entirely operator-facing —
           it names environment variables — and it stood in the client's empty
           slot styled exactly like the client's own empty state. It stays
           (staff are the people who clear it) but inside the shared staff
           frame, so nobody previewing this account mistakes it for what the
           client is being told. */
        <StaffOnlySection label="Staff only · agent service">
          <EmptyState
            icon={<Icon name="Bot" className="h-7 w-7" />}
            title="Agent service not configured"
            description="Run controls are unavailable until the agent-service environment variables are set. Existing deliverables and calendars above are unaffected."
          />
        </StaffOnlySection>
      ) : nothingToShow ? (
        /* A6. The client's own words for the same emptiness — their branch
           says "No active agents yet / After your Karos team completes the
           first agent run…", and a staff preview must read that, not a
           library-and-slug explanation in its place. The operator's way out
           survives as a marked secondary link UNDER it rather than as the
           primary action, because the primary action on this page belongs to
           whatever the client would be offered. */
        <EmptyState
          icon={<Icon name="Bot" className="h-7 w-7" />}
          title="No active agents yet"
          description="After your Karos team completes the first agent run, that agent will appear here."
          action={
            <span className="inline-flex flex-col items-center gap-1.5">
              <span className="inline-flex items-center gap-1.5">
                <Badge tone="neutral">Internal</Badge>
                <a href="/agents" className="text-xs text-muted hover:text-foreground hover:underline">
                  Import or enable an agent →
                </a>
              </span>
              {/* The slug field is NOT on this client's settings page — it only
                  exists in the Edit dialog on the Clients page, which no link
                  can open. So the sentence says where it is and there is no
                  button promising to take you there. */}
              {!client.agentsRepoSlug && (
                <span className="max-w-sm text-[11px] text-muted-2">
                  This client has no lab repo slug. Set it in the client&apos;s Edit dialog on the
                  Clients page, or runs go out without their client context.
                </span>
              )}
            </span>
          }
        />
      ) : (
        <>
          {(launchInFlight ||
            staffRuns.some((run) => run.status === "queued" || run.status === "running")) && (
            <AutoRefresh />
          )}
          {/* A3 (parity pass 2026-09): the roster starts at the same y as the
              client's. An "Agent setup" heading row sat above this grid for
              staff only, so the two rosters began 40px apart and a preview
              could not be compared with the real thing at a glance. The
              heading is gone and the bind control moved below, into the frame
              that says who it is for. */}
          {allStaffRosterEntries.length > 0 && (
            <ClientAgentRoster clientId={id} entries={allStaffRosterEntries} />
          )}
          {/* The bind control is roster-level: it answers "which agents does
              this client have", which is exactly the question the roster asks.
              Everything else that used to sit beside it - the launch card, the
              live card, the curation pane, the economics - is on the agent's
              own page now, next to the agent it describes. Below the grid and
              inside the staff frame (A3): it is additive, so it may not push
              the shared content down the page. */}
          {bindable.length > 0 && (
            <StaffOnlySection className="mt-6 sm:mt-8" label="Staff only · agent setup">
              <BindAgentControl clientId={id} agents={bindable} />
            </StaffOnlySection>
          )}
          {/* A7. Kept whole, and kept HERE: this is the cross-agent history
              staff had before, and per-agent pages alone would have lost it.
              Each agent's page carries its own slice of the same list. Framed,
              because the client's roster ends at the grid — every row here
              links to /jobs/<id>, which a client cannot open at all. */}
          {staffRuns.length > 0 && (
            <StaffOnlySection className="mt-6 sm:mt-8" label="Staff only · run history">
              <AgentRunHistory runs={staffRuns} agents={enabledAgents} />
            </StaffOnlySection>
          )}
        </>
      )}
    </>
  );
}
