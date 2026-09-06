import "server-only";

import { dateKeyInZone, jobDeliveredWork, shiftDateKey } from "@/lib/client-agents";
import { agentKeyMatchesClientSlug } from "@/lib/custom-agent-launch";
import { projectRunOccurrences } from "@/lib/scheduled-runs";
import { runtimeTimeZone } from "@/lib/run-cadence";
import { resolveContentIdentity } from "@/lib/agent-identity-map";
import {
  clientDeliveryStamp,
  getClientArchiveAssets,
  isLaunchDeliverable,
  isTestRunAsset,
  type AssetViewer,
} from "@/lib/asset-visibility";
import { isUpcomingPost } from "@/lib/calendar-kind";
import { assetImages, assetVideos } from "@/lib/asset-images";
import { parseRedditDrafts, type RedditParsedAccount } from "@/lib/reddit-drafts";
import type { ClientAgentIdentity } from "@/lib/agent-identity-map";
import type { TemplateDetail } from "@/components/client-agents/types";
import type {
  Asset,
  ClientAgent,
  ClientAgentTemplate,
  Job,
  PlannedScheduledRun,
} from "@/lib/types";

/**
 * The per-archetype projections behind the agent detail page (CD-I1).
 *
 * SAME DOCTRINE AS client-agent-rows.ts, and for the same reason: everything
 * returned here is serialized into the RSC payload a browser receives, so
 * redaction that happens at render time has already lost. The clip gallery and
 * the daily finder are new SHAPES, not new permissions — a client sees exactly
 * what the archive rules already let them see, arranged so the product is
 * legible instead of being a list of titles.
 *
 * The three archetypes share their attribution (`agentProducedAssets`) rather
 * than each joining assets to agents their own way. Asset carries no
 * clientAgentId, so "who made this" is a real resolution with four rungs, and
 * three subtly different copies of it is how one surface starts crediting a
 * post to an agent that did not write it (F147).
 *
 * The ROSTER reads the same rungs, through `agentsWithDeliveredWork`. It used to
 * answer "has this agent delivered?" from a job join of its own, which is a
 * different question with the same name: lab imports carry `jobId: null`, so an
 * agent whose whole history is imported was absent from the join — and because
 * that set also gates whether a card is listed at all, the agent was missing
 * from the client's roster entirely while its posts sat in their Workspace.
 */

/* ────────────────────────── shared attribution ────────────────────────── */

/**
 * The ONE spelling attribution compares identities in.
 *
 * lowercase → collapse every `-`, `_` and run of whitespace to a single `-` →
 * drop a leading `karos-` → trim stray separators. So `instagram-agent`,
 * `Instagram Agent`, `instagram_agent` and `karos-instagram-agent` are one
 * string, which is the entire point: the same agent is spelled all four ways
 * across the lab repo folder, the imported key and the rendered name.
 *
 * NORMALISATION, NEVER FUZZ. Two slugs are equal or they are not — no substring
 * containment, no prefix match, no edit distance. That restraint is F147's
 * subject, not a style preference: the combined `karos-instagram-tiktok-content-agent`
 * lives on the same clients as plain instagram agents, and anything looser than
 * equality unifies them and files months of one agent's posts under the other,
 * where a client has no way to tell it is wrong. An empty list is a visible
 * bug; a wrong list is an invisible one.
 */
function attributionSlug(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const slug = value
    .toLowerCase()
    .replace(/[-_\s]+/g, "-")
    .replace(/^karos-/, "")
    .replace(/^-+|-+$/g, "");
  return slug || null;
}

/** `meta.agentFolder` if the asset carries one — lab imports are the only writer. */
function agentFolderOf(asset: Asset): string | null {
  const folder = asset.meta?.["agentFolder"];
  return typeof folder === "string" ? folder : null;
}

/**
 * What this VIEWER may be told exists at all — asked before whose it is.
 *
 * DELIVERED WORK ONLY for a client (A3/A4): `getClientArchiveAssets` drops
 * drafts, future-dated posts and launch deliverables rather than mapping them
 * through a placeholder — the placeholder keeps `createdAt` and a template
 * name, which under a "what it has made for you" heading renders a whole
 * generated batch as seven posts all made in the same minute. Staff keep
 * everything, including drafts, because reviewing drafts is their job. This
 * filter runs FIRST and no rung below can reach past it.
 *
 * One home, and one call per page: every consumer in this module funnels its
 * asset list through here, so no surface can arrive at "which assets exist for
 * this viewer" by a slightly different route.
 */
function viewerVisibleAssets(args: {
  assets: Asset[];
  viewerIsClient: boolean;
  now: number;
  viewer?: AssetViewer;
}): Asset[] {
  return args.viewerIsClient
    ? getClientArchiveAssets(args.assets, { now: args.now, viewer: args.viewer })
    : args.assets;
}

/** The umbrella bound to an agent, by the field the bind writes. */
export function umbrellaForAgent<T extends { customAgentId: string }>(
  umbrellas: readonly T[],
  customAgentId: string,
): T | null {
  return umbrellas.find((umbrella) => umbrella.customAgentId === customAgentId) ?? null;
}

/** One agent's identity, resolved into the spellings the rungs compare. */
interface AgentAttribution {
  id: string;
  /** The job-name rung's target: trimmed and lowercased. */
  name: string;
  /**
   * Both normalised spellings of this agent's identity. A set, not a fallback
   * chain: key and name are two spellings of the same thing, and an asset
   * folder that equals either is this agent's.
   *
   * A COLLISION CREDITS BOTH AGENTS, and it is constructible: `customAgents.name`
   * carries no uniqueness constraint, so an agent named "Instagram Agent" with
   * key `karos-alpha-thing` and an agent named "Something Else" with key
   * `karos-instagram-agent` both hold the slug `instagram-agent`, and one asset
   * whose folder is `instagram-agent` is claimed by both. Pre-existing in
   * `agentProducedAssets`, where the cost is a list containing a post another
   * agent wrote; it now also decides whether a card is LISTED on a client's
   * roster, so the cost is a whole agent appearing. Dropping the name-slug would
   * close it — and would also drop every import whose folder matches the agent's
   * NAME but not its key, which is why it is not done here: that is a behaviour
   * change and needs its own decision, not a quiet edit inside a doc fix.
   */
  slugs: Set<string>;
  umbrella: ClientAgent | null;
  umbrellas: ClientAgentIdentity[];
}

function agentAttribution(args: {
  agent: { id: string; name: string; key?: string };
  umbrella: ClientAgent | null;
  umbrellas: ClientAgentIdentity[];
}): AgentAttribution {
  return {
    id: args.agent.id,
    name: args.agent.name.trim().toLowerCase(),
    slugs: new Set(
      [attributionSlug(args.agent.key), attributionSlug(args.agent.name)].filter(
        (slug): slug is string => slug !== null,
      ),
    ),
    umbrella: args.umbrella,
    umbrellas: args.umbrellas,
  };
}

/**
 * Whether this asset is this agent's — THE rungs, and the only copy of them.
 *
 * In descending confidence, all of them JOINS, none of them a comparison of
 * rendered human labels:
 *
 *  1. the job's own binding (`customAgentId`, or the umbrella's `clientAgentId`);
 *  2. an umbrella, when this agent has one: `resolveContentIdentity` decides,
 *     unchanged, because that helper is the only thing that knows how an asset,
 *     its job and an umbrella relate;
 *  3. the job's recorded `agentName`, compared case-insensitively and trimmed —
 *     jobs carry the name even when they predate `customAgentId`;
 *  4. for an asset with no job we can see, the normalised `meta.agentFolder`
 *     against the normalised key AND name of the agent.
 *
 * Rungs 3 and 4 replaced a single rung that compared `identity.label` to the
 * agent's name, and it could not match anything in production. The label is
 * SENTENCE case from `agentLabelForAsset` ("Instagram agent"); the name is
 * TITLE case from the importer ("Instagram Agent"). Those are never equal for a
 * multi-word name, the `clientAgents` backfill has not run so no client reached
 * the umbrella rung, and lab-imported assets are written with `jobId: null` so
 * they never reached rung 1 either — every rung missed and a client opened a
 * "Live" agent above an empty delivered-work section with months of its posts
 * in their Workspace. The fix is to stop comparing display strings, not to
 * change what either helper renders.
 */
function assetBelongsToAgent(
  asset: Asset,
  jobById: Map<string, Job>,
  agent: AgentAttribution,
): boolean {
  const job = asset.jobId ? (jobById.get(asset.jobId) ?? null) : null;
  if (
    job &&
    (job.customAgentId === agent.id ||
      (agent.umbrella && job.clientAgentId === agent.umbrella.id))
  ) {
    return true;
  }

  // WITH an umbrella the umbrella decides, exactly as before. That path is
  // correct and starts carrying real traffic the moment the backfill runs, so
  // the name/folder rungs below must not get a second vote on top of it.
  if (agent.umbrella) {
    const identity = resolveContentIdentity({ asset, job }, agent.umbrellas);
    return identity.clientAgentId === agent.umbrella.id;
  }

  if (job) {
    // A job we can see has already been asked the exact question and answered
    // no, so its own recorded name is the last word on it. Deliberately NOT
    // falling through to the folder rung: letting a string in the asset's meta
    // outrank a job that names a different agent is precisely how one agent's
    // run lands under another's heading.
    //
    // Read defensively even though `Job.agentName` is typed as required: this
    // runs over whatever Firestore actually holds, and an older job written
    // without the field would otherwise throw and take the page down.
    const jobName = typeof job.agentName === "string" ? job.agentName.trim().toLowerCase() : "";
    return jobName !== "" && jobName === agent.name;
  }

  // No job — the lab-import shape (`jobId: null`), and equally an asset whose
  // job is not in this page's `jobs`. Attribution has nothing but the folder
  // the run was imported from.
  const folder = attributionSlug(agentFolderOf(asset));
  return folder !== null && agent.slugs.has(folder);
}

/* ─────────────── the per-page index (round 6 review, E9/E10) ─────────────── */

/**
 * THE THREE THINGS EVERY ATTRIBUTION ANSWER NEEDS, BUILT ONCE PER PAGE.
 *
 * Every helper below used to build its own `jobById` map and run its own
 * `viewerVisibleAssets` / `isUpcomingCalendarItem` pass. On a roster that is
 * four functions × one client's whole asset and job history, per render, for
 * answers that are all derived from the same two lists — and the roster build
 * called three of those functions twice (once for the enabled set, once for the
 * paused one). Findings E9/E10: build the index once, hand it down.
 *
 * OPTIONAL EVERYWHERE. Every helper still works with no index: it builds the
 * one it needs from the `assets`/`jobs` it was given, exactly as before, so a
 * caller with one agent to ask about (the detail page) pays nothing to think
 * about this.
 */
export interface AgentAssetIndex {
  /** `Job.id` → job. The join `assetBelongsToAgent` walks on every asset. */
  jobById: Map<string, Job>;
  /** What this viewer may be told exists at all (`viewerVisibleAssets`). */
  visible: Asset[];
  /** The AF-5 candidate set: client-visible content on a day that has not happened. */
  upcoming: Asset[];
}

export function buildAgentAssetIndex(args: {
  assets: Asset[];
  jobs: Job[];
  viewerIsClient: boolean;
  now: number;
  viewer?: AssetViewer;
}): AgentAssetIndex {
  return {
    jobById: new Map(args.jobs.map((job) => [job.id, job])),
    visible: viewerVisibleAssets(args),
    // NOT viewer-projected, and deliberately: `isUpcomingCalendarItem` is the
    // AF-5 predicate, and the archive drops future-dated posts by construction,
    // so projecting first would empty this list for every client. What leaves
    // this set is one boolean (or one DAY) per agent — never a title, a count or
    // a generation instant — which is the A3/A4 argument stated on
    // `agentUpcomingCalendarDays`.
    upcoming: args.assets.filter((asset) => isUpcomingCalendarItem(asset, args.now)),
  };
}

/**
 * WHICH VISIBLE ASSETS BELONG TO WHICH AGENT — one pass over the assets.
 *
 * The rungs are per-agent (`agentAttribution` resolves one agent's spellings),
 * so a caller asking about N agents used to walk the whole asset list N times.
 * This resolves every agent's attribution first and then walks the list ONCE,
 * which is the same rungs in the same order with the loops swapped (finding
 * E11). Every id in `agents` gets a key, so an agent with nothing reads as an
 * empty array rather than as absent.
 *
 * `assets` must ALREADY be viewer-projected — pass `AgentAssetIndex.visible` or
 * `AgentAssetIndex.upcoming`. This function applies no visibility rule of its
 * own, which is the same contract `templateDetails` carries below and for the
 * same reason: a set that skipped the projection would hand a client the whole
 * batch at generation time.
 */
export function groupAssetsByAgent(args: {
  assets: readonly Asset[];
  jobById: Map<string, Job>;
  agents: readonly { id: string; name: string; key?: string }[];
  umbrellas: ClientAgent[];
}): Map<string, Asset[]> {
  const grouped = new Map<string, Asset[]>();
  const attributions = args.agents.map((agent) => {
    grouped.set(agent.id, []);
    return agentAttribution({
      agent,
      umbrella: umbrellaForAgent(args.umbrellas, agent.id),
      umbrellas: args.umbrellas,
    });
  });
  for (const asset of args.assets) {
    for (const attribution of attributions) {
      if (assetBelongsToAgent(asset, args.jobById, attribution)) {
        grouped.get(attribution.id)!.push(asset);
      }
    }
  }
  return grouped;
}

/** Everything this agent has produced that THIS viewer may see. */
export function agentProducedAssets(args: {
  assets: Asset[];
  jobs: Job[];
  /** `key` is the lab skill slug; absent only for an agent that has none. */
  agent: { id: string; name: string; key?: string };
  umbrella: ClientAgent | null;
  umbrellas: ClientAgentIdentity[];
  viewerIsClient: boolean;
  now: number;
  viewer?: AssetViewer;
  /** Prebuilt by the caller (`buildAgentAssetIndex`); built here when absent. */
  index?: Pick<AgentAssetIndex, "jobById" | "visible">;
}): Asset[] {
  const jobById = args.index?.jobById ?? new Map(args.jobs.map((job) => [job.id, job]));
  const attribution = agentAttribution(args);
  return (args.index?.visible ?? viewerVisibleAssets(args)).filter((asset) =>
    assetBelongsToAgent(asset, jobById, attribution),
  );
}

/**
 * Which of these agents have landed work for this client, by customAgentId.
 *
 * SCOPE, as of writing: the roster (both branches of
 * clients/[id]/agents/page.tsx) and the agent detail page (its client gate and
 * its status strip). Those two agreeing is the point of the function, and the
 * tripwire in agent-detail-archetypes.test.ts holds them to reading it — it does
 * not enumerate future callers, so read the imports for today's list. Anything
 * else that needs the answer belongs here rather than in a copy.
 *
 * WHY IT IS NOT A JOB JOIN. It is a job join PLUS the asset rungs above, and it
 * has to be both:
 *
 *  - `jobDeliveredWork` alone cannot see a lab import, which is written with
 *    `jobId: null` and produces no job at all. That was the bug: on the roster
 *    the same set decides whether a card is listed, so an agent whose only
 *    delivered work was imported did not merely read "Not set up yet" — unless
 *    separately granted it was absent from the client's roster, with its posts
 *    visible in their Workspace and no agent anywhere to own them.
 *
 *    SCOPE OF THAT RESCUE, which is narrower than "lab imports now count".
 *    `assetBelongsToAgent` hands an agent that HAS an umbrella to
 *    `resolveContentIdentity` and returns its verdict, so the folder rung is only
 *    reached for an agent with no umbrella. A jobless imported asset therefore
 *    puts an agent on the roster when the agent has no umbrella, or when its
 *    umbrella is `live` AND owns that asset's chain family — the resolver's
 *    family rung requires both. An agent mid-bind, umbrella written but not yet
 *    live, is NOT rescued by this. Widening the umbrella rung to make the shorter
 *    sentence true would give the folder rung a second vote on top of an
 *    umbrella's, which is the over-matching the rung order exists to prevent.
 *  - the asset rungs alone cannot see a job whose deliverables have aged out of
 *    a client's 30-day archive, or one sitting in `review` with nothing visible
 *    yet. Dropping the job half would trade "Runs on request" for "Not set up
 *    yet" on any agent that last delivered two months ago.
 *
 * A CLIENT'S ANSWER STAYS A CLIENT'S — both halves, which took two passes to
 * get right. The asset half runs through `viewerVisibleAssets`. The JOB half
 * needed its own gate: `DELIVERED_JOB_STATUSES` includes `review`, and a review
 * job's assets are dropped by `getClientArchiveAssets`, so before
 * `excludeInReview` a run staff were still holding listed the agent on the
 * client's roster with an empty page under it. An earlier version of this
 * comment claimed the whole function was safe while scoping the reason to the
 * asset half alone; a review pass constructed the counterexample.
 *
 * What the roster then shows is one status word, never a count or a date, so an
 * inherited agent still says nothing about how its work was generated (A3).
 *
 * THE BINDING WINS, here as everywhere: a per-client instance is dropped before
 * either half runs, so no amount of delivered work can move an instance off the
 * client its key names. Callers filter on the same predicate for visibility;
 * this is the second gate, so a future caller that forgets cannot widen it.
 *
 * ONE AGENT AT A TIME, so a list read is exactly N single reads. No agent's
 * answer depends on which OTHERS were asked about alongside it: the job half
 * returns the jobs' own facts and every rung is then evaluated per agent. It used
 * to build a name→id map over the whole list, and a map keyed on a display name
 * holds one entry per name — so of two agents sharing one, only the last was
 * attributable by the name rung, and this function answered differently for the
 * same agent depending on the company it was asked in. The roster asks about its
 * whole candidate list and the detail page about a single agent, which made that
 * the very disagreement between the two surfaces this function exists to remove.
 */
export function agentsWithDeliveredWork(args: {
  assets: Asset[];
  jobs: Job[];
  agents: readonly { id: string; name: string; key: string }[];
  umbrellas: ClientAgent[];
  /** `Client.agentsRepoSlug` — the binding rung. */
  clientSlug: string | null | undefined;
  viewerIsClient: boolean;
  now: number;
  /**
   * The seat gate (round 6 review, D3). `getClientArchiveAssets` drops another
   * seat's personal content only when it is told who is asking, so a roster
   * built without this counted a colleague's personal post as this agent's
   * delivered work for every viewer in the workspace.
   */
  viewer?: AssetViewer;
  /** Prebuilt by the caller (`buildAgentAssetIndex`); built here when absent. */
  index?: Pick<AgentAssetIndex, "jobById" | "visible">;
}): Set<string> {
  const bound = args.agents.filter((agent) =>
    agentKeyMatchesClientSlug(agent.key, args.clientSlug),
  );
  // A client's half excludes `review`: those assets are dropped by
  // `getClientArchiveAssets`, so counting them would list an agent on the
  // strength of work the client cannot see — the exact shape this rule removes.
  const byJob = jobDeliveredWork(args.jobs, { excludeInReview: args.viewerIsClient });

  // One archive filter and one job index for the whole roster, then the rungs
  // per agent. The rungs are the same function the detail page's own list runs
  // on, which is what makes the two answers one answer.
  const jobById = args.index?.jobById ?? new Map(args.jobs.map((job) => [job.id, job]));
  const visible = args.index?.visible ?? viewerVisibleAssets(args);

  const delivered = new Set<string>();
  // The job half first, per agent: its own binding, then the pre-`customAgentId`
  // name fallback. Both are lookups into facts about the jobs, so the answer is
  // the same whether this agent was asked about alone or in a list.
  const unanswered = bound.filter((agent) => {
    if (byJob.ids.has(agent.id) || byJob.names.has(agent.name)) {
      delivered.add(agent.id);
      return false;
    }
    return true;
  });
  // The asset half, in ONE pass over the visible set for however many agents are
  // left (finding E11) rather than one pass each.
  if (unanswered.length > 0) {
    const grouped = groupAssetsByAgent({
      assets: visible,
      jobById,
      agents: unanswered,
      umbrellas: args.umbrellas,
    });
    for (const [agentId, assets] of grouped) if (assets.length > 0) delivered.add(agentId);
  }
  return delivered;
}

/* ─────────────────── upcoming calendar content (AF-5) ─────────────────── */

/**
 * How far ahead a planned day still counts as "upcoming" for the status word
 * (round 6, decision 1).
 *
 * A CEILING, not a horizon. "Live" is a claim about now, and a single post dated
 * eight months out is not evidence that anything is producing this week — while
 * an imported daily stream always has the next fortnight filled, which is the
 * case the rung exists for. Fourteen days is also exactly the window the client's
 * own calendar shows as planned days ahead of the current week, so the word and
 * the surface underneath it are reading the same fortnight.
 */
export const UPCOMING_WINDOW_DAYS = 14;
const UPCOMING_WINDOW_MS = UPCOMING_WINDOW_DAYS * 24 * 60 * 60 * 1000;

/**
 * Is this asset an item the CLIENT's calendar shows on a day that has not
 * happened yet, inside the window above?
 *
 * THE CLIENT'S CALENDAR RULE, whoever is asking. The status word it feeds is the
 * client-facing one by ruling, so staff must be told the same thing the client is
 * being told — and a staff-flavoured version of this predicate would give the two
 * rosters different answers about the same agent, which is the one failure
 * `agentsWithDeliveredWork` exists to prevent.
 *
 * ONE SPELLING OF "UPCOMING" (round 6). The rule is `isUpcomingPost`, the
 * predicate Home's calendar widget already asks (`lib/calendar-kind.ts`), plus
 * the two exclusions that are about attribution rather than about the day, plus
 * the ceiling. It used to be written out again here — `isClientCalendarStatus`,
 * then a chip kind of `scheduled` or `placeholder` — and the reason given for
 * refusing `draft` ("content still in review, not yet planned") was the
 * pre-August doctrine that `isClientCalendarStatus` itself reversed: a client's
 * calendar now shows the same pending work staff see, unapproved drafts
 * included, and the post chain only ever moves DRAFTS onto future days
 * (`lib/post-chain.ts`). So every future day of an imported, chained stream was
 * a draft by construction, and this predicate answered `false` for the exact
 * agents the AF-5 rung was written for: the client read "your week is planned"
 * on the calendar and "Runs on request" on the agent above it.
 *
 *  • not a launch deliverable and not a test run — `getClientLibraryAssets` drops
 *    both, so neither is ever on anyone's calendar;
 *  • `isUpcomingPost` — `scheduledAt` strictly in the future (a past-due
 *    scheduled post is one that did NOT go out, not upcoming work) and a chip
 *    kind of `scheduled`, `placeholder` or `draft`;
 *  • `scheduledAt` no further out than `UPCOMING_WINDOW_DAYS`.
 *
 * PLACEHOLDER COUNTS, deliberately. It is a planned item the client sees on their
 * calendar for a future day, which is exactly the trigger in the ruling ("if
 * there's items on the calendar like Instagram or TikTok items, it should show us
 * live"), even though Karos never publishes one itself.
 */
function isUpcomingCalendarItem(asset: Asset, now: number): boolean {
  if (isLaunchDeliverable(asset) || isTestRunAsset(asset)) return false;
  if (asset.scheduledAt == null || asset.scheduledAt > now + UPCOMING_WINDOW_MS) return false;
  return isUpcomingPost(asset, now);
}

/**
 * Which of these agents have content waiting on this client's calendar (AF-5).
 *
 * The sibling of `agentsWithDeliveredWork`, over the same candidates, the same
 * binding rung and the SAME attribution rungs — because it answers the other half
 * of "is this agent working for me": that one reads history, this one reads the
 * days ahead. Sharing `assetBelongsToAgent` is the point; a second join here would
 * be a fourth chance to credit one agent's stream to another (F147).
 *
 * IT DOES NOT GO THROUGH `viewerVisibleAssets`, and that is the one deliberate
 * difference. The archive filter drops future-dated posts by construction (rule 2
 * of `getClientArchiveAssets`), so routing this through it would return the empty
 * set for every client, every time — the very posts being asked about are the ones
 * it exists to hide. What protects the boundary instead is the RETURN TYPE: a set
 * of agent ids, from which a caller can learn that some upcoming item exists and
 * nothing else. No count, no date, no title, no template leaves this function, so
 * a client learns only what their own calendar already shows them (A3/A4).
 *
 * The job half of `agentsWithDeliveredWork` has no counterpart here on purpose. A
 * job says an agent RAN; the question is whether content is on the calendar, and
 * an imported stream has no job at all — reading jobs would answer a different
 * question with the same name.
 */
export function agentsWithUpcomingContent(args: {
  assets: Asset[];
  jobs: Job[];
  agents: readonly { id: string; name: string; key: string }[];
  umbrellas: ClientAgent[];
  /** `Client.agentsRepoSlug` — the binding rung, as everywhere else. */
  clientSlug: string | null | undefined;
  now: number;
  /** Prebuilt by the caller (`buildAgentAssetIndex`); built here when absent. */
  index?: Pick<AgentAssetIndex, "jobById" | "upcoming">;
}): Set<string> {
  const bound = args.agents.filter((agent) =>
    agentKeyMatchesClientSlug(agent.key, args.clientSlug),
  );
  const upcoming =
    args.index?.upcoming ??
    args.assets.filter((asset) => isUpcomingCalendarItem(asset, args.now));
  if (upcoming.length === 0 || bound.length === 0) return new Set();

  const jobById = args.index?.jobById ?? new Map(args.jobs.map((job) => [job.id, job]));
  const producing = new Set<string>();
  // One pass over the upcoming set for the whole roster (finding E11).
  for (const [agentId, assets] of groupAssetsByAgent({
    assets: upcoming,
    jobById,
    agents: bound,
    umbrellas: args.umbrellas,
  })) {
    if (assets.length > 0) producing.add(agentId);
  }
  return producing;
}

/** One planned day ahead of this client, as the status line says it. */
export interface UpcomingCalendarDay {
  /** "YYYY-MM-DD" in the runtime zone — what the calendar's `?date=` key takes. */
  dateKey: string;
  /** The earliest instant planned on that day, for the label ("Thu 5"). */
  at: number;
}

/**
 * WHICH DAYS this one agent has planned inside the window, for its own page.
 *
 * The same predicate and the same attribution rungs as
 * `agentsWithUpcomingContent` — this is that function's answer with the days
 * kept, asked about one agent instead of a roster, so the status word and the
 * facts beside it can never come from two different readings of the calendar.
 *
 * DAYS, NOT ITEMS, and that is the whole of the A3/A4 argument (round 6). Its
 * sibling returns a bare set of ids because the ROSTER may only learn that
 * something exists; this is the agent's own page, and what it prints is the
 * count of distinct days and the first of them — which is exactly what the
 * client's calendar already shows them as locked "Upcoming post" chips. No
 * title, no per-day count, no batch shape and no generation instant leaves
 * here, so a reader still cannot decompose a week into the lump it was made in.
 */
export function agentUpcomingCalendarDays(args: {
  assets: Asset[];
  jobs: Job[];
  agent: { id: string; name: string; key: string };
  umbrellas: ClientAgent[];
  /** `Client.agentsRepoSlug` — the binding rung, as everywhere else. */
  clientSlug: string | null | undefined;
  now: number;
  /** Prebuilt by the caller (`buildAgentAssetIndex`); built here when absent. */
  index?: Pick<AgentAssetIndex, "jobById" | "upcoming">;
}): UpcomingCalendarDay[] {
  if (!agentKeyMatchesClientSlug(args.agent.key, args.clientSlug)) return [];
  const jobById = args.index?.jobById ?? new Map(args.jobs.map((job) => [job.id, job]));
  const attribution = agentAttribution({
    agent: args.agent,
    umbrella: umbrellaForAgent(args.umbrellas, args.agent.id),
    umbrellas: args.umbrellas,
  });
  const zone = runtimeTimeZone();
  const earliestByDay = new Map<string, number>();
  // `index.upcoming` is the same predicate, applied once for the page.
  for (const asset of args.index?.upcoming ?? args.assets) {
    if (!args.index && !isUpcomingCalendarItem(asset, args.now)) continue;
    if (!assetBelongsToAgent(asset, jobById, attribution)) continue;
    const at = asset.scheduledAt!;
    const dateKey = dateKeyInZone(at, zone);
    const seen = earliestByDay.get(dateKey);
    if (seen === undefined || at < seen) earliestByDay.set(dateKey, at);
  }
  return [...earliestByDay.entries()]
    .map(([dateKey, at]) => ({ dateKey, at }))
    .sort((a, b) => a.at - b.at);
}

/**
 * The stamp a deliverable row prints for this viewer.
 *
 * Client rows carry the DELIVERY moment, never the generation instant — a week
 * of "daily" posts shares one `createdAt`, so printing it publishes the batch
 * shape on every surface that lists deliverables.
 */
export function deliverableStamp(asset: Asset, viewerIsClient: boolean): number {
  return viewerIsClient ? clientDeliveryStamp(asset) : asset.createdAt;
}

/* ─────────────────── the template click-through (CD-K1) ────────────────── */

/** How many posts one template's expansion keeps. */
export const TEMPLATE_POSTS_SHOWN = 6;

/**
 * Every post this agent made under each of its templates, joined on
 * `Asset.templateKey` — the key `ClientAgentTemplate.key` was defined to equal.
 *
 * `assets` MUST already be `agentProducedAssets` output. That is the whole
 * safety of this function and the reason it lives in this module rather than
 * beside the component that renders it: for a client that set has already been
 * through `getClientArchiveAssets`, so a template's history inherits the
 * delivered-work-only filter instead of re-deriving one. A version of this that
 * read `listAssets` and filtered on `templateKey` alone would hand a client
 * every draft in the batch the moment they opened a format — the A3/A4 failure
 * in its most direct form, on the one surface that groups work by the stream
 * that produced it.
 *
 * `postCount` counts what this VIEWER may see, not what exists. It is therefore
 * a count of delivered work for a client and of everything for staff, which is
 * the same split every other number on the page already carries.
 *
 * Retired templates are included: a client who has posts under a stream that
 * was later retired still needs somewhere for them to appear. Which templates
 * are OFFERED is `visibleTemplates`' decision, upstream of this.
 */
export function templateDetails(args: {
  templates: ClientAgentTemplate[];
  assets: Asset[];
  viewerIsClient: boolean;
  perTemplate?: number;
}): Record<string, TemplateDetail> {
  const cap = args.perTemplate ?? TEMPLATE_POSTS_SHOWN;
  const byKey = new Map<string, Asset[]>();
  for (const asset of args.assets) {
    const key = asset.templateKey;
    if (!key) continue;
    const bucket = byKey.get(key);
    if (bucket) bucket.push(asset);
    else byKey.set(key, [asset]);
  }

  const details: Record<string, TemplateDetail> = {};
  for (const template of args.templates) {
    const posts = (byKey.get(template.key) ?? [])
      .map((asset) => ({
        id: asset.id,
        // The archive rows settle on the same fallback, so a titleless
        // deliverable reads the same wherever it is listed.
        title: asset.title || "Untitled",
        at: deliverableStamp(asset, args.viewerIsClient),
        // Carried alongside the row rather than mapped into it: only the newest
        // post becomes the example, so resolving an image for all of them would
        // be work for rows that never show one.
        asset,
      }))
      .sort((a, b) => b.at - a.at);
    // AF-6: the newest of exactly the set above, so the example a reader sees on
    // the closed row is the first row of the list it opens onto. Nothing here
    // widens what the join returned — if this viewer may not see a post, they may
    // not see it as an example either.
    const newest = posts[0];
    const exampleImage = newest ? assetImages(newest.asset)[0]?.url : undefined;
    details[template.key] = {
      key: template.key,
      ...(newest
        ? {
            example: {
              id: newest.id,
              title: newest.title,
              at: newest.at,
              ...(exampleImage ? { imageUrl: exampleImage } : {}),
            },
          }
        : {}),
      ...(template.rationale ? { rationale: template.rationale } : {}),
      addedAt: template.addedAt,
      source: template.source,
      posts: posts.slice(0, cap).map(({ asset: _asset, ...row }) => row),
      postCount: posts.length,
    };
  }
  return details;
}

/* ──────────────────────────── the daily strip ─────────────────────────── */

/**
 * One day on a daily-cadence agent's calendar strip.
 *
 * INTENT ONLY, exactly as the template-calendar week strip is (§4.1): a day
 * carries a date and a constant label, never a count, never a "found / not
 * found" mark for a day that has not happened. The whole point of the strip is
 * to answer "when does it go looking", and answering "and here is what it will
 * find" is the one thing it must never do.
 */
export interface FinderDay {
  dateKey: string;
  /** True for the viewer's current day in the SCHEDULE's zone (F108). */
  isToday: boolean;
  /** True once the day has passed — the strip greys it rather than dropping it. */
  isPast: boolean;
}

/**
 * Is this agent going looking at all? ONE derivation, on the view.
 *
 * The panel used to answer this twice from two different inputs — a
 * `scheduleActive` prop the page derived from the redacted schedule ROW, and
 * `finderDays`, which derived its own answer from the raw run — and printed
 * both. A paused schedule made them disagree out loud: the header read "Not
 * looking yet" directly above a strip of dated chips for tomorrow and the day
 * after. Both now read the same field.
 */
export type FinderScheduleState = "none" | "paused" | "active";

export function finderScheduleState(
  run: Pick<PlannedScheduledRun, "status"> | null,
): FinderScheduleState {
  if (!run || run.status === "completed") return "none";
  return run.status === "active" ? "active" : "paused";
}

/**
 * The days this agent goes looking, from its own schedule.
 *
 * Albert on the Reddit agent: "it will find a thread every day… fully connected
 * to the calendar itself." That connection is the SCHEDULE, projected — not an
 * invented daily rhythm. The Reddit agent fires at most five weekdays a week
 * (REDDIT_MAX_RUNS_PER_WEEK), so a strip that painted seven days would promise
 * two the agent never works.
 *
 * Day boundaries come from the schedule's stored IANA zone, the F108 contract —
 * reading them in the container's zone shifts the whole strip by a day for any
 * client who is not where the server is.
 */
export function finderDays(args: {
  run: PlannedScheduledRun | null;
  now: number;
  zone: string;
  /** How many days back the strip keeps for context. */
  lookbackDays?: number;
  horizonDays?: number;
}): FinderDay[] {
  // NOT FIRING, NO STRIP. The lookback days were painted unconditionally, so
  // an agent nobody has scheduled rendered four dated chips under "WHEN IT
  // LOOKS" while the panel above it said "Not looking yet" — days on which it
  // demonstrably did not look. The strip answers "when does it go looking", and
  // for an agent that is not going looking the honest answer is the one
  // DailyStrip already renders for an empty list.
  //
  // A PAUSED run is that same case and used to fall straight through this
  // guard: `projectRunOccurrences` knows nothing about status, so it happily
  // dated the next four fires of a schedule that will not fire again until
  // somebody resumes it. Keyed to `status === "active"`, not to a list of the
  // two statuses that were wrong, so a fourth status could not slip past.
  // (The null test is what narrows `run` for the projection below; the state
  // call alone already rejects null.)
  const run = args.run;
  if (!run || finderScheduleState(run) !== "active") return [];

  const todayKey = dateKeyInZone(args.now, args.zone);
  const lookback = args.lookbackDays ?? 3;
  const horizon = args.horizonDays ?? 7;

  const keys = new Set<string>();
  // Recent days always appear, whether or not a fire is still projected for
  // them: `nextRunAt` only ever points forward, so a projection alone would
  // render a strip that begins in the future and never contains today.
  for (let back = lookback; back >= 1; back -= 1) {
    keys.add(shiftDateKey(todayKey, -back));
  }
  keys.add(todayKey);

  // The projection's own guard (`run && status !== "completed"`) is gone: the
  // early return above already settled both halves of it, and more — it also
  // settles the half `projectRunOccurrences` never had, which is `paused`.
  for (const at of projectRunOccurrences(run, {
    from: args.now,
    horizonDays: horizon,
    ...(run.timeZone ? { timeZone: run.timeZone } : {}),
  })) {
    keys.add(dateKeyInZone(at, args.zone));
  }

  return [...keys]
    .sort()
    .map((dateKey) => ({
      dateKey,
      isToday: dateKey === todayKey,
      isPast: dateKey < todayKey,
    }));
}

/* ────────────────────────────── clip maker ────────────────────────────── */

export interface ClipMakerView {
  /**
   * The deliverables that are actually playable, newest first — the hero.
   *
   * `assetVideos` is the ONLY runtime video discriminator in this codebase
   * (`Asset` has no kind field and `AssetType` is video-agnostic), and it is
   * the same call the archive tile and the detail modal make. A locked or
   * future-dated asset can never appear here even by accident:
   * `redactLockedAsset` builds its copy by whitelist and does not carry
   * `videoUrl` forward, so a redacted clip resolves to zero videos — and
   * `agentProducedAssets` has already dropped it for a client anyway.
   */
  clips: Asset[];
  /**
   * Everything else this agent produced — the caption docs, the notes, the
   * run reports. A clip maker still writes things; they just are not the
   * product, so they sit under the gallery rather than replacing it.
   */
  documents: Asset[];
  /** The days a schedule will cut a clip on. Empty when there is no schedule. */
  scheduledDays: FinderDay[];
}

/**
 * Project a clip maker's assets into the deliverables-first view.
 *
 * NO TEMPLATE ROWS ANYWHERE, by construction: this view has no template field
 * to render one from. That is deliberate rather than incidental — `branded-shorts`
 * binds with no chain family and `slotMode: "single"`, so it generates no slots
 * and has no template registry, and a page that offered format rows for it
 * would be inventing streams the agent does not have (the same failure the
 * legacy panel documents for the umbrella-less shape).
 */
export function buildClipMakerView(args: {
  assets: Asset[];
  run: PlannedScheduledRun | null;
  now: number;
  zone?: string;
}): ClipMakerView {
  const clips: Asset[] = [];
  const documents: Asset[] = [];
  for (const asset of args.assets) {
    // ONE answer to "is this a clip", shared with the archive tile and the
    // detail modal. A predicate of this page's own — or one injected by its
    // caller — is a second answer, and the surface that disagrees is the one
    // that shows a client an empty gallery beside a video they can play.
    if (assetVideos(asset).length > 0) clips.push(asset);
    else documents.push(asset);
  }
  const zone = args.zone ?? args.run?.timeZone ?? runtimeTimeZone();
  return {
    clips,
    documents,
    scheduledDays: args.run ? finderDays({ run: args.run, now: args.now, zone }) : [],
  };
}

/* ───────────────────────────── daily finder ───────────────────────────── */

/**
 * One batch of finds, as a browser may receive it.
 *
 * The markdown is parsed HERE rather than in the reader component. Both do the
 * same parse — `parseRedditDrafts` is pure and client-safe, which is why the
 * asset modal can call it in the browser — but doing it at the boundary means
 * the payload carries the parsed shape instead of the whole raw document, and
 * it is the boundary that decides which assets get parsed at all.
 */
export interface FinderBatch {
  assetId: string;
  jobId?: string;
  /** When this batch reached the viewer (delivery for clients, generation for staff). */
  at: number;
  accounts: RedditParsedAccount[];
}

export interface DailyFinderView {
  /** The current day in the schedule's zone — what "today" means on this page. */
  todayKey: string;
  zone: string;
  /**
   * TODAY's finds, and only today's (churn A3/A4).
   *
   * A daily finder that showed tomorrow's thread would be saying out loud that
   * tomorrow's work already exists — the same fact the slot model exists to
   * keep indistinguishable. For a client the set is additionally archive-only,
   * so an unapproved draft never appears here however recently it landed.
   */
  today: FinderBatch[];
  /** Everything older, newest first — the per-agent archive. */
  earlier: FinderBatch[];
  days: FinderDay[];
  /**
   * Whether this agent is going looking — the ONE answer the whole panel reads.
   *
   * `days` and this field are computed from the same run in the same call, so
   * the header and the strip under it cannot print two verdicts again. The
   * panel takes no `scheduleActive` prop any more: a second input derived by
   * the page from a different object is exactly how they came to disagree.
   */
  scheduleState: FinderScheduleState;
  /**
   * This agent's output that is NOT a draft batch — run reports, notes.
   *
   * The common chassis promises "the documents it produced", and a finder page
   * that listed only its finds would quietly drop everything else the agent
   * wrote. Kept as a separate partition so the finds are never listed twice
   * under two headings.
   */
  documents: Asset[];
}

/**
 * Project the Reddit agent's assets into the daily-finder view.
 *
 * `assets` must already be this agent's (agentProducedAssets) — this function
 * decides WHICH DAY each batch belongs to and nothing about whose it is.
 */
export function buildDailyFinderView(args: {
  assets: Asset[];
  jobs: Job[];
  run: PlannedScheduledRun | null;
  viewerIsClient: boolean;
  now: number;
  zone?: string;
}): DailyFinderView {
  const zone = args.zone ?? args.run?.timeZone ?? runtimeTimeZone();
  const todayKey = dateKeyInZone(args.now, zone);
  const jobById = new Map(args.jobs.map((job) => [job.id, job]));

  const batches: Array<FinderBatch & { dateKey: string }> = [];
  const documents: Asset[] = [];
  for (const asset of args.assets) {
    const accounts = parseRedditDrafts(asset.content ?? "")?.accounts ?? null;
    // Not every asset this agent produced is a draft batch — a run can also
    // emit a report. Anything the reader cannot render is left to the generic
    // deliverables list rather than shown as an empty find.
    if (!accounts || accounts.length === 0) {
      documents.push(asset);
      continue;
    }
    const at = deliverableStamp(asset, args.viewerIsClient);
    const job = asset.jobId ? jobById.get(asset.jobId) : undefined;
    batches.push({
      assetId: asset.id,
      ...(job ? { jobId: job.id } : {}),
      at,
      accounts,
      dateKey: dateKeyInZone(at, zone),
    });
  }
  batches.sort((a, b) => b.at - a.at);

  const strip = (batch: FinderBatch & { dateKey: string }): FinderBatch => ({
    assetId: batch.assetId,
    ...(batch.jobId ? { jobId: batch.jobId } : {}),
    at: batch.at,
    accounts: batch.accounts,
  });

  return {
    todayKey,
    zone,
    today: batches.filter((b) => b.dateKey === todayKey).map(strip),
    earlier: batches.filter((b) => b.dateKey !== todayKey).map(strip),
    days: finderDays({ run: args.run, now: args.now, zone }),
    scheduleState: finderScheduleState(args.run),
    documents,
  };
}
