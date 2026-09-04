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
import { ContactUsButton } from "@/components/contact-us-modal";
import { Icon } from "@/components/icon";
import { AgentRunHistory } from "@/components/custom-agents";
import { AutoRefresh } from "@/components/auto-refresh";
import { ReplanCalendarButton } from "@/components/replan-calendar-button";
import { LabImportButton } from "@/components/lab-import";
import { MediaUploadButton } from "@/components/media-upload";
import { isAgentServiceConfigured } from "@/lib/agent-service/client";
import { shouldShowEngineHealthBanner } from "@/lib/agent-engine/health";
import { EngineHealthBanner } from "@/components/engine-health-banner";
import { RunsPausedNotice } from "@/components/runs-paused-notice";
import {
  agentKeyMatchesClientSlug,
  isUnlistedAgent,
} from "@/lib/custom-agent-launch";
import { isLabOutputsConfigured } from "@/lib/lab-outputs";
import { listClientAgents } from "@/lib/data-client-agents";
import { isLaunchInFlight } from "@/lib/client-agents";
import { umbrellaOwnsClientCard } from "@/lib/client-agent-runs";
import { BindAgentControl } from "@/components/client-agents/client-agents-section";
import { StaffOnlySection } from "@/components/staff-only-section";
import { ClientAgentRoster } from "@/components/client-agents/roster";
import { buildClientRosterEntries } from "@/lib/client-roster";
import { TaskKickoffStrip } from "@/components/client-agents/task-kickoff-strip";
import { buildTaskKickoffView } from "@/lib/task-kickoff";
import {
  bindableAgents,
  hasActiveTemplateRun,
  toRunRows,
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
export default async function ClientAgentsPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  /**
   * `task` — Home's recommended-task press for a task that names no single
   * custom agent (portal feedback round 2, 2026-09): a managed product has no
   * page of its own, so the roster is where the client lands. The kickoff strip
   * sits above the roster and carries the same Start / Not for us / Later it
   * carries on an agent's own page. Validated in lib/task-kickoff.ts.
   */
  searchParams: Promise<{ task?: string }>;
}) {
  const user = await requireUser();
  const { id } = await params;
  const { task: kickoffTaskId } = await searchParams;

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
    // The clock the delivered-work read and every roster entry's refusal window
    // age against — resolved once so the whole page agrees. (It used to roll the
    // credit spend windows too; that read left with #130.)
    // eslint-disable-next-line react-hooks/purity -- server component, no re-render concern
    const now = Date.now();
    // The recommended task this page was opened for, if any — fed the client's
    // already-booked dates (the assets above) so the start date it carries is
    // the one the calendar would have inferred for the same task.
    const kickoffTask = await buildTaskKickoffView({
      clientId: id,
      taskId: kickoffTaskId,
      scheduledAt: assets.filter((a) => a.scheduledAt != null).map((a) => a.scheduledAt as number),
      now,
    });
    // ── The roster (CD-G1) ──
    // One row per GRANTED agent, umbrella-bound or not, carrying a mark, a
    // name, one line of what it gives you and one status word. No Run button
    // anywhere: a client's run gesture lives only inside a detail page, beside
    // the context that explains what it costs and produces.
    //
    // EXTRACTED IN ROUND 6 (2026-09) to `lib/client-roster.ts`, and since the
    // review pass it is the ONLY assembler of `rosterStatus`'s inputs anywhere:
    // this branch, the staff branch below, Reporting and Home's setup ladder all
    // read the rows it returns. A second page assembling those order-sensitive
    // inputs by hand is how "Live" comes to mean two things — the bug Albert
    // flagged on the agent detail page. Everything below reads the returned rows
    // rather than re-deriving anything from them.
    const rosterEntries = await buildClientRosterEntries({
      clientId: id,
      client,
      // The seat gate (round 6 review, D3): `lastMade` prints a deliverable's
      // title, and one seat's personal post is not another seat's to read.
      viewer: { role: user.role, seatId: user.seatId, isGroupAdmin: user.isGroupAdmin },
      now,
      data: { allAgents, jobs, plannedRuns: scheduledRuns, umbrellas, assets },
    });
    // The enabled half of the roster, which is what the two notices below are
    // about: an outage has nothing to say about a paused agent, and the engine
    // health banner is keyed on the keys of agents that can actually run.
    const liveEntries = rosterEntries.filter((entry) => entry.enabled);
    // ── Card selection: exactly one card per agent ──
    // An umbrella owns its agent's card as soon as it is bound - the launch
    // card while it is being set up, the live card once it is producing. The
    // agent is dropped from the generic run rows below, so a client is never
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
    // Client viewers see only runs of agents they're allowed - not the history
    // of staff-fired agents outside their allowlist, and (§4.1 item 3) not the
    // batch rows of an umbrella-owned agent: "ran 2 hours ago · 7 drafts" beside
    // a week of daily slots is the tell that the days are a presentation of a
    // batch. Staff rows are unchanged.
    //
    // Still filtered on the STORED name (that is the join to the runnable set);
    // what each row prints is its resolved §7.3 identity (F147).
    const runnableNames = new Set(
      liveEntries.filter((e) => !ownedAgentIds.has(e.customAgentId)).map((e) => e.agentName),
    );
    const runs = toRunRows(jobs, false, umbrellas).filter((r) => runnableNames.has(r.agentName));
    // A client run takes 10–20 minutes and the client's rows carry no link, so
    // without this the page never moved again after "Start run". Mounted only
    // while something is actually in flight; it unmounts when the server
    // renders a terminal status. A setup run in flight moves the launch card
    // the same way — it is the same medicine for a longer wait.
    //
    // `hasActiveTemplateRun` asks the same question of the same two lists, both
    // already in hand, with no query.
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

    return (
      <>
        {runInFlight && <AutoRefresh />}
        {/* The section below used to repeat this heading and tagline almost
            verbatim ("active AI team" / "always-on AI team"), one in Title Case
            and one in sentence case. This is the surviving one. */}
        <PageHeader title="AI agents" description={AGENTS_PAGE_DESCRIPTION} />
        {/* Above the roster: the recommended task this page was opened for.
            Same strip, same three controls, same position relative to the
            page's main content as on an agent's own page (portal feedback
            round 2, 2026-09). */}
        {kickoffTask && (
          <div className="mb-4">
            <TaskKickoffStrip clientId={id} task={kickoffTask} />
          </div>
        )}
        {/* Two different conditions used to share the never-set-up empty state,
            so an outage or a bad deploy told a client with three live agents
            and a run history that they had never been set up. Only an empty
            allowlist gets that copy now; an unconfigured service keeps the
            agents, schedules and history on screen behind an honest notice. */}
        {liveEntries.length > 0 && !agentServiceConfigured && (
          <RunsPausedNotice viewerIsClient cause="service" />
        )}
        {/* SCRUM-264: a client cut over to agent-engine got no warning of any
            kind when it broke - agentServiceConfigured above has nothing to
            say about it, since these runs never touch agent-service. */}
        {shouldShowEngineHealthBanner(
          client.agentsRepoSlug,
          liveEntries.map((e) => e.agentKey),
        ) && (
          <EngineHealthBanner viewerIsClient />
        )}
        {rosterEntries.length > 0 ? (
          <ClientAgentRoster clientId={id} entries={rosterEntries} now={now} />
        ) : (
          /* R9 (flow audit 2026-09 · NN/g *Empty States*): this told a client
             what would eventually happen and gave them nothing to do about it —
             and there is no self-serve way to add an agent, so the only honest
             control is the one that reaches the people who can. `EmptyState`
             has taken an `action` node all along (ui.tsx); not one client-facing
             empty state passed one.
             Labelled "Support", not "Talk to your Karos team": R7's one word
             for this dialog, wherever it is opened from. The description is
             where the ask goes. */
          <EmptyState
            icon={<Icon name="Bot" className="h-7 w-7" />}
            title="No active agents yet"
            description="After your Karos team completes the first agent run, that agent will appear here. Ask them which agents are on your plan."
            action={<ContactUsButton variant="row" userName={user.name} userEmail={user.email} />}
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
  // NO PRICE HERE EITHER — see the client branch above. The staff roster paints
  // the same four things the client's does and mounts no run dialog, so a
  // per-agent estimate threaded through `toSummary` had no reader on this
  // branch either. Parity is preserved by both branches doing the same nothing.
  const enabledAgents = customAgents
    .filter(
      (a) =>
        a.enabled &&
        !isUnlistedAgent(a) &&
        agentKeyMatchesClientSlug(a.key, client.agentsRepoSlug),
    )
    .map((a) => toSummary(a));
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
    .map((a) => toSummary(a));

  // (The jobPreviews block that used to live here fed <ManagedProducts />,
  // which nothing imported - it read every managed asset for this client on
  // every page load and handed the result to no one. Removed with F39/F45.
  // origin/main rebuilt it in the same shape and likewise passes it to nobody,
  // so it stays removed: it is one getAsset per managed deliverable per page
  // load, for a value with no reader.)

  // No `intakePanes` here any more, and no listContextItems: both fed the run
  // DIALOG, and CD-I1 moved every staff run gesture to the agent detail page.
  // The detail route builds the panes for the one agent it is about, rather than
  // this page building them for all of them (three full reads of seats, intake,
  // drops and run history, per agent, for a dialog that is no longer on this
  // page). Readiness is not asked here either any more: `buildAgentSetup` is
  // fired once, inside `buildClientRosterEntries`, for the set it lists (round 6
  // review C1) — this branch was paying for a second full pass over the same
  // agents to answer the same question.
  const staffRuns = toRunRows(jobs, true, umbrellas);

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

  // The clock the refusal window is measured against — resolved once for the
  // whole roster so every card ages a refusal from the same instant.
  // eslint-disable-next-line react-hooks/purity -- server component, no re-render concern
  const staffNow = Date.now();
  // Parity pass (2026-09): the kickoff strip is a client-owned surface, so it
  // renders IDENTICALLY here — a staff viewer following the same link reads the
  // same task, with the same three controls, in the same slot.
  const staffKickoffTask = await buildTaskKickoffView({
    clientId: id,
    taskId: kickoffTaskId,
    scheduledAt: assets.filter((a) => a.scheduledAt != null).map((a) => a.scheduledAt as number),
    now: staffNow,
  });

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
  //
  // ── AND BUILT BY THE ONE ASSEMBLER (round 6 review, findings C1/C2/C3) ──
  //
  // This block used to hand-assemble `rosterStatus`'s inputs a second time,
  // beside the client branch above doing the same thing with the same functions.
  // Four differences had already crept in — the raw umbrella instead of the
  // card-owning one, `viewerIsClient: false` on the delivered-work join, a
  // separate `toScheduleRows` call and a re-spelled readiness conjunction — and
  // any one of them can change the WORD, which ruling 1 forbids outright. The
  // staff scope is the CANDIDATE SET (every enabled bound agent, granted or not,
  // plus the paused ones) and the additive `note` / `notGranted`; the status
  // inputs are the client's, computed once, in `lib/client-roster.ts`.
  const staffRosterEntries = await buildClientRosterEntries({
    clientId: id,
    client,
    scope: "staff",
    // The seat gate (D3): `lastMade` prints a deliverable's title, and an
    // operator reading a client's roster is not a licence to name a seat's
    // personal post. Same viewing context the client branch passes.
    viewer: { role: user.role, seatId: user.seatId, isGroupAdmin: user.isGroupAdmin },
    now: staffNow,
    data: {
      allAgents: customAgents,
      jobs,
      plannedRuns: scheduledRuns,
      umbrellas,
      assets,
      // The OTHER scheduling system, for the staff-only note. Read on this
      // branch only; the client's roster neither reads nor mentions it.
      legacyScheduledRuns: legacyScheduledRuns,
    },
  });

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
      {/* Same slot, same strip as the client branch above. */}
      {staffKickoffTask && (
        <div className="mb-4">
          <TaskKickoffStrip clientId={id} task={staffKickoffTask} />
        </div>
      )}
      {/* The outage notice, on the STAFF branch too. It was mounted only for
          clients, so an operator opened a roster of enabled Run controls with
          nothing anywhere on the page saying the service was down - they found
          out by pressing one. Same banner, staff wording: they are the people
          who clear it, so it names the cause rather than promising a call. */}
      {enabledAgents.length > 0 && !agentServiceConfigured && (
        <RunsPausedNotice viewerIsClient={false} cause="service" />
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
          {staffRosterEntries.length > 0 && (
            <ClientAgentRoster clientId={id} entries={staffRosterEntries} now={staffNow} />
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
