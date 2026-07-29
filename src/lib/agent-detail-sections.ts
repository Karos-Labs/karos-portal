import "server-only";

import {
  getAgentIntake,
  listAgentIntake,
  listClientSeats,
  listXNewsUpdates,
  listXTakes,
} from "@/lib/data";
import {
  isLinkedInAgentIdentity,
  isRedditAgentIdentity,
  isXAgentIdentity,
} from "@/lib/custom-agent-launch";
import { isOptionsMode } from "@/lib/client-agents";
import type {
  AgentIntake,
  ClientAgent,
  ClientAgentTemplate,
  ClientSeat,
  XNewsUpdate,
  XTake,
} from "@/lib/types";

/**
 * The two dated, categorized sections the agent detail hub grew for CD-K1 —
 * what an agent RUNS ON, and how it is SET UP.
 *
 * Albert's directive: "under each agent, everything Daniel created is there,
 * WITH DATES, categorized in sections — all inputs, all outputs, all settings."
 * Outputs already had a home (the archive, and the archetype heroes above it);
 * these are the other two, and they were the halves you could only reach by
 * knowing a URL the redesign stopped linking.
 *
 * SAME BOUNDARY DOCTRINE as client-agent-rows.ts and agent-detail-archetypes.ts:
 * everything returned here is serialized into the RSC payload a browser
 * receives, so redaction that happens at render has already lost. Two rules
 * follow from it and are worth stating because both are easy to undo:
 *
 *  1. `toAgentInputRows` builds by WHITELIST. An intake document carries
 *     `createdBy` (a uid), a private CV path and URL, and every other agent's
 *     fields — the three families share one collection. What crosses is a
 *     label, a handle, a count and two timestamps; the ANSWERS stay on the
 *     intake page, behind the client-safe views that already redact them
 *     (toXIntakeView / toLiIntakeView / toRedditIntakeView).
 *  2. `buildAgentSetupFacts` never hands a client a number that decomposes into
 *     the batch shape (A3/A4). Runs-per-week and outputs-per-run multiply out
 *     to "your week is generated in one lump", which is the fact the whole slot
 *     model exists to keep indistinguishable — the same reason the pace dialog
 *     has a `paceOnly` face.
 */

/* ──────────────────────── inputs: the intake documents ─────────────────── */

/** One intake document, as a browser may receive it. */
export interface AgentInputRow {
  id: string;
  /** What this document is, in the reader's words ("Company profile"). */
  label: string;
  /** One line of what is stored — never the answers themselves. */
  detail: string;
  /**
   * Epoch millis of the last save. Null when nothing has been saved yet, which
   * is a different statement from "saved a long time ago" and reads that way.
   */
  updatedAt: number | null;
  filled: boolean;
  /** lucide name for the row mark. */
  icon: string;
}

/** The "What it runs on" section for one of the three intake-driven agents. */
export interface AgentInputsView {
  agent: AgentIntake["agent"];
  /** The existing full-page intake surface — the ONE place these are edited. */
  href: string;
  /** Its label, e.g. "X agent data" (AgentSetupState.label). */
  label: string;
  /** True when the submit core would accept a run on what is stored. */
  ready: boolean;
  rows: AgentInputRow[];
}

/** Which intake family an agent belongs to, or null if it runs on none. */
export function intakeFamilyFor(agentKey: string): AgentIntake["agent"] | null {
  if (isXAgentIdentity(agentKey)) return "x";
  if (isLinkedInAgentIdentity(agentKey)) return "linkedin";
  if (isRedditAgentIdentity(agentKey)) return "reddit";
  return null;
}

/**
 * Project the stored intake into dated rows.
 *
 * Pure, and given already-read documents, so the rule that decides what crosses
 * the boundary can be driven by a test without a Firestore double.
 *
 * A seat with no intake document still gets a row. That is the point of the
 * section: "Daniel added Maya three weeks ago and nobody ever filled her form
 * in" is exactly the fact a list of only-the-saved-ones cannot state, and it is
 * the one a client or an operator opens this page to find.
 */
export function toAgentInputRows(args: {
  agent: AgentIntake["agent"];
  company: AgentIntake | null;
  seats: ClientSeat[];
  /** Every intake doc for this agent family, company row included. */
  intake: AgentIntake[];
  news: XNewsUpdate[];
  takes: XTake[];
}): AgentInputRow[] {
  const rows: AgentInputRow[] = [];

  rows.push({
    id: "company",
    label: args.agent === "reddit" ? "Your Reddit account" : "Company profile",
    detail: args.company
      ? (args.company.handle ?? "Saved — no account name yet")
      : "Not filled in yet",
    updatedAt: args.company?.updatedAt ?? null,
    filled: Boolean(args.company),
    icon: args.agent === "reddit" ? "User" : "Building2",
  });

  // Reddit runs on the company account alone — it has no seat model, and the
  // e15 intake surface renders none. Inventing empty seat rows for it would
  // promise a per-person product that does not exist.
  if (args.agent !== "reddit") {
    const intakeBySeat = new Map(
      args.intake.filter((doc) => doc.seatId).map((doc) => [doc.seatId as string, doc]),
    );
    for (const seat of args.seats) {
      const doc = intakeBySeat.get(seat.id) ?? null;
      rows.push({
        id: `seat-${seat.id}`,
        label: seat.name,
        detail: doc ? (doc.handle ?? "Saved — no account yet") : "No answers saved yet",
        // The SEAT's own date when its form is empty: a seat that has existed
        // for a month with nothing in it is the state this row exists to show,
        // and a null date there would read as "just added".
        updatedAt: doc?.updatedAt ?? seat.updatedAt,
        filled: Boolean(doc),
        icon: "User",
      });
    }
  }

  // The shared drop (PORTAL-INPUT-CONTRACT §3): the client types an update once
  // and both the X and LinkedIn agents read it, so it is listed on both.
  if (args.agent !== "reddit") {
    const latest = args.news[0] ?? null;
    rows.push({
      id: "news",
      label: "Company news drop",
      detail:
        args.news.length > 0
          ? `${args.news.length} update${args.news.length === 1 ? "" : "s"} on file`
          : "Nothing dropped yet",
      updatedAt: latest?.createdAt ?? null,
      filled: args.news.length > 0,
      icon: "FileText",
    });
  }

  if (args.agent === "x") {
    const latest = args.takes[0] ?? null;
    rows.push({
      id: "takes",
      label: "Takes & topics",
      detail:
        args.takes.length > 0
          ? `${args.takes.length} take${args.takes.length === 1 ? "" : "s"} on file`
          : "Nothing added yet",
      updatedAt: latest?.createdAt ?? null,
      filled: args.takes.length > 0,
      icon: "PenLine",
    });
  }

  return rows;
}

/** The read half — what is stored, before anything is said about readiness. */
export interface AgentInputDocs {
  agent: AgentIntake["agent"];
  rows: AgentInputRow[];
}

/**
 * Read this agent's intake documents, or null when it runs on no intake at all.
 *
 * Deliberately independent of `AgentSetupState` so the caller can fire it
 * alongside the staff intake panes rather than after them. It DOES re-read
 * documents the staff pane builder already fetched — see the dedup seam noted
 * in TOMER-HANDOVER §4.17; the two consumers want different projections of the
 * same collections, and merging them means changing a `ComponentProps<>` return
 * contract that four surfaces depend on.
 */
export async function readAgentInputDocs(
  clientId: string,
  agentKey: string,
): Promise<AgentInputDocs | null> {
  const agent = intakeFamilyFor(agentKey);
  if (!agent) return null;

  const [company, intake, seats, news, takes] = await Promise.all([
    getAgentIntake(clientId, agent, null),
    agent === "reddit" ? Promise.resolve<AgentIntake[]>([]) : listAgentIntake(clientId, agent),
    agent === "reddit" ? Promise.resolve<ClientSeat[]>([]) : listClientSeats(clientId),
    agent === "reddit" ? Promise.resolve<XNewsUpdate[]>([]) : listXNewsUpdates(clientId),
    agent === "x" ? listXTakes(clientId) : Promise.resolve<XTake[]>([]),
  ]);

  return { agent, rows: toAgentInputRows({ agent, company, seats, intake, news, takes }) };
}

/**
 * The inputs section, once readiness is known.
 *
 * `ready` is NOT re-derived here. It arrives from `buildAgentSetup`, which
 * answers it with the very calls the submit cores gate on — two independent
 * answers to "is this set up" is the drift that lets one band say Ready while
 * the run button beside it refuses (the F131 shape).
 */
export function agentInputsView(
  docs: AgentInputDocs | null,
  setup: { ready: boolean; href: string; label: string } | null,
): AgentInputsView | null {
  if (!docs || !setup) return null;
  return { agent: docs.agent, href: setup.href, label: setup.label, ready: setup.ready, rows: docs.rows };
}

/* ─────────────────── settings: the umbrella's launch data ──────────────── */

/**
 * One line of "how it's set up".
 *
 * `at` and `value` are alternatives, not a pair: a fact is either a moment the
 * row renders through the app's date idiom, or a phrase. Sending both would let
 * two renderers disagree about which one this row is.
 */
export interface AgentSetupFact {
  label: string;
  value?: string;
  /** Epoch millis. */
  at?: number;
}

/**
 * The launch run's output, laid out and dated (directive 2).
 *
 * READ-ONLY BY DESIGN. Every one of these already has an editor: the template
 * registry is reordered and paused from the format rows, the pace from the
 * schedule dialog, the registry itself from the staff curation pane. This
 * section is the answer to "what did the setup actually decide", which is the
 * question none of those editors answers — and growing a second write path for
 * fields that already have one is how two surfaces start disagreeing about the
 * same document.
 *
 * `templates` MUST be the viewer-redacted registry (ClientAgentCardRow.templates),
 * never `umbrella.templates`: while an umbrella is `curating`, the stored
 * registry holds what the setup run PROPOSED and staff have not confirmed, and
 * that is exactly what the row projection empties for a client viewer.
 */
export function buildAgentSetupFacts(args: {
  umbrella: Pick<
    ClientAgent,
    | "launchState"
    | "launchStartedAt"
    | "launchCompletedAt"
    | "createdAt"
    | "updatedAt"
    | "slotMode"
    | "chainFamily"
    | "rotation"
  >;
  templates: ClientAgentTemplate[];
  /** Already redacted for this viewer (toScheduleRows). */
  schedule: {
    status: "active" | "paused";
    postsPerWeek: number;
    outputsPerRun: number;
    nextRunAt: number;
  } | null;
  viewerIsClient: boolean;
}): AgentSetupFact[] {
  const facts: AgentSetupFact[] = [];
  const optionsMode = isOptionsMode(args.umbrella);
  const live = args.templates.filter((t) => t.status !== "retired");
  const active = live.filter((t) => t.status === "active");

  const setUpAt = args.umbrella.launchCompletedAt ?? args.umbrella.launchStartedAt ?? null;
  if (setUpAt) facts.push({ label: "Set up", at: setUpAt });
  else facts.push({ label: "Added", at: args.umbrella.createdAt });

  facts.push({
    label: "How it fills a day",
    value: optionsMode
      ? "One post a day, chosen from what it writes that morning"
      : "One format a day, in the order below",
  });

  if (!optionsMode) {
    facts.push({
      label: "Formats",
      value:
        live.length === 0
          ? "None registered yet"
          : `${active.length} running of ${live.length}`,
    });
    // The rotation is the ORDER, and printing it as an order is the only way
    // this row says anything the format list above does not. Built from the
    // redacted registry, in the same order the rows are sorted by, so the two
    // can never describe different sequences.
    const order = [...live]
      .sort((a, b) => a.position - b.position || a.key.localeCompare(b.key))
      .map((t) => t.name);
    if (order.length > 0) facts.push({ label: "Rotation", value: order.join(" → ") });
  }

  if (args.schedule) {
    if (args.viewerIsClient) {
      // A client is told WHETHER it is running, never the arithmetic. "3 runs a
      // week × 5 outputs each" states that their week arrives in lumps, which
      // is the one fact the slot model exists to keep indistinguishable — the
      // same rule that gives the pace dialog its `paceOnly` face.
      facts.push({
        label: "Schedule",
        value: args.schedule.status === "active" ? "Running" : "Paused",
      });
    } else {
      facts.push({
        label: "Pace",
        value: `${args.schedule.postsPerWeek} run${args.schedule.postsPerWeek === 1 ? "" : "s"}/week · ${args.schedule.outputsPerRun} output${args.schedule.outputsPerRun === 1 ? "" : "s"} each${args.schedule.status === "paused" ? " · paused" : ""}`,
      });
      if (args.schedule.nextRunAt) facts.push({ label: "Next fire", at: args.schedule.nextRunAt });
    }
  }

  if (!args.viewerIsClient) {
    facts.push({
      label: "Chain family",
      value: args.umbrella.chainFamily ?? "none (this umbrella owns no family)",
    });
  }

  facts.push({ label: "Last changed", at: args.umbrella.updatedAt });
  return facts;
}
