import type { ManagedTaskType } from "@/lib/types";

/**
 * Maps one of karosCMO's "managed" catalog task types onto agent-engine's
 * own fixed `productId` enum (`apps/agent-server/src/wiring/workflows.ts`'s
 * `KNOWN_PRODUCT_IDS`) — the only two directions this repo can currently
 * dispatch through agent-engine at all:
 *
 *   - "landing_page" is a direct 1:1 match: agent-engine's
 *     `landing-builder-agent`.
 *   - "social_post" is Instagram-or-TikTok (`MANAGED_TASK_LABELS`'s own
 *     "Social posts (IG/TikTok)" in `src/lib/jobs/submit-managed.ts`) and
 *     needs `brief.platform` (set by `execution-engine.ts`'s own
 *     "instagram" vs "tiktok" keyword match) to know which: `"instagram"` →
 *     `instagram-agent`, `"tiktok"` → `branded-shorts-agent`.
 *
 * That last pairing is deliberately UNCHANGED now that a `tiktok-agent`
 * exists, because the two products want different inputs and a managed
 * "social_post" brief carries neither on its own: branded-shorts renders one
 * uploaded talking-head video, while tiktok-agent clips a moment out of a
 * long-form episode it is pointed at. Which one a managed TikTok post should
 * mean is a product decision, not a mapping detail, so it stays where it has
 * always been until someone makes it. The custom-agent route below is where
 * `karos-tiktok-agent` reaches the clip system.
 *
 * Returns `undefined` — never a guess — for `"custom"` (see
 * `resolveAgentEngineProductIdForCustomAgent` below, which routes every custom
 * agent agent-engine now has a real workflow for) or when a "social_post"
 * brief has no recognized `platform`. Every caller must treat `undefined` as
 * "stay on the legacy agent-service path," not as an error.
 */
export function resolveAgentEngineProductId(taskType: ManagedTaskType, brief: Record<string, unknown>): string | undefined {
  if (taskType === "landing_page") {
    return "landing-builder-agent";
  }
  if (taskType === "social_post") {
    const platform = typeof brief.platform === "string" ? brief.platform.toLowerCase() : undefined;
    if (platform === "instagram") return "instagram-agent";
    if (platform === "tiktok") return "branded-shorts-agent";
    return undefined;
  }
  return undefined;
}

/**
 * The custom-agent half of the cutover: which `customAgents.key` values now
 * have a real agent-engine workflow behind them.
 *
 * Keyed on the agent's stable `key` rather than its display name, because the
 * name is admin-editable and a rename must not silently reroute a client's
 * traffic to a different execution engine.
 *
 * The map is exact rather than a prefix match, and that is the important part.
 * A setup agent and a drafting agent for the same channel share a name prefix
 * and do entirely different work, so a `startsWith("karos-linkedin")` shortcut
 * would feed an onboarding form into a post-drafting workflow. Each pairing is
 * written out because each was checked.
 *
 * `karos-linkedin-manager-v2` is deliberately still absent: it runs on two
 * clocks and rewrites the generators' inputs, and agent-engine has neither a
 * scheduler nor a write path for that. It stays on agent-service until it does.
 *
 * Everything absent from this map stays on agent-service, which is still the
 * executor for the overwhelming majority of production jobs. This is a
 * per-agent cutover, not a switch.
 */
const ENGINE_PRODUCT_BY_CUSTOM_AGENT_KEY: Readonly<Record<string, string>> = {
  "karos-x-agent-v2": "x-agent",
  "karos-linkedin-writer-v2": "linkedin-agent",
  "karos-reddit-runner": "reddit-agent",
  // The lab's onboarding skills, now routed to the DRAFTING agents.
  //
  // `linkedin-setup-agent`/`reddit-setup-agent` were separate engine products
  // until the setup workflow was inlined into each parent as its
  // `00-channel-setup` pre-flight. A run dispatched from one of these lab keys
  // carries the same filled form it always did; the parent agent records it if
  // the channel has no charter, skips it if one exists, and then drafts. So
  // onboarding and the first post are one run instead of two products someone
  // had to sequence by hand.
  //
  // The manager variants stay absent on purpose: karos-linkedin-manager-v2
  // runs on two clocks and rewrites the generators' inputs, and agent-engine
  // has neither a scheduler nor a write path for that.
  "karos-linkedin-setup-v2": "linkedin-agent",
  "karos-reddit-setup": "reddit-agent",
  // Three more whose engine workflows already exist.
  //
  // instagram-agent and branded-shorts-agent route correctly but do not finish
  // for a client whose engine-side workspace is not populated: verified in
  // prep, instagram-agent `held` at 03-claim-topic on an empty topics catalog
  // and branded-shorts-agent `blocked_intake` at 00-brand-resolve with no
  // brandedShortsProfilePath on file. (Both stop there BEFORE reaching the
  // unprovisioned UNSPLASH_ACCESS_KEY / BRANDED_SHORTS_ENGINE_DIR, so those
  // are still missing but are not the current blocker.) Both fail honestly
  // rather than wrongly, and the per-client gate means neither routes for
  // anyone until that client is opted in -- so this is the mapping landing
  // ahead of the per-client data, not instead of it.
  "karos-instagram-agent": "instagram-agent",
  "landing-builder": "landing-builder-agent",
  "branded-shorts": "branded-shorts-agent",
  // The three remaining drafting agents whose engine workflows were built and
  // sitting idle. Same shape as the writers above: one portal agent, one
  // engine product, drafting only.
  "karos-blog-writer-v2": "blog-agent",
  "karos-newsletter-writer-v2": "newsletter-agent",
  "karos-reputation-runner": "reputation-agent",
  // seo-geo-agent-v2 closes a split rather than opening a new route: the
  // engine's seo-geo-agent was ALREADY running in production, dispatched from
  // dispatch-research-agents.ts, while this custom agent went on running the
  // agent-service implementation. One client could get two different
  // implementations depending on which surface they came through. Both now
  // land on the same workflow.
  "seo-geo-agent-v2": "seo-geo-agent",
  // The clip system, now that agent-engine has a workflow for it. It is its
  // own product and not branded-shorts under another name: branded-shorts
  // turns ONE talking-head video into one vertical short, while this finds a
  // moment inside someone else's long-form episode and puts the client's
  // commentary on it. Routing it at branded-shorts-agent, which was the
  // tempting shortcut while no tiktok-agent existed, would have quietly run a
  // different product for the client.
  "karos-tiktok-agent": "tiktok-agent",
};

export function resolveAgentEngineProductIdForCustomAgent(agentKey: string): string | undefined {
  return ENGINE_PRODUCT_BY_CUSTOM_AGENT_KEY[agentKey];
}

/**
 * Which `runKind` a dispatch to this product should carry.
 *
 * `"recurring"` for everything, with one exception that is not cosmetic:
 * `landing-builder-agent` treats `runKind === "recurring"` as MODE=rebuild —
 * "apply the one feedback delta" — and its own doc comment says so outright.
 * A rebuild needs a `feedback-round.json` for the next round number, and if
 * one isn't in the bundle the run resolves to `blocked_intake`.
 *
 * This portal has no feedback-round concept anywhere in it, so the only thing
 * a landing-page job here can possibly mean is a fresh build. Sending
 * `"recurring"` meant every landing job blocked on a feedback round that
 * nothing in this codebase can produce — and because the first build never
 * happened, no later run could ever have a prior site to rebuild either.
 * Verified both directions against prep: the same brief blocks as
 * `"recurring"` and proceeds to the copy/compose stages as `"setup"`.
 *
 * Only `landing-builder-agent` and `seo-geo-agent` branch on `runKind` engine-
 * side at all, and seo-geo is not reachable from either submit path, so this
 * changes nothing else.
 *
 * When the portal grows a real "here is my feedback on round N" surface, this
 * is the function that should start returning `"recurring"` for it.
 */
export function resolveAgentEngineRunKind(productId: string): "setup" | "recurring" {
  return productId === "landing-builder-agent" ? "setup" : "recurring";
}

/**
 * SHARED BRIEF FIELDS (C3's shared layer), dialog key -> wire key.
 *
 * snake_case in the dialog, camelCase on the wire, converted here and nowhere
 * else — the one place C3 names for the conversion, so a second spelling can
 * never appear on a second code path.
 *
 * `success_criteria` is the GENERIC profile's constraints field and maps onto
 * the same `mustInclude` list as `must_include`. It is there because
 * `karos-reddit-setup` resolves to the generic profile (its key matches no
 * dedicated matcher), so without this alias a client filling the visible
 * "Success criteria and constraints" box on a reddit-agent run would have it
 * silently dropped — the exact defect T-B12 exists to close.
 */
const SHARED_SCALAR_FIELDS: ReadonlyArray<readonly [dialogKey: string, wireKey: string]> = [
  ["audience", "audience"],
  ["tone", "tone"],
  ["cta", "cta"],
];

/**
 * Shared LIST fields. C3 spells these `mustInclude[]` and `keywords[]` — the
 * only two brief fields that are arrays on the wire, so nothing else here
 * invents one.
 *
 * `must_include` splits on NEWLINES ONLY: its dialog helper says "one item per
 * line" and its items routinely contain commas ("Dates, product facts,
 * compliance"), so comma-splitting would shred one requirement into three.
 * `keywords` is a single-line text input whose natural separator is the comma,
 * so it splits on both.
 */
const SHARED_LIST_FIELDS: ReadonlyArray<
  readonly [dialogKey: string, wireKey: string, splitOnCommas: boolean]
> = [
  ["must_include", "mustInclude", false],
  ["success_criteria", "mustInclude", false],
  ["keywords", "keywords", true],
];

/**
 * DEDICATED PER-AGENT FIELDS, dialog key -> wire key.
 *
 * Per-agent by CONSTRUCTION rather than by a product-keyed filter here: each
 * of these keys appears in exactly one launch profile (verified field-by-field
 * in `product-mapping.test.ts`'s dialog-coverage sweep), so `offer` can only
 * ever arrive from a landing-page dialog and `li_identity` only from a
 * LinkedIn one.
 *
 * A product-keyed allow-list on THIS side was considered and rejected: the
 * portal cannot know which profile a scheduled run or a copilot dispatch
 * filled, and narrowing here would re-open the same silent-drop hole the
 * moment a profile grows a field (it already would today — C3's reddit row
 * lists only `tone`, while `karos-reddit-setup`'s generic dialog shows
 * `audience`). Which fields a given agent READS is enforced engine-side by
 * T-A13, where C3 requires one per-agent test that the field reaches the
 * prompt.
 *
 * The five `requested*` keys are already camelCase and have no dialog field at
 * all: nothing in this repo renders them. They are kept because non-dialog
 * callers (`linkedin-agent-actions.ts` builds `briefValues` by hand, and the
 * scheduled-run cron may) can set them, and dropping a key an existing caller
 * may pass is a silent regression rather than a fix.
 */
const DEDICATED_FIELDS: ReadonlyArray<readonly [dialogKey: string, wireKey: string]> = [
  // X draft
  ["run_scope", "runScope"],
  ["requestedLane", "requestedLane"],
  ["requestedArchetype", "requestedArchetype"],
  // LinkedIn post / setup
  ["li_identity", "liIdentity"],
  // Reddit reply
  ["requestedSubreddit", "requestedSubreddit"],
  ["requestedThreadUrl", "requestedThreadUrl"],
  ["requestedThreadTitle", "requestedThreadTitle"],
  // Blog / social content system
  ["run_mode", "runMode"],
  // Social content system + short-form video
  ["platform", "platform"],
  ["duration", "duration"],
  // Conversion page
  ["offer", "offer"],
  ["proof", "proof"],
  // Search audit
  ["website", "website"],
  ["scope", "scope"],
  ["market", "market"],
  ["competitors", "competitors"],
];

/**
 * Dialog keys whose ANSWER IS PROSE FOR THE MODEL and which C3 rules should be
 * folded into `customPrompt` rather than given a wire field of their own.
 *
 * Folded with their dialog label, in `buildCustomAgentPrompt`'s own
 * "Label\nvalue" shape, so the engine receives the same prose the legacy
 * agent-service path receives for the same answer.
 */
const FOLDED_INTO_CUSTOM_PROMPT: ReadonlyArray<readonly [dialogKey: string, label: string]> = [
  ["point_of_view", "Brand point of view and proof"],
  ["editing_notes", "Editing notes"],
];

/**
 * Dialog keys that are LISTS OF LINKS, folded into `mediaAssets` — C3's
 * "folds sources into mediaAssets/context" and "folds references into
 * mediaAssets".
 *
 * A line that is not a `gs://` or `https://` URI is not silently discarded:
 * these boxes take "URLs, studies, product pages, claims to verify", so the
 * non-URI remainder folds into `customPrompt` under the same label. Nothing
 * the client typed leaves without a destination.
 */
const FOLDED_INTO_MEDIA: ReadonlyArray<
  readonly [dialogKey: string, role: string, label: string]
> = [
  ["sources", "reference", "Required sources or internal links"],
  ["references", "reference", "Reference URLs"],
  ["source_url", "source", "Source video or link"],
];

/**
 * ONE DIALOG KEY IS DELIBERATELY ABSENT FROM EVERY TABLE ABOVE: `batch_size`.
 *
 * It is hidden in every profile that still declares it and inert for pricing
 * by product ruling (2026-08-05 / 2026-08-11): one press, one output, flat
 * price. C3 deletes it from the x-agent and linkedin-agent rows outright ("the
 * engine does one post per run — product ruling 11.08"). Forwarding it would
 * ask the engine for N outputs the client cannot see and is not billed for.
 *
 * Written here rather than enforced by a filter, because a filter over a key
 * no table mentions is a check that cannot fail. What can fail is the test
 * ("batch_size never reaches the engine, visible or not"), which asserts the
 * payload — so adding the key to a table above breaks the suite.
 */

/** The engine product whose dialog `request` is DIRECTION, not a topic. */
const REQUEST_IS_DIRECTION_PRODUCT = "seo-geo-agent";

function splitList(raw: string, splitOnCommas: boolean): string[] {
  return raw
    .split(splitOnCommas ? /[\n,]+/ : /\n+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

/**
 * `target_date` as an ISO string, or `undefined`.
 *
 * NEVER THROWS and never guesses: a value Date.parse cannot read is an omitted
 * field, not a failed run (C3's readRichRunInput invariant, held on this side
 * too). A date-only answer stays date-only — widening `2026-09-01` to
 * `2026-09-01T00:00:00.000Z` would move it a day for anyone west of UTC, and
 * delivery reads this to schedule a publish.
 */
function normalizeTargetDate(raw: string): string | undefined {
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    return Number.isFinite(Date.parse(`${raw}T00:00:00Z`)) ? raw : undefined;
  }
  const parsed = Date.parse(raw);
  if (!Number.isFinite(parsed)) return undefined;
  return new Date(parsed).toISOString();
}

/**
 * The subset of a custom agent's brief that agent-engine understands as a
 * per-run request (`WorkflowContext.input`, C3's `RichRunInputSchema`).
 *
 * Allow-listed rather than passed through wholesale for two reasons. The
 * engine's workflows overlay these onto the client's standing config, so an
 * unrecognized key would be carried into a run and silently ignored — looking
 * honoured without being. And a brief is user input: forwarding it verbatim
 * would let a form field named `targetSubreddits` or `xHandle` reach a place
 * where the engine reads client identity.
 *
 * WHAT T-B12 CHANGED. The allow-list used to be eight keys wide, and the
 * fourteen other fields the run dialogs actually render — audience, tone, cta,
 * must_include, keywords, point_of_view, sources, references, source_url,
 * editing_notes, offer, proof, run_mode, run_scope, li_identity, platform,
 * duration, post_count, website, scope, market, competitors — were accepted by
 * the form and dropped here without a trace. C3's non-negotiable principle is
 * that every field a dialog shows reaches the agent or is deleted from the
 * dialog; this function is the half of that which reaches the agent.
 *
 * `engineProductId` is the product the PAGE resolved when it decided which
 * fields to show (`withEngineRunFields`). It is passed so the two sides cannot
 * disagree about the shape of the same dialog — C3's second mandatory fix —
 * and today only `seo-geo-agent` reads it, whose `request` box asks for a
 * business question rather than a topic. Omitted, `request` keeps its
 * historical meaning.
 */
export function toEngineRunInput(
  briefValues: Record<string, string> | undefined,
  engineProductId?: string,
): Record<string, unknown> {
  if (!briefValues) return {};

  const input: Record<string, unknown> = {};
  const at = (key: string): string | undefined => briefValues[key]?.trim() || undefined;

  // The run's own direction, in the person's words. Distinct from `request`,
  // which is the topic: this is how to treat it. Left blank it is absent
  // rather than empty, because an agent handed "" would have to decide for
  // itself whether that meant "no direction" or "no strategy", and the answer
  // is always the first. Folded answers append to it, base direction first.
  const promptParts: string[] = [];
  const base = at("customPrompt");
  if (base) promptParts.push(base);

  const request = at("request");
  if (request) {
    if (engineProductId === REQUEST_IS_DIRECTION_PRODUCT) {
      promptParts.push(`Business goal or question\n${request}`);
    } else {
      input.requestedTopic = request;
    }
  }

  for (const [dialogKey, wireKey] of SHARED_SCALAR_FIELDS) {
    const value = at(dialogKey);
    if (value) input[wireKey] = value;
  }

  for (const [dialogKey, wireKey, splitOnCommas] of SHARED_LIST_FIELDS) {
    const value = at(dialogKey);
    if (!value) continue;
    const items = splitList(value, splitOnCommas);
    if (items.length === 0) continue;
    const existing = Array.isArray(input[wireKey]) ? (input[wireKey] as string[]) : [];
    input[wireKey] = [...existing, ...items];
  }

  const targetDate = at("target_date") ?? at("targetDate");
  if (targetDate) {
    const iso = normalizeTargetDate(targetDate);
    if (iso) input.targetDate = iso;
  }

  // `post_count` is the social dialog's own VISIBLE "Number of posts" (1-10,
  // default 3) and is not `batch_size`: it multiplies no bill and is not
  // hidden, so a client who moves it is asking for something and must be heard.
  // Sent as a number rather than the form's string, because a count is a count.
  const postCount = at("post_count");
  if (postCount) {
    const n = Number(postCount);
    if (Number.isInteger(n) && n > 0) input.postCount = n;
  }

  for (const [dialogKey, wireKey] of DEDICATED_FIELDS) {
    const value = at(dialogKey);
    if (value) input[wireKey] = value;
  }

  // Attachments arrive as a JSON array from the dialog, because a form field
  // carries strings. Parsed and re-validated here rather than forwarded raw:
  // a malformed attachment should be dropped at the boundary, not become an
  // engine-side surprise on a run someone is waiting for.
  const mediaAssets = parseMediaAssets(briefValues["mediaAssets"]);

  for (const [dialogKey, role, label] of FOLDED_INTO_MEDIA) {
    const value = at(dialogKey);
    if (!value) continue;
    const leftovers: string[] = [];
    for (const line of splitList(value, false)) {
      if (line.startsWith("gs://") || line.startsWith("https://")) {
        mediaAssets.push({ uri: line, role });
      } else {
        leftovers.push(line);
      }
    }
    if (leftovers.length > 0) promptParts.push(`${label}\n${leftovers.join("\n")}`);
  }
  if (mediaAssets.length > 0) input.mediaAssets = mediaAssets;

  for (const [dialogKey, label] of FOLDED_INTO_CUSTOM_PROMPT) {
    const value = at(dialogKey);
    if (value) promptParts.push(`${label}\n${value}`);
  }

  if (promptParts.length > 0) input.customPrompt = promptParts.join("\n\n");

  return input;
}

/** The asset roles agent-engine understands (`MediaAssetSchema` in its core package). */
const MEDIA_ROLES = new Set(["source", "reference", "logo", "overlay"]);

/**
 * Attachments the engine will accept, and nothing else.
 *
 * Only `gs://` and `https://` are allowed through. A local path would be
 * meaningless to a container that has never seen this machine's disk, and
 * anything else is a caller sending something we have no reason to forward.
 */
export function parseMediaAssets(raw: string | undefined): Array<Record<string, string>> {
  if (!raw?.trim()) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const out: Array<Record<string, string>> = [];
  for (const candidate of parsed) {
    if (typeof candidate !== "object" || candidate === null) continue;
    const entry = candidate as Record<string, unknown>;
    const uri = typeof entry.uri === "string" ? entry.uri.trim() : "";
    if (!uri.startsWith("gs://") && !uri.startsWith("https://")) continue;
    const role = typeof entry.role === "string" && MEDIA_ROLES.has(entry.role) ? entry.role : "source";
    out.push({
      uri,
      role,
      ...(typeof entry.contentType === "string" && entry.contentType ? { contentType: entry.contentType } : {}),
      ...(typeof entry.label === "string" && entry.label ? { label: entry.label } : {}),
    });
  }
  return out;
}

/**
 * Which clients may have their custom-agent jobs routed to agent-engine.
 *
 * Per-agent routing alone is not enough to cut over safely, and production
 * shows why: all seven clients are granted the X agent, but only one has an
 * `xHandle` in the engine's workspace store. Routing on the agent key alone
 * would send six clients' X jobs to `blocked_intake` — work that succeeds on
 * agent-service today.
 *
 * `AGENT_ENGINE_CUSTOM_AGENT_CLIENTS` is a comma-separated list of
 * `agentsRepoSlug` values, or `*` for all. Unset means NOBODY, so deploying
 * this code changes nothing until someone names a client — which is what lets
 * the build ship to production ahead of the cutover decision.
 *
 * A client is added once its engine-side context is in place and one real run
 * has been verified. That is the unit of this drain: not "the X agent is
 * migrated" but "this client's X agent is migrated".
 */
export function isClientEnabledForEngineCustomAgents(
  clientSlug: string | undefined,
  env: Record<string, string | undefined> = process.env,
): boolean {
  if (!clientSlug) return false;
  const raw = env.AGENT_ENGINE_CUSTOM_AGENT_CLIENTS?.trim();
  if (!raw) return false;
  if (raw === "*") return true;
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .includes(clientSlug);
}
