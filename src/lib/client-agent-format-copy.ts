/**
 * What a client agent's TEMPLATE STREAMS are called on a client's screen, and
 * the two sentences a surface says when it has none to list (pure, client-safe:
 * this module imports nothing at all).
 *
 * THE OBJECT HAS THREE NAMES AND TWO OF THEM WERE ON THE SAME PAGE. Internally
 * it is a "template stream" (`ClientAgentTemplate`, `templateKey`,
 * submit-custom's job field), and that word is correct in the schema and in
 * staff-facing prose. The word a CLIENT reads settled on "format" — it is what
 * live-card, launch-card, agent-detail-panel and the publish-hold sentence all
 * say ("In your Workspace under this format", "the set of post formats this
 * agent will produce", "an earlier post in this format"). One rendered string
 * had not caught up: the launch card's live summary said "No template streams
 * registered yet." while the detail panel one component over, for the same
 * empty registry, said "no formats registered yet".
 *
 * SO THE SENTENCE LIVES ONCE. It was written twice for one fact, which is the
 * shape that drifts — and it had already drifted, in vocabulary, which is the
 * expensive way to find out.
 *
 * TWO SENTENCES, NOT ONE, and that is a correctness point rather than a
 * flourish. The two surfaces ask different questions of the registry: the
 * detail panel asks "are there any formats at all", the launch card's summary
 * lists only the ACTIVE ones. "No formats registered yet" is false on an agent
 * whose formats all happen to be paused or retired, and the fix for a wrong
 * word must not ship a wrong statement (a consolidation has to be true at every
 * site it takes over). So the empty registry and the empty ACTIVE set get one
 * sentence each, and the caller picks by asking which it is.
 *
 * NOT in lib/client-agents.ts beside CLIENT_LAUNCH_PHASE_COPY: that module owns
 * the LAUNCH ladder's copy — the phases a setup run passes through — and this is
 * the vocabulary of what the agent produces afterwards. Different question, and
 * folding them together would make "what do we call a format" reachable only
 * through the launch module.
 */

/**
 * The registry is empty: the agent has no formats at all.
 *
 * Lifted VERBATIM from live-card.tsx, which is the surface a client actually
 * reaches for a live agent — so no rendered byte changes there, and the launch
 * card converges on the wording that was already in front of clients rather
 * than a new one invented for the merge.
 */
export const NO_FORMATS_YET =
  "This agent has no formats registered yet — your Karos team is setting them up.";

/**
 * The registry is NOT empty, but nothing in it is running.
 *
 * Deliberately says "running" rather than naming a state. A format sits at
 * `active`, `paused` or `retired`, so "all your formats are paused" would be
 * false for a retired one and "none are active" would print our own enum's word
 * at a client. This sentence is true under every mix of the three.
 */
export const NO_FORMATS_RUNNING = "None of this agent's formats are running right now.";
