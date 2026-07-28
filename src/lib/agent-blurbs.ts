/**
 * What a client is told an agent DOES (CD-G2).
 *
 * The roster used to print `customAgent.description`, which is the lab
 * manifest's own line — written for the people who build agents, not the people
 * who buy them. Clients were reading "Master content-social skill. Given a
 * brand's guidelines + any past competitor research, it does a deep competitor +
 * industry-trend dive…", which names an internal artefact ("skill"), describes
 * the machinery instead of the outcome, and reads like a spec.
 *
 * The pattern Albert set, and the one every line here follows:
 *
 *   "Improve your Instagram reach with a daily post, different templates,
 *    and an agent that scans."
 *
 *   · a benefit the client actually wants, first;
 *   · concrete nouns for what arrives (a daily post, a newsletter, an article);
 *   · one sentence, no buzzwords, no internal vocabulary.
 *
 * Precedence: an explicit `clientBlurb` on the agent wins (that is the field
 * staff curate, and scripts/backfill-agent-blurbs.ts fills it with exactly
 * these lines). Otherwise the keyed fallback below. The manifest description is
 * deliberately NOT in that chain any more — falling back to it is what put the
 * spec text in front of clients in the first place.
 *
 * Matching mirrors `launchProfileFor` in custom-agent-launch.ts: the identity
 * string is `"<key> <name>"` lowercased, first match wins. It is kept as its
 * own ordered list rather than reusing the launch profiles because these two
 * things answer different questions — a launch profile describes the form a
 * staff operator fills in, this describes the product a client bought — and
 * fusing them would make every future copy change to one silently rewrite the
 * other.
 */

/** Managed-product task types, whose agents carry no lab key to match on. */
const PRODUCT_BLURBS: Record<string, string> = {
  social_post:
    "Keep your social channels busy with posts built around what your audience is already reacting to.",
  newsletter_issue:
    "Send a newsletter your list actually opens, written from the work you have done since the last one.",
  blog_article:
    "Publish articles that bring in search traffic, written around the words your buyers actually type.",
  landing_page:
    "Turn your campaign into a landing page that converts, with the copy and structure already in place.",
};

/**
 * FIRST HIT WINS, so specific keys precede broad ones. The combined content
 * engine (`karos-instagram-tiktok-content-agent`) contains both "instagram" and
 * "tiktok" and must be matched by its own key before either single-platform
 * pattern gets a chance at it — the same ordering hazard the backfill script
 * documents, because they are twins and must stay in step.
 */
const BLURBS: Array<{ matches: (identity: string) => boolean; blurb: string }> = [
  {
    // The X agent (e13). Multi-seat, sources from live conversation.
    matches: (identity) => identity.startsWith("karos-x-agent "),
    blurb:
      "Grow your following on X with a post a day, written in your voice from what your industry is talking about right now.",
  },
  {
    // Company-page LinkedIn agents: one page, one voice.
    matches: (identity) => identity.startsWith("karos-linkedin-company-"),
    blurb:
      "Keep your LinkedIn company page active with posts that sound like your business instead of a press release.",
  },
  {
    // The multi-seat LinkedIn agent: one stream per person you put forward.
    matches: (identity) => identity.startsWith("karos-linkedin-agent "),
    blurb:
      "Build your team's presence on LinkedIn with a steady run of posts for each person you put forward, each in their own voice.",
  },
  {
    matches: (identity) => /linkedin/.test(identity),
    blurb:
      "Show up on LinkedIn every week with posts written in your voice, ready for you to approve.",
  },
  {
    // The combined content engine — MUST precede /tiktok/ and /instagram/.
    // Albert's own example line, and the pattern every other blurb follows.
    matches: (identity) => identity.startsWith("karos-instagram-tiktok-content-agent"),
    blurb:
      "Improve your Instagram reach with a daily post, different templates, and an agent that scans what is working in your niche.",
  },
  {
    matches: (identity) => /reddit/.test(identity),
    blurb:
      "Find the Reddit threads worth joining and get a reply drafted in your voice, one at a time.",
  },
  {
    matches: (identity) => /interview/.test(identity),
    blurb: "Turn your interviews and long recordings into short captioned clips, ready to post.",
  },
  {
    matches: (identity) => /branded.?short|shorts.?editor|short.?form|video.?clip/.test(identity),
    blurb: "Turn one of your videos into short branded cuts with captions, sized for social.",
  },
  {
    matches: (identity) => /tiktok/.test(identity),
    blurb:
      "Reach more people on TikTok with a steady run of ideas and scripts built around what is trending in your industry.",
  },
  {
    matches: (identity) => /instagram|content.?engine|content.?social/.test(identity),
    blurb:
      "Improve your Instagram reach with a daily post, different templates, and an agent that scans what is working in your niche.",
  },
  {
    matches: (identity) => /newsletter/.test(identity),
    blurb:
      "Send a newsletter your list actually opens, written from the work you have done since the last one.",
  },
  {
    matches: (identity) => /\bblog\b|\barticle\b/.test(identity),
    blurb:
      "Publish articles that bring in search traffic, written around the words your buyers actually type.",
  },
  {
    // "Landing Builder" (CD-H7d). Its name carries no "page", so the
    // /landing.?page/ pattern below never matched it and clients read the
    // contentless fallback on an agent whose output is entirely concrete.
    // Matched off the identity, so the display name alone is enough.
    matches: (identity) => /landing.?builder|page.?builder/.test(identity),
    blurb:
      "Get a landing page built for your next campaign, with the headline, sections and call to action already written.",
  },
  {
    matches: (identity) => /landing.?page|web.?page/.test(identity),
    blurb:
      "Turn your campaign into a landing page that converts, with the copy and structure already in place.",
  },
  {
    matches: (identity) => /seo|geo|search/.test(identity),
    blurb:
      "Find the searches your buyers make that you are not showing up for yet, and what to publish about them.",
  },
  {
    matches: (identity) => /reputation|reviews/.test(identity),
    blurb:
      "Keep track of what people are saying about you online, and reply to reviews before they go stale.",
  },
  {
    matches: (identity) => /competitor|intel|research/.test(identity),
    blurb:
      "Watch what your competitors publish and price, and tell you what changed and what to do about it.",
  },
];

/**
 * The one-line description of this agent a CLIENT may read.
 *
 * `productType` lets a managed product (which has no lab key) resolve without
 * inventing a fake identity string for it.
 */
export function clientAgentBlurb(input: {
  key: string;
  name: string;
  /** Curated copy on the agent. Wins outright when present. */
  clientBlurb?: string | null;
  /** Managed products: the task type, checked before identity matching. */
  productType?: string | null;
}): string {
  const curated = input.clientBlurb?.trim();
  if (curated) return curated;

  if (input.productType && PRODUCT_BLURBS[input.productType]) {
    return PRODUCT_BLURBS[input.productType] as string;
  }

  const identity = `${input.key} ${input.name}`.toLowerCase();
  const matched = BLURBS.find((entry) => entry.matches(identity));
  if (matched) return matched.blurb;

  // Honest and contentless rather than invented: an agent nobody has written a
  // line for gets a sentence that promises nothing specific, because guessing
  // what an unknown agent produces is how a client ends up expecting the wrong
  // thing. The backfill script exists to make this branch rare.
  return `${input.name} runs on this account and produces work your Karos team reviews before it reaches you.`;
}

/**
 * The fallback set, exported so the backfill script and its tests read the same
 * lines the roster renders — the script must never drift into writing different
 * copy from what clients already see.
 */
export const AGENT_BLURB_FALLBACKS = { BLURBS, PRODUCT_BLURBS } as const;
