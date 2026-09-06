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
  listLiDirectionRequests,
  listLiDraftFeedback,
  listNewsletterDraftFeedback,
  listRedditDraftFeedback,
  listXDraftFeedback,
  listXNewsUpdates,
  listXTakes,
} from "@/lib/data";
import {
  BLOG_SETUP_V2_KEY,
  NEWSLETTER_SETUP_V2_KEY,
  REPUTATION_SETUP_KEY,
  agentKeyMatchesClientSlug,
  isUnlistedAgent,
  isBlogAgentIdentity,
  isLinkedInAgentIdentity,
  isNewsletterAgentIdentity,
  isRedditAgentIdentity,
  isReputationAgentIdentity,
  isXAgentIdentity,
} from "@/lib/custom-agent-launch";
import {
  LINKEDIN_SETUP_V2_KEY,
  hasLinkedInV2Setup,
  listLinkedInReadySeatIds,
} from "@/lib/agent-service/linkedin-agent-context";
import { hasNewsletterV2Setup } from "@/lib/agent-service/newsletter-agent-context";
import { hasBlogV2Setup } from "@/lib/agent-service/blog-agent-context";
import { hasReputationV2Setup, isReputationSetupInlinedForClient } from "@/lib/agent-service/reputation-agent-context";
import type { AgentProfileScopeFields } from "@/lib/data";
import type { BlogAgentIntake, BlogIntakeView } from "@/components/blog-agent-intake";
import type {
  ReputationAgentIntake,
  ReputationIntakeView,
} from "@/components/reputation-agent-intake";
import type {
  NewsletterAgentIntake,
  NewsletterIntakeView,
  NewsletterRunRowView,
} from "@/components/newsletter-agent-intake";
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
import {
  BLOG_RUN_CREDITS,
  CREDIT_COSTS,
  NEWSLETTER_RUN_CREDITS,
  REPUTATION_RUN_CREDITS,
} from "@/lib/credits";
import { collapseRunsPerDay } from "@/lib/client-run-rows";
import { refLaneLabel } from "@/lib/draft-lane-label";
import type { AgentIntake, Job } from "@/lib/types";

export type XAgentIntakeProps = ComponentProps<typeof XAgentIntake>;
export type LinkedInAgentIntakeProps = ComponentProps<typeof LinkedInAgentIntake>;
export type RedditAgentIntakeProps = ComponentProps<typeof RedditAgentIntake>;
export type NewsletterAgentIntakeProps = ComponentProps<typeof NewsletterAgentIntake>;
export type BlogAgentIntakeProps = ComponentProps<typeof BlogAgentIntake>;
export type ReputationAgentIntakeProps = ComponentProps<typeof ReputationAgentIntake>;

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
  newsletter: isNewsletterAgentIdentity,
  blog: isBlogAgentIdentity,
  reputation: isReputationAgentIdentity,
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
  //
  // THE UNLISTED FILTER IS NOT ON THIS RUNG, and putting it here was a mistake
  // worth naming: the gate is deliberately the coarser question ("do they have a
  // LinkedIn agent at all"), because being coarse cannot 404 a legitimate client
  // — and narrowing it 404'd exactly the client whose only LinkedIn agent is the
  // superseded e10 instance. It belongs on the DESTINATION below, which is the
  // rung that has to be precise.
  if (!args.isStaff && family.length === 0 && args.runs.length === 0) notFound();
  return (
    family.find(
      (agent) =>
        agentKeyMatchesClientSlug(agent.key, args.clientSlug) &&
        // The LinkedIn family has four keys and only one is the agent a person
        // means. Without this the header control could point at "LinkedIn Setup"
        // — a card nothing lists, whose page would then offer the data for an
        // agent the reader never chose. Null is not a refusal: `intakePageAction`
        // falls back to an honestly-labelled link to the roster.
        !isUnlistedAgent(agent),
    )?.id ?? null
  );
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
 * How long a queued or running job goes on counting as in flight.
 *
 * WHY THERE IS A BOUND AT ALL (review wave, 2026-09). `queued`/`running` are
 * written when a run is dispatched and moved only by the webhook, so a job whose
 * webhook never arrives — a service that died mid-run, a delivery dropped on a
 * deploy, an agent-service outage — stays `running` in Firestore for ever.
 * Unbounded, ONE such row is enough to:
 *
 *  · hide "Set it up" permanently, because a setup band reads `runInFlight ||
 *    fired` and its own press expiring changes nothing while the server keeps
 *    saying a run is going. The family then has no way to be set up at all, on
 *    the surface whose entire job is setting it up; and
 *  · pin a full-page `router.refresh()` every four seconds, for ever, against a
 *    job that ended hours ago. That is the exact defect SETUP_FIRE_GRACE_MS was
 *    written to fix, reintroduced through the server's half of the answer.
 *
 * TWO HOURS, and it is a ceiling rather than an estimate: a stand-up takes ~30
 * minutes and the longest agent run this portal dispatches is well inside an
 * hour, so a job still marked running after two is a row nobody is going to
 * update. The failure direction is deliberate — past the bound the reader gets
 * their control back and can press again, which costs a duplicate run at worst,
 * where the other direction costs them the product entirely.
 *
 * Measured from `updatedAt` (falling back to `createdAt`), so a long run that
 * reports progress keeps its clock; only a row nothing has touched ages out.
 */
export const IN_FLIGHT_MAX_AGE_MS = 2 * 60 * 60 * 1000;

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
 *
 * BOUNDED BY AGE — see IN_FLIGHT_MAX_AGE_MS for what an unbounded answer did to
 * the setup bands that read it.
 */
function anyRunInFlight(jobs: readonly Job[], now: number = Date.now()): boolean {
  return jobs.some(
    (j) =>
      IN_FLIGHT_STATUSES.has(j.status) &&
      now - (j.updatedAt ?? j.createdAt) < IN_FLIGHT_MAX_AGE_MS,
  );
}

/**
 * Is a SETUP run — the one a "Set it up" or "Build their voice" press starts —
 * queued or working right now?
 *
 * NARROWER THAN `anyRunInFlight`, and the difference is the point (review wave,
 * 2026-09). A seat's voice build sits on a family that is ALREADY set up, so the
 * family-wide answer it used to be handed counts ordinary post runs too: a
 * scheduled LinkedIn post going out held every seat card's press open for as
 * long as it ran, on a card that is not about that work at all.
 *
 * `runType: "launch"` is the whole test, and it is the submit side's own word
 * for this: every one of the four setup actions submits with it
 * (`runLinkedInSetupAction` and its three siblings), and no writer run carries
 * it.
 *
 * THE RESIDUAL, stated rather than smoothed over: this cannot tell WHICH seat a
 * setup run belongs to. The job document records the agent, the client and the
 * run type, and the identity travels in `briefValues` into the prompt — nothing
 * queryable. So one seat's voice build still holds another seat's press open
 * until it finishes. Closing that needs a seat id on the job, which is a
 * submit-core change; what this fixes is the far commoner case, where the run in
 * flight is not a setup at all.
 */
function setupRunInFlight(jobs: readonly Job[], now: number = Date.now()): boolean {
  return anyRunInFlight(
    jobs.filter((j) => j.runType === "launch"),
    now,
  );
}

/**
 * What one press of a family's setup band costs a billable client.
 *
 * FLOW AUDIT 2026-09, R3: the four "Set it up" buttons and LinkedIn's "Build
 * their voice" charged a full agent run and quoted nothing. The figure cannot
 * be a constant in the component — it is per agent (`CustomAgent.creditCost`,
 * set by an admin) with a per-family carried default — so it is resolved here,
 * on the server, from the SAME three inputs `submitCustomAgentJob` resolves
 * `runCost` from: the agent document's own override, then the family's carried
 * price, then the generic custom-agent rate. Quoting anything else would be a
 * number that is not the one at the till.
 *
 * The multiplier the submit core also applies is deliberately absent: a setup
 * run produces one thing and is submitted with no `chargeMultiplier`.
 */
async function setupRunCredits(agentKey: string, carriedDefault: number | null): Promise<number> {
  const agent = await getCustomAgentByKey(agentKey);
  return agent?.creditCost ?? carriedDefault ?? CREDIT_COSTS.customAgentRun;
}

/**
 * Whose money the price beside a metered control is, for this reader.
 *
 * `isBillableClientActor()` when the caller resolved it (the intake pages and
 * the agent detail page all have the session in hand); otherwise derived from
 * `isStaff`, which is the same answer for every reader except an admin in "View
 * as Client" — the divergence `simulationPrice` in lib/credits.ts already
 * writes down. Either way no billed actor is left un-quoted and no client is
 * shown a price they will not pay: an unbilled reader still sees the figure,
 * marked as the client's (see CreditPriceNote).
 */
function viewerIsBilledFrom(opts: { isStaff: boolean; viewerIsBilled?: boolean }): boolean {
  return opts.viewerIsBilled ?? !opts.isStaff;
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
  opts: { isStaff: boolean; jobs?: Job[]; viewerIsBilled?: boolean },
): Promise<XAgentIntakeProps> {
  const [seats, allIntake, news, takes, feedback, jobs, xAgent, profileData] = await Promise.all([
    listClientSeats(clientId),
    listAgentIntake(clientId, "x"),
    listXNewsUpdates(clientId),
    listXTakes(clientId),
    listXDraftFeedback(clientId),
    opts.jobs ?? listJobs({ clientId }),
    getCustomAgentByKey("karos-x-agent-v2"),
    getAgentProfileDocData(clientId, "x"),
  ]);

  // TAKEN OUT OF THE LIST THIS FUNCTION ALREADY HAS (review wave, 2026-09).
  // This was a tenth parallel read, `getAgentIntake(clientId, "x", null)`, over
  // the same collection and the same two `where` clauses as `listAgentIntake`
  // one line above it — the company row is simply the `seatId: null` member of
  // that list, and the seat map below already splits the same array on the same
  // field. Two queries for one document, on every render of the X surface and
  // again on every staff render of the agent detail page.
  //
  // `=== null`, not a loose check, because that is exactly what the query it
  // replaces matches: `where("seatId", "==", null)` finds documents whose field
  // is explicitly null and never one where it is absent, and `upsertAgentIntake`
  // always writes the field.
  const companyIntake = allIntake.find((i) => i.seatId === null) ?? null;
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
    viewerIsBilled: viewerIsBilledFrom(opts),
    isStaff: opts.isStaff,
  };
}

export async function buildLinkedInAgentIntakeView(
  clientId: string,
  opts: { isStaff: boolean; pageUrlSuggestion?: string; jobs?: Job[]; viewerIsBilled?: boolean },
): Promise<LinkedInAgentIntakeProps> {
  const [
    seats,
    allIntake,
    news,
    feedback,
    requests,
    readySeatIds,
    isSetUp,
    jobs,
    // The company stand-up and a seat's voice run are the SAME agent doc fired
    // with a different identity, so one figure answers for both controls.
    //
    // IN THE Promise.all, not after it (review wave, 2026-09). It was a serial
    // `await` on the line below, so every render of this surface paid a full
    // round trip to `getCustomAgentByKey` after nine parallel reads had already
    // finished — for a value that depends on none of them. Its five siblings
    // already fold it in; this was the one that did not.
    setupCost,
  ] = await Promise.all([
    listClientSeats(clientId),
    listAgentIntake(clientId, "linkedin"),
    listXNewsUpdates(clientId),
    listLiDraftFeedback(clientId),
    listLiDirectionRequests(clientId),
    listLinkedInReadySeatIds(clientId),
    hasLinkedInV2Setup(clientId),
    opts.jobs ?? listJobs({ clientId }),
    setupRunCredits(LINKEDIN_SETUP_V2_KEY, null),
  ]);

  // The company row out of the list this function already reads, not a second
  // query for it — see the same note in buildXAgentIntakeView above (review
  // wave, 2026-09).
  const companyIntake = allIntake.find((i) => i.seatId === null) ?? null;
  const intakeBySeat = new Map(allIntake.filter((i) => i.seatId).map((i) => [i.seatId as string, i]));
  const ready = new Set(readySeatIds);
  const seatViews: LiSeatView[] = seats.map((seat) => ({
    id: seat.id,
    name: seat.name,
    slug: seat.slug,
    intake: toLiIntakeView(intakeBySeat.get(seat.id) ?? null),
    voiceReady: ready.has(seat.id),
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
    // Open rows first (they are the live brief), then the recent covered ones as
    // the record of what was asked for. Capped like the feedback rail.
    directionRequests: [
      ...requests.filter((r) => r.status === "open"),
      ...requests.filter((r) => r.status === "covered").slice(0, 8),
    ].map((r) => ({
      id: r.id,
      account: r.account,
      request: r.request,
      date: r.date,
      status: r.status,
    })),
    isSetUp,
    feedback: feedback.slice(0, 12).map((f) => ({
      id: f.id,
      account: f.account,
      action: f.action,
      ...draftLabelOf(f),
      createdAt: f.createdAt,
    })),
    runs,
    runInFlight: anyRunInFlight(liJobs),
    // The seat cards' own answer — a voice build, not "anything LinkedIn is
    // doing". See setupRunInFlight.
    setupRunInFlight: setupRunInFlight(liJobs),
    setupCost,
    viewerIsBilled: viewerIsBilledFrom(opts),
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

/**
 * Strip an intake doc to the client-safe newsletter view.
 *
 * `preferredWeekday` is copied UNCONDITIONALLY, which every other field on every
 * one of these projections is not. The others use a conditional spread so an
 * absent answer stays absent; here absent and null are two different answers to
 * the same question and the difference is load-bearing — null is "the client
 * looked at this and has not chosen", which the framework requires be carried
 * rather than resolved into a default. A conditional spread would erase exactly
 * that distinction on its way to the browser.
 */
export function toNewsletterIntakeView(intake: AgentIntake | null): NewsletterIntakeView | null {
  if (!intake) return null;
  return {
    preferredWeekday: intake.preferredWeekday ?? null,
    ...(intake.espName ? { espName: intake.espName } : {}),
    ...(intake.audienceNote ? { audienceNote: intake.audienceNote } : {}),
    ...(intake.bannedPhrases?.length ? { bannedPhrases: intake.bannedPhrases } : {}),
    ...(intake.openComplianceNote ? { openComplianceNote: intake.openComplianceNote } : {}),
  };
}

export async function buildNewsletterAgentIntakeView(
  clientId: string,
  opts: { isStaff: boolean; jobs?: Job[]; viewerIsBilled?: boolean },
): Promise<NewsletterAgentIntakeProps> {
  const [companyIntake, feedback, isSetUp, jobs, setupCost] = await Promise.all([
    getAgentIntake(clientId, "newsletter", null),
    listNewsletterDraftFeedback(clientId),
    hasNewsletterV2Setup(clientId),
    opts.jobs ?? listJobs({ clientId }),
    setupRunCredits(NEWSLETTER_SETUP_V2_KEY, NEWSLETTER_RUN_CREDITS),
  ]);

  // Matched on the agent NAME the way LinkedIn's and Reddit's are, so the four
  // v2 skills all report into one history — a client asking "when did you last
  // work on my newsletter" means the product, not one of its steps.
  const newsletterJobs: Job[] = jobs
    .filter(
      (j) =>
        j.agentId === "agent-service" &&
        j.external?.taskType === "custom" &&
        /newsletter/i.test(j.agentName),
    )
    .sort((a, b) => b.createdAt - a.createdAt);

  const runs: NewsletterRunRowView[] = toRunRowViews(newsletterJobs, opts.isStaff);

  return {
    clientId,
    company: toNewsletterIntakeView(companyIntake),
    isSetUp,
    feedback: feedback.slice(0, 12).map((f) => ({
      id: f.id,
      action: f.action,
      ...(f.issueNumber ? { issueNumber: f.issueNumber } : {}),
      ...(f.reasonCode ? { reasonCode: f.reasonCode } : {}),
      createdAt: f.createdAt,
    })),
    runs,
    runInFlight: anyRunInFlight(newsletterJobs),
    setupCost,
    viewerIsBilled: viewerIsBilledFrom(opts),
    isStaff: opts.isStaff,
  };
}

/**
 * Strip an intake doc to the client-safe blog view. All five fields are the
 * client's own answers, so all five cross; the type exists so a field added to
 * `AgentIntake` for another family cannot reach a browser by riding the shared
 * document.
 */
export function toBlogIntakeView(intake: AgentIntake | null): BlogIntakeView | null {
  if (!intake) return null;
  return {
    ...(intake.internalDomains?.length ? { internalDomains: intake.internalDomains } : {}),
    ...(intake.toneNote ? { toneNote: intake.toneNote } : {}),
    ...(intake.audienceNote ? { audienceNote: intake.audienceNote } : {}),
    ...(intake.bannedTopics?.length ? { bannedTopics: intake.bannedTopics } : {}),
    ...(intake.cmsName ? { cmsName: intake.cmsName } : {}),
  };
}

export async function buildBlogAgentIntakeView(
  clientId: string,
  opts: { isStaff: boolean; jobs?: Job[]; viewerIsBilled?: boolean },
): Promise<BlogAgentIntakeProps> {
  const [companyIntake, isSetUp, jobs, setupCost] = await Promise.all([
    getAgentIntake(clientId, "blog", null),
    hasBlogV2Setup(clientId),
    opts.jobs ?? listJobs({ clientId }),
    setupRunCredits(BLOG_SETUP_V2_KEY, BLOG_RUN_CREDITS),
  ]);

  // Matched on the agent NAME the way its three siblings are, so all three blog
  // skills report into one history — a client asking "when did you last work on
  // my blog" means the product, not one of its steps.
  const blogJobs: Job[] = jobs
    .filter(
      (j) =>
        j.agentId === "agent-service" &&
        j.external?.taskType === "custom" &&
        /blog/i.test(j.agentName),
    )
    .sort((a, b) => b.createdAt - a.createdAt);

  return {
    clientId,
    company: toBlogIntakeView(companyIntake),
    isSetUp,
    runs: toRunRowViews(blogJobs, opts.isStaff),
    // Both from the unfiltered scan, never from the collapsed display rows —
    // see anyRunInFlight. The band uses it to keep its "this page updates
    // itself" promise across a reload (flow audit 2026-09, R1).
    runInFlight: anyRunInFlight(blogJobs),
    setupCost,
    viewerIsBilled: viewerIsBilledFrom(opts),
    isStaff: opts.isStaff,
  };
}

/**
 * Strip an intake doc to the client-safe reputation view. All five fields are
 * the client's own answers, so all five cross; the type exists so a field added
 * to `AgentIntake` for another family cannot reach a browser by riding the
 * shared document.
 */
export function toReputationIntakeView(
  intake: AgentIntake | null,
): ReputationIntakeView | null {
  if (!intake) return null;
  return {
    ...(intake.reviewSurfaces?.length ? { reviewSurfaces: intake.reviewSurfaces } : {}),
    ...(intake.reviewMarkets?.length ? { reviewMarkets: intake.reviewMarkets } : {}),
    ...(intake.reputationContext ? { reputationContext: intake.reputationContext } : {}),
    ...(intake.crisisRoutingTag ? { crisisRoutingTag: intake.crisisRoutingTag } : {}),
    ...(intake.responseNoGos?.length ? { responseNoGos: intake.responseNoGos } : {}),
  };
}

export async function buildReputationAgentIntakeView(
  clientId: string,
  opts: { isStaff: boolean; jobs?: Job[]; viewerIsBilled?: boolean },
): Promise<ReputationAgentIntakeProps> {
  // `isSetUp` is what the setup band keys off ("We need to set this up
  // first" / "Set it up"). For a client whose reputation agent routes to
  // agent-engine, setup is the run's own `00-roster-setup` pre-flight, so the
  // band has nothing to ask for and reads as set up — the roster row the
  // legacy predicate looks for is never written on that path.
  const [companyIntake, hasRosterRow, inlined, jobs, setupCost] = await Promise.all([
    getAgentIntake(clientId, "reputation", null),
    hasReputationV2Setup(clientId),
    isReputationSetupInlinedForClient(clientId),
    opts.jobs ?? listJobs({ clientId }),
    setupRunCredits(REPUTATION_SETUP_KEY, REPUTATION_RUN_CREDITS),
  ]);
  const isSetUp = hasRosterRow || inlined;

  // Matched on the agent NAME the way its four siblings are, so both
  // reputation skills report into one history: a client asking "when did you
  // last check my reviews" means the product, not its setup step. (The
  // standalone monthly-review manager that used to also match this regex was
  // retired 2026-08-29, SCRUM-377/T-B25a — its past runs, if any, still show
  // here by name; nothing new will.)
  //
  // Engine runs count too: on the engine path a pulse is a `jobs` row with
  // `agentId: "agent-engine"` and the product id, not an agent-service task,
  // and a client who has only ever run there would otherwise read "never".
  const reputationJobs: Job[] = jobs
    .filter(
      (j) =>
        (j.agentId === "agent-service" &&
          j.external?.taskType === "custom" &&
          /reputation/i.test(j.agentName)) ||
        (j.agentId === "agent-engine" && j.agentEngineProductId === "reputation-agent"),
    )
    .sort((a, b) => b.createdAt - a.createdAt);

  return {
    clientId,
    company: toReputationIntakeView(companyIntake),
    isSetUp,
    runs: toRunRowViews(reputationJobs, opts.isStaff),
    runInFlight: anyRunInFlight(reputationJobs),
    setupCost,
    viewerIsBilled: viewerIsBilledFrom(opts),
    isStaff: opts.isStaff,
  };
}

/**
 * The carousel agent family (`karos-carousel-runner` / `-setup` / `-manager`)
 * was retired in full 2026-08-29 (SCRUM-377/T-B25a) — no engine equivalent
 * was ever planned. `toCarouselIntakeView` and `buildCarouselAgentIntakeView`
 * used to live here; removed from code and the db, do not reintroduce.
 */

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
