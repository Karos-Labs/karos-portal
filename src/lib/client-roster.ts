import { agentKeyMatchesClientSlug, isUnlistedAgent } from "@/lib/custom-agent-launch";
import { clientAgentBlurb } from "@/lib/agent-blurbs";
import { isCreditDenialMessage } from "@/lib/credits";
import {
  agentNeedsSetup,
  isCurrentScheduleRefusal,
  lastRunFailedAgentIds,
  rosterStatus,
} from "@/lib/client-agents";
import {
  agentsWithDeliveredWork,
  agentsWithUpcomingContent,
  buildAgentAssetIndex,
  deliverableStamp,
  groupAssetsByAgent,
} from "@/lib/agent-detail-archetypes";
import { buildAgentSetup, toScheduleRows, toSummary } from "@/lib/client-agent-rows";
import { umbrellaOwnsClientCard } from "@/lib/client-agent-runs";
import { selectAgentSchedules } from "@/lib/agent-schedule-selection";
import type { AgentRosterEntry } from "@/components/client-agents/roster";
import type { AssetViewer } from "@/lib/asset-visibility";
import type { AgentSetupState } from "@/components/custom-agents";
import type {
  Asset,
  Client,
  ClientAgent,
  CustomAgent,
  Job,
  PlannedScheduledRun,
  ScheduledRun,
} from "@/lib/types";

/**
 * THE CLIENT'S AGENT ROSTER, DERIVED ONCE FOR EVERY SURFACE THAT PRINTS IT.
 *
 * Extracted from `app/(app)/clients/[id]/agents/page.tsx` in round 6 (2026-09)
 * because a SECOND surface needed the same rows (Reporting's "What we are doing
 * to improve your SEO and GEO"), and widened in the review pass that followed to
 * be the ONLY assembler of `rosterStatus`'s inputs anywhere in the portal.
 *
 * WHY ONE ASSEMBLER (review findings C1, C2, C3, C8). `rosterStatus` was already
 * one function every surface called, so the risk was never two status functions
 * — it was FOUR INPUT ASSEMBLIES: this file, the staff branch of the agents page,
 * Home's setup ladder and the agent detail page. The rungs are order-sensitive
 * and quietly interdependent (an umbrella owns the card as soon as it is bound; a
 * refusal outranks "Live" but only while it is fresh; delivered work is asked of
 * the paused set separately because the candidate filter drops it; readiness is
 * the CONJUNCTION of two questions), and four hand assemblies of that is how
 * "Live" came to mean two things on two screens — the bug Albert reported ("we
 * pre-created content ... yet the page says runs on request") and then a second
 * time on Home, where a client with a delivered post and a future draft read
 * "We are setting up your first agent".
 *
 * THE WORD IS VIEWER-INDEPENDENT BY CONSTRUCTION (ruling 1). Every status input
 * — delivered work, upcoming content, readiness, the owning umbrella, the
 * schedule — is computed AS THE CLIENT WOULD SEE IT, whatever the `scope`. Staff
 * scope changes exactly two things: which agents are CANDIDATES (the superset:
 * every enabled bound agent, granted or not) and which ADDITIVE fields come back
 * (`note`, `notGranted`, and the Internal sentence `rosterStatus` already
 * resolves). It cannot reach the word, which is what makes the parity ruling a
 * property of this file rather than a convention four callers have to remember.
 *
 * SERVER-SIDE. `buildAgentSetup` reads the three intake surfaces; everything
 * else is handed in, so a caller that already paid for the reads does not pay
 * twice (ruling 8).
 */

/** What a caller must already hold. Every caller reads all five for other reasons. */
export interface ClientRosterInputs {
  /** `listCustomAgents()` — the whole catalogue, unfiltered. */
  allAgents: CustomAgent[];
  /** `listJobs({ clientId })`. */
  jobs: Job[];
  /** `listPlannedScheduledRuns({ clientId })`. */
  plannedRuns: PlannedScheduledRun[];
  /** `listClientAgents({ clientId })` — the umbrellas. */
  umbrellas: ClientAgent[];
  /**
   * `listAssets({ clientId })`. Needed for the delivered-work and upcoming-content
   * joins: a lab-imported deliverable has no job at all. The agents page's own
   * note on that call documents what the read costs and the cheaper shapes when
   * it stops being fine at pilot volume.
   */
  assets: Asset[];
  /**
   * `listScheduledRuns({ clientId })` — the OTHER, legacy generator, for the
   * staff-only note. `scope: "staff"` only; omitted, the note simply does not
   * mention it, and no client-facing field reads it.
   */
  legacyScheduledRuns?: ScheduledRun[];
  /**
   * `AgentSetupState` this caller has ALREADY resolved, as a cache (round 6
   * review, ruling 8).
   *
   * `buildAgentSetup` is per-agent Firestore reads of the three intake surfaces,
   * and Home needs the same objects for the setup ladder's own copy (which
   * intake is missing, what it is called). Anything present here is used as-is;
   * anything missing is resolved here and merged. A caller whose map is a strict
   * subset therefore pays for the difference only — and never gets a silent
   * wrong default, which is why this is a cache rather than a replacement.
   */
  agentSetup?: Record<string, AgentSetupState>;
}

/**
 * WHOSE CANDIDATE SET, and nothing else (review C1).
 *
 * `"client"` — the agents this client HAS: their grants, plus any agent that has
 * already delivered work for this workspace (see `granted` below).
 *
 * `"staff"` — the superset an operator needs: every enabled bound agent whether
 * granted or not, plus every paused one, each carrying the additive staff fields.
 * It does NOT mean "the staff answer to the status question": there is no such
 * thing any more.
 */
export type ClientRosterScope = "client" | "staff";

export interface ClientRosterEntry extends AgentRosterEntry {
  /**
   * Is this agent in `client.customAgentIds`?
   *
   * FALSE is reachable on a client's own roster: an agent that has already
   * delivered work for this workspace is listed whether or not the grant was
   * ever written, because "Not set up yet" beside a shelf of delivered posts is
   * the roster contradicting itself. What that costs is a destination — a
   * client opening an ungranted agent's page gets `notFound()`
   * (`agents/[agentId]/page.tsx`) — so Reporting offers those rows Support
   * instead of a link (risk review C21), and the roster's whole-card link is
   * unchanged from what it has always done.
   *
   * DISTINCT FROM `AgentRosterEntry.notGranted`, which is the STAFF-view marker
   * ("this card is on the staff superset and not in the client's grants"). The
   * two hold the same fact for different readers: `granted` is a property of the
   * row for anyone who reads it, `notGranted` is a badge only the staff scope
   * paints.
   */
  granted: boolean;
  /** The agent's stable `key`. Never rendered; joins, gates and lever lookups only. */
  agentKey: string;
  /** The STORED name, which is the join to a run row and the label of a control. */
  agentName: string;
  /** `CustomAgent.enabled`. False is the "Coming Soon" rung and takes no controls. */
  enabled: boolean;
}

export async function buildClientRosterEntries(args: {
  clientId: string;
  client: Pick<Client, "customAgentIds" | "agentsRepoSlug">;
  /** Which agents are candidates, and which additive fields come back. */
  scope?: ClientRosterScope;
  /**
   * WHO IS ASKING, for the personal-content gate (review finding D3).
   *
   * `getClientArchiveAssets` drops another seat's personal post only when it is
   * told who is looking, and without it `lastMade` named a colleague's personal
   * content on every seat's roster — the one field on this row that prints an
   * asset TITLE. Both callers already hold the viewing context; a caller that
   * omits it keeps the pre-seat behaviour rather than failing closed, which is
   * the same optionality `getClientLibraryAssets` documents on its own `viewer`.
   */
  viewer?: AssetViewer;
  /**
   * Should the three row facts be resolved at all (review finding E11)?
   *
   * Default true, because the roster prints them. Reporting does NOT: its rows
   * carry a mark, a name, a lever sentence and the status word, so resolving the
   * newest deliverable and the next planned day for every agent on the account
   * was a full attribution pass per agent for values with no reader.
   */
  withRowFacts?: boolean;
  /** One clock for the whole page: the joins, the refusal window, the horizon. */
  now: number;
  data: ClientRosterInputs;
}): Promise<ClientRosterEntry[]> {
  const { clientId, client, now } = args;
  const { allAgents, jobs, plannedRuns, umbrellas, assets } = args.data;
  const scope = args.scope ?? "client";
  const staffScope = scope === "staff";
  const withRowFacts = args.withRowFacts ?? true;

  const allowedIds = new Set(client.customAgentIds ?? []);
  const agentIdByName = new Map(allAgents.map((agent) => [agent.name, agent.id]));

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
  // Paused agents stay ON the roster as their own row, badged "Coming Soon"
  // (rosterStatus's enabled:false short-circuit), rather than vanishing and
  // leaving the client wondering where an agent they were told about went. Kept
  // out of the interactive set: they never enter the umbrella/setup pipeline.
  const disabledBound = allAgents.filter(
    (agent) =>
      !agent.enabled &&
      !isUnlistedAgent(agent) &&
      agentKeyMatchesClientSlug(agent.key, client.agentsRepoSlug),
  );

  /**
   * THE PAGE'S ONE ASSET INDEX (review findings E9/E10).
   *
   * `jobById` and the client-visible projection are built ONCE here and handed
   * to every join below. They used to be rebuilt inside each of the four helpers
   * this function calls, twice over (the enabled set and the paused set), so one
   * roster render ran `getClientArchiveAssets` and rebuilt the job map six times
   * over the client's whole history.
   *
   * `viewerIsClient: true` UNCONDITIONALLY, and that is the parity ruling as a
   * line of code: the status word is the client's for every reader, so a staff
   * roster asks the client's question and gets the client's answer. It also
   * means the ROW FACTS are the client's — `lastMade` carries the delivery stamp
   * rather than the generation instant and stops at the archive window — which
   * is what staff in client context are supposed to read (ruling 1); the
   * operator facts they additionally need are the `note` below.
   */
  const index = buildAgentAssetIndex({
    assets,
    jobs,
    viewerIsClient: true,
    now,
    ...(args.viewer ? { viewer: args.viewer } : {}),
  });

  // The same set answers two questions: which agents a client inherits by having
  // been delivered to, and — through rosterStatus — which of them are plainly
  // set up already. It reads JOBS AND ASSETS through the one shared answer the
  // agent's own page reads, because a job-only join left an agent whose only
  // delivered work was a lab import (jobId: null) off the roster while its posts
  // sat in the client's Workspace.
  const completedAgentIds = agentsWithDeliveredWork({
    assets,
    jobs,
    agents: candidateAgents,
    umbrellas,
    clientSlug: client.agentsRepoSlug,
    viewerIsClient: true,
    now,
    ...(args.viewer ? { viewer: args.viewer } : {}),
    index,
  });
  // Delivered work is asked of the paused set SEPARATELY, because
  // `candidateAgents` filters on enabled and the main answer cannot speak for
  // these. Same function, same index, no second projection.
  const disabledDeliveredIds = agentsWithDeliveredWork({
    assets,
    jobs,
    agents: disabledBound,
    umbrellas,
    clientSlug: client.agentsRepoSlug,
    viewerIsClient: true,
    now,
    ...(args.viewer ? { viewer: args.viewer } : {}),
    index,
  });
  // Which agents' most recent finished run FAILED. A schedule refusal cannot see
  // that — it only records a fire the scheduler turned away before a job existed
  // — so without this a green "Live" badge sits above a run history whose last
  // row says Failed. It moves NO word (ruling 4): with `viewerIsStaff` it adds
  // the Internal sentence and nothing else, so the wider staff job set here
  // cannot change what a client is told.
  const failedAgentIds = lastRunFailedAgentIds(jobs, agentIdByName, { staff: staffScope });
  // AF-5. Which agents have content sitting on this client's calendar for a day
  // that has not happened. It reads the assets already in hand (no extra query)
  // and returns ids only, so what leaves here is one boolean per agent and
  // nothing about the items themselves.
  const producingAgentIds = agentsWithUpcomingContent({
    assets,
    jobs,
    agents: candidateAgents,
    umbrellas,
    clientSlug: client.agentsRepoSlug,
    now,
    index,
  });

  /**
   * WHICH CANDIDATES ACTUALLY GET A ROW — the one thing `scope` decides.
   *
   * A client's roster is their grants plus what has been delivered to them. A
   * staff roster is the whole bound superset, because staff need to see what is
   * available to grant; each extra card says so through `notGranted` (A4).
   */
  const listed = (agent: CustomAgent, delivered: Set<string>) =>
    staffScope || allowedIds.has(agent.id) || delivered.has(agent.id);
  // NOT `.map(toSummary)`: `toSummary` takes pricing as its OPTIONAL second
  // argument and `Array.map` would hand it the index — a summary priced at
  // whatever position the agent happened to sit in. No pricing is resolved for
  // a roster: it quotes no price and offers no press.
  const agents = candidateAgents
    .filter((agent) => listed(agent, completedAgentIds))
    .map((agent) => toSummary(agent));
  const disabledAgents = disabledBound
    .filter((agent) => listed(agent, disabledDeliveredIds))
    .map((agent) => toSummary(agent));
  // A8. Readiness through the same `buildAgentSetup` the detail route uses, so
  // the surfaces answer it off one object rather than three derivations. No
  // panes: those belong to the run dialog. Only the agents the caller has not
  // already resolved are read (see `ClientRosterInputs.agentSetup`).
  const providedSetup = args.data.agentSetup ?? {};
  const unresolved = agents.filter((agent) => !(agent.id in providedSetup));
  const clientAgentSetup: Record<string, AgentSetupState> = {
    ...providedSetup,
    ...(unresolved.length > 0 ? await buildAgentSetup(clientId, unresolved) : {}),
  };

  // An umbrella owns its agent's row as soon as it is bound - the launch card
  // while it is being set up, the live card once it is producing. Read through
  // `umbrellaOwnsClientCard` rather than off the raw list, because the one
  // exception it encodes is deliberate: a LIVE umbrella with no templates yet
  // (the grandfathered bind of an already-producing agent) does not own the row.
  // ONE MAP FOR BOTH SCOPES (review C1): the staff branch used to read the raw
  // list here, so a grandfathered bind produced a different launch state — and
  // therefore a different WORD — for the two readers of one agent.
  const umbrellaByAgentId = new Map(
    umbrellas
      .filter((umbrella) => umbrellaOwnsClientCard(umbrella))
      .map((umbrella) => [umbrella.customAgentId, umbrella] as const),
  );
  // CLIENT-REDACTED FOR BOTH SCOPES. Redaction changes a refusal's TEXT, never
  // whether one exists, so the status rungs are unaffected — and the one
  // staff-only field it withholds (`prompt`, staff-authored operator copy) is
  // read by nothing here. Asking for it would put it in the RSC payload of a
  // page that never paints it.
  const scheduleByAgentId = new Map(
    toScheduleRows(plannedRuns, true).map((row) => [row.agentId, row] as const),
  );

  /* ─────────── the additive staff facts (scope: "staff" only) ─────────── */

  // The rows `toScheduleRows` did NOT pick. It returns one governing row per
  // agent (see selectAgentSchedules) — which is what stops two surfaces showing
  // two different schedules — so without this the extras would simply be gone
  // from staff's view as well as the client's, and the point of picking one is
  // that somebody is told there were two.
  const scheduleSelection = staffScope ? selectAgentSchedules(plannedRuns) : null;
  // Drafts waiting on staff, per agent — the queue the retired card surfaced as
  // its "N ready" chip. Counted from the jobs already loaded.
  const reviewCountByAgentName = new Map<string, number>();
  if (staffScope) {
    for (const job of jobs) {
      if (job.external?.taskType !== "custom" || job.status !== "review") continue;
      if (job.assetIds.length === 0) continue;
      reviewCountByAgentName.set(
        job.agentName,
        (reviewCountByAgentName.get(job.agentName) ?? 0) + job.assetIds.length,
      );
    }
  }
  // The legacy generator, indexed by the agent it fires. Its rows key the agent
  // on `agentId` (the planned rows use `customAgentId`) — same collection of
  // custom agents, different field name.
  const legacyByAgentId = new Map<string, ScheduledRun[]>();
  if (staffScope) {
    for (const run of args.data.legacyScheduledRuns ?? []) {
      const bucket = legacyByAgentId.get(run.agentId);
      if (bucket) bucket.push(run);
      else legacyByAgentId.set(run.agentId, [run]);
    }
  }

  /* ────────────────────── the three row facts (E11) ────────────────────── */

  // ONE PASS OVER THE ASSETS FOR THE WHOLE ROSTER, twice — the delivered set and
  // the upcoming set — instead of `agentProducedAssets` +
  // `agentUpcomingCalendarDays` re-walking both lists per agent. Same rungs, in
  // the same order, off the same index (`groupAssetsByAgent`).
  //
  // The attribution umbrella is the RAW one (`groupAssetsByAgent` reads
  // `umbrellaForAgent`), which is the umbrella `agentsWithDeliveredWork` already
  // used: the two answers now come off one resolution, where before `lastMade`
  // asked with the card-owning umbrella and "has it delivered?" asked with the
  // raw one — two rungs for one question, on one row.
  // The paused set is deliberately absent: a "Coming Soon" row takes no
  // controls and prints no facts, so resolving them would be a full attribution
  // pass for a column that row never renders.
  const factAgents = withRowFacts ? agents : [];
  const producedByAgentId = withRowFacts
    ? groupAssetsByAgent({
        assets: index.visible,
        jobById: index.jobById,
        agents: factAgents,
        umbrellas,
      })
    : new Map<string, Asset[]>();
  const upcomingByAgentId = withRowFacts
    ? groupAssetsByAgent({
        assets: index.upcoming,
        jobById: index.jobById,
        agents: factAgents,
        umbrellas,
      })
    : new Map<string, Asset[]>();

  /**
   * The three facts the round-6 row prints beside the badge, or nothing at all
   * when the caller does not print them.
   *
   * NEWEST PRODUCED, from the same client-visible set the client's own Workspace
   * shows them, so naming it publishes nothing new. No status, no draft marker
   * and no count (A3/A4).
   *
   * NEXT PLANNED DAY, and a DAY is all it is (the row labels it through
   * `rosterNextLabel`). Precedence: a client-visible calendar item inside the
   * 14-day window first — the same predicate and the same attribution rungs
   * `hasUpcomingContent` used, so the row cannot disagree with its own badge —
   * otherwise the schedule's next fire, and only while the schedule is actually
   * active, because a paused schedule's stored `nextRunAt` is a date nothing
   * will honour.
   */
  const rowFacts = (
    agentId: string,
    schedule: { status: string; nextRunAt?: number | null } | null,
  ): Pick<AgentRosterEntry, "lastMade" | "nextAt"> => {
    if (!withRowFacts) return {};
    const produced = producedByAgentId.get(agentId) ?? [];
    const newest = produced.reduce<Asset | null>(
      (best, asset) =>
        best === null || deliverableStamp(asset, true) > deliverableStamp(best, true)
          ? asset
          : best,
      null,
    );
    const nextPlanned = (upcomingByAgentId.get(agentId) ?? []).reduce<number | null>(
      (earliest, asset) =>
        asset.scheduledAt != null && (earliest === null || asset.scheduledAt < earliest)
          ? asset.scheduledAt
          : earliest,
      null,
    );
    return {
      lastMade: newest ? { title: newest.title, at: deliverableStamp(newest, true) } : null,
      nextAt:
        nextPlanned ?? (schedule?.status === "active" ? schedule.nextRunAt ?? null : null),
    };
  };

  const entries: ClientRosterEntry[] = agents.map((agent) => {
    const umbrella = umbrellaByAgentId.get(agent.id) ?? null;
    const schedule = scheduleByAgentId.get(agent.id) ?? null;
    const setup = clientAgentSetup[agent.id] ?? null;
    const hasDelivered = completedAgentIds.has(agent.id);
    const status = rosterStatus({
      launchState: umbrella?.launchState ?? null,
      // Already client-redacted by toScheduleRows, and passed RAW: a refusal
      // outranks "Live" (F24/F129), but WHEN it stops counting — aged out, or
      // answered by a pause — is `rosterStatus`'s rule, not a caller's.
      scheduleRefusal: schedule?.lastError ?? null,
      scheduleRefusalAt: schedule?.lastErrorAt ?? null,
      scheduleActive: schedule?.status === "active",
      // "Not set up yet" beside a shelf of delivered work is the row
      // contradicting itself; an agent that has produced says so instead.
      hasDelivered,
      // A8: the readiness pair, handed over WHOLE. `rosterStatus` owns the
      // conjunction now (`agentReadyToRun`) and the "does it still need setting
      // up" question with it (`agentNeedsSetup`), so no caller spells either
      // (review C2). Null for an agent that runs on no intake — an unknown must
      // not read as ready.
      setup,
      // Resolved, and then deliberately not acted on for a client: ruling 4 took
      // this flag out of the status WORD entirely, so with `viewerIsStaff` false
      // what it skips is the Internal sentence, not a rung (AF-14).
      lastRunFailed: failedAgentIds.has(agent.id),
      viewerIsStaff: staffScope,
      // AF-5: an agent whose posts we produce internally has no schedule of
      // its own to read Live from, and the client can see its work filling
      // next week's calendar.
      hasUpcomingContent: producingAgentIds.has(agent.id),
      now,
    });
    /**
     * WHICH FIX AN ATTENTION ROW POINTS AT (review findings D7/E6). It changes
     * no status WORD (ruling 4 keeps the seven, and one badge renders them) — it
     * decides the row's verb, and it has to name the thing that actually
     * produced the attention tone.
     *
     * THE REFUSAL IS ASKED FIRST, because it is the rung that outranks
     * everything else in `rosterStatus`: an agent badged "Needs attention" over
     * a credit denial was being offered "Set up" whenever its intake happened to
     * be incomplete as well, which is the wrong lever on the one state the
     * client can fix themselves. `isCurrentScheduleRefusal` is the SAME window
     * the word was resolved through, so a refusal that has aged out of the badge
     * cannot still be choosing the verb; `isCreditDenialMessage` is the stored
     * marker (`clientSafeRefusal` passes credit denials through verbatim, so it
     * survives redaction).
     */
    const refusalCurrent =
      schedule != null &&
      isCurrentScheduleRefusal({
        scheduleRefusal: schedule.lastError,
        scheduleRefusalAt: schedule.lastErrorAt,
        scheduleActive: schedule.status === "active",
        now,
      });
    const attentionReason =
      refusalCurrent && isCreditDenialMessage(schedule!.lastError as string)
        ? ("credits" as const)
        : agentNeedsSetup({ setup, hasDelivered })
          ? ("intake" as const)
          : umbrella?.launchState === "launch_failed"
            ? ("launch" as const)
            : null;
    /**
     * The staff-only operator line (scope: "staff"), so the roster still answers
     * "which of these needs me" without becoming a control panel again.
     * Highest-priority fact only — the detail page carries the full ladder.
     *
     * A DUPLICATE SCHEDULE OUTRANKS ALL OF IT. Two live rows for one client and
     * one agent is not a state anyone chose: nothing refuses to create the
     * second, every surface renders only the one `selectAgentSchedules` picks,
     * and the other keeps firing and billing where nobody can see or pause it.
     *
     * `status.staffNote` LEADS it (AF-5): when the badge says Live and the
     * schedule row under it says nothing is firing, "why" is the first question
     * an operator has. The legacy line is APPENDED rather than ranked — it names
     * a SECOND system firing this agent, not a competing status — and says "not
     * billed" out loud, because that is the whole reason it is easy to forget.
     */
    let note: string | null = null;
    if (staffScope) {
      const extraSchedules = scheduleSelection?.get(agent.id)?.duplicates.length ?? 0;
      const review = reviewCountByAgentName.get(agent.name) ?? 0;
      const primary =
        extraSchedules > 0
          ? `${extraSchedules + 1} schedules for this agent. Only the next to fire is shown here or editable`
          : review > 0
            ? `${review} draft${review === 1 ? "" : "s"} waiting for review`
            : setup && !setup.ready
              ? `${setup.label} is still empty`
              : schedule
                ? `${schedule.postsPerWeek} run${schedule.postsPerWeek === 1 ? "" : "s"}/week · ${schedule.outputsPerRun} output${schedule.outputsPerRun === 1 ? "" : "s"} each`
                : null;
      const legacy = legacyByAgentId.get(agent.id) ?? [];
      const legacyNote =
        legacy.length > 0
          ? `${legacy.length} settings-page schedule${legacy.length === 1 ? "" : "s"} (${legacy.filter((r) => r.enabled).length} on). Not billed to the client`
          : null;
      note = [status.staffNote ?? null, primary, legacyNote].filter(Boolean).join(" · ") || null;
    }
    const granted = allowedIds.has(agent.id);
    return {
      ...rowFacts(agent.id, schedule),
      attentionReason,
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
      granted,
      agentKey: agent.key,
      agentName: agent.name,
      enabled: true,
      ...(note ? { note } : {}),
      // A4. Not a status word — the agent's status is whatever it is — but a
      // fact about THIS client's view of it, which is why it is its own flag and
      // its own neutral badge rather than another `rosterStatus` rung. Staff
      // scope only: a client's own roster never paints it.
      ...(staffScope && !granted ? { notGranted: true } : {}),
    };
  });

  // Paused agents ride the same row, just with rosterStatus's enabled:false
  // short-circuit (-> "Coming Soon", every other input moot).
  const disabledEntries: ClientRosterEntry[] = disabledAgents.map((agent) => {
    const granted = allowedIds.has(agent.id);
    return {
      customAgentId: agent.id,
      identity: `${agent.key} ${agent.name}`,
      icon: agent.icon ?? null,
      displayName: agent.name,
      blurb: clientAgentBlurb({
        key: agent.key,
        name: agent.name,
        clientBlurb: agent.clientBlurb ?? null,
      }),
      status: rosterStatus({ launchState: null, enabled: false }),
      granted,
      agentKey: agent.key,
      agentName: agent.name,
      enabled: false,
      ...(staffScope && !granted ? { notGranted: true } : {}),
    };
  });

  return [...entries, ...disabledEntries];
}
