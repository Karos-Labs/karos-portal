import { redirect } from "next/navigation";
import { requireUser, requireVisibleClient } from "@/lib/auth";
import {
  getClientSeoGeo,
  listAssets,
  listJobs,
  listClientContextDocs,
  listClientIntegrations,
  listClientTasks,
  listClientActionStates,
  listCustomAgents,
  listPlannedScheduledRuns,
} from "@/lib/data";
import { listClientAgents } from "@/lib/data-client-agents";
import { isBillableClientActor } from "@/lib/credits";
import { isAiProcessingLockActive } from "@/lib/constants";
import { integrationIsUsable, integrationNeedsReconnect } from "@/lib/integration-status";
import { StaffOnlySection } from "@/components/staff-only-section";
import { PageHeader } from "@/components/ui";
import { AiProcessingBanner } from "@/components/ai-processing-banner";
import { ClientAnalytics } from "@/components/client-analytics";
import { AiInsights } from "@/components/ai-insights";
import { ClientHomeOverview } from "@/components/client-home-overview";
import { buildScoreViews, buildPresence } from "@/components/seo-geo/presenter";
import { RegenerateWorkspaceButton } from "@/components/regenerate-workspace-button";
import { getClientLibraryAssets } from "@/lib/asset-visibility";
import {
  clientAgentsById,
  contentLabelsByAsset,
  resolveContentIdentity,
} from "@/lib/agent-identity-map";
import { platformForAgentRow } from "@/lib/content-platform";
import { GetSetUpWidget } from "@/components/home-get-set-up";
import {
  resolveActionList,
  toClientActions,
  type ActionSignals,
} from "@/lib/action-list";
import {
  agentRunLabel,
  agentSetupHref,
  familyHasIntakePage,
  hasReadableClientDoc,
  pickSetupLadderAgent,
  resolveSetupLadderOrder,
  resolveSetupLadder,
  setupLadderComplete,
  setupLadderFamily,
  SETUP_LADDER_HIDDEN_ACTION_ID,
  type SetupLadderAgentCandidate,
} from "@/lib/setup-ladder";
import { buildAgentSetup } from "@/lib/client-agent-rows";
import { buildClientRosterEntries } from "@/lib/client-roster";
import { railAgentsForClient } from "@/lib/rail-agents";
import { isUpcomingPost } from "@/lib/calendar-kind";
import {
  CLIENT_ARCHIVE_WINDOW_MS,
  clientDeliveryStamp,
  getClientArchiveAssets,
} from "@/lib/asset-visibility";
import {
  CalendarPreviewWidget,
  CALENDAR_PREVIEW_ROWS,
  type CalendarPreviewRow,
} from "@/components/home-calendar-preview";
import { HomeKpisWidget } from "@/components/home-kpis";
import { HomeStandingWidget, hasStanding } from "@/components/home-standing";
import { HomeOpsStrip, type OpsStat } from "@/components/home-ops-strip";
import { contentThroughput } from "@/lib/content-throughput";
import { contentStatusHref } from "@/lib/content-status-links";
import { relativeTime } from "@/lib/utils";
import type { Asset } from "@/lib/types";

/**
 * How many open tasks the attention widget reads.
 *
 * Named rather than inlined because the widget's counts are `.length` of this
 * array, so the cap is part of what those numbers MEAN — `tasksHitLimit` below
 * turns "50" into "50+" when the window is full, instead of printing a
 * truncation as a total.
 */
const TASK_FEED_LIMIT = 50;

export default async function ClientDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  const { id } = await params;

  // CLIENT_USER may only view their own account.
  if (user.role === "CLIENT_USER") {
    if (user.clientId !== id) redirect(user.clientId ? `/clients/${user.clientId}` : "/assets");
  } else if (user.role !== "KAROS_ADMIN" && user.role !== "KAROS_EMPLOYEE") {
    redirect("/dashboard");
  }

  const client = await requireVisibleClient(user, id);

  const isClientViewer = user.role === "CLIENT_USER";
  // NOT the same question as isClientViewer, and the difference is money: an
  // admin in "View as Client" reads CLIENT_USER but is never charged. Surfaces
  // that quote a price ask this one; surfaces that pick a vocabulary ask the
  // other.
  const viewerIsBilled = isBillableClientActor(user);

  const [
    assets,
    jobs,
    integrations,
    seoGeo,
    tasks,
    umbrellas,
    actionStates,
    allCustomAgents,
    scheduledRuns,
    contextDocs,
  ] = await Promise.all([
    // TODO(bounded-reads): `listAssets`/`listJobs` read this client's ENTIRE
    // history to render a dashboard whose widest reader is a 30-day window —
    // they want a `limit` / date-window option in data.ts, the same shape
    // `listJobsByClientAndAgent` and `listStuckManagedJobs` already have. Not done
    // in this pass because data.ts is being edited concurrently (credits
    // rework, 2026-09) and a signature change there would collide; the page
    // caps what it MAPS in the meantime (see the calendar rows below), which is
    // where the per-row cost was, not the read.
    listAssets({ clientId: id }),
    listJobs({ clientId: id }),
    listClientIntegrations(id),
    getClientSeoGeo(id),
    // Read for BOTH viewers, and handed to ClientHomeOverview on BOTH branches
    // (parity pass, 2026-09). It used to be client-only, which left the staff
    // dashboard's Task Map nudge permanently reporting "0 suggestions" — a
    // banner that cannot count is a banner that lies — and then staff-only as
    // a count, on the reasoning that the attention rows linked to an
    // owner-scoped board a staff viewer would land on the wrong tab of. That
    // board is gone (2026-08); the rows are plain status lines now.
    listClientTasks({ clientId: id, status: ["pending", "review_pending"], limit: TASK_FEED_LIMIT }),
    // The umbrellas feed Recent Agent Activity's §7.3 join and the calendar
    // preview's identities; the action states carry the stored
    // dismiss/not-relevant/done rows no live signal can answer. Read
    // unconditionally rather than gated on isClientViewer since both are cheap,
    // indexed, single-field reads and gating them would just move the branch
    // into every widget that needs them instead of removing a real cost.
    //
    // FOUR READS LEFT THIS BLOCK (review wave, 2026-09): the competitor list,
    // the follower snapshots, the seat list and the credit doc. Each fed exactly
    // one thing — action-list rows 07, 11 and 24, and the followers KPI — and
    // NONE of those renders on this page any more. The checklist widget was
    // replaced by the setup ladder, which reads five ids (01, 04, 05, 21, 22);
    // the followers cell has always been gated on real stored snapshots and
    // nothing writes `clientFollowerSnapshots` today, so it has never rendered
    // for any client. Four collection reads per dashboard load for numbers
    // nobody sees. The signals they fed are optional now (lib/action-list.ts)
    // and the KPI card can still draw the follower cell the moment an ingestion
    // cron gives it something to draw.
    listClientAgents({ clientId: id }),
    listClientActionStates(id),
    // The setup ladder's step 3 needs the KEY of each granted agent (the id
    // alone cannot say which family an agent belongs to, and the family is what
    // decides whether the client has a form to fill in at all). One read of a
    // small, staff-managed collection, on both branches, because the ladder is
    // mounted on both.
    listCustomAgents(),
    // TWO READS JOINED THIS BLOCK IN ROUND 6, both for the setup ladder, and
    // both for the same reason: two of its six steps were answering from a
    // signal that could not see what the client sees.
    //
    //  · The planned schedule rows, so step 3's "live" can be asked of
    //    `rosterStatus` — the ONE function the roster and the agent page ask —
    //    instead of the bare `launchState === "live"` this page used to test.
    //    That test is the logic bug the brief names: a client receiving
    //    pre-created posts every day still read "We are setting up your first
    //    agent". A schedule that is refusing outranks Live, and a schedule that
    //    is active qualifies as Live, so the rows have to be in hand.
    //  · The client-tier context documents, so step 2 can tell "not read yet"
    //    from "not written yet". The Documents list filters an unwritten
    //    document out of itself entirely, so the old row pointed a client at an
    //    empty section (§2.4).
    listPlannedScheduledRuns({ clientId: id }),
    listClientContextDocs(id, "client"),
  ]);

  const firstName = user.name?.trim().split(/\s+/)[0];

  // ONE CLOCK FOR THE WHOLE RENDER (review wave, 2026-09). Every projection and
  // window below reads this, so the visibility cutoff the calendar preview uses,
  // the one the throughput window uses and the one the overview ages rows by are
  // the same instant rather than three readings taken milliseconds apart.
  // eslint-disable-next-line react-hooks/purity -- server component, no re-render concern
  const now = Date.now();

  /**
   * THE CLIENT-VISIBLE PROJECTION, COMPUTED ONCE (review wave, 2026-09).
   *
   * `getClientLibraryAssets` ran TWICE with identical arguments — once for the
   * overview, once for the calendar preview — each taking its own `Date.now()`,
   * so two lists built from one asset set could disagree about which posts had
   * unlocked. One call, one clock, two derivations.
   *
   * Client viewers must never receive un-redacted future content across the RSC
   * boundary (requirement H / amendment A6): every locked post in here is a
   * whitelist-redacted placeholder. Staff keep full visibility (invariant
   * A10.6) and read the raw set on their own branch — but the SIGNALS below are
   * computed from this projection for both readers, so the ladder tells a staff
   * member in client context exactly what it tells the client.
   */
  const clientLibrary = getClientLibraryAssets(assets, {
    forClient: true,
    now,
    viewer: { role: user.role, seatId: user.seatId, isGroupAdmin: user.isGroupAdmin },
  });
  // Locked placeholders are FILTERED out of the overview, not passed redacted:
  // "Recent activity" is delivered work, and a week of slots generated in one
  // minute would render as five "Upcoming post · 3 hours ago" rows - the batch
  // tell the churn rules exist to prevent (delta-lens bounce, 2026-07-28).
  const clientVisibleAssets = clientLibrary.filter((a) => !a.locked);
  const overviewAssets = isClientViewer ? clientVisibleAssets : assets;

  // Calendar Preview WANTS the locked/future rows overviewAssets just dropped —
  // that is the whole point of a preview — but never their real title:
  // redactLockedAsset already replaces it with a template name or "Upcoming
  // post", and the widget prints a `locked` row's platform NOUN instead of
  // whatever title it is holding (portal feedback round 4, 2026-09). The hour
  // and the kind chip come from fields the redacted copy deliberately keeps; the
  // agent and its mark do NOT, and are resolved from the original asset before
  // the row is built (see `toCalendarRow` below).
  /**
   * WHAT "UPCOMING" MEANS, asked of the calendar's own classifier (2026-09).
   *
   * This was `a.status === "scheduled" && (a.scheduledAt ?? 0) > now`, and that
   * spelling emptied the Calendar widget for a real client. `postKind` — which
   * is what the calendar page's chips are built from — admits `approved` and
   * dated `draft` assets too, and approval is what arms auto-publish, so a
   * client's content can go from draft to approved to posted without ever
   * holding the status this line asked for. XO Digital in production: 22
   * assets, 21 approved, 1 draft, 0 scheduled; thirteen future-dated
   * placeholders on their calendar and an empty widget on their dashboard.
   *
   * `isUpcomingPost` lives beside `postKind` so the two cannot drift again.
   * The `Asset` type is a superset of its `CalendarKindInput` parameter.
   */
  const isUpcoming = (a: Asset) => isUpcomingPost(a, now);
  // Staff read the unredacted set — there is no future-content rule to keep for
  // an operator, and the preview shows type + platform either way.
  const upcomingAssets = (isClientViewer ? clientLibrary : assets)
    .filter(isUpcoming)
    // SORTED AND CAPPED BEFORE THE IDENTITY JOIN (review wave, 2026-09). The
    // widget shows five dates and does its own sort; the page was resolving an
    // identity for every upcoming post the client has — thirteen for the account
    // in the note above, and unbounded in general — then handing the lot over
    // for eight of them to be dropped. Same order the widget applies, so the
    // five that survive here are the five it would have kept.
    .sort((a, b) => (a.scheduledAt ?? 0) - (b.scheduledAt ?? 0))
    .slice(0, CALENDAR_PREVIEW_ROWS);

  /**
   * WHO MADE THIS POST, threaded onto each Calendar Preview row (portal
   * feedback round 4, 2026-09).
   *
   * The widget's rows read "Thu 3 · Social post" for every agent a client has,
   * and the product owner's question — *"What is 'Social post' here?"* — is the
   * whole brief: five posts from three agents rendered as five copies of one
   * thing. The mark, the platform noun and the caption all need the producing
   * agent's identity, and resolving one needs this client's umbrella agents and
   * their jobs — neither of which belongs in the browser.
   *
   * `resolveContentIdentity` directly rather than `contentLabelsByAsset` below,
   * which is a thin wrapper over the SAME call: the row needs the umbrella's
   * platform as well as its label, and the wrapper returns only labels. Same
   * resolver either way, so this widget's caption cannot name an agent the
   * archive's headings disagree with.
   *
   * ── IT ASKS THE ORIGINAL ASSET, NOT THE REDACTED ONE (review wave, 2026-09) ──
   *
   * A client's rows arrive from `clientLibrary`, where every locked post is a
   * `redactLockedAsset` copy: `jobId` nulled, `meta` replaced by `{ locked:
   * true }`. Resolving an identity from that copy skips rules 1-2 (no job, so no
   * umbrella link and no custom agent) AND the asset half of rule 3 (no
   * `meta.taskType`), leaving the weakest rung in the resolver — "the live
   * umbrella that owns this content FAMILY" — to answer alone. A client with two
   * live umbrellas in one family therefore got whichever one `find` reached
   * first on every upcoming row: the wrong caption and the wrong mark, stated
   * with no hedge. The redacted copy keeps the asset's `id`, so the original is
   * one lookup away and the identity is resolved from the facts.
   */
  const jobById = new Map(jobs.map((job) => [job.id, job]));
  const assetById = new Map(assets.map((asset) => [asset.id, asset]));
  const umbrellaById = clientAgentsById(umbrellas);
  const toCalendarRow = (a: Asset): CalendarPreviewRow => {
    const source = assetById.get(a.id) ?? a;
    const identity = resolveContentIdentity(
      { asset: source, job: source.jobId ? (jobById.get(source.jobId) ?? null) : null },
      umbrellas,
      umbrellaById,
    );
    const umbrella = identity.clientAgentId ? umbrellaById.get(identity.clientAgentId) : undefined;
    // The platform TOKEN, resolved here rather than sniffed out of a lab repo
    // key in the browser: same two rungs the widget used to run itself (the
    // umbrella's stored platform, then its exact key / the printed label), asked
    // once on the server. `platformForAsset` still outranks it at render time
    // with anything the asset itself records.
    const agentPlatform = platformForAgentRow(
      identity.platform ?? null,
      umbrella?.agentKey ?? null,
      identity.label,
    );
    return {
      asset: a,
      agentLabel: identity.label,
      ...(agentPlatform ? { agentPlatform } : {}),
    };
  };
  const upcomingRows = upcomingAssets.map(toCalendarRow);

  // Recent Agent Activity's §7.3 join — same helper the Workspace archive and
  // Account Center's Archive tab use, so this widget cannot name an agent
  // something those two disagree with.
  const agentLabelByAssetId = contentLabelsByAsset(overviewAssets, jobs, umbrellas);

  // KPIs, audience cell: REAL STORED SNAPSHOTS ONLY (D6), and this page no
  // longer reads them (review wave, 2026-09). The rule is unchanged and so is
  // the cell — `HomeKpisWidget` still draws followers when it is handed a series
  // of two or more points — but nothing writes `clientFollowerSnapshots`, so the
  // page was reading that collection, running `resolveFollowerHistory` per
  // connected channel and threading four props into a cell that has never
  // rendered for anybody. The read comes back with the ingestion cron that gives
  // it something to say, in one place, beside a test.
  /**
   * How many channels are dead (2026-09).
   *
   * All that survives of the KPI card's per-channel list, which was the SECOND
   * copy of "Connected channels" and was removed in the de-duplication pass
   * (see HomeKpisWidget's own note). The detailed list stays on that card; the
   * number that asks somebody to DO something moves to "Needs your attention",
   * which ranks by exactly that.
   *
   * `integrationNeedsReconnect` rather than `!integrationIsUsable` — the same
   * predicate "Connected channels" counts its own "N need attention" with, so
   * the attention row and the detailed card cannot report different totals.
   */
  const channelsNeedingAttention = integrations.filter(integrationNeedsReconnect).length;
  const channelsHref = `/clients/${id}/settings?tab=settings`;

  // The KPI card's score meter and the full report share ONE buildScoreViews
  // call so the widget and the page can never quote different numbers for the
  // same snapshot. Same rule for buildPresence and "SEO & AI visibility"
  // (the card renamed from "Where you stand", 2026-09).
  const scoreViews = seoGeo ? buildScoreViews(seoGeo) : [];
  // D6 kept exactly one of the three: "the overall Google/AI visibility
  // rank" is this view's own established label ("AI visibility today"), not
  // a new metric — search score and AI readiness stay on the full report only.
  const visibilityScore = scoreViews.find((v) => v.key === "visibility") ?? null;
  const presence = seoGeo ? buildPresence(seoGeo) : null;
  const reportHref = `/clients/${id}/settings?tab=reporting`;

  // The checklist SIGNAL ENGINE (Surface 08, lib/action-list.ts). Its widget is
  // gone from Home (see "Get set up" below) but the engine is not: five of the
  // ladder's six steps read their "done" through these same ids, so nobody's
  // stored progress resets. Signals are read fresh from data already in hand
  // this render; `actionStates` supplies the client-chosen
  // (dismissed/not_relevant) and event-tracked (12/13/14/21/22) rows that no
  // live signal can answer. See lib/action-list.ts for the full precedence rule
  // and the documented proxies (02/05/07/09).
  /**
   * RUNS AND OUTPUTS ARE COUNTED THE WAY THE CLIENT SEES THEM (review wave,
   * 2026-09), on BOTH branches, because staff in client context read the
   * client's own ladder.
   *
   * `jobs.length > 0` and `assets.length > 0` are the raw collections, and both
   * are full of work that is not the client's: a stand-up (launch) run and its
   * research write-up, and a Control Room test run and its draft. Karos binds an
   * agent and does exactly those two things BEFORE the client has done anything
   * at all — so the ladder ticked "Run your first agent" and "See your first
   * result" for a client who had never run one and had nothing to look at, which
   * is the checklist telling them they are finished and then leaving them on an
   * empty archive. A future-dated post has the same problem from the other end:
   * it exists, and the client provably cannot open it.
   *
   * Same two predicates the rest of the portal already uses — the run list's
   * `runType !== "launch" && !== "test"` (client-agent-rows.ts, and
   * `lastRunFailedAgentIds` for the badge) and the client library's own
   * projection, unlocked rows only.
   */
  const clientVisibleJobs = jobs.filter((j) => j.runType !== "launch" && j.runType !== "test");
  /**
   * "RUN YOUR FIRST AGENT" NEEDS A RUN THAT PRODUCED SOMETHING (round 6, §2.6).
   *
   * `clientVisibleJobs.length > 0` counted a FAILED run and a cancelled one, so
   * the step ticked for a client who had pressed the button and got nothing —
   * the checklist telling them the thing they are waiting for already happened.
   * `review` is the first status that means an output exists (the Karos review
   * queue); `approved` and `delivered` are the two beyond it.
   */
  const RUN_PRODUCED = new Set(["review", "approved", "delivered"]);
  const producedJobs = clientVisibleJobs.filter((j) => RUN_PRODUCED.has(j.status));
  /** The three named halves of "profile complete" (decision 2). */
  const profileFields = {
    category: Boolean(client.category?.trim()),
    // `client.description` alone, NOT `description || brief`: the brief is ours,
    // not theirs. The Brand Profile sheet pre-fills the About field with it so
    // the client confirms a sentence rather than writing one (§2.3).
    description: Boolean(client.description?.trim()),
    website: Boolean(client.website?.trim()),
  };
  const actionSignals: ActionSignals = {
    profileComplete: profileFields.category && profileFields.description && profileFields.website,
    hasGrantedAgent: (client.customAgentIds?.length ?? 0) > 0,
    grantedAgentCount: client.customAgentIds?.length ?? 0,
    hasRun: producedJobs.length > 0,
    runCount: clientVisibleJobs.length,
    // NO `hasOutput` (round 6, decision 8): action 05 is event-tracked now — the
    // client opened a deliverable — and "one exists" was only ever its proxy.
    hasStarredAgent: (client.starredAgentIds?.length ?? 0) > 0,
    hasUsableChannel: integrations.some((i) => integrationIsUsable(i)),
    connectedPlatformIds: integrations.filter((i) => integrationIsUsable(i)).map((i) => i.platform),
    // NOT PASSED: `hasManualCompetitor` (07), `seatCount` (11) and
    // `hasBillingConfigured` (24). All three are optional now, and the reads
    // behind them left this page with the widget that rendered them — see the
    // note in the Promise.all above.
  };
  const actionStatesById = new Map(
    actionStates.map((s) => [s.actionId, { status: s.status, updatedAt: s.updatedAt }]),
  );
  const resolvedActions = resolveActionList(actionSignals, actionStatesById, now);

  /* ── "Get set up": Home's ONE list (portal feedback round 4, 2026-09) ──
   *
   * TWO WIDGETS BECAME ONE, and the other two lists are gone from this page:
   *
   *  · "Next actions" (ActionListWidget) rendered lib/action-list.ts's 24 rows
   *    three at a time behind a "See all 24" expander. The product owner's
   *    verdict on the expanded state was that it "looks bad" — a wall of greyed
   *    done rows — and the audit found worse: three of the 24 (03, 08, 24) can
   *    only be completed by Karos staff, so a client was being asked to do
   *    things the product gives them no way to do.
   *  · "Recommended tasks" (RecommendedTasksWidget) rendered the onboarding
   *    swarm's CONTENT IDEAS. They are not setup steps and are not linked to an
   *    agent by construction. The ruling: what Home recommends is a fixed,
   *    small set of setup steps that get the client to a first result with our
   *    agents, ordered per client at onboarding. The ideas still render on the
   *    Calendar with their inferred dates, and the `?task=` kickoff strip still
   *    turns one into a run — they left HOME, not the product.
   *
   * The signals underneath are UNCHANGED: five of the six steps reuse the
   * action-list ids the portal already stores state for (01, 21+22, 04, 05), so
   * nobody's existing progress resets and there is no ClientActionState
   * migration. lib/action-list.ts stays as the signal engine.
   */
  const clientActions = toClientActions(
    resolvedActions,
    client.id,
    // Staff read this page for ONE client, so their calendar rows have to be
    // scoped; the flat route resolves to the cross-client overview for them.
    isClientViewer ? {} : { calendarHref: `/clients/${id}/calendar` },
  );
  const actionById = new Map(clientActions.map((a) => [a.id, a]));
  // "not_relevant" counts as complete on purpose: a client who has already told
  // us a row does not apply to them must not be asked the same question again
  // under a new heading. It is the one permanent skip in the portal and the
  // ladder honours it rather than reopening it.
  const actionDone = (actionId: string): boolean => {
    const status = actionById.get(actionId)?.status;
    return status === "done" || status === "not_relevant";
  };
  const profileTabHref = `/clients/${id}/settings?tab=profile`;
  const agentsHref = `/clients/${id}/agents`;

  /**
   * Step 3's candidates: this client's granted agents, in the plan's own order.
   *
   * Resolved through `railAgentsForClient` rather than a filter written here —
   * the one helper that answers "which agents does this client have", and the
   * reason the rail and the roster cannot disagree about it. It applies the
   * BINDING filter (`agentKeyMatchesClientSlug`: a per-client instance baked
   * under another client's lab folder is never this client's agent), drops
   * paused agents (their card is badged "Coming Soon" and carries no setup
   * affordance, so telling a client to set one up would send them to a page
   * with nothing to do on it) and drops the structural sub-agents that are
   * steps of another agent rather than products of their own.
   *
   * Then intersected with `customAgentIds` — the helper also admits a STARRED
   * agent that was never granted, which is a pin, not a product this client can
   * run — and re-ordered by it, because that array is the plan's own order and
   * is what the ladder's ties break on.
   *
   * Readiness comes from the SAME `buildAgentSetup` the roster and the agent
   * detail page ask, so the ladder cannot claim an agent is set up when the
   * submit core would refuse its run (or the reverse). Skipped entirely when
   * this client has no grants yet — Karos has not finished their setup, and the
   * call would be per-agent Firestore reads for an empty list.
   */
  const railAgentById = new Map(
    railAgentsForClient(allCustomAgents, client).map((a) => [a.id, a]),
  );
  const grantedAgents = (client.customAgentIds ?? [])
    .map((agentId) => railAgentById.get(agentId))
    .filter((a): a is NonNullable<typeof a> => Boolean(a));
  const agentSetup =
    grantedAgents.length > 0
      ? await buildAgentSetup(
          id,
          grantedAgents.map((a) => ({ id: a.id, key: a.key })),
        )
      : {};
  const umbrellaByCustomAgentId = new Map(umbrellas.map((u) => [u.customAgentId, u]));
  /**
   * IS THIS AGENT LIVE? ASKED OF THE ONE ASSEMBLER (risk-review B3, then round 6
   * review C1/C3).
   *
   * This page used to test `launchState === "live"` on its own, which is the
   * logic bug the round-6 brief names: an agent whose posts fill the client's
   * calendar every day has no schedule and no umbrella launch state of its own,
   * so the ladder said "We are setting up your first agent" over a week of their
   * content. B3 replaced that with a `rosterStatus` call — and left this page
   * assembling that function's order-sensitive inputs by hand, as a FOURTH
   * assembly, missing `hasDelivered`. So a client with a delivered post and a
   * future draft still read "We are setting up your first agent" on Home while
   * their roster said "Live" (review finding C1).
   *
   * The rows come from `buildClientRosterEntries` now — the same call the Agents
   * page and Reporting read — so the ladder gets the WORD those surfaces show
   * rather than a private re-derivation of it. `withRowFacts: false`: the ladder
   * reads one boolean per agent and prints no titles or dates.
   *
   * NO NEW READS. All five inputs are already in this page's `Promise.all`
   * above, and `agentSetup` is handed over as a cache so the intake reads
   * `buildAgentSetup` makes are not made twice (ruling 8).
   */
  const rosterEntries = await buildClientRosterEntries({
    clientId: id,
    client,
    // The seat gate (round 6 review, D3), and the same viewer the client
    // library projection above uses.
    viewer: { role: user.role, seatId: user.seatId, isGroupAdmin: user.isGroupAdmin },
    withRowFacts: false,
    now,
    data: {
      allAgents: allCustomAgents,
      jobs,
      plannedRuns: scheduledRuns,
      umbrellas,
      assets,
      agentSetup,
    },
  });
  const rosterByAgentId = new Map(rosterEntries.map((entry) => [entry.customAgentId, entry]));
  const ladderCandidates: SetupLadderAgentCandidate[] = grantedAgents.map((agent) => {
    const setup = agentSetup[agent.id];
    return {
      id: agent.id,
      name: agent.name,
      setupHref: agentSetupHref(id, agent),
      // The run gesture lives ONLY on the agent's own detail page, for either
      // role — the roster states that rule in its own comments.
      runHref: `/clients/${id}/agents/${agent.id}`,
      selfServe: familyHasIntakePage(setupLadderFamily(agent)),
      setupReady: Boolean(setup?.ready && setup?.standUpDone),
      // The two rungs separately, so step 3 can name the one that is missing
      // instead of sending a client back to a form they already filled in.
      hasIntake: Boolean(setup?.ready),
      standUpDone: Boolean(setup?.standUpDone),
      // The roster's own word. An agent with no roster row at all reads NOT
      // live, which is the safe direction: step 3 stays a task rather than
      // ticking on an absence. (`railAgentsForClient` and the roster's candidate
      // filter ask the same three questions, so the sets agree today.)
      live: rosterByAgentId.get(agent.id)?.status.tone === "live",
      runLabel: agentRunLabel(agent),
      intakeLabel: setup?.clientLabel ?? `${agent.name} details`,
    };
  });
  /**
   * The order: the one stored at onboarding while it still describes this
   * client's plan, and a fresh rank when it does not.
   *
   * `rankSetupLadder` is pure and deterministic, so the fallback is not a
   * DIFFERENT behaviour for a client onboarded before the field existed — it is
   * the same answer, computed a moment later.
   *
   * `setupLadderOrderAt` HAS A READER NOW (review wave, 2026-09). It was written
   * by `completeOnboardingAction` and read nowhere, so its own docstring — "so a
   * later re-grant can tell a stale order from an absent one" — described an
   * intention. `resolveSetupLadderOrder` is that reader; see its note for the
   * two staleness rules. `grantedAt` is the bound umbrella's `createdAt`, the
   * closest thing to a per-grant instant the data records (nothing stamps
   * `customAgentIds` itself), and it is what catches a grant that was revoked and
   * given back under a new plan.
   */
  const setupLadderOrder = resolveSetupLadderOrder({
    agents: grantedAgents.map((a) => ({ id: a.id, key: a.key, name: a.name })),
    category: client.category,
    socialLinks: client.socialLinks,
    connectedPlatformIds: actionSignals.connectedPlatformIds,
    starredAgentIds: client.starredAgentIds,
    website: client.website,
    brandVoice: client.brandVoice,
    storedOrder: client.setupLadderOrder,
    storedOrderAt: client.setupLadderOrderAt,
    grantedAt: new Map(
      grantedAgents
        .map((a) => [a.id, umbrellaByCustomAgentId.get(a.id)?.createdAt] as const)
        .filter((entry): entry is readonly [string, number] => entry[1] != null),
    ),
  });
  /**
   * WHICH DELIVERABLE "Open your first post" OPENS (round 6, decision 8).
   *
   * The newest row of the CLIENT ARCHIVE, not of the library: `?asset=` opens
   * the archive's own detail modal, and the archive drops drafts, future-dated
   * posts and anything older than 30 days by construction. Linking a row that
   * list provably excludes would land the client on a screen with no such item
   * on it — the one thing `isInClientArchive` exists to prevent. Already
   * sorted newest-first by the same helper the calendar's archive uses, so
   * `[0]` is the same row that list will show at the top.
   */
  const newestArchived = getClientArchiveAssets(assets, {
    now,
    viewer: { role: user.role, seatId: user.seatId, isGroupAdmin: user.isGroupAdmin },
  })[0];
  /**
   * STEP 5'S SECOND HALF: WORK THE PORTAL CAN NO LONGER SHOW (round 6 review,
   * C4/C5).
   *
   * Action 05 is an EVENT — the client opened a deliverable, written when the
   * archive modal opens — so no client alive on ship day had ever recorded one.
   * The first answer to that was a fixed grandfather date
   * (`RESULT_STEP_LEGACY_BEFORE`), which is a fact about OUR release timeline
   * and read as one: it ticked step 5 for a client who had never opened
   * anything, and it went stale the moment the date passed, at which point a
   * client with one three-month-old post was told forever to "open what came
   * back" from a Workspace that no longer lists it.
   *
   * The honest question is about the CLIENT'S ARCHIVE, and it does not go stale:
   * a non-draft posted deliverable older than the window is one
   * `getClientArchiveAssets` will not show them, so the step cannot be asked.
   * `published` is the only status the archive ages out (`isInClientArchive` —
   * approved, scheduled and delivered work stays until the client marks it
   * posted), so it is the only one this can be true of.
   *
   * Derived on read from the projection computed above — this page writes
   * nothing to Firestore — so it costs no read and no second clock.
   */
  const agedOutDeliverable = clientVisibleAssets.some(
    (a) => a.status === "published" && clientDeliveryStamp(a) < now - CLIENT_ARCHIVE_WINDOW_MS,
  );
  // Staff read this page for ONE client, so the flat route (which scopes itself
  // to the VIEWER's own client) is rewritten the same way `toClientActions`
  // rewrites the checklist's calendar rows.
  const calendarBase = isClientViewer ? "/calendar" : `/clients/${id}/calendar`;
  const setupSteps = resolveSetupLadder({
    profileDone: actionDone("01"),
    profileHref: actionById.get("01")?.href ?? profileTabHref,
    profile: profileFields,
    // Two ids, one step: brand voice and target persona are one gesture (both
    // are context documents read from the same place), spelled as two rows.
    // `present` is what keeps the step honest while the pipeline is still
    // writing them — an unwritten document is not an unread one.
    brandVoice: {
      present: hasReadableClientDoc(contextDocs, "brand-voice"),
      confirmed: actionDone("21"),
    },
    audience: {
      present: hasReadableClientDoc(contextDocs, "target-audience"),
      confirmed: actionDone("22"),
    },
    agent: pickSetupLadderAgent(ladderCandidates, setupLadderOrder),
    agentsHref,
    runDone: actionDone("04"),
    // TWO FACTS, one rule, and the rule lives in `resolveSetupLadder`.
    resultOpened: actionDone("05"),
    agedOutDeliverable,
    resultHref: `${calendarBase}?view=archive${newestArchived ? `&asset=${newestArchived.id}` : ""}`,
    // Only an item the archive will actually SHOW arms the button (alignment
    // fix 1). Same list `resultHref` points into, so the two cannot disagree.
    resultReady: Boolean(newestArchived),
  });
  /**
   * WHEN THE FINISHED CARD STAYS HIDDEN, AND FOR WHOM.
   *
   * TWO CONDITIONS, and both are about the FINISHED card (round 6, decision 9,
   * corrected in the review pass):
   *
   *  · THE STORED ROW, read WITHOUT `ACTION_DISMISS_COOLDOWN_MS`. That window is
   *    the checklist's seven-day snooze, and applying it here brought a card
   *    whose own copy says "You're set up" back onto the dashboard every week.
   *    The press is "Done" now, and done is not a snooze.
   *  · AND THE LADDER STILL BEING COMPLETE. This conjunct was removed in the
   *    same change and should not have been: decision 9 says the SLOT STAYS
   *    EMPTY after completion, not that an incomplete ladder stays hidden. Grant
   *    a client a second agent and the ladder legitimately reopens with real
   *    steps in it — with the conjunct gone, that client was never told, on the
   *    one surface built to tell them (review finding C6).
   *
   * What the conjunct was removed to guard against was step 5 un-ticking for
   * every existing client on ship day; that is fixed at the source instead
   * (`agedOutDeliverable` above), so the reopen only fires on real outstanding
   * work.
   *
   * The legacy `not_relevant` row is still honoured: clients who pressed Hide
   * before the row's meaning changed are not shown the card again either.
   */
  const ladderHiddenState = actionStatesById.get(SETUP_LADDER_HIDDEN_ACTION_ID);
  const ladderDismissed =
    ladderHiddenState?.status === "not_relevant" || ladderHiddenState?.status === "dismissed";
  const ladderHidden = ladderDismissed && setupLadderComplete(setupSteps);
  // ONE element, mounted by both branches below — the parity rule for this page.
  const getSetUpWidget = (
    <GetSetUpWidget
      clientId={client.id}
      steps={setupSteps}
      hidden={ladderHidden}
      // Staff read this card in client context but do not get its one control:
      // it writes a row against somebody else's account, and whether a client's
      // own onboarding card is on their dashboard is the client's call.
      canHide={isClientViewer}
    />
  );

  // Newest job, for the ops strip's "Last run" caption. `jobs[0]` because
  // `listJobs` already returns them newest-first (data.ts sorts by `createdAt`
  // descending) — the local re-sort was a second, quieter statement of the same
  // order (review wave, 2026-09). Staff-only reader — a client's dashboard may
  // not carry the batch timestamp (the churn rule; see ClientAnalyticsStats'
  // note), and HomeOpsStrip is never mounted for them.
  const lastJob = jobs[0];

  // ── Home's summary of the Search & AI visibility report ──
  //
  // THE FULL REPORT NO LONGER RENDERS ON THIS PAGE, FOR ANYONE (2026-08).
  //
  // Surface 09 moved it to Account Center's Reporting tab and took it off the
  // CLIENT branch — but the staff branch went on mounting <SeoGeoPanel/> whole,
  // with `hideScores={false} hidePlan={false}`, on the reasoning that staff
  // "reach it ONLY here". That stopped being true the moment the Reporting tab
  // shipped for staff too (settings/page.tsx builds it for every viewer), so
  // the consolidation had simply not been applied to this half of the file:
  // engine-by-engine breakdowns, the citation-source table and the question log
  // rendered on the dashboard AND one click away, and the dashboard is where a
  // person landed first.
  //
  // So Home carries two summaries and a link — score meters inside the KPI card
  // and the two share numbers in "SEO & AI visibility" — and the deep report has
  // exactly one address. Both summaries are projections of the same
  // buildScoreViews / buildPresence calls that page renders from, so this is
  // not a second copy of the report; it is the report's headline.
  const competitorsHref = `/clients/${id}/settings?tab=competitors`;
  const standing = presence && hasStanding(presence) ? (
    <HomeStandingWidget presence={presence} href={reportHref} competitorsHref={competitorsHref} />
  ) : null;

  /**
   * The KPI card's published-content cell, and where it opens.
   *
   * Both are new in the 2026-09 de-duplication pass — the cell replaces the
   * per-channel list that duplicated "Connected channels" (see HomeKpisWidget's
   * own note for the full argument, and lib/content-throughput.ts for why this
   * is the one metric of the four suggested that the product can actually
   * measure today).
   *
   * Fed `overviewAssets`, the projection every other widget on this page reads,
   * rather than the raw set: a client's numbers must not count a row their own
   * surfaces cannot show them.
   */
  const throughput = contentThroughput(overviewAssets, now);
  // "published" is in every reader's set — staff's Library and a client's
  // archive both hold it — so this never falls back. Asked through the shared
  // helper anyway, so the cell and the "Content by status" bars resolve one
  // spelling of the link between them.
  const publishedHref = contentStatusHref("published", id, isClientViewer) ?? reportHref;
  /**
   * Where the KPI cell's number opens, which is NOT `publishedHref` (review
   * wave, 2026-09).
   *
   * `contentThroughput` counts what reached an audience: `published` AND
   * `delivered` (a newsletter issue is delivered, never published — see
   * lib/content-throughput.ts). The cell linked to `?status=published`, so a
   * client counting six and landing on four had been handed a filter narrower
   * than the number above it, with nothing on either screen to explain the gap.
   *
   * Two ways to fix it, and this is the one that keeps the metric: WIDEN THE
   * DESTINATION to the unfiltered list, which contains every row the count
   * counted. Narrowing the COUNT to `published` was the alternative and it would
   * quietly stop counting every deliverable that never gets that status, which
   * is exactly the throughput this cell exists to report.
   */
  const throughputHref = isClientViewer ? "/calendar?view=archive" : `/clients/${id}/assets`;
  /**
   * Where "N deliverables in review" opens, when the reader has such a screen.
   *
   * Null for a client by construction, not by a branch written here: no client
   * surface lists a draft, and `contentStatusHref` answers that by asking
   * `client-state-domain` rather than by taking our word for it.
   */
  const draftsHref = contentStatusHref("draft", id, isClientViewer);

  /**
   * Where each KPI cell goes (portal feedback round 5, 2026-09).
   *
   * Every cell is a link now and the card-level "Full report" control is gone
   * (see HomeKpisWidget's own note). Each destination is chosen to show MORE
   * ABOUT THAT NUMBER rather than to be "the report":
   *
   *  • PUBLISHED → `throughputHref`, the deliverables themselves, in a list that
   *    contains every row the cell counted.
   *  • VISIBILITY → the Reporting tab AT ITS SCORES SECTION, when there is a
   *    snapshot for that section to render. The anchor is written by
   *    settings/page.tsx and it is written ONLY inside `seoGeo ? …`, so on an
   *    unmeasured account the fragment names nothing and the browser leaves the
   *    reader wherever the tab opens. The tab itself always renders (the panel's
   *    own empty state is what they get), so the cell keeps a destination —
   *    every cell on this card is a link by rule — and drops the anchor.
   *  • FOLLOWERS is not passed at all today; the cell hides itself. See the
   *    follower note above.
   */
  const visibilityHref = seoGeo ? `${reportHref}#visibility-scores` : reportHref;

  const kpis = (
    <HomeKpisWidget
      throughput={throughput}
      visibilityScore={visibilityScore}
      contentHref={throughputHref}
      visibilityHref={visibilityHref}
    />
  );

  /**
   * The retired five tiles, as one line (staff only — see HomeOpsStrip).
   *
   * Four of the five survive; "Channels" does not. It was a bare integer whose
   * only interesting question — is any of them broken? — the KPI card answers
   * properly now, and repeating the total beside it would be the duplication
   * this pass exists to remove. "Awaiting review" is new and is the one number
   * on the old row that was genuinely missing: it is the only counter here that
   * asks somebody to DO something, which is why it is the only one that tints.
   */
  const opsStats: OpsStat[] = [
    {
      label: "Awaiting review",
      value: assets.filter((a) => a.status === "draft").length,
      // Filtered since 2026-09: the queue link now lands on the queue rather
      // than on the whole library with the drafts somewhere in it. Same helper
      // the attention row and the chart use, so the three cannot disagree.
      href: draftsHref ?? `/clients/${id}/assets`,
      warnWhenNonZero: true,
    },
    {
      // "Upcoming", not "Scheduled" (2026-09). The predicate above now admits
      // every forward-looking kind the calendar shows — a booked post, a
      // placeholder, a dated draft — so a tile labelled with one of the three
      // statuses would be naming a subset of what it counts. The number and
      // the calendar it links to now agree, which is the point of the change.
      label: "Upcoming",
      value: assets.filter(isUpcoming).length,
      // Staff-only strip (see HomeOpsStrip below) — scoped to this client's
      // own calendar, not the flat /calendar route, which resolves to the
      // cross-client overview for a staff viewer (calendar-body.tsx's
      // `isClient` branch is the only one that scopes the flat route, and it
      // keys off `user.clientId`, which a staff viewer here doesn't have).
      href: `/clients/${id}/calendar`,
    },
    {
      label: "Published",
      value: assets.filter((a) => a.status === "published").length,
      href: publishedHref,
    },
    { label: "Deliverables", value: assets.length, href: `/clients/${id}/assets` },
    {
      label: "Agent runs",
      value: jobs.length,
      href: "/jobs",
      ...(lastJob ? { hint: `Last run ${relativeTime(lastJob.createdAt)}` } : {}),
    },
  ];

  /**
   * THE STAFF DASHBOARD GOT THE SAME TREATMENT AS THE CLIENT ONE (2026-08).
   *
   * It was "the plain single stack: the operator's read-everything view", which
   * in practice meant: five counter tiles, two chart cards, the entire SEO/GEO
   * report, then AI Insights. Three screens before anything a person could act
   * on, and the product owner's verdict was that most of it did not inform —
   * the counters are inventory, the status bars restate the counters, and the
   * report is a page that already exists elsewhere.
   *
   * So this branch is now the client's own information architecture with the
   * operator's extras added, rather than a different page. PARITY PASS
   * (2026-09, product owner: "the client portal doesn't look the same as when
   * the client actually signs in ... every single element should be pretty
   * much the same"): the shared part is now the client branch below, element
   * for element and in the client's order -
   *
   *   1. alerts        — processing banner, welcome line, Task Map / gap nudge
   *   2. what's next   — Get set up + Calendar preview, side by side
   *   3. how we're doing — Your numbers (one card)
   *   4. where we stand — SEO & AI visibility (+ the admin Regenerate footer)
   *   5. attention     — Needs your attention + Recent activity, full width
   *
   * - and everything staff keep that a client does not (the ops strip, the
   * Performance charts, AI Insights) lives in ONE labelled staff-only block
   * under it, never interleaved with the shared cards. When the client branch
   * changes, this one changes with it.
   */
  if (!isClientViewer) {
    /**
     * REGENERATE MOVED OUT OF THE PAGE HEADER (2026-09).
     *
     * CD-G5 put it at client level, and it earned that: the pipeline rewrites
     * the documents AND the SEO/GEO intel, so the rail's documents header was
     * the wrong home for it. But "client level" got read as "the page header",
     * where it sat beside the word "Dashboard" as a lone button whose only
     * explanation was a `title` tooltip, three widgets above the numbers it
     * rewrites. The product owner's read was that it looked disconnected from
     * everything around it, and it was.
     *
     * It now sits in the footer of the SEO & AI visibility card: beside the
     * data it regenerates, with the sentence saying what it rebuilds and when
     * to reach for it in permanent view rather than on hover. Same modal, same
     * server action, same admin gate, same AI-processing lock; only the
     * placement changed, which is the same kind of move CD-G5 itself was.
     *
     * The admin gate stays HERE rather than moving into the widget: the widget
     * is mounted on a client's dashboard too, and a component that decides for
     * itself whether to render a staff control is one prop away from getting it
     * wrong. It is also what keeps this staff copy out of the client-copy
     * sweep's reach (channel 5 recognises `role === "KAROS_` as a staff gate).
     *
     * IT WEARS THE MARKER (review wave, 2026-09). This is the one staff control
     * that lives INSIDE a shared card rather than in the staff-only block below,
     * and it was styled exactly like the client's own card furniture — so an
     * admin previewing an account read a footer the client will never get with
     * nothing saying so, which is the precise confusion `StaffOnlySection`
     * exists to remove. Same frame, same caption grammar, one card deeper.
     */
    const regenerateFooter =
      user.role === "KAROS_ADMIN" ? (
        <StaffOnlySection
          label="Staff only · admin control"
          className="space-y-3 p-3 md:p-3.5"
        >
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="min-w-0 flex-1 text-xs leading-relaxed text-muted-2">
              Re-runs the Intel Report pipeline: it rebuilds this client&apos;s strategy
              documents and re-measures the SEO/GEO snapshot both numbers above come from.
              Reach for it after a positioning change, or when the snapshot has gone stale.
            </p>
            <RegenerateWorkspaceButton
              clientId={client.id}
              isAiProcessing={isAiProcessingLockActive(client)}
            />
          </div>
        </StaffOnlySection>
      ) : undefined;

    /**
     * Staff keep this card even with nothing measured, BECAUSE of that footer:
     * an unmeasured account is exactly when an operator wants the refresh, and a
     * control that disappears when there is no data is a control you cannot use
     * to GET data. An employee on an unmeasured account (no footer, no snapshot)
     * still gets nothing, which is the client rule — see `hasStanding`.
     *
     * Built here rather than reusing `standing`: that binding is the client's,
     * and it is gated on `hasStanding` alone.
     */
    const staffStanding =
      (presence && hasStanding(presence)) || regenerateFooter ? (
        <HomeStandingWidget
          presence={presence}
          href={reportHref}
          competitorsHref={competitorsHref}
          {...(regenerateFooter ? { footer: regenerateFooter } : {})}
        />
      ) : null;

    return (
      <>
        {/* CLIENT_USER gets this from the (app) shell's own wrapper, ABOVE the
            page; staff use the plain Sidebar shell with no such wrapper, so the
            page mounts it itself - in the same slot, before the welcome line,
            so the two views stack identically. */}
        <AiProcessingBanner client={client} isAdmin={user.role === "KAROS_ADMIN"} />
        {/* The client's own header, verbatim (portal feedback round 4,
            2026-09: the muted one-line welcome "doesn't look like a header").
            Same PageHeader every other page uses, same on both branches. */}
        <PageHeader
          title={firstName ? `Welcome back, ${firstName}` : "Welcome back"}
          description={`Here's what's happening across the ${client.name} workspace.`}
        />
        <div className="space-y-8">
          <section className="space-y-3">
            <p className="font-mono text-[10px] uppercase tracking-[0.08em] text-muted">
              Overview
            </p>
            {/* `@container` on an inner div, NOT on the section - same nesting
                as the client branch. With the container on the section itself,
                ClientHomeOverview's own `@4xl:grid-cols-2` resolved against the
                full-width section while the widget sat in a half-width track,
                and split its two cards again into four quarter-width columns
                (the 2026-08 "unreadable dashboard" defect, reintroduced by the
                staff branch alone). */}
            <div className="@container space-y-6">
              <div className="grid gap-6 @4xl:grid-cols-2">
                {/* "Get set up" is mounted for staff too (parity pass,
                    2026-09): the signals and the resolved steps are computed
                    unconditionally above, and action-list-actions.ts already
                    authorizes staff to write the ladder's one stored row for
                    any client - "View as Client at onboarding, or clearing one
                    up on a support call". The only staff-specific wrinkle is
                    the calendar destination, resolved in toClientActions. */}
                {getSetUpWidget}
                <CalendarPreviewWidget
                  upcoming={upcomingRows}
                  calendarHref={`/clients/${id}/calendar`}
                  /* R9 (flow audit 2026-09): the empty state's control. Same
                     roster route both branches use, so staff previewing this
                     page get the client's own empty state rather than a
                     shorter one. */
                  agentsHref={`/clients/${id}/agents`}
                  viewerIsClient={false}
                />
              </div>
              {kpis}
              {staffStanding}
              {/* Full width, after the numbers - the client's slot. `tasks` is
                  the real feed now: it used to be `[]` on the reasoning that
                  the attention rows linked to an owner-scoped board a staff
                  viewer would land on the wrong tab of, but that board is gone
                  (2026-08) and both rows are plain status lines today, so an
                  empty feed only made the card rank - and tint - differently
                  for staff than for the client looking at the same account. */}
              <ClientHomeOverview
                clientId={client.id}
                tasks={tasks}
                assets={overviewAssets}
                viewerIsClient={false}
                agentLabelByAssetId={agentLabelByAssetId}
                recentActivityLimit={3}
                tasksHitLimit={tasks.length >= TASK_FEED_LIMIT}
                channelsNeedingAttention={channelsNeedingAttention}
                channelsHref={channelsHref}
                // The page's own render clock, so this card ages a row against
                // the same instant the projection above was built with.
                now={now}
                // Staff CAN act on a draft — approval is theirs — so their
                // "N deliverables in review" row gets the destination a
                // client's provably cannot have. Same helper the chart below
                // writes its bars' links with. This is the one additive
                // control inside the shared cards, and the widget labels it.
                {...(draftsHref ? { draftsHref } : {})}
              />
            </div>
          </section>

          {/* ── The operator's extras, in ONE block below the client's page.
              Everything above this line is what the client sees, in the order
              they see it; everything inside this block is staff-only and says
              so, so a staff member previewing an account can tell at a glance
              which part of the screen the client will never get. ── */}
          <StaffOnlySection>
            <HomeOpsStrip stats={opsStats} />
            <div className="space-y-3">
              <p className="font-mono text-[10px] uppercase tracking-[0.08em] text-muted">
                Performance
              </p>
              {/* Built HERE, not above (review wave, 2026-09). The element
                  used to be constructed for every reader and mounted only by
                  this branch, so a client's render paid for a two-chart tree
                  nothing ever displayed - and the binding read as if the client
                  branch showed it too. Performance is staff-only (see the
                  client branch's own note: the charts moved to Account Center's
                  Reporting tab), so it is built inside the branch that shows
                  it. */}
              <ClientAnalytics
                clientId={client.id}
                // The unredacted set: staff read everything on their own branch
                // (invariant A10.6). It used to be handed `analyticsAssets`, a
                // binding whose comment said it withheld upcoming volume from a
                // client - true when this mounted for a client, and dead the
                // moment it stopped.
                assets={assets}
                jobs={jobs}
                integrations={integrations}
                // The chart names statuses, and this register is the staff one:
                // a client reads "Posted", staff read "Awaiting review"
                // (asset-status-copy's two registers).
                viewerIsClient={false}
                // The counter row is lifted out of this component on BOTH
                // branches now: a client's four tiles were lifted to the top of
                // Overview by CD-H1 and then retired by the portal revamp, and
                // staff's five became the one-line HomeOpsStrip above. Neither
                // branch may print them twice.
                hideStats
              />
            </div>
            <div className="space-y-3">
              <p className="font-mono text-[10px] uppercase tracking-[0.08em] text-muted">
                AI Insights
              </p>
              {/* Staff branch — agency overhead, never billed, so no price is
                  quoted here even though the refresh does spend Karos money. */}
              <AiInsights clientId={client.id} viewerIsBilled={viewerIsBilled} />
            </div>
          </StaffOnlySection>
        </div>
      </>
    );
  }

  // QA F99 - client dashboard, in value order: what needs the client now
  // (attention + recent), then how they're doing, then where they stand.
  // The full Search & AI visibility report moved off this page entirely
  // (Surface 09 reporting consolidation) — it lives on Account Center's
  // Reporting tab now, next to Competitors, so it has one home instead of
  // rendering here AND there. The oversized "Welcome back" banner - the
  // shallowest element on the page - becomes one line.
  //
  // AI INSIGHTS AND PERFORMANCE ARE GONE FROM THIS BRANCH (2026-08 UI/UX
  // pass). Both sat below everything actionable and restated numbers the
  // widgets above already show: AI Insights is a generated paragraph of the
  // same scores and channel state, and the status/channel charts are
  // inventory, not a next step. AI Insights stays on the STAFF branch below
  // (operators do read it, same viewerIsBilled gate as before); the two
  // <ClientAnalytics/> charts now mount in Account Center → Reporting instead
  // (settings/page.tsx's analyticsSection) — moved, not deleted. After this
  // cut the client Home is exactly: alerts → Get set up + Calendar Preview
  // → Your numbers → SEO & AI visibility → Recent activity. Nothing else belongs
  // here without a fresh product decision.
  return (
    <>
      <PageHeader
          title={firstName ? `Welcome back, ${firstName}` : "Welcome back"}
          description={`Here's what's happening across the ${client.name} workspace.`}
        />
      <div className="space-y-8">
        <section className="space-y-3">
          <p className="font-mono text-[10px] uppercase tracking-[0.08em] text-muted">Overview</p>
          {/* Portal revamp, Surface 02: the old Published/Scheduled/Channels/
              Deliverables tile row is gone — "Approved, Posted and Draft are
              deleted" (locked decision). Scheduled becomes the Calendar
              Preview widget below; Channels moves into the KPIs widget as
              connection badges; the rest is superseded by real numbers (D6)
              rather than activity counts. */}
          {/* `@container` (2026-08). Every grid inside these widgets sizes
              itself against THIS element now instead of the viewport, because
              the content column is the window minus a 288px rail — so a
              viewport-keyed `lg:` fired on a ~700px column and split it into
              two ~330px tracks, which is the unreadable dashboard in the
              product owner's capture. One declaration here makes every child's
              container query resolve against the width they are actually
              given, at any window size, zoom level or rail width. */}
          <div className="@container space-y-6">
            <div className="grid gap-6 @4xl:grid-cols-2">
              {getSetUpWidget}
              <CalendarPreviewWidget
                upcoming={upcomingRows}
                agentsHref={`/clients/${id}/agents`}
                viewerIsClient
              />
            </div>
            {kpis}
            {/* "SEO & AI visibility" replaced the old Reporting chip card here. The
                chips restated the three scores the KPI card now meters two
                inches above; these are the two numbers that were NOT anywhere
                on Home — how often the engines name you in an open category
                question, and how much of that conversation is yours. */}
            {standing}
            <ClientHomeOverview
              clientId={client.id}
              tasks={tasks}
              assets={overviewAssets}
              viewerIsClient={isClientViewer}
              agentLabelByAssetId={agentLabelByAssetId}
              recentActivityLimit={3}
              tasksHitLimit={tasks.length >= TASK_FEED_LIMIT}
              now={now}
              // The one thing the retired Channels cell said that the detailed
              // "Connected channels" card does not repeat on a client's Home:
              // that one of them is broken. It is an action, so it is on the
              // card that ranks actions. No `draftsHref` — a client has no
              // screen that lists a draft (F97 × F149).
              channelsNeedingAttention={channelsNeedingAttention}
              channelsHref={channelsHref}
            />
          </div>
        </section>
      </div>
    </>
  );
}
