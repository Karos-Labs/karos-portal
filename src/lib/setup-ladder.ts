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
 *    a click on the item. Every step here reads a signal, and no X: none of the
 *    six is optional, so nothing here offers "not for us".
 *    ONE STEP TAKES A GESTURE (round 6, decision 3), and it is not a tick on
 *    the row: step 2 completes when the client presses "Looks right" at the
 *    foot of the document itself. "Opened it once" was the activity signal
 *    before, and it is the weakest activity there is — it confirmed nothing.
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
import { agentArchetype, OUTPUT_NOUN } from "@/lib/agent-archetype";
import {
  isBlogAgentIdentity,
  isLinkedInAgentIdentity,
  isNewsletterAgentIdentity,
  isRedditAgentIdentity,
  isReputationAgentIdentity,
  isXAgentIdentity,
} from "@/lib/custom-agent-launch";
import { stripDocPreamble } from "@/lib/doc-render";
import type { ContextDocType } from "@/lib/types";

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
 * It is `dismissActionAction`'s row now, and Home additionally re-shows the
 * card whenever the ladder is no longer complete, so nothing has to be cleared
 * by hand. A `not_relevant` row written before this change is still honoured.
 *
 * HOW HOME READS IT (round 6, decision 9, corrected in the review pass): the
 * row is honoured WITHOUT the checklist's seven-day cooldown, and only while the
 * ladder is still complete —
 * `dismissed && setupLadderComplete(steps)`.
 *
 * Both halves are one rule with one subject: what the press dismisses is the
 * FINISHED CARD. `dismissActionAction`'s cooldown is a snooze for a checklist
 * row, and applying it here brought a card whose own copy reads "You're set up"
 * back every week; dropping the completeness conjunct went too far the other way
 * and hid the card for good, so a client granted a second agent would never be
 * told there were steps waiting for it. Decision 9 says the slot stays empty
 * after completion — not that an incomplete ladder stays hidden.
 *
 * The reopen is not a signal wobble either way round: step 5's rule (below) is
 * "the client opened one, OR the portal can no longer show them one", so it does
 * not un-tick under anybody who had genuinely finished.
 *
 * Not an `ACTION_DEFINITIONS` row: it has no label, no href and no place in
 * any list. It is allow-listed by name in action-list-actions.ts's
 * `isKnownAction` instead.
 */
export const SETUP_LADDER_HIDDEN_ACTION_ID = "ladder-done";

/* ─────────────────────────── the landings (round 6) ────────────────────── */

/**
 * THE LADDER LANDS ON THE FIELD, NOT ON THE PAGE (portal feedback round 6).
 *
 * "Clicking 'Complete your profile' lands on Account Center → Profile with no
 * indication of what to do; the profile may already be complete." Every row
 * that names a missing thing now carries the query that opens the editor for
 * exactly that thing, and `for=` tells the landed surface it was reached from
 * the ladder so it can say why (components/here-for.tsx).
 *
 * The three field names are the three halves of "profile complete" (decision
 * 2); `doc` names one of the two documents step 2 is about. Both are read with
 * `useSearchParams` by the landed component, which is why they are QUERY keys
 * and the `#documents` anchor is appended last: `?tab=profile#documents&doc=…`
 * would put `doc` in the FRAGMENT, where no search-param reader can see it.
 */
export type SetupLandingField = "description" | "category" | "website";

export const SETUP_LANDING_FIELDS: readonly SetupLandingField[] = [
  "description",
  "category",
  "website",
] as const;

/** `?edit=`, `?doc=` and `?for=` — named once, so a rename is one edit. */
export const SETUP_LANDING_KEYS = {
  /** Which profile field to open the editor on. */
  edit: "edit",
  /** Which context document to open. */
  doc: "doc",
  /** The ladder step this landing was reached from. */
  for: "for",
} as const;

/** Append query params to an href that may or may not already carry a query. */
function withQuery(href: string, params: Record<string, string>): string {
  const [base, hash = ""] = href.split("#") as [string, string?];
  const joined = Object.entries(params)
    .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
    .join("&");
  const sep = base.includes("?") ? "&" : "?";
  return `${base}${sep}${joined}${hash ? `#${hash}` : ""}`;
}

/** Where a profile row sends the client: the Profile tab, opened on one field. */
export function profileFieldHref(profileHref: string, field: SetupLandingField): string {
  return withQuery(profileHref, {
    [SETUP_LANDING_KEYS.edit]: field,
    [SETUP_LANDING_KEYS.for]: "profile",
  });
}

/** Where a document row sends the client: the Documents block, with that document open. */
export function contextDocHref(profileHref: string, docType: ContextDocType): string {
  return `${withQuery(profileHref, {
    [SETUP_LANDING_KEYS.doc]: docType,
    [SETUP_LANDING_KEYS.for]: "voice",
  })}#documents`;
}

/**
 * What the `<HereFor>` band says at each landing.
 *
 * ONE sentence of action and one of reason, keyed by the thing that was landed
 * on rather than by the step: the band is rendered by the profile panel and the
 * documents list, and neither of them knows anything about ladder steps beyond
 * the `for=` param that says "you were sent here".
 */
export const SETUP_LANDING_COPY: Partial<
  Record<SetupLandingField | ContextDocType, { action: string; reason: string }>
> = {
  description: {
    action: "add a short description",
    reason: "Every agent writes from it.",
  },
  category: {
    action: "add your category",
    reason: "It decides who your agents write for.",
  },
  website: {
    action: "add your website",
    reason: "Your SEO and GEO report and your blog agent read it first.",
  },
  "brand-voice": {
    action: "read your Brand Voice",
    reason: "Every draft gets checked against it.",
  },
  "target-audience": {
    action: "read your Target Audience",
    reason: "It is who every draft is written for.",
  },
};

/**
 * Is there a client-readable copy of this document yet?
 *
 * The same two rules `pickDoc` applies in components/client-documents.tsx for a
 * client viewer — the `client` tier, with a body — so the ladder cannot say
 * "Read your Brand Voice" over a Documents list that is still empty (§2.4).
 * Spelled here rather than imported from that component because it is a "use
 * client" module: a server page importing a value out of one gets a client
 * reference proxy, not the function.
 */
export function hasReadableClientDoc(
  docs: ReadonlyArray<{ docType: string; tier: string; content: string }>,
  docType: ContextDocType,
): boolean {
  return docs.some(
    (doc) =>
      doc.docType === docType &&
      doc.tier === "client" &&
      stripDocPreamble(doc.content).length > 40,
  );
}

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
  /**
   * THE TWO RUNGS, SEPARATELY (portal feedback round 6, §2.5).
   *
   * `setupReady` is their conjunction and it is what the submit core gates on,
   * but a row that knows only the conjunction cannot say WHICH of the two is
   * missing — so the ladder sent a client whose form was already saved back to
   * a filled form, when what was actually outstanding was the one-time stand-up
   * run. `hasIntake` is `buildAgentSetup`'s `ready` (the form is saved);
   * `standUpDone` is its own half. Both are already computed by that call.
   */
  hasIntake: boolean;
  standUpDone: boolean;
  /**
   * This agent is LIVE — `rosterStatus(...).tone === "live"`, resolved by the
   * caller through the one function every other surface asks (risk-review B3).
   *
   * It used to be `launchState === "live"` alone, which is the logic bug the
   * brief names: a client receiving pre-created posts every day read "We are
   * setting up your first agent". Evidence beats the flag, and the evidence is
   * the same evidence the roster and the agent page paint.
   */
  live: boolean;
  /**
   * The runnable format noun this agent's own run panel names (`OUTPUT_NOUN`),
   * and the short platform word in front of it — so step 4's control says
   * "Create your first Instagram post" rather than one label for six steps.
   */
  runLabel: string;
  /** `buildAgentSetup`'s `clientLabel` — "X agent details". Names the intake. */
  intakeLabel: string;
}

/**
 * Is step 3 done for this agent?
 *
 * THREE ANSWERS, and the split is the honest one. An agent with an intake page
 * is set up when its form is saved and its stand-up run has happened — the
 * exact pair the submit core refuses on, so the ladder and the server agree
 * about what "ready" means. An agent with NO self-service path cannot be set up
 * by the client at all, so asking after its intake would be asking about a form
 * that does not exist. And EITHER kind is set up, whatever its rungs say, once
 * it is live: an agent producing content for this client has provably been set
 * up by somebody (risk-review B3).
 */
export function agentSetupStepDone(agent: SetupLadderAgentCandidate): boolean {
  return agent.live || (agent.selfServe && agent.setupReady);
}

/**
 * The control label for step 3, which names the missing RUNG (§2.5, B6c).
 *
 * The long form of the roster's own verb: "Set up" on a card becomes "Set up
 * the LinkedIn Agent" here, because a button on Home has to say which agent it
 * is about. "Request setup" never appears — a waiting row carries no button.
 */
export function agentSetupAction(agent: SetupLadderAgentCandidate): string {
  return agent.hasIntake ? `Set up the ${agent.name}` : `Add your ${agent.intakeLabel}`;
}

/** The short platform word in an agent's stored name: "Instagram Agent" → "Instagram". */
export function agentShortName(name: string): string {
  return name.replace(/\s+agents?$/i, "").trim() || name;
}

/**
 * What one run of this agent makes, in the words its own run panel uses.
 *
 * `OUTPUT_NOUN` through `agentArchetype`, so Reddit says "reply" here exactly
 * as it does on its own page (it drafts a reply, never a post) and a clip maker
 * says "clip".
 */
export function agentRunLabel(agent: { key: string; name?: string }): string {
  const noun = OUTPUT_NOUN[agentArchetype(agent)];
  const short = agentShortName(agent.name ?? "");
  return short ? `${short} ${noun}` : noun;
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

/**
 * WHAT SHAPE A ROW TAKES, as one discriminated field (round 6 review, E7). The
 * widget derived it from a four-deep ternary over six of the flags below, in an
 * order this module never stated, inside a component whose own docstring says it
 * decides nothing.
 *
 *  · `done` plain · `current` carries the accent control (`nextSetupStep`) ·
 *    `link` outstanding and the client's · `waiting` outstanding and OURS ·
 *    `blocked` prerequisite unmet. The last two never take the button.
 */
export type SetupStepKind = "done" | "current" | "link" | "waiting" | "blocked";

export interface SetupStepView {
  id: SetupStepId;
  /**
   * Which of the five shapes this row is. Derived from the flags below by the
   * resolver, so the widget switches instead of re-deriving.
   */
  kind: SetupStepKind;
  label: string;
  /** The one-line reason. Rendered on the step the client is on, on a waiting
   *  row (where it is the only thing that explains the wait), and on any row
   *  whose own line says what is already done and what is left. */
  why: string;
  done: boolean;
  /**
   * WHERE THE ROW GOES, AND EVERY INCOMPLETE ROW HAS ONE (round 6, §2.1).
   *
   * It used to be where the one generic button went, rendered on the current step
   * alone — so four of six rows were not clickable at all while this module's
   * own docstring claimed "every row stays a legitimate destination". The row
   * is the link now (GOV.UK's task list: every task is a link, any order); the
   * current row is the one that also carries the accent control.
   *
   * ABSENT on a step that is nobody's to press: step 0 (the wizard a finished
   * client would be bounced out of) and the documents-are-being-written wait.
   */
  href?: string;
  /**
   * The control label on the step the client is on — it names the ACTION and
   * the missing thing (§2.2). The old one-label-fits-six said neither, which is why
   * "Complete your profile" landed on a page with no clue what to do.
   *
   * Absent on a waiting row and on a blocked one: neither takes the press.
   */
  action?: string;
  /**
   * The status word an incomplete row shows where the control would be:
   * "Not started", or "After step N" when its prerequisite is unmet. The
   * destination already explains the block, so the word does not repeat it.
   */
  status?: string;
  /**
   * This step cannot be done yet because the step it depends on is not. The row
   * stays a link (the page it opens paints the reason it already paints) and
   * never takes the button.
   */
  blocked?: boolean;
  /**
   * This step is outstanding and KAROS owns it, not the client (review wave,
   * 2026-09). Two cases: step 3 pointing at an agent with no self-service path
   * (the Instagram/TikTok content engine), which staff bind and take live, and
   * step 2 while the pipeline has not written the documents yet. It is not
   * done, so it does not tick and the ladder is not complete; it just is not a
   * task, and it never takes the accent button.
   */
  waiting?: boolean;
}

/** The three halves of "profile complete" (decision 2), each asked separately. */
export interface SetupLadderProfileFields {
  category: boolean;
  description: boolean;
  website: boolean;
}

/** One context document's state for step 2 (§2.4): missing, unread, confirmed. */
export interface SetupLadderDocState {
  /** A client-readable copy exists — `hasReadableClientDoc`. */
  present: boolean;
  /** The client pressed "Looks right" on it (action 21 / 22). */
  confirmed: boolean;
}

export interface SetupLadderContext {
  /** Action 01's signal — `category && description && website` (decision 2). */
  profileDone: boolean;
  /** The Profile tab, unadorned: the landings are built off it. */
  profileHref: string;
  /** Which of the three named fields are filled in, for the row's own line. */
  profile: SetupLadderProfileFields;
  /** Actions 21 AND 22, plus whether each document exists to be read at all. */
  brandVoice: SetupLadderDocState;
  audience: SetupLadderDocState;
  /** Step 3's agent, already picked (`pickSetupLadderAgent`). Null when this
   *  client has no granted agent at all — Karos has not finished their setup. */
  agent: SetupLadderAgentCandidate | null;
  /** Where the agent steps point when there is no agent to point at. */
  agentsHref: string;
  /** Action 04's signal: one client-visible run REACHED review or better. */
  runDone: boolean;
  /** Action 05's signal: the client OPENED a deliverable (the archive modal writes it). */
  resultOpened: boolean;
  /**
   * Has a deliverable already aged out of this client's archive (round 6 review,
   * C4/C5)?
   *
   * The second half of step 5's rule, and the reason it needs one. Action 05 is
   * an EVENT — the client opened one — and an event nobody recorded before the
   * release cannot be recovered. The honest reading is not a grandfather date
   * (which was a fixed timestamp answering "did this exist before we changed our
   * minds", i.e. a fact about US) but the client's own archive: a non-draft
   * posted deliverable older than `CLIENT_ARCHIVE_WINDOW_MS` is one the portal
   * CAN NO LONGER SHOW THEM, so "open what came back" is a step that cannot be
   * asked and must not sit unticked forever. Resolved by the page from the same
   * client-visible projection Home already computes.
   */
  agedOutDeliverable: boolean;
  /** Where "See your first result" points: the client archive, on one item. */
  resultHref: string;
  /**
   * Is there anything in the client archive for step 5 to open (round 6,
   * alignment fix 1)?
   *
   * `runDone` is true the moment a run REACHES review, but the asset that run
   * produced is a draft, and the client archive excludes drafts by
   * construction. So the two were not the same fact: the ladder handed the
   * client an accent button called "Open your first post" that opened an empty
   * Workspace. The step waits on Karos's review instead when this is false.
   */
  resultReady: boolean;
}

/**
 * "After step 4" — the prerequisite's own position in the displayed ladder,
 * ONE-BASED (round 6 review, C7).
 *
 * It was the bare array index, so the row that depends on "Set up your first
 * agent" — the fourth of the six rows a client can see and count — told them to
 * come back "After step 3", which is the row above it. Six rows are rendered and
 * none of them is numbered on screen, so the only numbering a client can apply
 * is 1..6 from the top.
 */
function afterStep(id: SetupStepId): string {
  return `After step ${SETUP_STEP_IDS.indexOf(id) + 1}`;
}

/**
 * The profile row's line: what is already there, then what is left.
 *
 * Albert's complaint in one sentence ("the profile may already be complete"),
 * answered by naming both halves. Nothing is invented: each clause is one of
 * the three fields decision 2 counts.
 */
export function profileStepLine(fields: SetupLadderProfileFields): string {
  const NAMES: Record<SetupLandingField, string> = {
    category: "your category",
    description: "a short description",
    website: "your website",
  };
  const missing = SETUP_LANDING_FIELDS.filter((field) => !fields[field]);
  if (missing.length === 0) return "Your category, description and website are all set.";
  const done = SETUP_LANDING_FIELDS.filter((field) => fields[field]).map((f) => NAMES[f]);
  const left = list(missing.map((f) => NAMES[f]));
  const lead =
    done.length > 0 ? `${sentence(list(done))} ${done.length > 1 ? "are" : "is"} set. ` : "";
  return `${lead}Add ${left}.`;
}

/** "a, b and c" — the portal's own list voice, no serial comma, no dashes. */
function list(parts: readonly string[]): string {
  if (parts.length <= 1) return parts[0] ?? "";
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

/** Sentence case for a clause that starts a sentence. */
function sentence(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Which profile field the row's control names: the first one still missing. */
export function firstMissingProfileField(
  fields: SetupLadderProfileFields,
): SetupLandingField | null {
  return SETUP_LANDING_FIELDS.find((field) => !fields[field]) ?? null;
}

/** The control label for one profile field, in the same verb voice as the rest. */
export function profileFieldAction(field: SetupLandingField): string {
  const copy = SETUP_LANDING_COPY[field];
  // Sentence-cased action from the one copy table the landing band also reads,
  // so the button and the band it lands on cannot say two different things.
  const action = copy?.action ?? "complete your profile";
  return action.charAt(0).toUpperCase() + action.slice(1);
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
   * instead, and never takes the button — but it IS a link now (round 6, §2.9):
   * the agent's own page shows the same state, and a row that explains a wait
   * and goes nowhere is the dead end rule 3 forbids.
   */
  const agentWaitingOnKaros = Boolean(agent && !agent.selfServe && !agent.live);
  const agentDone = agent ? agentSetupStepDone(agent) : false;
  /**
   * The noun steps 4 and 5 both name (round 6, alignment fix 1). One constant
   * so "Create your first reply" cannot be followed by "Open your first post" —
   * Reddit drafts a reply, and the ladder is not allowed to rename it halfway.
   */
  const resultNoun = agent?.runLabel ?? "post";
  /**
   * Step 2's three states (§2.4): the documents are missing, one of them is
   * unread, or both are confirmed. "Missing" is Karos's, so it is a waiting row
   * with no destination — the Documents list filters an unwritten document out
   * entirely, so the old row pointed at an empty section.
   */
  const docsMissing = !ctx.brandVoice.present || !ctx.audience.present;
  const voiceDone = ctx.brandVoice.confirmed && ctx.audience.confirmed;
  const unreadDoc: ContextDocType | null = !ctx.brandVoice.confirmed
    ? "brand-voice"
    : !ctx.audience.confirmed
      ? "target-audience"
      : null;
  const missingProfileField = firstMissingProfileField(ctx.profile);
  /**
   * STEP 5, ONE DEFINITION (round 6 review, C4/C5).
   *
   * `resultDone = the client opened one, OR the portal can no longer show them
   * one`. Two halves, one rule, resolved HERE rather than by each page that
   * mounts the ladder — the page hands over the two facts and this decides, so
   * the widget, the progress bar, `nextSetupStep` and the completion state
   * cannot end up reading three different answers.
   *
   * The second half replaced a fixed grandfather date. See
   * `SetupLadderContext.agedOutDeliverable` for why a fact about the client's
   * archive is the honest reading of an event we never recorded, where a fact
   * about our own release timeline was not.
   */
  const resultDone = ctx.resultOpened || ctx.agedOutDeliverable;
  const steps: Omit<SetupStepView, "kind">[] = [
    {
      id: "workspace",
      label: "Tell us about your company",
      why: "You did this when you signed up, and every draft starts from it.",
      done: true,
      // NO HREF (round 6, §2.1). It was `/onboarding`, a wizard the (app) shell
      // bounces a finished client straight out of, so the one row that is
      // always done was also the one row with a broken destination.
    },
    {
      id: "profile",
      label: "Complete your profile",
      why: profileStepLine(ctx.profile),
      done: ctx.profileDone,
      href: missingProfileField
        ? profileFieldHref(ctx.profileHref, missingProfileField)
        : ctx.profileHref,
      ...(missingProfileField ? { action: profileFieldAction(missingProfileField) } : {}),
    },
    {
      id: "voice",
      label: "Confirm your brand voice and audience",
      why: docsMissing
        ? // round 6 (alignment fix 3): the old line promised "Usually ready
          // within the hour". Decision 4's number covers AGENT setup only, and
          // nobody approved an hour for the document pipeline, so the row says
          // who is working on it and stops there.
          "Your Karos team is writing your Brand Voice and Target Audience now."
        : voiceDone
          ? "Both documents are confirmed."
          : ctx.brandVoice.confirmed
            ? "Brand Voice confirmed. Your Target Audience is waiting."
            : ctx.audience.confirmed
              ? "Target Audience confirmed. Your Brand Voice is waiting."
              : "These are the two documents every draft gets checked against.",
      done: voiceDone,
      ...(docsMissing
        ? { waiting: true }
        : {
            href: contextDocHref(ctx.profileHref, unreadDoc ?? "brand-voice"),
            ...(unreadDoc
              ? { action: `Read your ${unreadDoc === "brand-voice" ? "Brand Voice" : "Target Audience"}` }
              : {}),
          }),
    },
    {
      id: "agent",
      label: agentWaitingOnKaros ? "We are setting up your first agent" : "Set up your first agent",
      why: agentWaitingOnKaros
        ? agentName
          ? `Karos is setting up your ${agentName}. Usually ready within 2 business days.`
          : "Karos is setting up your first agent. Usually ready within 2 business days."
        : agent && !agent.hasIntake
          ? `${agent.name} cannot write anything until it has its details.`
          : agent
            ? `${agent.name} has its details. One setup run and it starts producing.`
            : "Your first agent cannot write anything until it has its details.",
      done: agentDone,
      ...(agentWaitingOnKaros
        ? // The agent's own page, which paints the same wait. It is a link, not
          // a press: nothing there asks the client for anything.
          { waiting: true, href: agent?.runHref ?? ctx.agentsHref }
        : {
            // WHICH RUNG IS MISSING decides the destination (§2.5): an intake
            // that is already saved sends the client to the setup hero, not
            // back to a filled form. A step that is DONE points at the agent
            // itself — the row renders plain and unlinked, and the agent's page
            // is the honest answer to "where did this end up".
            href: agent
              ? agentDone
                ? agent.runHref
                : agent.hasIntake
                  ? `${agent.runHref}#setup`
                  : agent.setupHref
              : ctx.agentsHref,
            ...(agent && !agentDone ? { action: agentSetupAction(agent) } : {}),
          }),
    },
    {
      id: "run",
      label: "Run your first agent",
      why: "Nothing exists until one run has finished.",
      done: ctx.runDone,
      href: agent ? `${agent.runHref}#run` : ctx.agentsHref,
      ...(agentDone
        ? { action: `Create your first ${resultNoun}` }
        : { blocked: true, status: afterStep("agent") }),
    },
    {
      id: "result",
      label: "See your first result",
      why: "Open what came back, and tell us what to change.",
      done: resultDone,
      href: ctx.resultHref,
      ...(resultDone
        ? // A ticked row takes neither the press nor the wait: it renders plain,
          // and its href is the archive it already sent the client to.
          {}
        : ctx.runDone
        ? ctx.resultReady
          ? // The noun step 4 just used, so "Create your first reply" is
            // followed by "Open your first reply" rather than a generic post.
            { action: `Open your first ${resultNoun}` }
          : /**
             * THE RUN FINISHED AND KAROS HAS IT (round 6, alignment fix 1).
             *
             * A draft is not in the client archive, so there is nothing for the
             * button to open. The row states whose move it is — like step 2's
             * document wait and step 3's stand-up wait — and takes no button.
             * It stays a link to the Workspace, the place the item will appear.
             *
             * REACHED ONLY IN THE GENUINE IN-REVIEW CASE (round 6 review, C5):
             * `runDone`, nothing in the archive, and nothing aged out of it
             * either. The aged-out half is what `resultDone` above already
             * covers — a client whose only deliverable is three months old is
             * not waiting on our review of it, and telling them we are
             * "reviewing your first post" would be inventing a queue.
             */
            {
              waiting: true,
              why: `Your Karos team is reviewing your first ${resultNoun}. It lands in your Workspace once approved.`,
            }
        : { blocked: true, status: afterStep("run") }),
    },
  ];
  // "Not started" is the default word for every other incomplete row: the row
  // is a link, so the right-hand slot says where the client stands rather than
  // repeating the destination.
  const worded = steps.map((step) =>
    step.done || step.status || step.waiting ? step : { ...step, status: "Not started" },
  );
  // The row SHAPE, stamped here so the widget does not re-derive it from six
  // fields in an order this module never stated (review E7). `nextSetupStep`
  // already skips the done, waiting, blocked and href-less rows, so "current" is
  // whatever it picks and the other four fall out of the flags above.
  const current = nextSetupStep(worded);
  return worded.map((step) => ({
    ...step,
    kind: step.done
      ? ("done" as const)
      : step.waiting
        ? ("waiting" as const)
        : step === current
          ? ("current" as const)
          : step.blocked
            ? ("blocked" as const)
            : ("link" as const),
  }));
}

/** The bar and the count, from the one resolved array, so they cannot disagree. */
export function setupLadderProgress(steps: readonly Pick<SetupStepView, "done">[]): {
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
 * A WAITING OR BLOCKED STEP IS SKIPPED. The waiting row is outstanding but is
 * not the client's to press; a blocked row's own page would refuse the press
 * (the run panel paints the reason it already paints). So the accent control
 * goes to the first step the client can actually complete — and when there is
 * none, the ladder shows no accent control at all, which is the true statement
 * about a client whose next move is ours.
 *
 * A step with no href is skipped too: step 0, which is always done anyway, and
 * the documents-are-being-written wait.
 */
export function nextSetupStep<T extends Omit<SetupStepView, "kind">>(
  steps: readonly T[],
): T | null {
  return steps.find((s) => !s.done && s.href && !s.waiting && !s.blocked) ?? null;
}

/** True once every step is done — the widget's "You're set up" state. */
export function setupLadderComplete(steps: readonly Pick<SetupStepView, "done">[]): boolean {
  return steps.length > 0 && steps.every((s) => s.done);
}
