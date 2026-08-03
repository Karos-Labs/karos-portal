import "server-only";

/**
 * Props builders for the X (e13), LinkedIn (e10) and Reddit (e15) intake
 * surfaces — the one place the Firestore intake docs, seats, ongoing drops and
 * run history are mapped into the client-safe views those components take. Both
 * the dedicated agent pages and the run dialog render the same surfaces, so the
 * mapping lives here rather than in either caller.
 *
 * `isStaff` decides whether a run row carries the /jobs/<id> link: that page
 * is staff-only, so client sessions get rows without an href.
 *
 * `jobs` lets a caller that already scanned this client's jobs hand that scan
 * over; without it each builder reads the jobs itself, so callers that have no
 * scan of their own stay unchanged.
 */

import type { ComponentProps } from "react";
import { notFound } from "next/navigation";
import {
  getAgentIntake,
  getAgentProfileDocData,
  getCustomAgentByKey,
  listAgentIntake,
  listClientSeats,
  listCustomAgents,
  listJobs,
  listLiDraftFeedback,
  listRedditDraftFeedback,
  listXDraftFeedback,
  listXNewsUpdates,
  listXTakes,
} from "@/lib/data";
import {
  agentKeyMatchesClientSlug,
  isLinkedInAgentIdentity,
  isRedditAgentIdentity,
  isXAgentIdentity,
} from "@/lib/custom-agent-launch";
import type { AgentProfileScopeFields } from "@/lib/data";
import type {
  LinkedInAgentIntake,
  LiIntakeView,
  LiRunRowView,
  LiSeatView,
} from "@/components/linkedin-agent-intake";
import type {
  RedditAgentIntake,
  RedditIntakeView,
  RedditRunRowView,
} from "@/components/reddit-agent-intake";
import type {
  XAgentIntake,
  XIntakeView,
  XRunRowView,
  XSeatView,
} from "@/components/x-agent-intake";
import { collapseRunsPerDay } from "@/lib/client-run-rows";
import { refLaneLabel } from "@/lib/draft-lane-label";
import type { AgentIntake, Job } from "@/lib/types";

export type XAgentIntakeProps = ComponentProps<typeof XAgentIntake>;
export type LinkedInAgentIntakeProps = ComponentProps<typeof LinkedInAgentIntake>;
export type RedditAgentIntakeProps = ComponentProps<typeof RedditAgentIntake>;

/**
 * Which key predicate answers for which intake family.
 *
 * A RECORD keyed by the union rather than an if-chain, so widening
 * `AgentIntake["agent"]` is a type error here instead of a fourth family
 * silently inheriting whichever branch happened to be last.
 */
const IDENTITY_BY_FAMILY: Record<AgentIntake["agent"], (key: string) => boolean> = {
  x: isXAgentIdentity,
  linkedin: isLinkedInAgentIdentity,
  reddit: isRedditAgentIdentity,
};

/**
 * The grant rung for an intake page, AND this client's own agent page for that
 * family — one call, because they are one read and because the second must not
 * be obtainable without the first (#82, #114).
 *
 * WHY THEY ARE THE SAME FUNCTION rather than a gate the page remembers to call.
 * The agent DETAIL route refuses a client who was neither granted this agent nor
 * already delivered by it, and gives "not granted" and "does not exist" the same
 * answer on purpose ("a client probing ids must not learn which agents the lab
 * has"). The three intake pages had no such rung, so a client who typed
 * `/clients/<their id>/x-agent` reached a form for an agent they do not have and
 * could write an intake document nothing would ever read. Making the refusal a
 * separate statement each page has to remember is the shape that produced the
 * gap; here the ONLY way to the header control's destination is through the
 * refusal, so a fourth intake page cannot render the control without it.
 *
 * WHAT IT ASKS, per rung, and why the two rungs use different sets:
 *
 *  - The GATE asks whether this client has an enabled, granted agent of this
 *    FAMILY — deliberately without the per-client instance filter. It is the
 *    coarser question ("do they have an X agent at all"), and being coarser is
 *    the safe direction for a gate: it cannot 404 a client whose granted
 *    instance happens not to match their lab slug.
 *  - The PAGE ID keeps the instance filter (`agentKeyMatchesClientSlug`, the same
 *    predicate the agents page and the submit core use), so the control can never
 *    point a client at another client's per-client instance. Null is not a
 *    refusal: `intakePageAction`'s fallback is an honestly-labelled link to the
 *    roster.
 *
 * `runs` is the detail route's `hasDelivered` rung at family grain, and it is
 * passed as the ROWS rather than as a boolean so "any?" is asked in one place.
 * Non-emptiness is the one property of that list the display projection cannot
 * change: `toRunRowViews` collapses a client's rows per day and caps them at 8,
 * and neither can turn a non-empty job set into no rows. (Contrast
 * `anyRunInFlight` below, which is a predicate the collapse CAN flip and is
 * therefore answered from the unfiltered scan.)
 *
 * TWO RESIDUALS, because an overstated guarantee is worse than a stated one:
 *  - `hasDelivered` on the detail route also counts LAB-IMPORTED assets, which
 *    carry no job. A client whose grant was withdrawn and whose only work from
 *    this family was imported can open that agent's detail page and will now get
 *    a 404 from the intake links on it. Closing that needs the asset join
 *    (`agentsWithDeliveredWork`), which is four more reads per intake page.
 *  - This is the rung on the PAGES. The save actions
 *    (`saveRedditCompanyIntakeAction` and friends) still stop at
 *    `requireClientAccess`, so a client who posts the action directly still
 *    writes the document. Those files are not this change's to edit.
 */
export async function requireIntakeAgentAccess(args: {
  family: AgentIntake["agent"];
  isStaff: boolean;
  clientSlug: string | null | undefined;
  grantedAgentIds: readonly string[] | null | undefined;
  /** This family's run rows for this client, exactly as the view built them. */
  runs: readonly unknown[];
}): Promise<string | null> {
  const granted = new Set(args.grantedAgentIds ?? []);
  const matchesFamily = IDENTITY_BY_FAMILY[args.family];
  const family =
    granted.size === 0
      ? []
      : (await listCustomAgents()).filter(
          (agent) => agent.enabled && granted.has(agent.id) && matchesFamily(agent.key),
        );
  // Same refusal as the detail route, and the same two rungs: granted, or this
  // family has already worked for them. Staff reached this line through
  // requireVisibleClient, which is their gate.
  if (!args.isStaff && family.length === 0 && args.runs.length === 0) notFound();
  return family.find((agent) => agentKeyMatchesClientSlug(agent.key, args.clientSlug))?.id ?? null;
}

/**
 * The run rows a viewer may see — the same treatment on all three surfaces.
 *
 * Staff get the runs themselves, newest first, each linking to /jobs/<id>: the
 * generation instant and the per-run granularity are the facts they debug with.
 *
 * A client gets what the Workspace timeline already gives them (A3/A4): ONE row
 * per calendar day, stamped at that day's last fire, because a fire produces a
 * week of drafts and four rows carrying the same date state outright that the
 * week came out of one minute. Failures stay one row each — a run that could
 * not finish is a distinct event, and its badge is the only place this card
 * says so — which is exactly how clientEventsFromJobs splits them.
 *
 * The row shape is identical across X, LinkedIn and Reddit, so it is built
 * once; each surface's own RunRowView type is structurally this.
 *
 * @param jobs newest-first, already filtered to this agent's runs.
 */
function toRunRowViews(
  jobs: Job[],
  isStaff: boolean,
): Array<{ id: string; status: Job["status"]; createdAt: number; href?: string }> {
  const rows = isStaff ? jobs : collapseRunsPerDay(jobs);
  return rows.slice(0, 8).map((j) => ({
    id: j.id,
    status: j.status,
    createdAt: j.createdAt,
    ...(isStaff ? { href: `/jobs/${j.id}` } : {}),
  }));
}

/**
 * The statuses that mean the agent service is holding a run of this agent right
 * now — it already has its own copy of the payload and the portal has no recall
 * channel.
 */
const IN_FLIGHT_STATUSES: ReadonlySet<Job["status"]> = new Set<Job["status"]>([
  "queued",
  "running",
]);

/**
 * Is one of this agent's runs queued or working?
 *
 * ASKED OF THE JOBS, never of the rows `toRunRowViews` returns, and that is the
 * whole point of it living here. A client's rows are collapsed to ONE per
 * calendar day (newest kept, failures exempt), so a run queued at 09:00
 * disappears from that list the moment a later run the same day lands in any
 * non-failed state — and a fire producing a week of drafts is exactly why the
 * collapse exists. Derived in the browser from the collapsed list, "a run is in
 * flight" therefore answered TRUE for staff, whose rows are not collapsed, and
 * FALSE for the client — who is the only viewer the seat-removal confirm is
 * written for (#84): they are the one who presses Remove and the one who has to
 * be told a run already has that person's details.
 *
 * So it is answered once, on the server, from the unfiltered scan, and travels
 * as its own prop. The collapse is a display decision; this is not, and it must
 * not be re-derived from a display list.
 */
function anyRunInFlight(jobs: readonly Job[]): boolean {
  return jobs.some((j) => IN_FLIGHT_STATUSES.has(j.status));
}

/**
 * Which draft a feedback row was written against, as its reader may see it.
 *
 * `draftRef` is stored raw on purpose — it is the feedback log's join key, and
 * the agent reads those rows back verbatim — but raw it is the lab's own
 * vocabulary: "Albert Kattan (seat 1, handle pending) · Avenue 3 ·
 * News-reaction (live)". Two of the three surfaces printed it as-is, so a
 * client's recent-feedback list read "Company page · feedback · Avenue 3 ·
 * News-reaction (live) · 2 days ago" (#87).
 *
 * Humanised HERE, once, for all three surfaces rather than in three components:
 * one rule needs one home, and this one is on the server, so the raw ref is
 * ABSENT from the payload instead of merely unpainted. The row carries the label
 * only when there is a lane to name — the segment is optional in the copy.
 */
function draftLabelOf(row: { draftRef?: string }): { draftLabel?: string } {
  const label = row.draftRef ? refLaneLabel(row.draftRef) : null;
  return label ? { draftLabel: label } : {};
}

/**
 * Strip an intake doc + its profile-doc scope (handle/off-limits/come-across,
 * now stored in clientContextDocs — see upsertAgentProfileScope) to the
 * client-safe X view. `intake` alone still carries roster/premium.
 *
 * EXPORTED for AF-7, and that export is load-bearing rather than convenience.
 * The agent detail page renders these answers inline (Albert: "your X details
 * — this is a button here, but realistically it should show on this page"),
 * and the only safe way to do that is to read the SAME whitelist the intake
 * surface reads. A second projection of `AgentIntake` — a shared collection
 * carrying a uid, a private CV path and URL — would be a second set of rules
 * to keep in step, and the one that gets forgotten is the one that leaks.
 */
export function toXIntakeView(
  intake: AgentIntake | null,
  profile: AgentProfileScopeFields | null,
): XIntakeView | null {
  if (!intake && !profile) return null;
  return {
    // Profile doc first (x-agent-v2's home for these), the intake doc as the
    // legacy fallback — production still holds pre-migration intake docs whose
    // handle/off-limits never moved, and a view that ignored them would strip
    // a client's own saved answers from every surface that renders this.
    handle: profile?.handle ?? intake?.handle ?? null,
    ...(profile?.comeAcross ?? intake?.comeAcross
      ? { comeAcross: (profile?.comeAcross ?? intake?.comeAcross) as string }
      : {}),
    offLimits: profile?.offLimits ?? intake?.offLimits ?? "",
    roster: intake?.roster ?? [],
    ...(intake?.premium !== undefined ? { premium: intake.premium } : {}),
  };
}

/**
 * Strip an intake doc to the client-safe LinkedIn view (the CV itself stays
 * private — `cvName` is the uploaded file's NAME, never its path or its URL).
 * Exported for AF-7; see `toXIntakeView` for why the inline band reads this
 * rather than projecting the document again.
 */
export function toLiIntakeView(intake: AgentIntake | null): LiIntakeView | null {
  if (!intake) return null;
  return {
    handle: intake.handle ?? null,
    ...(intake.comeAcross ? { comeAcross: intake.comeAcross } : {}),
    offLimits: intake.offLimits ?? "",
    ...(intake.role ? { role: intake.role } : {}),
    ...(intake.focus ? { focus: intake.focus } : {}),
    ...(intake.fallbackKind ? { fallbackKind: intake.fallbackKind } : {}),
    ...(intake.fallbackText ? { fallbackText: intake.fallbackText } : {}),
    ...(intake.cvName ? { cvName: intake.cvName } : {}),
  };
}

export async function buildXAgentIntakeView(
  clientId: string,
  opts: { isStaff: boolean; jobs?: Job[] },
): Promise<XAgentIntakeProps> {
  const [seats, companyIntake, allIntake, news, takes, feedback, jobs, xAgent, profileData] = await Promise.all([
    listClientSeats(clientId),
    getAgentIntake(clientId, "x", null),
    listAgentIntake(clientId, "x"),
    listXNewsUpdates(clientId),
    listXTakes(clientId),
    listXDraftFeedback(clientId),
    opts.jobs ?? listJobs({ clientId }),
    getCustomAgentByKey("karos-x-agent"),
    getAgentProfileDocData(clientId, "x"),
  ]);

  const intakeBySeat = new Map(allIntake.filter((i) => i.seatId).map((i) => [i.seatId as string, i]));
  const seatViews: XSeatView[] = seats.map((seat) => ({
    id: seat.id,
    name: seat.name,
    slug: seat.slug,
    intake: toXIntakeView(intakeBySeat.get(seat.id) ?? null, profileData.seats[seat.id] ?? null),
    takes: takes
      .filter((t) => t.seatId === seat.id)
      .map((t) => ({ id: t.id, take: t.take, date: t.date, ...(t.topic ? { topic: t.topic } : {}) })),
  }));

  const xJobs: Job[] = jobs
    .filter(
      (j) =>
        j.agentId === "agent-service" &&
        j.external?.taskType === "custom" &&
        (xAgent ? j.agentName === xAgent.name : /\bX Agent\b/i.test(j.agentName)),
    )
    .sort((a, b) => b.createdAt - a.createdAt);

  const runs: XRunRowView[] = toRunRowViews(xJobs, opts.isStaff);

  return {
    clientId,
    company: toXIntakeView(companyIntake, profileData.company),
    seats: seatViews,
    news: news.map((n) => ({
      id: n.id,
      title: n.title,
      date: n.date,
      ...(n.type ? { type: n.type } : {}),
    })),
    feedback: feedback.slice(0, 12).map((f) => ({
      id: f.id,
      account: f.account,
      action: f.action,
      ...draftLabelOf(f),
      createdAt: f.createdAt,
    })),
    runs,
    runInFlight: anyRunInFlight(xJobs),
    isStaff: opts.isStaff,
  };
}

export async function buildLinkedInAgentIntakeView(
  clientId: string,
  opts: { isStaff: boolean; pageUrlSuggestion?: string; jobs?: Job[] },
): Promise<LinkedInAgentIntakeProps> {
  const [seats, companyIntake, allIntake, news, feedback, jobs] = await Promise.all([
    listClientSeats(clientId),
    getAgentIntake(clientId, "linkedin", null),
    listAgentIntake(clientId, "linkedin"),
    listXNewsUpdates(clientId),
    listLiDraftFeedback(clientId),
    opts.jobs ?? listJobs({ clientId }),
  ]);

  const intakeBySeat = new Map(allIntake.filter((i) => i.seatId).map((i) => [i.seatId as string, i]));
  const seatViews: LiSeatView[] = seats.map((seat) => ({
    id: seat.id,
    name: seat.name,
    slug: seat.slug,
    intake: toLiIntakeView(intakeBySeat.get(seat.id) ?? null),
  }));

  // The customAgents key is per client instance (karos-linkedin-company-<slug>),
  // so run history matches on the agent name rather than one fixed key.
  const liJobs: Job[] = jobs
    .filter(
      (j) =>
        j.agentId === "agent-service" &&
        j.external?.taskType === "custom" &&
        /linkedin/i.test(j.agentName),
    )
    .sort((a, b) => b.createdAt - a.createdAt);

  const runs: LiRunRowView[] = toRunRowViews(liJobs, opts.isStaff);

  return {
    clientId,
    ...(opts.pageUrlSuggestion ? { pageUrlSuggestion: opts.pageUrlSuggestion } : {}),
    company: toLiIntakeView(companyIntake),
    seats: seatViews,
    news: news.map((n) => ({
      id: n.id,
      title: n.title,
      date: n.date,
      ...(n.type ? { type: n.type } : {}),
    })),
    feedback: feedback.slice(0, 12).map((f) => ({
      id: f.id,
      account: f.account,
      action: f.action,
      ...draftLabelOf(f),
      createdAt: f.createdAt,
    })),
    runs,
    runInFlight: anyRunInFlight(liJobs),
    isStaff: opts.isStaff,
  };
}

/**
 * Strip an intake doc to the client-safe Reddit view. Exported for AF-7; see
 * `toXIntakeView` for why the inline band reads this rather than the document.
 */
export function toRedditIntakeView(intake: AgentIntake | null): RedditIntakeView | null {
  if (!intake) return null;
  return {
    handle: intake.handle ?? null,
    offLimits: intake.offLimits ?? "",
    ...(intake.accountHistory ? { accountHistory: intake.accountHistory } : {}),
    ...(intake.subreddits?.length ? { subreddits: intake.subreddits } : {}),
    ...(intake.offLimitsSubreddits?.length
      ? { offLimitsSubreddits: intake.offLimitsSubreddits }
      : {}),
    ...(intake.disclosurePosture ? { disclosurePosture: intake.disclosurePosture } : {}),
    ...(intake.mode ? { mode: intake.mode } : {}),
  };
}

export async function buildRedditAgentIntakeView(
  clientId: string,
  opts: { isStaff: boolean; jobs?: Job[] },
): Promise<RedditAgentIntakeProps> {
  const [companyIntake, feedback, jobs] = await Promise.all([
    getAgentIntake(clientId, "reddit", null),
    listRedditDraftFeedback(clientId),
    opts.jobs ?? listJobs({ clientId }),
  ]);

  // The Reddit agent is shared and unbound, so its key is fixed — but run
  // history matches on the agent NAME the way LinkedIn's does, so a future
  // per-client instance would show its runs here without another change.
  const redditJobs: Job[] = jobs
    .filter(
      (j) =>
        j.agentId === "agent-service" &&
        j.external?.taskType === "custom" &&
        /reddit/i.test(j.agentName),
    )
    .sort((a, b) => b.createdAt - a.createdAt);

  const runs: RedditRunRowView[] = toRunRowViews(redditJobs, opts.isStaff);

  return {
    clientId,
    company: toRedditIntakeView(companyIntake),
    feedback: feedback.slice(0, 12).map((f) => ({
      id: f.id,
      account: f.account,
      action: f.action,
      ...draftLabelOf(f),
      ...(f.subreddit ? { subreddit: f.subreddit } : {}),
      ...(f.reasonCode ? { reasonCode: f.reasonCode } : {}),
      createdAt: f.createdAt,
    })),
    runs,
    isStaff: opts.isStaff,
  };
}
