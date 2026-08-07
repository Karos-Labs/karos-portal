import "server-only";

import { getAsset, listClientSeats, listPlannedScheduledRuns } from "@/lib/data";
import { matchAccountTitleToSeat } from "@/lib/client-seats";
import { CREDIT_COSTS } from "@/lib/credits";
import { hasXAgentIntake } from "@/lib/agent-service/x-agent-context";
import {
  hasLinkedInAgentIntake,
  hasLinkedInV2Setup,
  isLinkedInSetupV2,
  isLinkedInV2Agent,
} from "@/lib/agent-service/linkedin-agent-context";
import { hasRedditAgentIntake } from "@/lib/agent-service/reddit-agent-context";
import {
  hasNewsletterAgentIntake,
  hasNewsletterV2Setup,
} from "@/lib/agent-service/newsletter-agent-context";
import { hasBlogAgentIntake, hasBlogV2Setup } from "@/lib/agent-service/blog-agent-context";
import {
  hasReputationAgentIntake,
  hasReputationV2Setup,
} from "@/lib/agent-service/reputation-agent-context";
import {
  hasCarouselAgentIntake,
  hasCarouselV2Setup,
} from "@/lib/agent-service/carousel-agent-context";
import {
  agentKeyMatchesClientSlug,
  clientSafeRefusal,
  isBlogAgentIdentity,
  isCarouselAgentIdentity,
  isLinkedInAgentIdentity,
  isReputationAgentIdentity,
  isNewsletterAgentIdentity,
  isRedditAgentIdentity,
  isXAgentIdentity,
  isSubAgent,
} from "@/lib/custom-agent-launch";
import { clientAgentBlurb } from "@/lib/agent-blurbs";
import { selectAgentSchedules, weeklyFireDays } from "@/lib/agent-schedule-selection";
import { runRowLabel, type ClientAgentIdentity } from "@/lib/agent-identity-map";
import { listClientAgentFeedback } from "@/lib/data-client-agents";
import { dateKeyInZone, evaluateLaunchGate, isOptionsMode } from "@/lib/client-agents";
import { evaluateTemplateRunGate } from "@/lib/client-agent-runs";
import { canNoteSlot } from "@/lib/slot-notes";
import { parseXDrafts } from "@/lib/x-drafts";
import { resolveOptions, toClientXOption } from "@/lib/x-options";
import { refLaneLabel } from "@/lib/draft-lane-label";
import { upcomingSlots } from "@/lib/client-agent-slots";
import { runtimeTimeZone } from "@/lib/run-cadence";
import type { ComponentProps } from "react";
import type { BlogAgentIntake } from "@/components/blog-agent-intake";
import type { CarouselAgentIntake } from "@/components/carousel-agent-intake";
import type { ReputationAgentIntake } from "@/components/reputation-agent-intake";
import type { LinkedInAgentIntake } from "@/components/linkedin-agent-intake";
import type { NewsletterAgentIntake } from "@/components/newsletter-agent-intake";
import type { RedditAgentIntake } from "@/components/reddit-agent-intake";
import type { XAgentIntake } from "@/components/x-agent-intake";
import type { AgentSetupState, ClientAgentScheduleRow, CustomAgentRunRow, RunnableAgentSummary } from "@/components/custom-agents";
import type { ClientAgentCardRow } from "@/components/client-agents/types";
import type { ClientAgent, CustomAgent, Job } from "@/lib/types";

/**
 * The RSC-boundary projections behind the AI Agents surfaces.
 *
 * Extracted from the roster page when the agent DETAIL page arrived (CD-G1):
 * both routes have to answer "what may this viewer see about this agent" with
 * exactly the same redaction, the same server-evaluated gates and the same
 * week strip, and a second copy of that logic is a second place for a client to
 * start receiving something staff-only. The detail page calls the same
 * toClientAgentRows with a single-umbrella array.
 *
 * Everything here runs on the SERVER. That is the whole point: every field
 * below is serialized into the RSC payload, so redaction that happens at render
 * time has already lost.
 */

/** How many days of the plan the live card's "Coming up" strip shows. */
export const WEEK_STRIP_DAYS = 7;

/**
 * Strip an agent to the client-safe summary — never the instructions/skill paths.
 *
 * And never `description` (F127). It is the lab manifest's own line, written for
 * the people who build agents, and it shipped in this projection unread: every
 * surface that takes a RunnableAgentSummary renders the curated `clientBlurb`
 * instead (CD-G2 removed the manifest from that fallback chain), so the field
 * reached client browsers doing nothing but sitting in the RSC payload. This
 * module's doctrine says redaction belongs at the boundary rather than at
 * render, and a field nothing paints is exactly the case that rule is for.
 */
export function toSummary(agent: CustomAgent): RunnableAgentSummary {
  return {
    id: agent.id,
    key: agent.key,
    name: agent.name,
    clientBlurb: agent.clientBlurb ?? null,
    icon: agent.icon,
    color: agent.color,
    creditCost: agent.creditCost ?? null,
    enabled: agent.enabled,
  };
}

/**
 * The agents the staff bind control may OFFER for this client.
 *
 * It asks the same questions `bindClientAgentAction` asks before it writes, and
 * asks the binding one through the same predicate: enabled, not a per-client
 * instance baked under a DIFFERENT client's lab folder
 * (`agentKeyMatchesClientSlug` — the action refuses that pair outright, before
 * any umbrella exists), and not already bound here.
 *
 * The binding question is the one the dropdown used to skip (#131). The roster
 * rendered directly beneath it already dropped foreign instances, so one screen
 * carried two lists that disagreed about which agents exist for this client —
 * and choosing the extra one returned an error paragraph and wrote nothing. One
 * rule governs the offer and the accept now.
 *
 * A PROJECTION, not just a filter: the control is a client component, so it
 * receives id and name only. A `CustomAgent` carries the agent's instructions,
 * its skill path and the lab manifest's own `description` (F127/CD-G2) — none
 * of which may be serialized into a browser payload to populate a `<select>`.
 */
export function bindableAgents(args: {
  /** The whole custom-agent catalogue, unfiltered (`listCustomAgents`). */
  agents: CustomAgent[];
  /** This client's lab-repo slug (`Client.agentsRepoSlug`). */
  clientSlug: string | null | undefined;
  /** `customAgentId`s this client already has an umbrella for. */
  boundAgentIds: Set<string>;
}): Array<{ id: string; name: string }> {
  return args.agents
    .filter(
      (agent) =>
        agent.enabled &&
        // A STEP of another agent is not a thing to set up for a client. The
        // LinkedIn setup and manager are fired by the LinkedIn agent's own
        // surface, so offering them here would bind an umbrella to half an
        // agent — and this dropdown is exactly where they leaked into a
        // client-facing choice.
        //
        // STRUCTURAL ONLY (`isSubAgent`), deliberately not the wider
        // `isUnlistedAgent`. Bindability and listing are different questions: a
        // SUPERSEDED agent is hidden from rosters because it must not advertise
        // itself to a client, but binding one is a staff act on an agent that
        // still exists, and excluding it here broke the rule this dropdown is
        // actually for — keeping a client's OWN per-client instance available
        // (client-agent-projection-bind-offer.test.ts).
        !isSubAgent(agent) &&
        agentKeyMatchesClientSlug(agent.key, args.clientSlug) &&
        !args.boundAgentIds.has(agent.id),
    )
    .map((agent) => ({ id: agent.id, name: agent.name }));
}

/**
 * Custom-agent runs as slim rows. `staff` adds the /jobs link target AND the
 * submitted prompt: the raw request is an operator's free text (typos, stray
 * capitals) and never belongs in a client's run history, so it is dropped here
 * at the RSC boundary rather than hidden at render.
 *
 * LAUNCH runs are not runs as far as a client is concerned — they are the
 * setup, and the launch card is already telling that story in three phases. A
 * generic row beside it would give the same event two identities (the F147
 * failure this architecture exists to kill), offer a Cancel the card doesn't,
 * and advertise "· 1 draft" for a deliverable that is staff-only by design.
 * Staff keep the rows: they link to /jobs and are the run's real history.
 *
 * `agentName` stays the STORED name because the surfaces join on it (a card
 * matches its own runs by agent name, the avatar looks the lab agent up by it).
 * What a row PRINTS is `label`, resolved through the §7.3 helper against this
 * client's umbrellas — so a run and the calendar card of what it produced never
 * again carry two names for one stream (F147).
 */
export function toRunRows(
  jobs: Job[],
  staff: boolean,
  umbrellas: ClientAgentIdentity[],
): CustomAgentRunRow[] {
  return jobs
    .filter((j) => j.agentId === "agent-service" && j.external?.taskType === "custom")
    .filter((j) => staff || (j.runType !== "launch" && j.runType !== "test"))
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, 8)
    .map((j) => ({
      id: j.id,
      agentName: j.agentName,
      label: runRowLabel(j, umbrellas),
      status: j.status,
      createdAt: j.createdAt,
      assetCount: j.assetIds.length,
      ...(staff && j.input.prompt ? { prompt: j.input.prompt } : {}),
      ...(staff ? { href: `/jobs/${j.id}` } : {}),
      ...(staff && j.error ? { error: j.error } : {}),
      ...(staff && j.runType ? { runType: j.runType } : {}),
    }));
}

/**
 * `viewerIsClient` decides what the refusal may say. The redaction happens HERE,
 * not at render: everything on a ClientAgentScheduleRow is serialized into the
 * RSC payload the browser receives, so a raw internal string handed to a client
 * component is readable whether or not it is ever painted.
 *
 * WHICH ROWS AND WHICH ONE PER AGENT are both `agent-schedule-selection`'s to
 * answer, not this function's. It used to keep its own
 * `cadence === "weekly"` copy of the first question — one of five — so a daily
 * schedule that was firing and billing reached the card as `schedule: null` and
 * the client was offered "Start posting" for an agent already posting. And it
 * answered the second by accident: it returned every match and let the caller's
 * `new Map(...)` keep whichever came last, while the detail page's `.find` kept
 * the first, so two surfaces could show two different schedules for one agent.
 *
 * A row whose cadence has no weekly pace (monthly) is dropped rather than
 * quoted at one-a-week — see `weeklyFireDays`, which states that residual.
 */
export function toScheduleRows(
  runs: Awaited<ReturnType<typeof listPlannedScheduledRuns>>,
  viewerIsClient: boolean,
): ClientAgentScheduleRow[] {
  return [...selectAgentSchedules(runs).values()].flatMap(({ schedule: run }) => {
    const postsPerWeek = weeklyFireDays(run);
    if (postsPerWeek == null) return [];
    return [{
      id: run.id,
      agentId: run.customAgentId,
      status: run.status === "paused" ? ("paused" as const) : ("active" as const),
      postsPerWeek,
      // The multiplier stays: the client's pace dialog has to quote the REAL
      // weekly cost of a schedule someone set at more than one output per fire,
      // and it cannot do that without this number. No client-visible copy
      // decomposes it — see the paceOnly branch of AgentScheduleModal.
      outputsPerRun: run.outputsPerRun ?? 1,
      nextRunAt: run.nextRunAt,
      // The standing instruction is STAFF-AUTHORED operator copy, and this
      // module's own doctrine is that anything on these rows is readable by the
      // browser whether or not it is painted. It shipped unconditionally and
      // was rendered editable in the client's pace dialog.
      ...(viewerIsClient ? {} : { prompt: run.prompt }),
      hour: run.hour,
      minute: run.minute,
      // The scheduler's refusal, so a schedule that can never fire stops
      // rendering as a healthy "Live" agent.
      //
      // SUBMIT-TIME ONLY, and that is a known hole rather than a full answer.
      // Enumerated, because the residual is only credible if the writers are:
      // `/api/run-scheduled` SETS it when a fire is refused before a job row
      // exists; `configureClientAgentScheduleAction` and
      // `setPlannedRunStatusAction`'s resume only CLEAR it; nothing else in
      // src/ touches the field. The agent-service webhook is not on that list —
      // a run that submits cleanly and then fails lands on `job.error` and
      // never reaches this row, so a schedule whose every run has failed for a
      // month still arrives here with `lastError: null`. What covers that case
      // is the roster's separate `lastRunFailed` rung (`lastRunFailedAgentIds`,
      // read from jobs); closing it HERE needs run history this cannot invent.
      lastError: run.lastError
        ? viewerIsClient
          ? clientSafeRefusal(run.lastError)
          : run.lastError
        : null,
      lastErrorAt: run.lastErrorAt ?? null,
    }];
  });
}

/**
 * Firing zone per custom agent, from its governing schedule row.
 *
 * The week strip's day boundaries come from the SCHEDULE's stored IANA zone,
 * not the container's — the F108 contract, and the same source
 * `slotScheduleFor` uses when the slots were planned. Reading them in a
 * different zone than they were written in shifts the whole strip by a day for
 * any client who is not in the server's timezone.
 *
 * Reads the SAME selection `toScheduleRows` does — the second of the five
 * weekly-only copies of that rule, and the one that quietly handed a daily
 * agent's strip the container's zone. With two live rows it also picked
 * whichever came last, so an agent could get one row's pace and another row's
 * timezone. A monthly row still contributes its zone: it has no weekly pace to
 * quote, but it is this agent's clock and the strip has to be drawn in some
 * zone.
 */
export function scheduleZonesByAgent(
  runs: Awaited<ReturnType<typeof listPlannedScheduledRuns>>,
): Map<string, string> {
  const zones = new Map<string, string>();
  for (const [customAgentId, { schedule }] of selectAgentSchedules(runs)) {
    if (schedule.timeZone) zones.set(customAgentId, schedule.timeZone);
  }
  return zones;
}

/**
 * Intake readiness, resolved once per agent with the SAME call the submit core
 * makes (submitCustomAgentJob → hasXAgentIntake / hasLinkedInAgentIntake /
 * hasRedditAgentIntake). The LinkedIn check answers differently per agent key —
 * the multi-seat agent runs on any stored intake, the company-page agents need
 * the company form — so a single shared flag would block agents the server
 * would run, and a card cannot derive this from the key alone.
 *
 * `panes` is optional and additive: a caller that has already built the intake
 * VIEWS (the staff branch of the agents page does, for its run dialog) hands
 * them in, and the matching agent's state gains the payload its dialog renders
 * inline. Callers that have not — the client's detail route — get the same
 * states with `href` alone, which is the CD-E1 model and stays a full page.
 * One keyed map either way, so no surface has to be handed a second set of
 * per-platform props and asked to re-derive which agent is which.
 */
export interface AgentIntakePanes {
  x?: ComponentProps<typeof XAgentIntake>;
  linkedin?: ComponentProps<typeof LinkedInAgentIntake>;
  reddit?: ComponentProps<typeof RedditAgentIntake>;
  newsletter?: ComponentProps<typeof NewsletterAgentIntake>;
  blog?: ComponentProps<typeof BlogAgentIntake>;
  reputation?: ComponentProps<typeof ReputationAgentIntake>;
  carousel?: ComponentProps<typeof CarouselAgentIntake>;
}

export async function buildAgentSetup(
  clientId: string,
  agents: Array<{ id: string; key: string }>,
  panes?: AgentIntakePanes,
): Promise<Record<string, AgentSetupState>> {
  const resolved = await Promise.all(
    agents.map(async (agent): Promise<[string, AgentSetupState] | null> => {
      if (isXAgentIdentity(agent.key)) {
        const ready = await hasXAgentIntake(clientId);
        const href = `/clients/${clientId}/x-agent`;
        const label = "X agent data";
        const clientLabel = "Your X details";
        // No stand-up run exists for X — it drafts from its form directly.
        return [
          agent.id,
          panes?.x
            ? { ready, standUpDone: true, href, label, clientLabel, kind: "x", data: panes.x }
            : { ready, standUpDone: true, href, label, clientLabel },
        ];
      }
      if (isLinkedInAgentIdentity(agent.key)) {
        // TWO questions, not one. `ready` is "is the form saved"; `standUpDone` is
        // "has the one-time stand-up run happened". Both submit cores refuse a v2
        // writer run on the second (submit-custom.ts's hasLinkedInV2Setup rung),
        // so a surface that knows only the first offers a press the server turns
        // away — the F131 shape this whole object exists to prevent.
        //
        // Keyed to the V2 predicate, matching the core: the e10 generation has no
        // stand-up run, so requiring one of them would block runs the server
        // would accept.
        const [ready, standUpDone] = await Promise.all([
          hasLinkedInAgentIntake(clientId, agent.key),
          // The SETUP skill is exempt — it is the run that creates the foundation
          // row, so demanding one of it would refuse the only run that can ever
          // satisfy the rung. Both cores carry the same exemption.
          isLinkedInV2Agent(agent.key) && !isLinkedInSetupV2(agent.key)
            ? hasLinkedInV2Setup(clientId)
            : Promise.resolve(true),
        ]);
        const href = `/clients/${clientId}/linkedin-agent`;
        const label = "LinkedIn agent data";
        const clientLabel = "Your LinkedIn details";
        return [
          agent.id,
          panes?.linkedin
            ? { ready, standUpDone, href, label, clientLabel, kind: "linkedin", data: panes.linkedin }
            : { ready, standUpDone, href, label, clientLabel },
        ];
      }
      if (isRedditAgentIdentity(agent.key)) {
        // e15 is intake-driven exactly like the other two. Without this entry
        // its card computes `ready: true` by omission, which is the one answer
        // that cannot be right for an agent the submit core hard-gates.
        const ready = await hasRedditAgentIntake(clientId);
        const href = `/clients/${clientId}/reddit-agent`;
        const label = "Reddit agent data";
        const clientLabel = "Your Reddit details";
        // No stand-up run exists for Reddit either.
        return [
          agent.id,
          panes?.reddit
            ? { ready, standUpDone: true, href, label, clientLabel, kind: "reddit", data: panes.reddit }
            : { ready, standUpDone: true, href, label, clientLabel },
        ];
      }
      if (isNewsletterAgentIdentity(agent.key)) {
        // BOTH RUNGS, unlike the other three, and the difference is deliberate.
        // Elsewhere `ready` asks only whether the form is saved, and the second
        // question — has the one-time stand-up run happened — travels separately
        // as the pane's own `isSetUp` flag. Here the writer CLAIMS an issue
        // number in the index at its very first step, so a run started without
        // one is charged for and dies immediately. The submit core gates on both
        // (submitCustomAgentJob → hasNewsletterAgentIntake, then
        // hasNewsletterV2Setup), so `ready` answers with both or it would offer
        // a run the server refuses.
        const [hasIntake, isSetUp] = await Promise.all([
          hasNewsletterAgentIntake(clientId),
          hasNewsletterV2Setup(clientId),
        ]);
        const href = `/clients/${clientId}/newsletter-agent`;
        const label = "Newsletter agent data";
        const clientLabel = "Your newsletter details";
        return [
          agent.id,
          // `standUpDone: true` even though this family HAS a stand-up run, and
          // that is not a lie — it is what the field means. It marks an
          // OUTSTANDING stand-up step for the run gate to refuse on, and here
          // there can never be one: `ready` above already folds `isSetUp` in, so
          // the intake rung has refused first. Reporting the raw flag instead
          // would fire the stand-up rung a second time, in LinkedIn's words, at a
          // newsletter client. See the field's doc on AgentSetupState.
          panes?.newsletter
            ? {
                ready: hasIntake && isSetUp,
                standUpDone: true,
                href,
                label,
                clientLabel,
                kind: "newsletter",
                data: panes.newsletter,
              }
            : { ready: hasIntake && isSetUp, standUpDone: true, href, label, clientLabel },
        ];
      }
      if (isBlogAgentIdentity(agent.key)) {
        // BOTH RUNGS, like the newsletter and for the same reason: the writer
        // claims a post number in the index at step 01, so a run without one is
        // charged for and dies. The submit core gates on both, so a one-rung
        // answer here would offer a run the server refuses.
        const [hasIntake, isSetUp] = await Promise.all([
          hasBlogAgentIntake(clientId),
          hasBlogV2Setup(clientId),
        ]);
        const href = `/clients/${clientId}/blog-agent`;
        const label = "Blog agent data";
        const clientLabel = "Your blog details";
        return [
          agent.id,
          // Same as the newsletter above: `ready` already folds `isSetUp` in, so
          // there is no outstanding stand-up step for the second rung to find.
          panes?.blog
            ? { ready: hasIntake && isSetUp, standUpDone: true, href, label, clientLabel, kind: "blog", data: panes.blog }
            : { ready: hasIntake && isSetUp, standUpDone: true, href, label, clientLabel },
        ];
      }
      if (isReputationAgentIdentity(agent.key)) {
        // BOTH RUNGS, like the newsletter and the blog. The runner reads from the
        // ROSTER setup resolves, and a pulse without one has nowhere to read —
        // the submit core gates on both, so a one-rung answer here would offer a
        // run the server refuses.
        const [hasIntake, isSetUp] = await Promise.all([
          hasReputationAgentIntake(clientId),
          hasReputationV2Setup(clientId),
        ]);
        const href = `/clients/${clientId}/reputation-agent`;
        const label = "Reputation agent data";
        const clientLabel = "Your review details";
        return [
          agent.id,
          // `standUpDone: true`, the newsletter and blog idiom rather than
          // LinkedIn's: `ready` above already folds `isSetUp` in, so the intake
          // rung refuses first and there can never be an OUTSTANDING stand-up
          // step for the run gate to catch. Reporting the raw flag would fire
          // that rung a second time and tell a reputation client about LinkedIn.
          // See the field's doc on AgentSetupState.
          panes?.reputation
            ? {
                ready: hasIntake && isSetUp,
                standUpDone: true,
                href,
                label,
                clientLabel,
                kind: "reputation",
                data: panes.reputation,
              }
            : { ready: hasIntake && isSetUp, standUpDone: true, href, label, clientLabel },
        ];
      }
      if (isCarouselAgentIdentity(agent.key)) {
        // BOTH RUNGS and `standUpDone: true`, the newsletter/blog/reputation
        // idiom: `ready` folds `isSetUp` in, so the intake rung refuses first and
        // there can never be an OUTSTANDING stand-up step for the run gate to
        // catch. See the field's doc on AgentSetupState.
        const [hasIntake, isSetUp] = await Promise.all([
          hasCarouselAgentIntake(clientId),
          hasCarouselV2Setup(clientId),
        ]);
        const href = `/clients/${clientId}/carousel-agent`;
        const label = "Carousel agent data";
        const clientLabel = "Your carousel details";
        return [
          agent.id,
          panes?.carousel
            ? {
                ready: hasIntake && isSetUp,
                standUpDone: true,
                href,
                label,
                clientLabel,
                kind: "carousel",
                data: panes.carousel,
              }
            : { ready: hasIntake && isSetUp, standUpDone: true, href, label, clientLabel },
        ];
      }
      return null;
    }),
  );
  return Object.fromEntries(resolved.filter((entry): entry is [string, AgentSetupState] => entry !== null));
}

/**
 * The one run a card acknowledges: a manual "Run this template now" on a LIVE
 * umbrella that is still queued or running.
 *
 * Scheduled fires are deliberately not matched (see `ClientAgentCardRow`), and
 * for a client viewer the match also asks WHO pressed it — a staff "Run now"
 * announced on the client's page is work the client did not ask for.
 *
 * Its own function so the boolean twin below cannot drift from the row it
 * stands in for: the two must answer the same question, and they did not have
 * to when one of them was a copy.
 */
function activeTemplateRun(args: {
  umbrella: ClientAgent;
  jobs: Job[];
  viewerIsClient: boolean;
  viewerUid: string;
}): Job | undefined {
  if (args.umbrella.launchState !== "live") return undefined;
  return args.jobs.find(
    (job) =>
      job.clientAgentId === args.umbrella.id &&
      job.runType === "manual_template" &&
      (job.status === "queued" || job.status === "running") &&
      (!args.viewerIsClient || job.createdBy === args.viewerUid),
  );
}

/**
 * Would `toClientAgentRows` return a row with a non-null `activeRun`? — the one
 * bit the agents roster needs to decide whether to mount `<AutoRefresh />`.
 *
 * #130: the roster's client branch used to get that bit by awaiting the whole
 * projection and discarding everything else. Per live umbrella that is a
 * `listAgentSlots` query and a `listClientAgentFeedback` query, plus a
 * `getAsset` on an options day, spent to build a week strip, template gates,
 * today's option texts and a feedback list that the roster renders nowhere.
 * This reads no Firestore at all: the umbrellas and the jobs are already in the
 * caller's hand, and the answer only ever depended on those.
 *
 * It repeats the projection's own skip — an umbrella whose bound agent was
 * deleted or disabled produces no row, so it cannot produce an active run
 * either — and asks the shared predicate for the rest.
 */
export function hasActiveTemplateRun(args: {
  umbrellas: ClientAgent[];
  agentsById: Map<string, CustomAgent>;
  jobs: Job[];
  viewerIsClient: boolean;
  viewerUid: string;
}): boolean {
  return args.umbrellas.some((umbrella) => {
    const agent = args.agentsById.get(umbrella.customAgentId);
    if (!agent || !agent.enabled) return false;
    return (
      activeTemplateRun({
        umbrella,
        jobs: args.jobs,
        viewerIsClient: args.viewerIsClient,
        viewerUid: args.viewerUid,
      }) !== undefined
    );
  });
}

/**
 * Project each client-agent umbrella into the card row its surface may read.
 *
 * The launch GATE is evaluated here, server-side, with the same pure function
 * the action runs — so the card can only ever offer a press the server would
 * accept (F131), and every blocked state arrives with the exact line that
 * explains it (F25). `launchError` is redacted for client viewers HERE rather
 * than at render: everything on these rows is serialized into the RSC payload,
 * so an internal string handed to a client component is readable whether or
 * not it is ever painted.
 */
export async function toClientAgentRows(args: {
  umbrellas: ClientAgent[];
  agentsById: Map<string, CustomAgent>;
  viewerIsClient: boolean;
  grantedAgentIds: Set<string> | null;
  /**
   * This client's lab-repo slug (Client.agentsRepoSlug). Feeds the launch
   * gate's binding rung, so a card never offers a launch of an instance baked
   * under another client's folder.
   */
  clientSlug?: string | null;
  agentSetup: Record<string, AgentSetupState>;
  spendable?: number;
  creditBlockReasons: Record<string, string>;
  /** Weekly schedule rows, ALREADY redacted for this viewer (toScheduleRows). */
  scheduleRows: ClientAgentScheduleRow[];
  /** Firing zones by customAgentId, for the week strip's day boundaries. */
  scheduleZones: Map<string, string>;
  /** This client's jobs — read only for in-flight manual template runs. */
  jobs: Job[];
  viewerUid: string;
  viewerIsStaff: boolean;
  /** This viewer's own seat, if their login is linked to one (see AppUser.seatId). */
  viewerSeatId?: string | null;
  /** A client's group admins keep full visibility across every seat, like staff. */
  viewerIsGroupAdmin?: boolean;
  now: number;
}): Promise<ClientAgentCardRow[]> {
  const scheduleByAgentId = new Map(args.scheduleRows.map((row) => [row.agentId, row]));
  const rows: ClientAgentCardRow[] = [];
  // Fetched at most once per client, and only when a plain (non-staff,
  // non-group-admin) client viewer could actually be handed someone else's
  // personal option below — most page loads need it zero times.
  const seatsByClientId = new Map<string, Awaited<ReturnType<typeof listClientSeats>>>();
  const seatsFor = async (clientId: string) => {
    const cached = seatsByClientId.get(clientId);
    if (cached) return cached;
    const seats = await listClientSeats(clientId);
    seatsByClientId.set(clientId, seats);
    return seats;
  };
  for (const umbrella of args.umbrellas) {
    const agent = args.agentsById.get(umbrella.customAgentId);
    // The bound lab agent was deleted or disabled: the umbrella has nothing to
    // fire, so it renders nowhere rather than as a launchable card.
    if (!agent || !agent.enabled) continue;
    const setup = args.agentSetup[agent.id] ?? null;
    const granted = args.grantedAgentIds ? args.grantedAgentIds.has(agent.id) : true;
    const launchCost = agent.launchCreditCost ?? null;
    const gate = evaluateLaunchGate({
      launchState: umbrella.launchState,
      granted,
      agentKey: agent.key,
      clientSlug: args.clientSlug,
      intakeReady: setup ? setup.ready : true,
      intakeLabel: setup?.label ?? null,
      launchCreditCost: launchCost,
      ...(args.spendable !== undefined ? { availableCredits: args.spendable } : {}),
      creditBlockReason: args.creditBlockReasons[agent.id] ?? null,
    });

    // ── The LIVE view's own projections (WP-2) ──
    // Built here, on the server, for the same reason the launch gate is: the
    // card must never offer a Run the action would refuse, and it can only be
    // sure of that if the same pure gate decided both.
    const live = umbrella.launchState === "live";
    const optionsMode = isOptionsMode(umbrella);
    const runCost = agent.creditCost ?? CREDIT_COSTS.customAgentRun;
    const templateGates: ClientAgentCardRow["templateGates"] = {};
    if (live) {
      for (const template of umbrella.templates) {
        const templateGate = evaluateTemplateRunGate({
          launchState: umbrella.launchState,
          templateStatus: template.status,
          // The SAME resolved intake the launch gate above just used, and the
          // same one the legacy ladder takes. A live umbrella does not exempt an
          // agent from its intake — the submit core hard-gates on it either way
          // (F131 re-entry).
          setup,
          cost: runCost,
          ...(args.spendable !== undefined ? { availableCredits: args.spendable } : {}),
          creditBlockReason: args.creditBlockReasons[agent.id] ?? null,
        });
        templateGates[template.key] = {
          allowed: templateGate.allowed,
          ...(templateGate.allowed
            ? {}
            : { code: templateGate.code, reason: templateGate.reason }),
        };
      }
    }

    // The week strip and the feedback list only exist for a live umbrella —
    // and the strip carries a DAY and a LABEL, nothing else. An asset id or a
    // fulfilment status here would let a client tell a pre-generated day from a
    // day-of one, which is precisely the distinction the slot model exists to
    // erase (§4.1).
    //
    // THIS IS THE REDACTION LAYER, and `upcomingSlots` is not (#163). It hands
    // back the stored AgentSlot documents whole — assetId, jobId, optionRefs,
    // optionPick and all — so the `week` projection below, and the `today`
    // block that lets option texts cross for the current day only, are what
    // stand between those fields and the RSC payload. Harden A3/A4 here; a new
    // consumer of `upcomingSlots` owns its own projection.
    const zone = args.scheduleZones.get(umbrella.customAgentId) ?? runtimeTimeZone();
    // The day boundary in the SCHEDULE's zone (F108), not the container's —
    // otherwise a client one timezone east is told today has passed.
    const todayKey = dateKeyInZone(args.now, zone);
    const [slots, feedbackRows] = live
      ? await Promise.all([
          upcomingSlots(umbrella.id, todayKey, WEEK_STRIP_DAYS),
          listClientAgentFeedback({ clientAgentId: umbrella.id }),
        ])
      : [[], []];
    const templateNames = new Map(umbrella.templates.map((t) => [t.key, t.name]));

    // §4.5 / WP-9. TODAY only — a future day's option texts must never enter
    // the payload, because their existence is precisely what the slot model
    // keeps indistinguishable. The batch asset is read here, on the server, and
    // only the three texts for the current day cross the boundary.
    let today: ClientAgentCardRow["today"] = null;
    if (live && optionsMode) {
      const todaySlot = slots.find((slot) => slot.dateKey === todayKey);
      if (todaySlot && (todaySlot.optionRefs?.length ?? 0) > 0) {
        if (todaySlot.optionPick) {
          // F70: a ref is `account · lane`, and its tail is the LAB's lane
          // vocabulary ("Avenue 2 · News-reaction (live)"), which no client
          // surface may render raw. The direction stored at pick time is already
          // humanised; the fallback runs the ref through the shared helper — the
          // one home for that rule — so a pick made before the field existed
          // still reads properly. NULL rather than "Draft" when the ref names no
          // lane: the receipt puts this word in a client's sentence, and an
          // internal status word does not belong there (#155).
          const pick = todaySlot.optionPick;
          today = {
            slotId: todaySlot.id,
            options: [],
            pickedDirection: pick.direction?.trim() || refLaneLabel(pick.optionRef),
          };
        } else if (todaySlot.assetId) {
          const batchAsset = await getAsset(todaySlot.assetId);
          const batch = batchAsset ? parseXDrafts(batchAsset.content ?? "") : null;
          let options = batch ? resolveOptions(batch, todaySlot.optionRefs ?? []) : [];
          // A plain team login only picks from ITS OWN seat's options plus the
          // shared company account — never a colleague's personal drafts. Staff
          // and a client's own group admins keep the full pool, same as every
          // other personal-content rule in this app.
          if (options.length > 0 && !args.viewerIsStaff && !args.viewerIsGroupAdmin) {
            const seats = await seatsFor(umbrella.clientId);
            options = options.filter((option) => {
              const seat = matchAccountTitleToSeat(seats, option.account);
              return seat === "company" || seat === args.viewerSeatId;
            });
          }
          if (options.length > 0) {
            // The account heading is humanised HERE, not at render: the option
            // objects are serialized into the RSC payload, so "Albert Kattan
            // (seat 1, handle pending)" that a component declines to paint is
            // still readable in view-source.
            today = {
              slotId: todaySlot.id,
              options: options.map(toClientXOption),
              pickedDirection: null,
            };
          }
        }
      }
    }

    // The one run the card acknowledges — see `activeTemplateRun` above for the
    // rule, which `hasActiveTemplateRun` shares so the roster's AutoRefresh bit
    // cannot disagree with the row it stands in for.
    const pending = activeTemplateRun({
      umbrella,
      jobs: args.jobs,
      viewerIsClient: args.viewerIsClient,
      viewerUid: args.viewerUid,
    });

    rows.push({
      id: umbrella.id,
      clientId: umbrella.clientId,
      customAgentId: agent.id,
      identity: `${agent.key} ${agent.name}`,
      icon: agent.icon,
      displayName: umbrella.displayName,
      // NEVER `agent.description` (CD-G2): that is the lab manifest's own line,
      // written for the people who build agents. Clients were reading "Master
      // content-social skill. Given a brand's guidelines + any past competitor
      // research…" on their own roster. Curated clientBlurb first, then the
      // keyed fallback, and no third rung back to the manifest.
      blurb: clientAgentBlurb({
        key: agent.key,
        name: agent.name,
        clientBlurb: agent.clientBlurb ?? null,
      }),
      launchState: umbrella.launchState,
      launchStartedAt: umbrella.launchStartedAt ?? null,
      launchError: umbrella.launchError
        ? args.viewerIsClient
          ? clientSafeRefusal(umbrella.launchError)
          : umbrella.launchError
        : null,
      launchRefunded: umbrella.launchRefunded === true,
      // Staff never pay for a launch, so quoting them a price would be a lie.
      launchCost: args.spendable !== undefined ? launchCost : null,
      gate: {
        allowed: gate.allowed,
        ...(gate.allowed ? {} : { code: gate.code, reason: gate.reason }),
      },
      // The CLIENT label: `setupLabel` is painted by the launch card and by the
      // detail panel's intake block, both of which a client reads.
      ...(setup ? { setupHref: setup.href, setupLabel: setup.clientLabel } : {}),
      // Templates cross to a client viewer ONLY once the umbrella is live.
      // While it is `curating` the registry holds what the setup run PROPOSED,
      // which staff have not confirmed yet (the Q3 gate) — sending it and
      // deciding not to paint it inside a client component would still put
      // unconfirmed AI-written names and rationales in the RSC payload.
      templates:
        args.viewerIsClient && umbrella.launchState !== "live" ? [] : (umbrella.templates ?? []),

      optionsMode,
      // Staff never pay for a run, so quoting them a price would be a lie —
      // the same rule the launch price already follows.
      runCost: args.spendable !== undefined ? runCost : null,
      templateGates,
      week: slots.map((slot) => ({
        dateKey: slot.dateKey,
        // A constant label per mode, deliberately. Deriving "pick of N" from a
        // slot's assigned optionRefs would paint a future day differently
        // depending on whether its candidates had been picked out yet — a
        // difference the client can see and the churn rule forbids.
        // "Daily post · pick of 3" said two things it must not. It stated the
        // BATCH SHAPE — three of tomorrow's posts already exist to be picked
        // from — which is the one fact the whole slot model exists to keep
        // indistinguishable (A3/A4). And it promised a picker that ships with
        // WP-9, on the same page where the options row now correctly says the
        // agent writes one post a day. A day carries a day and a label; the
        // label is the product, not its machinery.
        label: optionsMode
          ? "Daily post"
          : (templateNames.get(slot.templateKey) ?? slot.templateKey),
        slotId: slot.id,
        // The note crosses because its author wrote it and its reader needs it
        // back. authorName, never the uid — the same rule the feedback list
        // follows, so a client never receives the internal id of the staff
        // member who answered them.
        // B5: the label is VIEWER-relative, not role-derived. "You" computed
        // from authorRole === "client" is right for the client and a lie to the
        // staff member reading the same note on the same surface — this row is
        // built for both. Whoever wrote it sees "You"; everyone else sees the
        // stored name, falling back to the side they were on for notes written
        // before authorName existed.
        note: slot.note
          ? {
              text: slot.note.text,
              authorName:
                slot.note.authorUid === args.viewerUid
                  ? "You"
                  : (slot.note.authorName ??
                    (slot.note.authorRole === "client" ? "Your team" : "Karos")),
              createdAt: slot.note.createdAt,
              applied: slot.note.consumedAt != null,
            }
          : null,
        canNote: canNoteSlot(slot, todayKey).ok,
      })),
      today,
      feedback: feedbackRows.map((row) => ({
        id: row.id,
        scope: row.scope,
        templateKey: row.templateKey ?? null,
        text: row.text,
        category: row.category ?? null,
        status: row.status,
        // Denormalized at write time — a client viewer never receives the uid
        // of the staff member who answered them.
        authorName: row.createdByName ?? (row.creatorRole === "client" ? "Your team" : "Karos"),
        creatorRole: row.creatorRole,
        createdAt: row.createdAt,
        editable: args.viewerIsStaff || row.createdBy === args.viewerUid,
      })),
      activeRun: pending
        ? {
            id: pending.id,
            status: pending.status === "running" ? "running" : "queued",
            templateName: pending.templateKey
              ? (templateNames.get(pending.templateKey) ?? null)
              : null,
          }
        : null,
      runnable: live ? toSummary(agent) : null,
      schedule: scheduleByAgentId.get(agent.id) ?? null,
      ...(args.spendable !== undefined ? { availableCredits: args.spendable } : {}),
    });
  }
  return rows;
}
