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
import {
  getAgentIntake,
  getCustomAgentByKey,
  listAgentIntake,
  listClientSeats,
  listJobs,
  listLiDraftFeedback,
  listRedditDraftFeedback,
  listXDraftFeedback,
  listXNewsUpdates,
  listXTakes,
} from "@/lib/data";
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
import type { AgentIntake, Job } from "@/lib/types";

export type XAgentIntakeProps = ComponentProps<typeof XAgentIntake>;
export type LinkedInAgentIntakeProps = ComponentProps<typeof LinkedInAgentIntake>;
export type RedditAgentIntakeProps = ComponentProps<typeof RedditAgentIntake>;

/** Strip an intake doc to the client-safe X view. */
function toXIntakeView(intake: AgentIntake | null): XIntakeView | null {
  if (!intake) return null;
  return {
    handle: intake.handle,
    ...(intake.comeAcross ? { comeAcross: intake.comeAcross } : {}),
    offLimits: intake.offLimits,
    roster: intake.roster,
    ...(intake.premium !== undefined ? { premium: intake.premium } : {}),
  };
}

/** Strip an intake doc to the client-safe LinkedIn view (the CV itself stays private). */
function toLiIntakeView(intake: AgentIntake | null): LiIntakeView | null {
  if (!intake) return null;
  return {
    handle: intake.handle,
    ...(intake.comeAcross ? { comeAcross: intake.comeAcross } : {}),
    offLimits: intake.offLimits,
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
  const [seats, companyIntake, allIntake, news, takes, feedback, jobs, xAgent] = await Promise.all([
    listClientSeats(clientId),
    getAgentIntake(clientId, "x", null),
    listAgentIntake(clientId, "x"),
    listXNewsUpdates(clientId),
    listXTakes(clientId),
    listXDraftFeedback(clientId),
    opts.jobs ?? listJobs({ clientId }),
    getCustomAgentByKey("karos-x-agent"),
  ]);

  const intakeBySeat = new Map(allIntake.filter((i) => i.seatId).map((i) => [i.seatId as string, i]));
  const seatViews: XSeatView[] = seats.map((seat) => ({
    id: seat.id,
    name: seat.name,
    slug: seat.slug,
    intake: toXIntakeView(intakeBySeat.get(seat.id) ?? null),
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

  const runs: XRunRowView[] = xJobs.slice(0, 8).map((j) => ({
    id: j.id,
    status: j.status,
    createdAt: j.createdAt,
    ...(opts.isStaff ? { href: `/jobs/${j.id}` } : {}),
  }));

  return {
    clientId,
    company: toXIntakeView(companyIntake),
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
      ...(f.draftRef ? { draftRef: f.draftRef } : {}),
      createdAt: f.createdAt,
    })),
    runs,
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

  const runs: LiRunRowView[] = liJobs.slice(0, 8).map((j) => ({
    id: j.id,
    status: j.status,
    createdAt: j.createdAt,
    ...(opts.isStaff ? { href: `/jobs/${j.id}` } : {}),
  }));

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
      ...(f.draftRef ? { draftRef: f.draftRef } : {}),
      createdAt: f.createdAt,
    })),
    runs,
  };
}

/** Strip an intake doc to the client-safe Reddit view. */
function toRedditIntakeView(intake: AgentIntake | null): RedditIntakeView | null {
  if (!intake) return null;
  return {
    handle: intake.handle,
    offLimits: intake.offLimits,
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

  const runs: RedditRunRowView[] = redditJobs.slice(0, 8).map((j) => ({
    id: j.id,
    status: j.status,
    createdAt: j.createdAt,
    ...(opts.isStaff ? { href: `/jobs/${j.id}` } : {}),
  }));

  return {
    clientId,
    company: toRedditIntakeView(companyIntake),
    feedback: feedback.slice(0, 12).map((f) => ({
      id: f.id,
      account: f.account,
      action: f.action,
      ...(f.draftRef ? { draftRef: f.draftRef } : {}),
      ...(f.subreddit ? { subreddit: f.subreddit } : {}),
      ...(f.reasonCode ? { reasonCode: f.reasonCode } : {}),
      createdAt: f.createdAt,
    })),
    runs,
  };
}
