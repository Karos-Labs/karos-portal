/**
 * WHICH SHAPE an agent's detail page takes (CD-I1).
 *
 * Albert: "everything about that agent… documents, the archive of everything
 * that got created, current outputs, the calendar… in a logical UI for each of
 * the agents based on what each of the agents does." The last clause is this
 * module. One page template cannot be logical for three products that differ in
 * what they DELIVER:
 *
 *  · a template-calendar agent delivers posts on a plan, so its page leads with
 *    the formats it writes and the week ahead;
 *  · a clip maker delivers VIDEO, so its page leads with the clips themselves —
 *    a list of titles is not a way to look at a video, and template rows
 *    describe machinery this product does not have;
 *  · a daily finder delivers a FIND — today's thread, today's draft reply — so
 *    its page leads with what it found today and a calendar of days, not a
 *    format registry.
 *
 * The selection is by AGENT IDENTITY, matched the way every other per-agent
 * decision in this codebase is (§7.3): the `"<key> <name>"` string, lowercased,
 * first match wins. That idiom is `launchProfileFor` (custom-agent-launch.ts)
 * and `clientAgentBlurb` (agent-blurbs.ts), and this file deliberately mirrors
 * their ORDER hazard too — see CLIP_MAKER below, which must not swallow the
 * combined Instagram/TikTok content engine.
 *
 * PURE and client-safe: no imports from the data layer, so a client component
 * may import the type and a server projection may import the resolver without
 * either dragging the Admin SDK across the boundary.
 */

import { isRedditAgentIdentity } from "@/lib/custom-agent-launch";

/**
 * The three page shapes.
 *
 * `template_calendar` is the DEFAULT, and deliberately so: it is today's shape,
 * every agent already renders it, and an agent nobody has classified is far
 * better served by the generic surface than by a video gallery with nothing in
 * it. A new archetype is opted INTO by naming its family here, never fallen
 * into by an unrecognised key.
 */
export type AgentArchetype = "template_calendar" | "clip_maker" | "daily_finder";

/**
 * The clip-maker family: agents whose deliverable is a VIDEO FILE.
 *
 * The vocabulary is lifted verbatim from agent-blurbs.ts, which already had to
 * name this family to describe it ("Turn one of your videos into short branded
 * cuts with captions"; "Turn your interviews and long recordings into short
 * captioned clips"). Keeping one vocabulary matters: the line a client reads
 * about what an agent makes and the page shape they get when they open it must
 * be derived from the same patterns, or a client reads "short captioned clips"
 * on the roster and opens a page about post templates.
 *
 * THE ORDERING HAZARD, inherited from the blurbs module and its backfill twin:
 * `karos-instagram-tiktok-content-agent` contains "tiktok" and is NOT a clip
 * maker — it is the flagship template-calendar agent, the daily Instagram post
 * with a template set. It is excluded explicitly rather than by relying on the
 * order of the array, because an exclusion that is really just a sort order is
 * one refactor away from silently turning the most-used agent in the portal
 * into an empty video gallery.
 */
const COMBINED_CONTENT_ENGINE = /^karos-instagram-tiktok-content-agent/;

/**
 * The same exclusion stated as a RULE rather than as one key: any agent that
 * names Instagram and TikTok together is the combined content engine's shape —
 * a daily feed post with a template set — whatever its key happens to be. A
 * per-client instance of that engine carries the client's slug in its key and
 * would not match the literal above, and misfiling one into a video gallery
 * that can never fill is a worse failure than the reverse.
 */
const FEED_PLUS_CLIP_ENGINE = (identity: string) =>
  /instagram/.test(identity) && /tiktok/.test(identity);

const CLIP_MAKER =
  /branded.?short|shorts.?editor|short.?form|video.?clip|\bclips?\b|\btiktok\b|\binterview\b/;

/**
 * The daily-finder family: agents that go looking every day and come back with
 * something specific to act on.
 *
 * Reddit (e15) is the whole family today, and it is detected through the §7.3
 * helper rather than a pattern of its own — `isRedditAgentIdentity` is the
 * client-safe twin of the server's `isRedditAgent`, and the submit core, the
 * schedule gate, the intake builder and the setup registry all already gate on
 * it. A second, looser regex here would be a fourth answer to "is this the
 * Reddit agent" and the one that disagrees.
 */
export function agentArchetype(input: { key: string; name?: string }): AgentArchetype {
  const key = input.key ?? "";
  if (isRedditAgentIdentity(key)) return "daily_finder";

  const identity = `${key} ${input.name ?? ""}`.toLowerCase();
  if (COMBINED_CONTENT_ENGINE.test(identity) || FEED_PLUS_CLIP_ENGINE(identity)) {
    return "template_calendar";
  }
  if (CLIP_MAKER.test(identity)) return "clip_maker";
  return "template_calendar";
}

/**
 * The archetype patterns, exported so tests read the same source the resolver
 * does rather than restating it — a test that re-declares the regex proves the
 * regex, not the wiring.
 */
export const AGENT_ARCHETYPE_PATTERNS = {
  CLIP_MAKER,
  COMBINED_CONTENT_ENGINE,
  FEED_PLUS_CLIP_ENGINE,
} as const;

/**
 * What ONE run of this shape makes, in the client's words.
 *
 * "Create a new post" is wrong on a clip maker and wrong on a Reddit agent, and
 * a control that misnames its own output is how a client presses a button
 * expecting one thing and is billed for another. Reddit is the sharp case: its
 * whole product promise is that we never post, so a page whose strongest
 * affordance says "post" contradicts the rule it is built around.
 *
 * Lives here rather than in a panel because BOTH panels need it — the umbrella
 * one and the legacy one — and two copies is how the Reddit page ended up
 * saying "reply" in its hero and "post" on its button.
 */
export const OUTPUT_NOUN: Record<AgentArchetype, string> = {
  template_calendar: "post",
  clip_maker: "clip",
  daily_finder: "reply",
};
