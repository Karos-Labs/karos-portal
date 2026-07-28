import "server-only";

import { getAsset, listPlannedScheduledRuns } from "@/lib/data";
import { CREDIT_COSTS } from "@/lib/credits";
import { hasXAgentIntake } from "@/lib/agent-service/x-agent-context";
import { hasLinkedInAgentIntake } from "@/lib/agent-service/linkedin-agent-context";
import { clientSafeRefusal, isLinkedInAgentIdentity, isXAgentIdentity } from "@/lib/custom-agent-launch";
import { clientAgentBlurb } from "@/lib/agent-blurbs";
import { runRowLabel, type ClientAgentIdentity } from "@/lib/agent-identity-map";
import { listClientAgentFeedback } from "@/lib/data-client-agents";
import { dateKeyInZone, evaluateLaunchGate, isOptionsMode } from "@/lib/client-agents";
import { evaluateTemplateRunGate } from "@/lib/client-agent-runs";
import { canNoteSlot } from "@/lib/slot-notes";
import { parseXDrafts } from "@/lib/x-drafts";
import { resolveOptions } from "@/lib/x-options";
import { laneLabel } from "@/lib/draft-lane-label";
import { upcomingSlots } from "@/lib/client-agent-slots";
import { runtimeTimeZone } from "@/lib/run-cadence";
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
  };
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
    .filter((j) => staff || j.runType !== "launch")
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
    }));
}

/**
 * `viewerIsClient` decides what the refusal may say. The redaction happens HERE,
 * not at render: everything on a ClientAgentScheduleRow is serialized into the
 * RSC payload the browser receives, so a raw internal string handed to a client
 * component is readable whether or not it is ever painted.
 */
export function toScheduleRows(
  runs: Awaited<ReturnType<typeof listPlannedScheduledRuns>>,
  viewerIsClient: boolean,
): ClientAgentScheduleRow[] {
  return runs
    .filter((run) => run.cadence === "weekly" && run.status !== "completed")
    .map((run) => ({
      id: run.id,
      agentId: run.customAgentId,
      status: run.status === "paused" ? "paused" : "active",
      postsPerWeek: run.weekdays?.length ?? 1,
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
      lastError: run.lastError
        ? viewerIsClient
          ? clientSafeRefusal(run.lastError)
          : run.lastError
        : null,
      lastErrorAt: run.lastErrorAt ?? null,
    }));
}

/**
 * Firing zone per custom agent, from its weekly schedule row.
 *
 * The week strip's day boundaries come from the SCHEDULE's stored IANA zone,
 * not the container's — the F108 contract, and the same source
 * `slotScheduleFor` uses when the slots were planned. Reading them in a
 * different zone than they were written in shifts the whole strip by a day for
 * any client who is not in the server's timezone.
 */
export function scheduleZonesByAgent(
  runs: Awaited<ReturnType<typeof listPlannedScheduledRuns>>,
): Map<string, string> {
  const zones = new Map<string, string>();
  for (const run of runs) {
    if (run.cadence !== "weekly" || run.status === "completed") continue;
    if (run.timeZone) zones.set(run.customAgentId, run.timeZone);
  }
  return zones;
}

/**
 * Intake readiness, resolved once per agent with the SAME call the submit core
 * makes (submitCustomAgentJob → hasXAgentIntake / hasLinkedInAgentIntake). The
 * LinkedIn check answers differently per agent key — the multi-seat agent runs
 * on any stored intake, the company-page agents need the company form — so a
 * single shared flag would block agents the server would run, and a card cannot
 * derive this from the key alone.
 */
export async function buildAgentSetup(
  clientId: string,
  agents: Array<{ id: string; key: string }>,
): Promise<Record<string, AgentSetupState>> {
  const resolved = await Promise.all(
    agents.map(async (agent): Promise<[string, AgentSetupState] | null> => {
      if (isXAgentIdentity(agent.key)) {
        return [
          agent.id,
          {
            ready: await hasXAgentIntake(clientId),
            href: `/clients/${clientId}/x-agent`,
            label: "X agent data",
          },
        ];
      }
      if (isLinkedInAgentIdentity(agent.key)) {
        return [
          agent.id,
          {
            ready: await hasLinkedInAgentIntake(clientId, agent.key),
            href: `/clients/${clientId}/linkedin-agent`,
            label: "LinkedIn agent data",
          },
        ];
      }
      return null;
    }),
  );
  return Object.fromEntries(resolved.filter((entry): entry is [string, AgentSetupState] => entry !== null));
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
  now: number;
}): Promise<ClientAgentCardRow[]> {
  const scheduleByAgentId = new Map(args.scheduleRows.map((row) => [row.agentId, row]));
  const rows: ClientAgentCardRow[] = [];
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
          // F70: the ref's tail is the LAB's lane vocabulary ("News-reaction
          // (live)", "Avenue 2"), which no client surface may render raw. The
          // direction stored at pick time is already humanised; the fallback
          // runs the tail through the same laneLabel every other path uses, so
          // a pick made before the field existed still reads properly.
          const pick = todaySlot.optionPick;
          today = {
            slotId: todaySlot.id,
            options: [],
            pickedDirection:
              pick.direction ?? laneLabel(pick.optionRef.split(" · ").slice(1).join(" · ")),
          };
        } else if (todaySlot.assetId) {
          const batchAsset = await getAsset(todaySlot.assetId);
          const batch = batchAsset ? parseXDrafts(batchAsset.content ?? "") : null;
          const options = batch ? resolveOptions(batch, todaySlot.optionRefs ?? []) : [];
          if (options.length > 0) {
            today = { slotId: todaySlot.id, options, pickedDirection: null };
          }
        }
      }
    }

    // The one run the card acknowledges: a "Run now" the viewer just pressed.
    // Scheduled fires are deliberately invisible here (see ClientAgentCardRow).
    const pending = live
      ? args.jobs.find(
          (job) =>
            job.clientAgentId === umbrella.id &&
            job.runType === "manual_template" &&
            (job.status === "queued" || job.status === "running"),
        )
      : undefined;

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
      ...(setup ? { setupHref: setup.href, setupLabel: setup.label } : {}),
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
