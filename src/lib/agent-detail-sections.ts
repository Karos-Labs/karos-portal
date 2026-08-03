import "server-only";

import {
  getAgentIntake,
  getAgentProfileDocData,
  listAgentIntake,
  listClientSeats,
  listXNewsUpdates,
  listXTakes,
} from "@/lib/data";
import type { AgentProfileScopeFields } from "@/lib/data";
import {
  isLinkedInAgentIdentity,
  isRedditAgentIdentity,
  isXAgentIdentity,
} from "@/lib/custom-agent-launch";
import {
  toLiIntakeView,
  toRedditIntakeView,
  toXIntakeView,
} from "@/lib/agent-intake-views";
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
 *     label, a handle, a count, two timestamps, and — since AF-7 — the client's
 *     own ANSWERS, taken from the very functions the intake page renders
 *     (toXIntakeView / toLiIntakeView / toRedditIntakeView), never from the
 *     document. Albert: "your X details — this is a button here, but realistically
 *     it should show on this page." Reading the shared view rather than projecting
 *     the doc again is the whole safety of that: there is one whitelist, and a
 *     field added to `AgentIntake` reaches this band only if somebody first
 *     decided it was client-safe on the intake surface.
 *  2. `buildAgentSetupFacts` never hands a client a number that decomposes into
 *     the batch shape (A3/A4). Runs-per-week and outputs-per-run multiply out
 *     to "your week is generated in one lump", which is the fact the whole slot
 *     model exists to keep indistinguishable — the same reason the pace dialog
 *     has a `paceOnly` face.
 */

/* ──────────────────────── inputs: the intake documents ─────────────────── */

/** One saved answer, as the band prints it. */
export interface AgentInputAnswer {
  /** The question, in the reader's words ("Never post about"). */
  label: string;
  /** Their answer, already a string — a list is joined, a flag is a word. */
  value: string;
}

/** How many rows of a repeating drop (news, takes) the band carries. */
export const INPUT_ANSWERS_SHOWN = 5;

/** One intake document, as a browser may receive it. */
export interface AgentInputRow {
  id: string;
  /** What this document is, in the reader's words ("Company profile"). */
  label: string;
  /** One line of what is stored — the handle, or a count of the drop's rows. */
  detail: string;
  /**
   * Epoch millis of the last save. Null when nothing has been saved yet, which
   * is a different statement from "saved a long time ago" and reads that way.
   */
  updatedAt: number | null;
  filled: boolean;
  /** lucide name for the row mark. */
  icon: string;
  /**
   * The client's own saved answers, rendered inline under the row (AF-7).
   *
   * Absent — not empty — for a document with nothing in it, so an unfilled row
   * stays the plain link to the form it is missing rather than growing an empty
   * disclosure. Every value here came out of a client-safe intake view; nothing
   * reads `AgentIntake` directly, and the key-set test in
   * agent-detail-sections.test.ts is what holds that line.
   */
  answers?: AgentInputAnswer[];
}

/** Drop a pair whose value is blank, so the band never prints a labelled nothing. */
function answer(label: string, value: string | null | undefined): AgentInputAnswer[] {
  const text = value?.trim();
  return text ? [{ label, value: text }] : [];
}

/** Same, for the list-valued fields (roster, subreddits). */
function listAnswer(label: string, values: readonly string[] | undefined): AgentInputAnswer[] {
  const items = (values ?? []).map((v) => v.trim()).filter(Boolean);
  return items.length > 0 ? [{ label, value: items.join(", ") }] : [];
}

/**
 * The client's X answers, in the order the intake page asks for them.
 *
 * Takes the VIEW, not the document. `toXIntakeView` is the whitelist and this is
 * only the register — which question each field answers, in the client's words —
 * so a field that view does not carry cannot be labelled into existence here.
 */
function xAnswers(view: ReturnType<typeof toXIntakeView>): AgentInputAnswer[] {
  if (!view) return [];
  return [
    ...answer("Account", view.handle),
    ...answer("How you want to come across", view.comeAcross),
    ...answer("Never post about", view.offLimits),
    ...listAnswer("Accounts you follow", view.roster),
    // A tri-state: unset means "we work it out", which is a different answer
    // from "no" and has to read as one.
    ...(view.premium === undefined ? [] : answer("Premium account", view.premium ? "Yes" : "No")),
  ];
}

const LI_FALLBACK_LABEL: Record<"writing" | "about", string> = {
  writing: "Writing sample",
  about: "About you",
};

function liAnswers(view: ReturnType<typeof toLiIntakeView>): AgentInputAnswer[] {
  if (!view) return [];
  return [
    ...answer("Account", view.handle),
    ...answer("Role", view.role),
    ...answer("What you post about", view.focus),
    ...answer("How you want to come across", view.comeAcross),
    ...answer("Never post about", view.offLimits),
    // The CV's NAME, which is all the client-safe view carries. Its path and its
    // signed URL stay private, and this band has no way to reach them.
    ...answer("CV on file", view.cvName),
    ...(view.fallbackKind ? answer(LI_FALLBACK_LABEL[view.fallbackKind], view.fallbackText) : []),
  ];
}

const REDDIT_MODE_LABEL: Record<"warming" | "established", string> = {
  warming: "Warming up a new account",
  established: "Established account",
};

/**
 * One intake document's answers, through its OWN family's whitelist.
 *
 * A switch over the union rather than a pair of lookup maps, so a fourth intake
 * family is a compile error here instead of a document silently projected through
 * whichever branch happened to be last — the three views take the same `AgentIntake`
 * and keep different fields of it, so handing an X document to `toLiIntakeView`
 * would publish LinkedIn's fields off an X form.
 */
function intakeAnswersFor(
  agent: AgentIntake["agent"],
  doc: AgentIntake | null,
  xProfile: AgentProfileScopeFields | null,
): AgentInputAnswer[] {
  if (!doc && !(agent === "x" && xProfile)) return [];
  switch (agent) {
    case "x":
      // Intake + profile scope together (x-agent-v2): the handle and
      // off-limits moved to the profile doc; roster/premium stay on intake.
      return xAnswers(toXIntakeView(doc, xProfile));
    case "linkedin":
      return liAnswers(toLiIntakeView(doc));
    case "reddit":
      return redditAnswers(toRedditIntakeView(doc));
  }
}

function redditAnswers(view: ReturnType<typeof toRedditIntakeView>): AgentInputAnswer[] {
  if (!view) return [];
  return [
    ...answer("Account", view.handle),
    ...(view.mode ? answer("Account stage", REDDIT_MODE_LABEL[view.mode]) : []),
    ...answer("Account history", view.accountHistory),
    ...listAnswer("Subreddits you are welcome in", view.subreddits),
    // The fact a dated row cannot state, and the reason the finder card exists
    // beside this band: being banned somewhere is something a client wants on
    // the page rather than behind a link.
    ...listAnswer("Off limits", view.offLimitsSubreddits),
    ...answer("Disclosure", view.disclosurePosture),
    ...answer("Never post about", view.offLimits),
  ];
}

/** The "What it runs on" section for one of the three intake-driven agents. */
export interface AgentInputsView {
  agent: AgentIntake["agent"];
  /** The existing full-page intake surface — the ONE place these are edited. */
  href: string;
  /**
   * What to call these documents to the READER, e.g. "Your X details"
   * (AgentSetupState.clientLabel). This band is client-facing, so it does not
   * carry the operator vocabulary the route and the staff run dialog use.
   */
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
  /** X only — the profile-scope doc that now carries handle/off-limits (x-agent-v2). */
  xProfile?: AgentProfileScopeFields | null;
}): AgentInputRow[] {
  const rows: AgentInputRow[] = [];
  const answersOf = (doc: AgentIntake | null): { answers?: AgentInputAnswer[] } => {
    const saved = intakeAnswersFor(args.agent, doc, args.xProfile ?? null);
    // ABSENT, not empty. A row with nothing saved stays the plain link to the
    // form it is missing; growing an empty disclosure on it would be a control
    // that opens onto nothing.
    return saved.length > 0 ? { answers: saved } : {};
  };

  rows.push({
    id: "company",
    label: args.agent === "reddit" ? "Your Reddit account" : "Company profile",
    detail: args.company
      ? (args.company.handle ?? "Saved — no account name yet")
      : "Not filled in yet",
    updatedAt: args.company?.updatedAt ?? null,
    filled: Boolean(args.company),
    icon: args.agent === "reddit" ? "User" : "Building2",
    ...answersOf(args.company),
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
        // THIS SEAT's document and no other. `intakeBySeat` is keyed on the
        // seat id, so the row cannot carry a colleague's answers even if two
        // seats share a name.
        ...answersOf(doc),
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
      // The drop's own rows are already the client's words, typed by them on
      // this client's own news box — there is no shared collection and no other
      // seat's data to ride along, so the whitelist here is the two fields the
      // box itself renders. Capped: this is a peek, and the box is where the
      // whole list lives.
      ...(args.news.length > 0
        ? {
            answers: args.news
              .slice(0, INPUT_ANSWERS_SHOWN)
              .map((update) => ({ label: update.date, value: update.title })),
          }
        : {}),
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
      // Same rule as the news drop: the client's own lines, two fields, capped.
      // `topic` when they gave one, the date when they did not, so the label
      // always says something rather than being blank on half the rows.
      ...(args.takes.length > 0
        ? {
            answers: args.takes
              .slice(0, INPUT_ANSWERS_SHOWN)
              .map((take) => ({ label: take.topic?.trim() || take.date, value: take.take })),
          }
        : {}),
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

  const [company, intake, seats, news, takes, xProfile] = await Promise.all([
    getAgentIntake(clientId, agent, null),
    agent === "reddit" ? Promise.resolve<AgentIntake[]>([]) : listAgentIntake(clientId, agent),
    agent === "reddit" ? Promise.resolve<ClientSeat[]>([]) : listClientSeats(clientId),
    agent === "reddit" ? Promise.resolve<XNewsUpdate[]>([]) : listXNewsUpdates(clientId),
    agent === "x" ? listXTakes(clientId) : Promise.resolve<XTake[]>([]),
    // x-agent-v2 moved the company handle/off-limits/come-across into the
    // profile-scope doc; the X view reads intake + profile together.
    agent === "x" ? getAgentProfileDocData(clientId, "x") : Promise.resolve(null),
  ]);

  return {
    agent,
    // The COMPANY scope of the profile doc — per-seat scopes stay behind the
    // intake surface, same as before.
    rows: toAgentInputRows({ agent, company, seats, intake, news, takes, xProfile: xProfile?.company ?? null }),
  };
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
  setup: { ready: boolean; href: string; clientLabel: string } | null,
): AgentInputsView | null {
  if (!docs || !setup) return null;
  return {
    agent: docs.agent,
    href: setup.href,
    label: setup.clientLabel,
    ready: setup.ready,
    rows: docs.rows,
  };
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
