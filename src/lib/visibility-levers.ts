import {
  isBlogAgentIdentity,
  isLinkedInAgentIdentity,
  isNewsletterAgentIdentity,
  isRedditAgentIdentity,
  isReputationAgentIdentity,
  isXAgentIdentity,
} from "@/lib/custom-agent-launch";
import { AGENT_ARCHETYPE_PATTERNS, agentArchetype } from "@/lib/agent-archetype";
import type { RosterStatus } from "@/lib/client-agents";

/**
 * WHAT EACH AGENT MAKES, AND WHERE IT LANDS — one sentence per agent family.
 *
 * The table behind Reporting's "What we are doing to improve your SEO and GEO"
 * (round 6, 2026-09). Albert asked for a section that lists "every relevant
 * Karos agent with what it does for visibility", above "Things only you can do".
 *
 * PURE, and client-safe: no Firestore, no `server-only`, no React. The whole
 * point of the table living here rather than inside the component is that the
 * claims it makes can be pinned by a node test (`visibility-levers.test.ts`).
 *
 * THE CAP ON WHAT A SENTENCE MAY CLAIM, which is the reason this file exists at
 * all rather than a paragraph of marketing in a JSX file: every sentence
 * describes what is MADE and WHERE IT LANDS. None of them says what an engine
 * will then do, none quotes a percentage, none promises an outcome, and none
 * compares the client to anyone. The scores above the section are the only
 * measure of how it is going, and the standfirst says so. The test enforces it
 * on the strings rather than on the reviewer.
 *
 * ── THE FAMILY OWNS THE COPY, THE RULE ONLY MATCHES (round 6 review, E2) ──
 *
 * There were ten RULES and each one carried its own `name`, `order`, `lever` and
 * `sentence`. Two of them were byte-identical copies (the combined content
 * engine and the bare Instagram pattern), a third `FAMILY_NAMES` table held the
 * display half of the same rows, and the family that a row belonged to was
 * discoverable only by reading which rule matched first. So one product's copy
 * lived in up to three places and "which sentence does this agent get" had no
 * single answer to point at.
 *
 * Now: `FAMILIES` is the catalogue — one entry per product, owning its name, its
 * mark, its display order, its internal lever name and the ONE sentence a client
 * reads. `RULES` is the matcher — family plus predicate, nothing else. A copy
 * change is one edit in one place, and a new matching pattern cannot smuggle in
 * new copy.
 *
 * WHY THE PRODUCT'S OWN PREDICATES DECIDE THE MATCH. `isBlogAgentIdentity` and
 * its siblings are the same functions that decide who gets which intake surface
 * and which setup gate, so a row here cannot come to mean a different agent than
 * the rest of the portal means. The two families with no exact-key predicate are
 * matched through `agent-archetype.ts` — `AGENT_ARCHETYPE_PATTERNS` and
 * `agentArchetype`, the same resolver that decides which SHAPE an agent's detail
 * page takes — rather than through regexes copied out of it. That is not tidying:
 * the copied set here was `/tiktok|branded.?short|shorts.?editor|short.?form|
 * video.?clip/`, which is `CLIP_MAKER` minus `\bclips?\b` and `\binterview\b`, so
 * a `karos-clip-maker` or an interview clipper matched NO rule, resolved to no
 * lever and silently vanished from a client's report while its page happily
 * rendered a clip gallery.
 */

/** What a lookup is asked about: the agent's stable key and its stored name. */
export interface VisibilityLeverSubject {
  key: string;
  name: string;
}

/**
 * The PRODUCT a lever belongs to, which is a coarser thing than a rule: one
 * family may be matched by several patterns (see `RULES`), and it is the unit
 * the "Not on your plan" pass counts, so an account without a product reads ONE
 * row rather than one row per regex.
 *
 * `social` and `clips` are two products and not one (round 6 review, E2): the
 * daily feed post with a template set, and the agents whose deliverable is a
 * VIDEO FILE (branded shorts, the shorts editor, the interview clipper — each
 * with its own line in `agent-blurbs.ts`). They were one family with two
 * different sentences, which cannot survive the family owning the copy: one of
 * the two sentences would have had to be printed over the other product's rows,
 * and "A daily post on your Instagram" under a clip maker is a false statement
 * about what the client is buying. The combined `karos-instagram-tiktok-content-agent`
 * is `social`, not `clips` — see the ordering hazard on `RULES`.
 */
export type VisibilityFamily =
  | "blog"
  | "landing"
  | "linkedin"
  | "reddit"
  | "x"
  | "social"
  | "clips"
  | "reputation"
  | "newsletter";

export interface VisibilityLever {
  /** The product this lever belongs to. See `VisibilityFamily`. */
  family: VisibilityFamily;
  /**
   * Display order INSIDE a state band (§2B): pages that can be cited first,
   * then the places that get quoted, then brand signals, then audience.
   */
  order: number;
  /**
   * The lever this agent moves, in our words. Internal: it is the column that
   * made the table reviewable and it is deliberately not rendered, because a
   * client reading "the lever it moves" is reading our vocabulary for their
   * business.
   */
  lever: string;
  /** The ONE sentence a client reads. See the claims cap above. */
  sentence: string;
}

/** One family's row in the catalogue: the lever, plus what a family row renders. */
interface FamilyEntry {
  /**
   * The name a catalogue row prints and its Support subject names - the product
   * as a client would ask for it, not a lab key. Client-facing copy, so the
   * dash rule (AF-8) covers it.
   */
  name: string;
  /**
   * What `AgentIdentity` reads to pick this family's platform mark, since a
   * family row has no stored agent to take one from. It must be a string the
   * matcher resolves back to this same family (the round-trip test).
   */
  markIdentity: string;
  order: number;
  lever: string;
  sentence: string;
}

/**
 * THE CATALOGUE: one entry per product, and the only place its copy lives.
 *
 * Decision 7 (approved): Reporting shows agents the client does NOT have as
 * "Not on your plan" with Support. The roster can only answer for agents this
 * account has, so the section needs a second source of rows - and it is this
 * table, which is static, so the widening costs no Firestore read.
 *
 * The measurement agent and every `NO_LEVER` key are absent for free: they match
 * no rule, so they have no family and never reach this list.
 */
const FAMILIES: Record<VisibilityFamily, FamilyEntry> = {
  blog: {
    name: "Blog agent",
    markIdentity: "karos-blog-writer-v2 blog article",
    order: 1,
    lever: "the pages that get cited for category questions",
    sentence:
      "Articles on your own site that answer the questions buyers ask about your category. These are the pages an engine can cite as a source, which is what your citation count measures.",
  },
  landing: {
    name: "Landing page agent",
    markIdentity: "landing-builder landing page",
    order: 2,
    lever: "the answer page for one buyer question",
    sentence:
      "One page on your site built to answer one buyer question end to end. It is the page an engine can hand a buyer as the answer.",
  },
  linkedin: {
    name: "LinkedIn agent",
    markIdentity: "karos-linkedin-agent linkedin",
    order: 3,
    lever: "a source the engines quote often",
    sentence:
      "Posts for your company page and for each person you put forward, in their own voice, ready for you to post. LinkedIn is a site the engines quote often when they answer business questions.",
  },
  reddit: {
    name: "Reddit agent",
    markIdentity: "karos-reddit-runner reddit",
    order: 4,
    lever: "replies in the threads the engines cite",
    sentence:
      "One reply a day, drafted for a live thread your account is placed to answer, for you to post yourself. Reddit threads are a source the engines cite, so this is where a category answer can start to include you.",
  },
  x: {
    name: "X agent",
    markIdentity: "karos-x-agent-v2 x",
    order: 5,
    lever: "your name in the public conversation",
    sentence:
      "A post a day on X, in your voice, from what your industry is talking about right now. It keeps your name in the public conversation, where buyers and engines both look for what is current.",
  },
  social: {
    name: "Instagram and TikTok agent",
    markIdentity: "karos-instagram-tiktok-content-agent instagram tiktok",
    order: 6,
    lever: "a public, dated record of what you do",
    sentence:
      "A daily post on your Instagram. Public posts from a professional account can be indexed by search, so it is a dated record of what you do that appears when someone looks you up.",
  },
  clips: {
    name: "Clips agent",
    markIdentity: "karos-branded-shorts-editor clips",
    order: 6.5,
    lever: "the profile a buyer checks",
    sentence:
      "Short clips for TikTok, where more buyers now search first. It builds the profile a buyer checks after an engine names you.",
  },
  reputation: {
    name: "Reputation agent",
    markIdentity: "karos-reputation-runner reputation",
    order: 7,
    lever: "the review footprint",
    sentence:
      "Drafts replies to your reviews and watches what is said about you. Reviews on independent sites are one of the off-site checks in your AI readiness score.",
  },
  newsletter: {
    name: "Newsletter agent",
    markIdentity: "karos-newsletter-writer-v2 newsletter",
    order: 8,
    lever: "feeds the blog its topics",
    sentence:
      "Goes to the people who already know you, not to the engines. Its issues are where the blog agent takes its next topics from, so it feeds the pages that can be cited.",
  },
};

/**
 * The one pattern for "this agent writes a PAGE on the client's own site",
 * hoisted because two things ask it: the `landing` rule below and
 * `citationDomainFor`, which has to know whose domain a row's citations land on.
 * It was written out twice, so the two could disagree about which agents put the
 * brand on the client's own domain (round 6 review, E2).
 */
const LANDING_PATTERN = /landing.?builder|page.?builder|landing.?page|web.?page/;

/** A rule: which family, and what matches it. No copy — that is `FAMILIES`. */
interface LeverRule {
  family: VisibilityFamily;
  matches: (subject: { key: string; name: string; identity: string }) => boolean;
}

/**
 * THE MATCHER. FIRST HIT WINS, so specific keys precede broad patterns.
 *
 * THE ORDERING HAZARD, the same one `agent-blurbs.ts` and `agent-archetype.ts`
 * both document: `karos-instagram-tiktok-content-agent` contains BOTH "instagram"
 * and "tiktok", and it is the daily-feed product rather than a clip maker. It is
 * claimed by `social` above `clips` here AND excluded from `clip_maker` inside
 * `agentArchetype` itself, which is belt and braces on purpose — an exclusion
 * that is really just a sort order is one refactor away from filing the
 * most-used agent in the portal under video.
 */
const RULES: readonly LeverRule[] = [
  { family: "blog", matches: ({ key }) => isBlogAgentIdentity(key) },
  { family: "landing", matches: ({ identity }) => LANDING_PATTERN.test(identity) },
  { family: "linkedin", matches: ({ key }) => isLinkedInAgentIdentity(key) },
  { family: "reddit", matches: ({ key }) => isRedditAgentIdentity(key) },
  { family: "x", matches: ({ key }) => isXAgentIdentity(key) },
  {
    // The combined content engine and the bare Instagram pattern were two rules
    // with byte-identical copy; they are one rule now. Both spellings of the
    // combined engine's exclusion come from `agent-archetype.ts` rather than
    // from a regex copied to here.
    family: "social",
    matches: ({ identity }) =>
      AGENT_ARCHETYPE_PATTERNS.COMBINED_CONTENT_ENGINE.test(identity) ||
      AGENT_ARCHETYPE_PATTERNS.FEED_PLUS_CLIP_ENGINE(identity) ||
      /instagram|content.?engine|content.?social/.test(identity),
  },
  {
    // Whatever the detail page would give a CLIP GALLERY to. Asked of
    // `agentArchetype` rather than of a partial copy of its pattern, so a client
    // cannot read "short captioned clips" on their agent's page and find the
    // agent missing from their report (round 6 review, E2).
    family: "clips",
    matches: (subject) => agentArchetype(subject) === "clip_maker",
  },
  { family: "reputation", matches: ({ key }) => isReputationAgentIdentity(key) },
  { family: "newsletter", matches: ({ key }) => isNewsletterAgentIdentity(key) },
];

/**
 * Agent keys that deliberately have NO lever, so "absent" cannot be mistaken for
 * "forgotten" (the completeness test reads this list).
 *
 * Two kinds, and they are refusals rather than gaps:
 *
 *  · THE MEASUREMENT ITSELF (`seo-geo-agent-v2`). It is what produces the
 *    numbers this whole section sits under; a row claiming it improves them
 *    would be the report crediting itself. The measurement stamp under the tiles
 *    already says when it last ran.
 *  · A STEP OF ANOTHER AGENT (setup, manager and compliance skills). They are
 *    `isUnlistedAgent` and never reach a roster, so they never reach this
 *    section either; they are listed because their KEYS are exported constants
 *    and the completeness test walks every one of them.
 *
 * Dynamic agents are out of v1 by decision D4: no lever and no status source.
 * They are not listed here because they have no key in either registry.
 */
export const NO_LEVER: readonly string[] = [
  "seo-geo-agent-v2",
  "karos-blog-setup-v2",
  "karos-blog-manager-v2",
  "karos-newsletter-setup-v2",
  "karos-newsletter-manager-v2",
  "karos-reputation-setup",
  "karos-compliance-lock-v2",
];

/** The lever a family carries, as the section reads it. */
function leverOf(family: VisibilityFamily): VisibilityLever {
  const entry = FAMILIES[family];
  return { family, order: entry.order, lever: entry.lever, sentence: entry.sentence };
}

/**
 * The lever for one agent, or null when it has none.
 *
 * Null is a real answer and the section drops the row: an agent key with no
 * entry never renders, which is also what keeps an unreviewed test agent out of
 * a client's report.
 */
export function visibilityLeverFor(subject: VisibilityLeverSubject): VisibilityLever | null {
  const identity = `${subject.key} ${subject.name}`.toLowerCase();
  const hit = RULES.find((rule) =>
    rule.matches({ key: subject.key, name: subject.name, identity }),
  );
  return hit ? leverOf(hit.family) : null;
}

/**
 * The domain whose citation count is THIS row's, or null when the row has none.
 *
 * The measured line is what makes the section "what the analysis shows" rather
 * than a brochure, so it may only ever be a number this snapshot really holds:
 * the LinkedIn and Reddit agents put the brand on linkedin.com and reddit.com,
 * and the two agents that write pages put it on the client's own domain. Every
 * other row prints no number, because for every other row we have not measured
 * one.
 *
 * Keyed on the same predicates the table is — including the ONE hoisted
 * `LANDING_PATTERN` the landing rule uses — and returning a DOMAIN rather than a
 * count: the count comes from `insights.citationLeaderboard`, which is the same
 * source (and the same unit) the report's "Who the engines quote" card reads, so
 * the two cannot disagree (QA F133).
 */
export function citationDomainFor(
  subject: VisibilityLeverSubject,
  clientDomain: string | null | undefined,
): string | null {
  if (isLinkedInAgentIdentity(subject.key)) return "linkedin.com";
  if (isRedditAgentIdentity(subject.key)) return "reddit.com";
  const identity = `${subject.key} ${subject.name}`.toLowerCase();
  const writesPages = isBlogAgentIdentity(subject.key) || LANDING_PATTERN.test(identity);
  return writesPages ? (clientDomain ?? null) : null;
}

export interface VisibilityFamilyEntry {
  family: VisibilityFamily;
  /** The name the row prints, and the one its Support subject names. */
  name: string;
  /** What `AgentIdentity` reads to pick this family's platform mark. */
  markIdentity: string;
  lever: VisibilityLever;
}

/**
 * THE FULL CATALOGUE, ONE ROW PER FAMILY, in lever order — read straight off
 * `FAMILIES`, which IS the catalogue (round 6 review, E2). It used to be
 * reconstructed by walking the matcher and de-duplicating families as they came
 * up, which made the row set a property of the rule ORDER rather than of the
 * table, and meant a family with no rule of its own could not exist at all.
 */
export function visibilityLeverFamilies(): VisibilityFamilyEntry[] {
  return (Object.keys(FAMILIES) as VisibilityFamily[])
    .map((family) => ({
      family,
      name: FAMILIES[family].name,
      markIdentity: FAMILIES[family].markIdentity,
      lever: leverOf(family),
    }))
    .sort((a, b) => a.lever.order - b.lever.order);
}

/** Every sentence in the table, for the claims-cap test. */
export function visibilityLeverSentences(): string[] {
  return Object.values(FAMILIES).map((entry) => entry.sentence);
}

/**
 * The section's standfirst. Here rather than in the component so the claims cap
 * covers it: it is the sentence that makes the rest of the section honest.
 */
export const VISIBILITY_WORK_STANDFIRST =
  "These agents make the things the engines read. The scores above are the only measure of how it is going; nothing here is a promise.";

/* ───────────────────────── ordering (§2D) ───────────────────────── */

/**
 * The state bands, top to bottom: what is running, what is being stood up, what
 * runs when asked, what is not set up, what is paused, and last what this
 * account does not have.
 *
 * Read off the status the ROSTER resolved (`RosterStatus.tone` plus, for the two
 * idle words, the label), never re-derived: one derivation, three surfaces
 * (round 6 ruling 4).
 *
 * `status: null` IS "Not on your plan" and it is the last band (round 6 review,
 * D4). It used to be a separate `granted` flag read ahead of the tone, which
 * also sent an UNGRANTED ROSTER ROW to the bottom — an agent that has delivered
 * work for this client, has a real status word, and was being filed under "what
 * this account does not have". The absence of a roster status is the fact that
 * band is about; a row that has one is banded by it.
 */
export function visibilityWorkBand(input: { status: RosterStatus | null }): number {
  if (input.status === null) return 5;
  switch (input.status.tone) {
    case "live":
      return 0;
    case "progress":
    case "attention":
      return 1;
    case "disabled":
      return 4;
    case "idle":
      return input.status.label === "Not set up yet" ? 3 : 2;
  }
}

/**
 * Band first, then the lever order, then the name — so the list is stable when
 * two agents share a band and a family (two LinkedIn company pages, say).
 *
 * Generic over the row so it RETURNS the caller's own rows: the settings page
 * used to map the result field by field afterwards, which was a second shape for
 * one row set (round 6 review, E4).
 */
export function sortVisibilityWorkRows<
  T extends { status: RosterStatus | null; lever: VisibilityLever; displayName: string },
>(rows: readonly T[]): T[] {
  return [...rows].sort(
    (a, b) =>
      visibilityWorkBand(a) - visibilityWorkBand(b) ||
      a.lever.order - b.lever.order ||
      a.displayName.localeCompare(b.displayName),
  );
}
