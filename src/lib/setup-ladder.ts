/**
 * THE SETUP LADDER — the six steps that stand between a fresh account and a
 * first result, and the per-client order they are asked in.
 *
 * PORTAL FEEDBACK ROUND 4, 2026-09. Home carried two lists: "Next actions"
 * (lib/action-list.ts's 24 rows, collapsed to three with a "See all 24"
 * expander) and "Recommended tasks" (the onboarding swarm's content ideas).
 * The product owner's ruling on the pair, verbatim in effect: the recommended
 * set must be a fixed, small number of SETUP steps that get the client to a
 * first result with our agents, ordered per client at onboarding, and the
 * expanded 24-row list with its greyed-out done rows "looks bad" — fewer,
 * essential steps, a progress bar, a best-practice onboarding checklist.
 *
 * So: six steps, one widget (components/home-get-set-up.tsx), and the swarm's
 * content ideas leave Home for the Calendar, where they already render with
 * dates.
 *
 * WHY SIX, AND WHY THE FIRST ONE SHIPS TICKED. The setup audit's UX section
 * settled both from published guidance rather than taste:
 *  · Chameleon's own data — a user completes about five checklist items, so be
 *    selective; product-onboarding guidance converges on "the 3-5 key actions
 *    to reach the aha moment".
 *  · Nunes & Drèze's endowed-progress effect — a 10-stamp card with 2 stamps
 *    already on it is completed at 34% against 19% for an 8-stamp card from
 *    zero. Coglode's rule of thumb is 10-25% of the total pre-granted; one
 *    ticked step of six is 17%. Step 0 is genuinely done (the signup wizard),
 *    so nothing is being pretended.
 *  · GOV.UK's task-list pattern — a completed task stays VISIBLE and turns
 *    plain, which is what draws attention to the tasks that still need action.
 *    Done rows are therefore never removed, only de-emphasised.
 *  · Chameleon again — mark items complete from activity in the app, not from
 *    a click on the item. Every step here reads a signal; there is no manual
 *    tick anywhere, and no X: none of the six is optional, so nothing here
 *    offers "not for us".
 *
 * PURE AND CLIENT-SAFE, like lib/action-list.ts beside it: no Firestore, no
 * framework import. The page resolves the signals (some of them need the
 * server: `buildAgentSetup` reads intake documents) and hands this module
 * plain data; the widget receives the resolved rows across the RSC boundary.
 *
 * WHAT THIS MODULE DOES NOT DO: it does not re-derive "done". Five of the six
 * steps reuse the action-list ids the portal already stores state for — 01,
 * 21+22, 04, 05 — so a client who has already completed one of them does not
 * meet it again, and no `ClientActionState` migration is needed.
 */

import { intakePageHref, type IntakeFamily } from "@/lib/agent-intake-links";
import {
  isBlogAgentIdentity,
  isLinkedInAgentIdentity,
  isNewsletterAgentIdentity,
  isRedditAgentIdentity,
  isReputationAgentIdentity,
  isXAgentIdentity,
} from "@/lib/custom-agent-launch";

/* ─────────────────────────── the six step ids ─────────────────────────── */

export type SetupStepId = "workspace" | "profile" | "voice" | "agent" | "run" | "result";

/** The six, in their fixed display order. The per-client ordering (below) ranks
 *  AGENTS, never steps: the steps are a data dependency chain, and reordering
 *  "see your first result" above "run your first agent" would be a lie. */
export const SETUP_STEP_IDS: readonly SetupStepId[] = [
  "workspace",
  "profile",
  "voice",
  "agent",
  "run",
  "result",
];

/**
 * The action-list ids each signal-backed step reuses, so a step's completion
 * and the existing checklist's cannot drift.
 *
 * "voice" is TWO ids merged (21 brand voice + 22 target persona): the audit
 * found them to be one gesture — both are context documents opened from the
 * same place — spelled as two rows, which is one of the reasons the old list
 * ran to 24.
 */
export const SETUP_STEP_ACTION_IDS = {
  profile: ["01"],
  voice: ["21", "22"],
  run: ["04"],
  result: ["05"],
} as const;

/**
 * The reserved `ClientActionState.actionId` a client's "Hide this" writes once
 * the ladder is finished.
 *
 * A stored row rather than a new `Client` field, deliberately: Home already
 * reads this client's whole `ClientActionState` set for the checklist signals,
 * and the action-list writers already authorize exactly the right people (the
 * client themselves, or staff on a support call). The alternative — a
 * `setupLadderHiddenAt` field — needs a type change, a data-layer write, a new
 * server action and a new authorization surface to say the same thing.
 *
 * WRITTEN AS `dismissed`, NOT `not_relevant` (review wave, 2026-09). The press
 * used to reach for `markActionNotRelevantAction`, the portal's ONE permanent
 * skip, with no un-mark on the client's own side — for a card that legitimately
 * comes back: grant a second agent and the ladder reopens with real steps in it.
 * It is `dismissActionAction`'s cooldown now, and Home additionally re-shows the
 * card whenever the ladder is no longer complete, so nothing has to be cleared
 * by hand. A `not_relevant` row written before this change is still honoured.
 *
 * Not an `ACTION_DEFINITIONS` row: it has no label, no href and no place in
 * any list. It is allow-listed by name in action-list-actions.ts's
 * `isKnownAction` instead.
 */
export const SETUP_LADDER_HIDDEN_ACTION_ID = "ladder-done";

/* ──────────────────────── which family an agent is ─────────────────────── */

/**
 * The families the ladder can say something specific about.
 *
 * Six of them have a portal intake page the client fills in themselves
 * (`IntakeFamily`); `instagram` is the combined Instagram/TikTok content
 * engine, which has NO self-service path at all — it is bound and taken live
 * by staff — and is called out here precisely so step 3 never tells a client
 * to go and do something the product gives them no way to do.
 */
export type SetupLadderFamily = IntakeFamily | "instagram";

const CONTENT_ENGINE = /instagram/i;

/**
 * Which family an agent belongs to, or null when we have nothing specific to
 * say about it.
 *
 * Asked through the same §7.3 identity predicates the submit cores, the setup
 * registry and the intake builder gate on, rather than a seventh regex: a
 * ladder that disagrees with the server about which agent needs an intake form
 * would send a client to a page that is not their gate.
 */
export function setupLadderFamily(agent: { key: string; name?: string }): SetupLadderFamily | null {
  const key = agent.key;
  if (isXAgentIdentity(key)) return "x";
  if (isLinkedInAgentIdentity(key)) return "linkedin";
  if (isRedditAgentIdentity(key)) return "reddit";
  if (isNewsletterAgentIdentity(key)) return "newsletter";
  if (isBlogAgentIdentity(key)) return "blog";
  if (isReputationAgentIdentity(key)) return "reputation";
  // Last, and only on the identity string the rest of the codebase matches on:
  // every predicate above is an exact key, so nothing can be swallowed by it.
  if (CONTENT_ENGINE.test(`${key} ${agent.name ?? ""}`)) return "instagram";
  return null;
}

/** True when the family has an intake page a client can fill in themselves. */
export function familyHasIntakePage(family: SetupLadderFamily | null): family is IntakeFamily {
  return (
    family === "x" ||
    family === "linkedin" ||
    family === "reddit" ||
    family === "newsletter" ||
    family === "blog" ||
    family === "reputation"
  );
}

/** Where step 3 sends the client for one agent: the family's own intake page
 *  when it has one, else the agent's detail page (where its launch card is). */
export function agentSetupHref(
  clientId: string,
  agent: { id: string; key: string; name?: string },
): string {
  const family = setupLadderFamily(agent);
  return familyHasIntakePage(family)
    ? intakePageHref(clientId, family)
    : `/clients/${clientId}/agents/${agent.id}`;
}

/* ───────────────────────── per-client ordering ─────────────────────────── */

/**
 * The deterministic score's weights, named so the rules can be read as rules.
 *
 * Straight from the setup audit's ordering section. The shape of the argument:
 * an agent for a platform the client already lives on gets to a result fastest
 * and is the one they will recognise, so evidence that they are ON that
 * platform outranks everything; a connected integration is stronger evidence
 * than a typed handle but rarer, so it sits just below it and the two stack; a
 * pin is Karos's own opinion recorded at onboarding; the category table is a
 * guess and is weighted like one; and an agent that needs a one-time stand-up
 * run before it can produce anything is further from a first result than one
 * that drafts straight off its form.
 */
export const SETUP_LADDER_WEIGHTS = {
  /** The client typed a handle for that platform into their own profile. */
  handle: 40,
  /** That platform is connected as a usable integration. */
  connected: 30,
  /** Karos pinned the agent to this client's rail at onboarding. */
  pinned: 25,
  /** The client's category matches the family in the table below. */
  category: 20,
  /** No stand-up run stands between the form and the first draft (X, Reddit). */
  noStandUp: 10,
  /** A one-time stand-up run does (LinkedIn, blog, newsletter, reputation). */
  standUp: -10,
} as const;

/** `socialLinks` key that evidences a family, when one exists. */
const FAMILY_SOCIAL_KEY: Partial<Record<SetupLadderFamily, keyof SetupLadderSocialLinks>> = {
  x: "x",
  linkedin: "linkedin",
  instagram: "instagram",
  blog: "website",
};

/** `ClientIntegration.platform` id that evidences a family, when one exists.
 *  Note X's integration id is the platform's older name, `twitter`. */
const FAMILY_PLATFORM_ID: Partial<Record<SetupLadderFamily, string>> = {
  x: "twitter",
  linkedin: "linkedin",
  instagram: "instagram",
  reputation: "google_business_profile",
};

/** Families that reach a first draft with no stand-up run in the way. */
const NO_STAND_UP: ReadonlySet<SetupLadderFamily> = new Set<SetupLadderFamily>(["x", "reddit"]);
/** Families whose submit core refuses a run until a one-time stand-up has run. */
const NEEDS_STAND_UP: ReadonlySet<SetupLadderFamily> = new Set<SetupLadderFamily>([
  "linkedin",
  "blog",
  "newsletter",
  "reputation",
]);

/**
 * Category keyword → the families that client usually wants first.
 *
 * A guess, weighted like one, and matched on a lowercased substring of the
 * client's own self-reported category. Deliberately short: a table nobody can
 * hold in their head stops being auditable, and the two stronger signals above
 * it (a handle, a connected channel) carry the ordering whenever they exist.
 */
const CATEGORY_FAMILIES: ReadonlyArray<{ match: RegExp; families: SetupLadderFamily[] }> = [
  { match: /b2b|saas|software|agency|consult|recruit/, families: ["linkedin", "x"] },
  { match: /restaurant|local|clinic|dental|hotel|salon|store|shop/, families: ["reputation", "instagram"] },
  { match: /ecommerce|e-commerce|dtc|d2c|retail|brand/, families: ["instagram", "newsletter"] },
  { match: /media|publisher|news|blog|content|education/, families: ["blog", "newsletter"] },
];

export interface SetupLadderSocialLinks {
  instagram?: string;
  linkedin?: string;
  x?: string;
  tiktok?: string;
  youtube?: string;
  facebook?: string;
  website?: string;
}

export interface SetupLadderRankingContext {
  /** This client's granted agents, in `Client.customAgentIds` order — that
   *  order is the plan's own and is what ties break on. */
  agents: ReadonlyArray<{ id: string; key: string; name?: string }>;
  /** `Client.category` — the self-reported vertical. */
  category?: string | undefined;
  /** `Client.socialLinks` — which handles the client actually has. */
  socialLinks?: SetupLadderSocialLinks | undefined;
  /** Usable (connected + healthy) `ClientIntegration.platform` ids. */
  connectedPlatformIds?: readonly string[] | undefined;
  /** `Client.starredAgentIds` — Karos's own pins. */
  starredAgentIds?: readonly string[] | undefined;
  /**
   * `Client.website` and `Client.brandVoice`. NEITHER SCORES ANYTHING TODAY,
   * and they are in the context on purpose rather than by accident: they are
   * the two remaining inputs the audit's optional LLM permutation step would
   * read, and the hook below is where that would land. A rule that gave the
   * blog agent points for a website would double-count `socialLinks.website`,
   * which already carries that evidence at full weight.
   */
  website?: string | undefined;
  brandVoice?: string | undefined;
}

/** One agent's score, exported so a test can assert a rule rather than an order. */
export function scoreSetupLadderAgent(
  agent: { id: string; key: string; name?: string },
  ctx: Omit<SetupLadderRankingContext, "agents">,
): number {
  const family = setupLadderFamily(agent);
  if (!family) return 0;
  let score = 0;

  const socialKey = FAMILY_SOCIAL_KEY[family];
  if (socialKey && (ctx.socialLinks?.[socialKey] ?? "").trim()) score += SETUP_LADDER_WEIGHTS.handle;

  const platformId = FAMILY_PLATFORM_ID[family];
  if (platformId && (ctx.connectedPlatformIds ?? []).includes(platformId)) {
    score += SETUP_LADDER_WEIGHTS.connected;
  }

  if ((ctx.starredAgentIds ?? []).includes(agent.id)) score += SETUP_LADDER_WEIGHTS.pinned;

  const category = (ctx.category ?? "").toLowerCase();
  if (category) {
    const row = CATEGORY_FAMILIES.find((r) => r.match.test(category));
    if (row?.families.includes(family)) score += SETUP_LADDER_WEIGHTS.category;
  }

  if (NO_STAND_UP.has(family)) score += SETUP_LADDER_WEIGHTS.noStandUp;
  if (NEEDS_STAND_UP.has(family)) score += SETUP_LADDER_WEIGHTS.standUp;

  return score;
}

/**
 * The per-client agent order, decided once at onboarding and stored as
 * `Client.setupLadderOrder` (ids only — a stored label would go stale, a
 * stored id resolves through code or is ignored).
 *
 * PURE AND DETERMINISTIC. Ties break by the agent's position in
 * `customAgentIds`, which is the plan's own order, so this function returns the
 * same answer for the same client every time it is called — which is what lets
 * Home fall back to computing it on the fly for a client onboarded before the
 * field existed and get the behaviour a fresh client gets.
 *
 * ── THE LLM PERMUTATION HOOK, DELIBERATELY NOT BUILT ────────────────────
 *
 * The audit proposes one optional refinement: when the deterministic score
 * leaves a tie spanning more than two agents, or the category matched nothing,
 * ask a model for a PERMUTATION OF THE INPUT IDS ONLY (never new steps, never
 * free text), validate it is exactly that, and fall back to this order on any
 * failure. It is out of scope for this pass and is not stubbed here: an
 * unreachable branch is a worse artefact than a documented absence. The seam
 * is the caller's — `completeOnboardingAction` already runs inside the
 * AI-processing lock with the swarm, which is where such a call would go, and
 * it would post-process this array rather than replace it.
 */
export function rankSetupLadder(ctx: SetupLadderRankingContext): string[] {
  return ctx.agents
    .map((agent, index) => ({ id: agent.id, index, score: scoreSetupLadderAgent(agent, ctx) }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((a) => a.id);
}

/**
 * Apply a stored order to the agents that actually exist right now.
 *
 * Unknown stored ids are DROPPED (a grant can be revoked, an agent retired) and
 * known ids missing from the stored order are APPENDED in the caller's own
 * order (a grant added after onboarding). Both directions matter: the stored
 * array is a preference, never a source of truth about what this client has.
 */
export function orderSetupLadderAgents<T extends { id: string }>(
  agents: readonly T[],
  order: readonly string[] | undefined,
): T[] {
  if (!order?.length) return [...agents];
  const byId = new Map(agents.map((a) => [a.id, a]));
  const ranked: T[] = [];
  for (const id of order) {
    const agent = byId.get(id);
    if (agent && !ranked.includes(agent)) ranked.push(agent);
  }
  for (const agent of agents) if (!ranked.includes(agent)) ranked.push(agent);
  return ranked;
}

/**
 * IS THE STORED ORDER STILL ABOUT THIS CLIENT'S PLAN (review wave, 2026-09)?
 *
 * `Client.setupLadderOrderAt` was written by `completeOnboardingAction` and read
 * by nobody, so the field's own docstring — "so a later re-grant can tell a
 * stale order from an absent one" — described an intention rather than a
 * behaviour. Meanwhile `orderSetupLadderAgents` APPENDS a grant the stored array
 * has never heard of, which is the safe answer for a missing id and the wrong
 * answer for a re-planned client: an agent granted after onboarding lands at the
 * BACK of the ladder however strong its evidence is, and the client is walked
 * through the agent Karos has since moved on from first.
 *
 * Two ways to be stale, and the caller re-ranks on either:
 *
 *  1. A GRANT THIS ORDER NEVER SAW. Cheap, exact, and available on every client:
 *     an id in the roster that the stored array does not contain can only have
 *     arrived after the array was computed.
 *  2. A GRANT STAMPED AFTER THE ORDER WAS. `grantedAt` is per-agent; the page
 *     fills it from the bound umbrella's `createdAt`, which is the closest thing
 *     to a grant instant the data records (nothing stamps `customAgentIds`
 *     itself). It catches the case rule 1 cannot: an id that WAS in the stored
 *     order, revoked, and granted again later under a different plan.
 *
 * Neither direction touches a client whose plan has not moved, which is the
 * point — a stored order exists so the ladder does not re-rank under a client
 * mid-setup.
 */
export function setupLadderOrderIsStale(
  agents: readonly { id: string }[],
  order: readonly string[] | undefined,
  opts?: {
    /** `Client.setupLadderOrderAt` — when the stored order was computed. */
    orderAt?: number | undefined;
    /** agent id → when this client got it, for the callers that know. */
    grantedAt?: ReadonlyMap<string, number> | undefined;
  },
): boolean {
  if (!order?.length) return true;
  const stored = new Set(order);
  if (agents.some((a) => !stored.has(a.id))) return true;
  const orderAt = opts?.orderAt;
  if (orderAt == null || !opts?.grantedAt) return false;
  return agents.some((a) => {
    const at = opts.grantedAt?.get(a.id);
    return at != null && at > orderAt;
  });
}

/**
 * The order the ladder actually uses: the stored one while it still describes
 * this client's grants, and a freshly computed rank when it does not.
 *
 * The fallback is not a DIFFERENT behaviour for a client onboarded before the
 * field existed — `rankSetupLadder` is pure and deterministic, so it is the same
 * answer, computed a moment later.
 */
export function resolveSetupLadderOrder(
  ctx: SetupLadderRankingContext & {
    storedOrder?: readonly string[] | undefined;
    storedOrderAt?: number | undefined;
    grantedAt?: ReadonlyMap<string, number> | undefined;
  },
): string[] {
  const stale = setupLadderOrderIsStale(ctx.agents, ctx.storedOrder, {
    orderAt: ctx.storedOrderAt,
    grantedAt: ctx.grantedAt,
  });
  return stale ? rankSetupLadder(ctx) : [...(ctx.storedOrder ?? [])];
}

/* ──────────────────────────── step 3's agent ───────────────────────────── */

export interface SetupLadderAgentCandidate {
  id: string;
  name: string;
  /** Where the client fills in what this agent needs — `agentSetupHref`. */
  setupHref: string;
  /** The agent's own page: the ONLY place a client's run gesture lives. */
  runHref: string;
  /**
   * Whether the client has a self-service path into this agent's setup at all.
   * False for the Instagram/TikTok content engine, which staff bind and take
   * live; see `setupLadderFamily`.
   */
  selfServe: boolean;
  /** `buildAgentSetup(...)`: `ready && standUpDone`. Only read when selfServe. */
  setupReady: boolean;
  /** This agent's bound umbrella is live. The only "set up" answer an agent
   *  with no self-service path can have. */
  live: boolean;
}

/**
 * Is step 3 done for this agent?
 *
 * TWO ANSWERS, and the split is the honest one. An agent with an intake page is
 * set up when its form is saved and its stand-up run has happened — the exact
 * pair the submit core refuses on, so the ladder and the server agree about
 * what "ready" means. An agent with NO self-service path cannot be set up by
 * the client at all, so asking after its intake would be asking about a form
 * that does not exist; the only true statement about it is whether Karos has
 * taken it live.
 */
export function agentSetupStepDone(agent: SetupLadderAgentCandidate): boolean {
  return agent.selfServe ? agent.setupReady : agent.live;
}

/**
 * Which agent steps 3, 4 and 5 are about: the FIRST in this client's ladder
 * order that still needs their input, falling back to the first in that order
 * once they are all set up (so a finished ladder's rows still point somewhere
 * real rather than at the roster).
 *
 * A NOT-DONE SELF-SERVE AGENT OUTRANKS A NOT-DONE ONE (review wave, 2026-09).
 * The plain "first that is not done" spelling parked the whole ladder on an
 * agent the client cannot act on: the Instagram/TikTok content engine has no
 * intake page at all, so a client whose ladder order opens with it read "Set up
 * your first agent" with a button into a page that asks them for nothing, and
 * their X agent — a form away from a first draft — was never named. The ladder
 * exists to get somebody to a first result, so the step goes to the agent they
 * can actually move.
 *
 * The non-self-serve agent is still the pick when it is the ONLY thing
 * outstanding; step 3 then renders as a status row rather than a task (see
 * `resolveSetupLadder`), because "Karos is doing this" is the true statement
 * about it and steps 4 and 5 are still the client's to reach.
 */
export function pickSetupLadderAgent(
  candidates: readonly SetupLadderAgentCandidate[],
  order: readonly string[] | undefined,
): SetupLadderAgentCandidate | null {
  const ranked = orderSetupLadderAgents(candidates, order);
  const pending = ranked.filter((a) => !agentSetupStepDone(a));
  return pending.find((a) => a.selfServe) ?? pending[0] ?? ranked[0] ?? null;
}

/* ─────────────────────────── the resolved rows ─────────────────────────── */

export interface SetupStepView {
  id: SetupStepId;
  label: string;
  /** The one-line reason, rendered on the step the client is on and on a
   *  waiting row (where it is the only thing that explains the wait). */
  why: string;
  done: boolean;
  /**
   * Where "Let's do this" goes. Rendered only on the step the client is on, and
   * ABSENT on a step that is nobody's to press — see `waiting` below. A step
   * with no href carries no button anywhere and is skipped by `nextSetupStep`,
   * so the press moves down to the next row that has one.
   */
  href?: string;
  /**
   * This step is outstanding and KAROS owns it, not the client (review wave,
   * 2026-09). True today for exactly one case: step 3 pointing at an agent with
   * no self-service path (the Instagram/TikTok content engine), which staff bind
   * and take live. It is not done, so it does not tick and the ladder is not
   * complete; it just is not a task.
   */
  waiting?: boolean;
}

export interface SetupLadderContext {
  /** Action 01's signal and href. */
  profileDone: boolean;
  profileHref: string;
  /** Actions 21 AND 22 — merged, so this is done only when both are. */
  brandVoiceDone: boolean;
  audienceDone: boolean;
  documentsHref: string;
  /** Step 3's agent, already picked (`pickSetupLadderAgent`). Null when this
   *  client has no granted agent at all — Karos has not finished their setup. */
  agent: SetupLadderAgentCandidate | null;
  /** Where the agent steps point when there is no agent to point at. */
  agentsHref: string;
  /** Action 04's signal. */
  runDone: boolean;
  /** Action 05's signal, and the archive it opens. */
  resultDone: boolean;
  resultHref: string;
}

/**
 * The six rows, resolved.
 *
 * Step 0 is hard-coded done. That is not a fudge: the client cannot reach this
 * page without having finished the signup wizard (lib/onboarding.ts blocks the
 * whole `(app)` group until `hasCompletedOnboarding`), so the only reader of
 * this row is someone for whom it is genuinely complete. It is here for the
 * endowed-progress reason in the module docstring, and because a checklist that
 * silently omits the work you already did tells you the work did not count.
 */
export function resolveSetupLadder(ctx: SetupLadderContext): SetupStepView[] {
  const agent = ctx.agent;
  const agentName = agent?.name;
  /**
   * Step 3 is on KAROS, not on this client (review wave, 2026-09).
   *
   * The picked agent has no self-service path and is not live yet, which is the
   * one combination where the row's own label would be a lie: there is no form
   * to fill in, so "Set up your first agent" with a button would send the client
   * to a page that asks them for nothing. The row states who it is waiting on
   * instead, and carries no destination, so steps 4 and 5 keep the affordance.
   */
  const agentWaitingOnKaros = Boolean(agent && !agent.selfServe && !agent.live);
  return [
    {
      id: "workspace",
      label: "Tell us about your company",
      why: "You did this when you signed up, and every draft starts from it.",
      done: true,
      href: "/onboarding",
    },
    {
      id: "profile",
      label: "Complete your profile",
      why: "Your category and description are what every agent writes from.",
      done: ctx.profileDone,
      href: ctx.profileHref,
    },
    {
      id: "voice",
      label: "Confirm your brand voice and audience",
      why: "These are the two documents every draft gets checked against.",
      done: ctx.brandVoiceDone && ctx.audienceDone,
      href: ctx.documentsHref,
    },
    {
      id: "agent",
      label: agentWaitingOnKaros ? "We are setting up your first agent" : "Set up your first agent",
      why: agentWaitingOnKaros
        ? agentName
          ? `Karos is setting ${agentName} up for you. Nothing is needed from you here.`
          : "Karos is setting this up for you. Nothing is needed from you here."
        : agentName
          ? `${agentName} cannot write anything until it has its details.`
          : "Your first agent cannot write anything until it has its details.",
      done: agent ? agentSetupStepDone(agent) : false,
      ...(agentWaitingOnKaros
        ? { waiting: true }
        : { href: agent?.setupHref ?? ctx.agentsHref }),
    },
    {
      id: "run",
      label: "Run your first agent",
      why: "Nothing exists until one run has finished.",
      done: ctx.runDone,
      href: agent?.runHref ?? ctx.agentsHref,
    },
    {
      id: "result",
      label: "See your first result",
      why: "Open what came back, and tell us what to change.",
      done: ctx.resultDone,
      href: ctx.resultHref,
    },
  ];
}

/** The bar and the count, from the one resolved array, so they cannot disagree. */
export function setupLadderProgress(steps: readonly SetupStepView[]): {
  done: number;
  total: number;
  percent: number;
} {
  const done = steps.filter((s) => s.done).length;
  const total = steps.length;
  return { done, total, percent: total === 0 ? 0 : Math.round((done / total) * 100) };
}

/**
 * The one step that carries the button and the reason line.
 *
 * Only one, deliberately (GOV.UK lets tasks be done in any order; every row
 * here stays a legitimate destination). The AFFORDANCE is ordered even though
 * the links are not: six primary buttons stacked on Home is six things
 * competing for one press, and the audit's sketch gives the press to the step
 * the client is actually on.
 *
 * A STEP WITH NO DESTINATION IS SKIPPED (review wave, 2026-09) — the waiting
 * row above. It is outstanding but it is not the client's to press, and parking
 * the ladder's one button on it would leave the two steps below it, which the
 * client CAN reach, with no affordance at all.
 */
export function nextSetupStep(steps: readonly SetupStepView[]): SetupStepView | null {
  return steps.find((s) => !s.done && s.href) ?? null;
}

/** True once every step is done — the widget's "You're set up" state. */
export function setupLadderComplete(steps: readonly SetupStepView[]): boolean {
  return steps.length > 0 && steps.every((s) => s.done);
}
