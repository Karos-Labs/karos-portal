/**
 * Running a LIVE client agent — the §2 guard rail and the per-template run
 * gate (Phase 3 §7.1 card 4).
 *
 * PURE and client-safe, for the same reason the launch gate is: the card that
 * draws a Run button and the action that fires the run evaluate the SAME
 * predicate in the same order, so a control can never offer a press the server
 * would refuse (F131). A gate that lives only on the server produces enabled
 * buttons that fail; a gate that lives only in the card produces a server that
 * trusts the browser. It has to be one function, called from both.
 *
 * Nothing in here may reveal how or when content is produced (the A3/A4 churn
 * rule): the copy talks about setup, formats and credits — never about batches,
 * queues, or posts that already exist.
 */

import type { ClientAgent, ClientAgentLaunchState, ClientAgentTemplate } from "@/lib/types";
import { isOptionsMode } from "@/lib/client-agents";

/* ───────────────────── the §2 guard rail (not-live umbrellas) ───────────── */

/**
 * Why a client may not run (or re-schedule) an umbrella-bound agent right now.
 * One code per non-live launch state — the umbrella owns the agent from the
 * moment it is bound, so "not live" is the whole condition.
 */
export type UmbrellaRunBlockCode = "setup_not_started" | "setup_running" | "setup_failed";

export interface UmbrellaRunBlock {
  code: UmbrellaRunBlockCode;
  reason: string;
}

const UMBRELLA_RUN_BLOCK: Record<UmbrellaRunBlockCode, string> = {
  setup_not_started: "This agent isn't set up yet — launch it first and it starts producing.",
  setup_running: "Setup is still running — this agent starts producing as soon as it finishes.",
  setup_failed: "Setup needs another pass before this agent can run.",
};

/**
 * The §2 guard rail: an umbrella-bound agent is not runnable by its CLIENT
 * until the umbrella is live.
 *
 * Returns null for a live umbrella (and for no umbrella at all — a plain
 * custom agent is unaffected), otherwise the line the client reads.
 *
 * Why the client and not everyone: staff fire the setup run, curate its output
 * and go live, and they need the generic Run and Schedule controls throughout —
 * blocking them would remove the only way to get an umbrella live. The client's
 * story is the launch card, and offering them a Run beside it would ask them to
 * pay for a run of an agent that has no templates to run.
 */
export function umbrellaRunBlock(state: ClientAgentLaunchState): UmbrellaRunBlock | null {
  switch (state) {
    case "live":
      return null;
    case "not_launched":
      return { code: "setup_not_started", reason: UMBRELLA_RUN_BLOCK.setup_not_started };
    case "launching":
    case "curating":
      return { code: "setup_running", reason: UMBRELLA_RUN_BLOCK.setup_running };
    case "launch_failed":
      return { code: "setup_failed", reason: UMBRELLA_RUN_BLOCK.setup_failed };
  }
}

/* ───────────────────────── the per-template run gate ────────────────────── */

export type TemplateRunBlockCode =
  | UmbrellaRunBlockCode
  | "template_paused"
  | "setup_missing"
  | "credits_short";

export interface TemplateRunGateInput {
  launchState: ClientAgentLaunchState;
  /** Registry status of the template being run. */
  templateStatus: ClientAgentTemplate["status"];
  /**
   * This agent's intake, when it has one (X / LinkedIn). Same shape and same
   * resolved value evaluateLegacyRunGate takes — see the rung below for why a
   * live umbrella still needs it.
   */
  setup?: { ready: boolean; label: string; href: string } | null;
  /**
   * What one run of this agent costs. Per-agent flat price (Q6): templates
   * inherit the agent's `creditCost`, there is no per-template pricing.
   */
  cost: number;
  /**
   * Spendable credits right now. `undefined` means the actor is NOT billable
   * (staff, or an admin in "View as Client") — their runs are free, so the
   * credit rung cannot block them.
   */
  availableCredits?: number;
  /** The pre-resolved binding-limit line (credits.ts creditBlockReason). */
  creditBlockReason?: string | null;
}

export type TemplateRunGateResult =
  | { allowed: true; cost: number }
  | { allowed: false; code: TemplateRunBlockCode; reason: string };

/**
 * Evaluated in the server's own order: the umbrella must be live, the template
 * must be active, the agent's intake must exist, and only then does the price
 * matter.
 *
 * Order is the point. A client whose agent is mid-setup AND out of credits must
 * be told about the setup — that is what the server refuses on, and "top up
 * your credits" would send them to buy something that still would not run.
 *
 * The INTAKE rung is the sibling of evaluateLegacyRunGate's, and it sits in the
 * same place in the ladder: above credits, for the same reason — do not sell a
 * run that cannot happen. It was missing here, and the gap was visible on one
 * screen (F131 re-entry): a LIVE X/LinkedIn umbrella whose intake had never been
 * filled in painted "Set it up" in the detail page's sidebar while "Create new
 * post" sat there enabled, because the only ladder that knew about intake was
 * the legacy one. The submit core hard-gates on the same intake and refuses
 * before charging, so the press produced a refusal rather than a post.
 *
 * Note the submit core checks intake AFTER the action has cleared credits; this
 * gate deliberately puts it BEFORE. A surface may refuse earlier than the server
 * does — what it may never do is offer a press the server would turn away.
 */
export function evaluateTemplateRunGate(input: TemplateRunGateInput): TemplateRunGateResult {
  const umbrella = umbrellaRunBlock(input.launchState);
  if (umbrella) return { allowed: false, code: umbrella.code, reason: umbrella.reason };

  if (input.templateStatus !== "active") {
    return {
      allowed: false,
      code: "template_paused",
      reason:
        input.templateStatus === "paused"
          ? "This format is paused — turn it back on to run it."
          : "This format has been retired.",
    };
  }

  if (input.setup && !input.setup.ready) {
    return {
      allowed: false,
      code: "setup_missing",
      // Word for word the legacy ladder's line: the two gates guard the same
      // refusal on the same agent, and a client who meets one on the roster and
      // the other on the detail page must not read two different explanations.
      reason: `This agent writes from your ${input.setup.label} — it needs that before it can make a post.`,
    };
  }

  // Staff / impersonated sessions never charge, so no price can block them.
  if (input.availableCredits === undefined) return { allowed: true, cost: 0 };

  if (input.availableCredits < input.cost) {
    return {
      allowed: false,
      code: "credits_short",
      reason:
        input.creditBlockReason?.trim() || "Not enough credits — ask your Karos team for a top-up.",
    };
  }
  return { allowed: true, cost: input.cost };
}

/**
 * Why "Create a new post" is off when NO template gate has an opinion.
 *
 * The detail panel picks the first template whose gate allows a run, and paints
 * the first blocked gate's reason when none does. A live umbrella with an EMPTY
 * registry has neither: no runnable template and no gate to quote, so the button
 * went dead with nothing beside it — the F25 failure (a disabled control whose
 * reason nobody can read is the same as no reason at all), reached by both of
 * the two shapes that legitimately have no templates.
 *
 * Options-mode (X) is the FINAL state of that shape, not a gap: its product is
 * the daily pick, so there is no per-format run to offer and never will be. The
 * single-mode empty registry is the temporary one — a grandfathered bind (W6) or
 * the §9 backfill before templates are seeded.
 *
 * Neither line may say anything about what has or has not been produced (A3/A4).
 */
export function noRunnableTemplateReason(input: {
  optionsMode: boolean;
  hasTemplates: boolean;
}): string | null {
  if (input.hasTemplates) return null;
  return input.optionsMode
    ? "This agent writes one post a day and you choose its direction — there is no separate format to run on demand."
    : "Your Karos team is still setting up the formats this agent writes. Making a post now works once they are in place.";
}

/* ─────────────────────────── the pinned run prompt ──────────────────────── */

/**
 * The brief a manual template run carries (§8.1: free-text `brief.prompt` is
 * the mechanism that exists today).
 *
 * Pinned to ONE post of ONE named template: the template registry is the
 * client's mental model of what this agent makes, so a run fired from the "By
 * The Numbers" row that came back with three posts in two other formats would
 * make the rows decorative. `template_key` also rides in the metadata, which is
 * what stamps the resulting asset — the prompt is the instruction, the metadata
 * is the join.
 */
export function templateRunPrompt(input: {
  agentName: string;
  templateName: string;
  templateKey: string;
  rationale?: string | null;
}): string {
  const lines = [
    `Produce exactly 1 post using the "${input.templateName}" template for this client's ${input.agentName}.`,
    "",
    `Template key: ${input.templateKey}`,
  ];
  if (input.rationale?.trim()) {
    lines.push(`What this template is for: ${input.rationale.trim()}`);
  }
  lines.push(
    "",
    "Stay inside that template — this is one post in an established recurring format, not a new idea for one.",
  );
  return lines.join("\n");
}

/* ──────────────────────────── template ordering ─────────────────────────── */

/**
 * Move one template up or down the registry order and return the resulting key
 * order. Pure so the card can render the new order optimistically and the
 * server can validate the exact same list.
 *
 * Retired templates travel with the list rather than being filtered out: the
 * order is a property of the registry, and dropping them here would quietly
 * renumber them on the next save.
 */
export function moveTemplateKey(
  keys: string[],
  key: string,
  direction: "up" | "down",
): string[] {
  const index = keys.indexOf(key);
  if (index < 0) return keys;
  const target = direction === "up" ? index - 1 : index + 1;
  if (target < 0 || target >= keys.length) return keys;
  const next = [...keys];
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}

/* ─────────────────────────── which card a client gets ──────────────────── */

/**
 * Whether the umbrella owns this agent's card on a CLIENT's agents page — i.e.
 * whether the launch card or the live card replaces today's generic one.
 *
 * A not-live umbrella always owns it: the launch card is the client's whole
 * story for an agent that is being set up, and a Run button beside it would
 * charge for an agent with no confirmed templates.
 *
 * A LIVE umbrella owns it only once it has something to show. A live umbrella
 * with an empty registry (the grandfathered bind of an already-producing agent
 * — W6 — and the state the §9 backfill leaves before templates are seeded) is
 * NOT ready: taking away a working Run button and schedule row and putting a
 * card with no rows in their place is the F131 failure with the roles reversed.
 * The generic card keeps serving until the registry exists.
 *
 * Options-mode umbrellas (X) own it immediately: their product is the daily
 * pick, so an empty template registry is the correct and final state.
 */
export function umbrellaOwnsClientCard(
  agent: Pick<ClientAgent, "launchState" | "templates" | "slotMode">,
): boolean {
  if (agent.launchState !== "live") return true;
  if (isOptionsMode(agent)) return true;
  return agent.templates.some((t) => t.status !== "retired");
}

/**
 * The registry in stored order — what the client's template rows render and
 * what a reorder re-positions. Unlike `activeTemplates` this keeps paused rows
 * (the client needs to see the thing they paused in order to resume it) and
 * drops only retired ones, which are history.
 */
export function visibleTemplates(agent: Pick<ClientAgent, "templates">): ClientAgentTemplate[] {
  return [...agent.templates]
    .filter((t) => t.status !== "retired")
    .sort((a, b) => a.position - b.position || a.key.localeCompare(b.key));
}

/* ───────────── the legacy (no-umbrella, live-schedule) run gate ──────────── */

export type LegacyRunBlockCode = "service_down" | "setup_missing" | "credits_short";

export interface LegacyRunGateResult {
  allowed: boolean;
  code?: LegacyRunBlockCode;
  reason?: string;
  href?: string;
  hrefLabel?: string;
}

/**
 * Whether an agent with a live schedule but NO umbrella may be run right now
 * (CD-H8).
 *
 * The sibling of evaluateTemplateRunGate, for the shape that has no templates
 * to gate on. Same ladder the generic card walks, in the same order — service,
 * then intake, then credits — so the detail page and the card can never
 * disagree about whether a run is possible, and pure for the same reason:
 * the surface evaluates it before painting a control, and the action re-runs
 * the equivalent check, so no button can offer a press the server refuses.
 *
 * Order is deliberate. An outage outranks a missing intake because filling in
 * the intake would not help while runs are paused; intake outranks credits
 * because a client who cannot run at all should not first be told to buy
 * credits for it.
 */
export function evaluateLegacyRunGate(input: {
  serviceConfigured: boolean;
  /** This agent's intake, when it has one. */
  setup?: { ready: boolean; label: string; href: string } | null;
  cost: number;
  /** Undefined ⇒ the actor is not billable (staff): credits cannot block them. */
  availableCredits?: number;
  /** Which limit bit, resolved by the same ladder assessCharge uses. */
  creditBlockReason?: string | null;
}): LegacyRunGateResult {
  if (!input.serviceConfigured) {
    return {
      allowed: false,
      code: "service_down",
      reason:
        "Agent runs are paused right now — this will work again once your Karos team clears it.",
    };
  }
  if (input.setup && !input.setup.ready) {
    return {
      allowed: false,
      code: "setup_missing",
      reason: `This agent writes from your ${input.setup.label} — it needs that before it can make a post.`,
      href: input.setup.href,
      hrefLabel: `Set up your ${input.setup.label}`,
    };
  }
  if (input.availableCredits !== undefined && input.availableCredits < input.cost) {
    return {
      allowed: false,
      code: "credits_short",
      reason: input.creditBlockReason ?? "Not enough credits for a post right now.",
    };
  }
  return { allowed: true };
}
