import "server-only";
import { createAsset, updateJob } from "@/lib/data";
import { uploadBytes } from "@/lib/storage";
import { reflowClientChain } from "@/lib/chain";
import { orderKeyForCreatedAt } from "@/lib/post-chain";
import { recommendedScheduleFields } from "@/lib/scheduling";
import { deliverableAssetType } from "@/lib/agent-service/deliverable-asset-type";
import { generateAssetTitle } from "@/lib/asset-titles";
import { AgentEngineCredentialError, getAgentEngineDeliverable } from "./client";
import { groupRecommendationsByOwner, hasClassifiedOwner, toRoutableRecommendation } from "./routable-recommendation";
import { renderIntelReport } from "./intel-report-render";
import type { AssetType, Job, WireTaskType } from "@/lib/types";

/**
 * Task 3 — asset materialization for a completed agent-engine run.
 *
 * `syncAgentEngineJobStatusFromView` (reconcile.ts) only ever flips
 * `job.status`; it has no equivalent of the legacy agent-service webhook's
 * artifact-rehost + `createAsset` + `reflowClientChain` pipeline (see that
 * webhook's own doc comments — one generic pipeline, no per-task-type
 * branching). This module is that pipeline's agent-engine-sourced counterpart.
 *
 * IT USED TO COVER THREE PRODUCTS OF ELEVEN, and the eight it left out were
 * not inert: every one of them writes a real deliverable through
 * `ledger.writeDeliverable` and then reached `status: "review"` here with
 * `assetIds: []` — a Job page showing a completed run, an "In review" badge,
 * and nothing to review. Three of the missing eight (`x-agent`,
 * `linkedin-agent`, `reddit-agent`) even render a `draftsMarkdown`/
 * `draftsEnvelope` field onto their deliverable FOR THIS PORTAL'S OWN readers
 * — see each workflow's own persist step, and the cross-repo fixture proof in
 * `src/lib/__tests__/agent-engine-drafts-compat.test.ts`. The engine half of
 * that handoff shipped; this half never accepted it.
 *
 * `PRODUCT_DELIVERABLES` below is now the whole engine catalog, in ONE table
 * rather than the two parallel records this module used to keep (a `kind` map
 * and a task-type map, joined by a non-null assertion that quietly promised
 * they held the same keys — a promise nothing checked). A product still absent
 * from it is a deliberate no-op, not an error: the job reaches `review`
 * regardless, exactly as before.
 */

/**
 * How one engine product's deliverable becomes a karosCMO asset.
 *
 * `taskType`/`assetTypeHint` are the INPUT to `deliverableAssetType`, never a
 * second asset-type derivation of this module's own — that shared helper is the
 * one point every runtime-derived type in this codebase goes through
 * (`platforms-publishable.test.ts`'s governance scan), and it also applies the
 * Reddit draft-only fence, which now genuinely fires here: `reddit-agent` is a
 * real product in this table, so its `social_post` base is fenced down to a
 * slot-less `note` instead of being offered to twitter/linkedin/facebook/
 * tiktok. That fence was vacuous in this module before and is not any more.
 *
 * WHY `blog-agent`/`newsletter-agent` ARE `custom` PLUS A HINT rather than the
 * `blog_article`/`newsletter_issue` task types whose names match them: both of
 * those `WireTaskType` members are RETIRED (`RETIRED_BLOG_TASK_TYPE` /
 * `RETIRED_NEWSLETTER_TASK_TYPE` in types.ts — "NEW WORK MUST NOT USE IT"; they
 * are spelled at all only so a v1 row already in Firestore still reads back).
 * A new delivery may not mint them. `custom` plus a whitelisted `assetTypeHint`
 * is the sanctioned route to a non-default asset type, and it lands on the same
 * `article`/`email` those retired types would have.
 */
interface ProductDeliverableSpec {
  /** The `kind` this product's workflow passes to `ledger.writeDeliverable`. Must match it exactly — anything else 404s, which this module reads as "not ready yet". */
  kind: string;
  taskType: WireTaskType;
  /** Honored by `deliverableAssetType` only when `taskType` is `"custom"`, and only if whitelisted there. */
  assetTypeHint?: AssetType;
}

const PRODUCT_DELIVERABLES = {
  "x-agent": { kind: "x-post", taskType: "social_post" },
  "linkedin-agent": { kind: "linkedin-post", taskType: "social_post" },
  "instagram-agent": { kind: "instagram-carousel", taskType: "social_post" },
  "branded-shorts-agent": { kind: "branded-shorts-video", taskType: "social_post" },
  "tiktok-agent": { kind: "tiktok-clip", taskType: "social_post" },
  // Draft-only by hard product rule. Left as `social_post` deliberately: the
  // fence in `deliverableAssetType` is what re-types it to `note`, and routing
  // through the fence rather than hard-coding `note` here is the whole point —
  // one rule, asked once, for every path that creates an asset.
  "reddit-agent": { kind: "reddit-reply", taskType: "social_post" },
  "blog-agent": { kind: "blog-post", taskType: "custom", assetTypeHint: "article" },
  "newsletter-agent": { kind: "newsletter-edition", taskType: "custom", assetTypeHint: "email" },
  "landing-builder-agent": { kind: "landing-page-site", taskType: "landing_page" },
  // The three report/bundle products have no publishable shape at all: they are
  // internal analysis a staff member reads, so `note` (target-less, pinned as
  // such in platforms-publishable.test.ts) is the honest type, not a hedge.
  "intel-report-agent": { kind: "intel-report", taskType: "custom", assetTypeHint: "note" },
  "seo-geo-agent": { kind: "seo-geo-report", taskType: "custom", assetTypeHint: "note" },
  "campaign-orchestrator": { kind: "campaign-bundle", taskType: "custom", assetTypeHint: "note" },
  // The reputation pulse. `note` for the same reason Reddit is fenced to it —
  // a review reply is posted from the CLIENT'S OWN business listing (Google,
  // Yelp, ...), so there is no platform this portal could push it to, and
  // this portal has no reputation publish channel at all (nothing in
  // `PUBLISHABLE_PLATFORMS` names one). A pulse is also not one post: it is a
  // batch of approved drafts plus flagged items with no draft, the same
  // "index over several things a staff member reads" shape as the three rows
  // above it rather than one schedulable post — so `custom` + the `note` hint
  // is the honest type here too, not `social_post` relying on a fence that
  // only recognizes Reddit's identity.
  "reputation-agent": { kind: "reputation-pulse", taskType: "custom", assetTypeHint: "note" },
} as const satisfies Record<string, ProductDeliverableSpec>;

/**
 * Every engine product this module can turn into an asset — the literal key
 * union other modules (`product-mapping.ts`'s build-time guard) check custom-
 * agent routes against, so a route added with no materializer here fails
 * `tsc`/`next build` instead of shipping a job that reaches `review` with
 * nothing attached.
 */
export type EngineProductWithDeliverable = keyof typeof PRODUCT_DELIVERABLES;

/**
 * Every engine product this module can turn into an asset, and the `kind` each
 * one is fetched by — exported so a test can assert coverage against the
 * engine's real catalog rather than re-listing it and drifting.
 */
export const PRODUCT_DELIVERABLE_KINDS: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(PRODUCT_DELIVERABLES).map(([productId, spec]) => [productId, spec.kind]),
);

interface AssetMaterialization {
  title: string;
  content: string;
  imageUrl?: string | null;
  videoUrl?: string | null;
  channels?: string[];
  meta: Record<string, unknown>;
}

/**
 * Re-hosts one agent-engine-produced file into karosCMO's own storage, the
 * same reason the legacy webhook never puts a foreign URL on a client-facing
 * asset directly: agent-engine's own signed URLs expire (7 days, V4 signing's
 * own maximum) and point at a bucket this portal doesn't control access to
 * long-term. Only a `path` that's actually an `https://` signed URL is
 * fetchable at all — a bare `gs://` URI (signing unavailable) or a local
 * filesystem path (no media store configured on agent-engine's side) is
 * skipped, loudly, rather than silently producing an asset with no image.
 *
 * `objectPath` here is deterministic — `agent-engine/${job.id}/slide-${n}.png`,
 * the same path every time this job's deliverable is materialized. `ifAbsent:
 * true` is not optional on a path like that: it's `uploadBytes`'s own
 * documented fix for "two overlapping writers to the same deterministic
 * path... whichever write lands LAST wins the object, so the OTHER writer's
 * Firestore doc now points a token that matches no live generation" — a
 * permanent, silent 403 on every future load, indistinguishable from a real
 * access-rules rejection. `materializeAgentEngineDeliverable`'s own
 * `assetIds.length > 0` guard narrows the window this can happen in but does
 * not close it (a read-then-later-write race, not a lock), and a real prep
 * job (hcf9ymPGJC7mDS5pcEQ4) hit exactly this: every slide's photo vanished
 * after initially rendering correctly, with no code change in between.
 */
async function rehostIfFetchable(path: string | undefined, objectPath: string, contentType: string): Promise<string | undefined> {
  if (!path || !path.startsWith("https://")) {
    if (path) console.error(`[agent-engine materialize] artifact at "${path}" is not a fetchable signed URL — skipping rehost, asset will have no media for it`);
    return undefined;
  }
  const res = await fetch(path, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) {
    console.error(`[agent-engine materialize] failed to fetch artifact (${res.status}): ${path}`);
    return undefined;
  }
  const bytes = Buffer.from(await res.arrayBuffer());
  const { url } = await uploadBytes({ bytes, path: objectPath, contentType, ifAbsent: true });
  return url;
}

/* ────────────────────── reading a foreign payload ───────────────────── */

/**
 * Every materializer below reads a deliverable that crossed a service
 * boundary, so each field is ASKED FOR rather than asserted: a payload whose
 * shape drifted produces a thinner asset, never a thrown materialization.
 * That distinction matters more than it looks — `materializeAgentEngineDeliverable`
 * swallows its own throws (it must not block the job reaching `review`), so an
 * over-confident cast here would land the job back in exactly the state this
 * module exists to fix: complete, in review, nothing attached.
 */
function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function strArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value.filter((v): v is string => typeof v === "string" && v.trim().length > 0);
  return items.length > 0 ? items : undefined;
}

function rec(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function objArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.map(rec) : [];
}

/** The first non-empty candidate — the "prefer the portal-shaped field, fall back to the raw one" idiom every materializer needs. */
function firstOf(...candidates: unknown[]): string | undefined {
  for (const candidate of candidates) {
    const value = str(candidate);
    if (value) return value;
  }
  return undefined;
}

/** Joins the parts of a rendered document, dropping the ones this deliverable didn't carry. */
function joinBlocks(parts: readonly (string | undefined)[]): string {
  return parts.filter((part): part is string => Boolean(part && part.trim())).join("\n\n");
}

/** A deterministic title off the deliverable's own fields, whitespace-collapsed and length-capped. The stand-in for `generateAssetTitle` when that returns null. */
function fallbackTitle(candidate: string | undefined, whenAbsent: string): string {
  const raw = candidate?.replace(/\s+/g, " ").trim();
  if (!raw) return whenAbsent;
  return raw.length > 90 ? `${raw.slice(0, 87).trimEnd()}…` : raw;
}

/** Only the keys the deliverable actually carried — an asset's `meta` should not be a field list with `undefined` against half of it. */
function metaFrom(deliverable: Record<string, unknown>, fields: readonly string[]): Record<string, unknown> {
  const meta: Record<string, unknown> = {};
  for (const field of fields) {
    if (deliverable[field] !== undefined) meta[field] = deliverable[field];
  }
  return meta;
}

/* ───────────────────── per-product materializers ────────────────────── */

/**
 * The three draft-batch channels share one shape from this module's point of
 * view: the workflow already rendered the exact string this portal's own
 * reader parses (`draftsMarkdown` for x/linkedin, `draftsEnvelope` for
 * reddit), so `content` is that string with its OUTER whitespace trimmed and
 * nothing else touched, and the AssetCard's existing sniff turns it into the
 * pick/edit/skip drafts reader with no new rendering here at all.
 * `text`/`replyBody` is the fallback for a deliverable written before those
 * fields existed — a plain-text asset reads fine, an empty one does not.
 *
 * THE TRIM IS THE ONLY MUTATION, and it is deliberate rather than incidental to
 * the helper: a post body whose first characters are blank lines renders as a
 * gap at the top of the card and, if published, on the platform. Both drafts
 * formats are whitespace-insensitive at their edges (markdown headings, JSON),
 * so nothing a reader depends on is lost. Nothing INSIDE the string is
 * normalized — no dash rewriting, no re-wrapping, no re-serializing the JSON
 * envelope — because the parser contract is against what the engine wrote.
 */
function materializeDraftBatch(
  deliverable: Record<string, unknown>,
  opts: {
    readerField: "draftsMarkdown" | "draftsEnvelope";
    rawTextFields: readonly string[];
    titleFrom: readonly string[];
    titleWhenAbsent: string;
    metaFields: readonly string[];
    channels?: string[];
  },
): AssetMaterialization {
  return {
    title: fallbackTitle(firstOf(...opts.titleFrom.map((f) => deliverable[f])), opts.titleWhenAbsent),
    content: firstOf(deliverable[opts.readerField], ...opts.rawTextFields.map((f) => deliverable[f])) ?? "",
    ...(opts.channels ? { channels: opts.channels } : {}),
    meta: metaFrom(deliverable, opts.metaFields),
  };
}

function materializeXPost(deliverable: Record<string, unknown>): AssetMaterialization {
  return materializeDraftBatch(deliverable, {
    readerField: "draftsMarkdown",
    rawTextFields: ["text", "mainPostText"],
    channels: ["twitter"],
    titleFrom: ["hook", "text", "mainPostText"],
    titleWhenAbsent: "X post",
    metaFields: ["lane", "angle", "targetHandle", "hook", "mediaRefs"],
  });
}

function materializeLinkedInPost(deliverable: Record<string, unknown>): AssetMaterialization {
  // `hashtags` keeps that exact key: the AssetCard reads `meta.hashtags`
  // directly for its own chip row, so it may not travel inside a nested blob.
  return materializeDraftBatch(deliverable, {
    readerField: "draftsMarkdown",
    rawTextFields: ["text", "body"],
    channels: ["linkedin"],
    titleFrom: ["headline", "hook", "text"],
    titleWhenAbsent: "LinkedIn post",
    metaFields: ["archetype", "hook", "hashtags", "callToAction", "targetAudience"],
  });
}

function materializeRedditReply(deliverable: Record<string, unknown>): AssetMaterialization {
  // No `channels`, deliberately. Reddit is draft-only by hard product rule — a
  // human always posts the reply from their own account — and `channels`
  // pre-selects a publish target in the approve/schedule flow, which is exactly
  // what a draft-only deliverable must never carry. The asset type is fenced to
  // `note` independently; this is the second half of the same rule.
  return materializeDraftBatch(deliverable, {
    readerField: "draftsEnvelope",
    rawTextFields: ["replyBody", "text"],
    titleFrom: ["targetThreadTitle", "replyBody", "text"],
    titleWhenAbsent: "Reddit reply",
    metaFields: ["targetThreadUrl", "targetThreadTitle", "targetSubreddit", "parentCommentId", "disclosureIncluded"],
  });
}

/** The blog article — `bodyMarkdown` is the publishable body; the SEO/GEO fields travel in meta for the structured-data consumers. */
function materializeBlogPost(deliverable: Record<string, unknown>): AssetMaterialization {
  return {
    title: fallbackTitle(firstOf(deliverable["title"]), "Blog article"),
    content: firstOf(deliverable["bodyMarkdown"], deliverable["text"], deliverable["excerpt"]) ?? "",
    meta: metaFrom(deliverable, [
      "slug",
      "excerpt",
      "metaDescription",
      "headersList",
      "estimatedReadMinutes",
      "faqItems",
      "canonicalUrl",
      "jsonLd",
    ]),
  };
}

/**
 * The newsletter edition. `text` is the agent's own assembled body; when it is
 * absent the intro/sections/signoff are stitched into one readable document
 * rather than handing over an empty asset with the real content buried in meta.
 */
function materializeNewsletterEdition(deliverable: Record<string, unknown>): AssetMaterialization {
  const stitched = joinBlocks([
    str(deliverable["intro"]),
    ...objArray(deliverable["sections"]).map((section) => {
      const heading = str(section["heading"]);
      const body = str(section["body"]);
      return heading && body ? `## ${heading}\n\n${body}` : (heading ?? body);
    }),
    str(deliverable["signoff"]),
  ]);
  return {
    title: fallbackTitle(firstOf(deliverable["subjectLine"]), "Newsletter edition"),
    content: firstOf(deliverable["text"]) ?? stitched,
    meta: metaFrom(deliverable, [
      "subjectLine",
      "previewText",
      "callToAction",
      "signoff",
      "sections",
      "footerDisclaimer",
      "unsubscribeUrl",
      "companyAddress",
    ]),
  };
}

/**
 * A slide as `create-instagram-agent-workflow.ts`'s `ledger.writeDeliverable`
 * call actually writes it: `slidesData.slides`, the render tool's own `Slide`
 * shape (`@agent-engine/tool-karos-publish`) — per-archetype `fields`, never a
 * single per-slide caption string. `headline`/`body` below is what a
 * text-only or stat/quote/comparison slide actually carries, and `fields`
 * covers whatever other archetype fields the template registry adds later
 * without this module needing to know their names.
 *
 * `caption` (2026-08) is the POST's own text — separate from any slide —
 * required on every new deliverable. Optional here only so an older
 * deliverable already in Firestore (written before this field existed)
 * still materializes something rather than throwing.
 */
interface InstagramCarouselDeliverable {
  postId?: string;
  topic?: string;
  caption?: string;
  slides?: Array<{ n: number; fields?: Record<string, string> }>;
  rendered?: Array<{ n: number; path: string; gcsUri?: string }>;
}

/** Never prose — excluded from anything read as slide text, same rule the engine's own workflow applies before this ever reaches a person. */
const NON_PROSE_FIELD_KEYS = new Set(["accentColor", "dir", "brandHandle", "seriesBadge", "fontScale", "textAlign"]);

/**
 * Every slide's prose field values, joined the same way the engine's own
 * topic guardrail does — so a slide's caption in the gallery is the exact
 * text that was reviewed, not a re-derivation of it. `accentColor` is a hex
 * string, never prose; excluding it is what stopped it leaking into a
 * gallery caption (prep run 2VFCw79Wu8xfJOKXC7zP).
 */
function joinSlideFields(slide: { fields?: Record<string, string> } | undefined): string {
  return Object.entries(slide?.fields ?? {})
    .filter(([key]) => !NON_PROSE_FIELD_KEYS.has(key))
    .map(([, value]) => value.trim())
    .filter(Boolean)
    .join(" ");
}

async function materializeInstagramCarousel(job: Job, deliverable: InstagramCarouselDeliverable): Promise<AssetMaterialization> {
  const rendered = deliverable.rendered ?? [];
  const slidesByN = new Map((deliverable.slides ?? []).map((s) => [s.n, s]));

  // Every slide, not only the first — `assetImages()` already understands
  // `meta.slides: [{headline, imageUrl}]` (content-engine/agent-service's own
  // carousel shape) and renders it as a gallery; this deliverable just never
  // populated it. Rehosts run in parallel: each is an independent fetch, and
  // a stalled one otherwise costs seven slides their wait for nothing.
  const slides = await Promise.all(
    rendered.map(async (r) => {
      const imageUrl = await rehostIfFetchable(r.path, `agent-engine/${job.id}/slide-${r.n}.png`, "image/png");
      const text = joinSlideFields(slidesByN.get(r.n));
      return { n: r.n, headline: text || undefined, imageUrl: imageUrl ?? null };
    }),
  );
  const withPhotos = slides.filter((s) => s.imageUrl);

  // The post's own caption — required on every new deliverable (§1 of the
  // engine's instagram-copy prompt). A deliverable written before `caption`
  // existed falls back to every slide's copy joined, which is what shipped
  // before — worse than a real caption, but still real text rather than the
  // bare topic string this used to be.
  const content = deliverable.caption?.trim() || joinBlocks(rendered.map((r) => joinSlideFields(slidesByN.get(r.n))));

  return {
    title: deliverable.topic ?? "Instagram post",
    content,
    // The cover thumbnail existing cards read directly — first slide with a
    // rehosted photo, same "best available" rule the single-photo path uses.
    imageUrl: withPhotos[0]?.imageUrl ?? null,
    channels: ["instagram"],
    meta: {
      taskType: "social_post",
      postId: deliverable.postId,
      slideCount: rendered.length,
      // `assetImages()` reads this shape FIRST, ahead of `meta.artifacts` —
      // one rehosted photo per slide, in order, each with its own caption.
      slides: withPhotos,
      artifacts: rendered.map((r) => ({ n: r.n, gcsUri: r.gcsUri })),
    },
  };
}

interface BrandedShortsVideoDeliverable {
  gcsUri?: string;
  signedUrl?: string;
  durationSeconds?: number;
}

async function materializeBrandedShortsVideo(job: Job, deliverable: BrandedShortsVideoDeliverable): Promise<AssetMaterialization> {
  const videoUrl = await rehostIfFetchable(deliverable.signedUrl, `agent-engine/${job.id}/final.mp4`, "video/mp4");
  return {
    title: "TikTok video",
    content: "",
    videoUrl: videoUrl ?? null,
    channels: ["tiktok"],
    meta: {
      taskType: "social_post",
      durationSeconds: deliverable.durationSeconds,
      artifacts: deliverable.gcsUri ? [{ gcsUri: deliverable.gcsUri }] : [],
    },
  };
}

/**
 * The commentary clip as `create-tiktok-agent-workflow.ts`'s
 * `ledger.writeDeliverable` call writes it. Unlike branded-shorts, this
 * deliverable's `caption` IS the post text — the client's own take, with the
 * source credit the engine enforces in code — so `content` carries it rather
 * than the empty string the branded-shorts materializer ships.
 */
interface TiktokClipDeliverable {
  topic?: string;
  caption?: string;
  about?: string;
  sourceCredit?: string;
  hookLine?: string;
  hookType?: string;
  sourceTier?: string;
  durationSeconds?: number;
  gcsUri?: string;
  signedUrl?: string;
}

async function materializeTiktokClip(job: Job, deliverable: TiktokClipDeliverable): Promise<AssetMaterialization> {
  const videoUrl = await rehostIfFetchable(deliverable.signedUrl, `agent-engine/${job.id}/clip.mp4`, "video/mp4");
  return {
    title: fallbackTitle(deliverable.topic, "Commentary clip"),
    content: deliverable.caption?.trim() ?? "",
    videoUrl: videoUrl ?? null,
    channels: ["tiktok"],
    meta: {
      taskType: "social_post",
      ...(deliverable.about !== undefined ? { about: deliverable.about } : {}),
      ...(deliverable.sourceCredit !== undefined ? { sourceCredit: deliverable.sourceCredit } : {}),
      ...(deliverable.hookLine !== undefined ? { hookLine: deliverable.hookLine } : {}),
      ...(deliverable.hookType !== undefined ? { hookType: deliverable.hookType } : {}),
      ...(deliverable.sourceTier !== undefined ? { sourceTier: deliverable.sourceTier } : {}),
      ...(deliverable.durationSeconds !== undefined ? { durationSeconds: deliverable.durationSeconds } : {}),
      artifacts: deliverable.gcsUri ? [{ gcsUri: deliverable.gcsUri }] : [],
    },
  };
}

interface LandingPageSiteDeliverable {
  gcsPrefix?: string;
  fileCount?: number;
  status?: string;
}

/**
 * No landing-page-bundle concept exists anywhere in `Asset` today (confirmed:
 * the legacy webhook has zero special-casing for `landing_page` either — it
 * lands as a slot-less `"note"`, same as here). `gcsPrefix` is a directory
 * tree, not a single fetchable URL, so there is nothing to rehost — the
 * asset's `content` names where the reviewed source tree lives, and staff
 * retrieve it out-of-band until a real bundle/preview concept exists on
 * either side.
 */
function materializeLandingPageSite(deliverable: LandingPageSiteDeliverable): AssetMaterialization {
  return {
    title: "Landing page",
    content: deliverable.gcsPrefix
      ? `Site source (${deliverable.fileCount ?? "?"} files) uploaded to ${deliverable.gcsPrefix}`
      : "Landing page build completed — no site bundle was uploaded (GCS_ARTIFACTS_BUCKET not configured on agent-engine).",
    meta: { taskType: "landing_page", gcsPrefix: deliverable.gcsPrefix, fileCount: deliverable.fileCount, buildStatus: deliverable.status },
  };
}

/**
 * The competitive-intelligence report, RENDERED through the typed structured
 * renderer (`./intel-report-render.ts`, T-B17/SCRUM-270) rather than the
 * hand-flattened `joinBlocks`/manual `- ${key}: ${score}/100` string-building
 * this used to do inline.
 *
 * `intel-report`'s deliverable is eight dimension scores, seven prose
 * analysis sections, a SWOT and a recommendation list, and this portal has no
 * dedicated report VIEWER UI that reads that structure — so `renderIntelReport`
 * is what stands in for one: real headings, a real dimension-scores table,
 * grouped/numbered recommendations, each section typed and parsed
 * defensively rather than read out of the raw object at the call site. Every
 * structured field still travels in `meta` untouched in addition to being
 * rendered, so a future dedicated viewer can still read the typed data
 * directly without a re-delivery.
 */
function materializeIntelReport(deliverable: Record<string, unknown>): AssetMaterialization {
  const { title, content } = renderIntelReport(deliverable);
  return {
    title,
    content,
    meta: metaFrom(deliverable, [
      "overallScore",
      "overallGrade",
      "competitorCount",
      "dimensionScores",
      "swot",
      "recommendations",
      "competitorRankings",
      "competitors",
      "brandVoiceRows",
      "brandVoiceArchetypes",
      "brandVoiceTerritory",
      "customerSentiment",
      "whitespaceOpportunities",
    ]),
  };
}

/**
 * The SEO/GEO report. `narrative` is the one field here that is already prose —
 * the agent's own written summary — so it leads, with the two canonical scores
 * above it and the fired recommendations under it. Every score object, the
 * frozen prompt set and the reproducibility digest stay in `meta`.
 */
function materializeSeoGeoReport(deliverable: Record<string, unknown>): AssetMaterialization {
  const seoScore = rec(deliverable["seoScore"])["score"];
  const geoScore = rec(deliverable["geoReadiness"])["score"];
  const recommendations = objArray(deliverable["firedRecommendations"]);

  const scoreLine = [
    typeof seoScore === "number" ? `SEO ${seoScore}` : undefined,
    typeof geoScore === "number" ? `GEO readiness ${geoScore}` : undefined,
  ]
    .filter((part): part is string => Boolean(part))
    .join(" · ");

  // Never narrower than the raw payload: an older/partial record (missing
  // `recommendation`, or predating C2's routing fields entirely) still gets
  // its title into this list exactly as before. This is deliberately loose
  // where the typed parse below is strict.
  const recommendationBlock = recommendations
    .map((recommendation) => {
      const title = firstOf(recommendation["title"], recommendation["recommendation"], recommendation["id"]);
      return title ? `- ${title}` : undefined;
    })
    .filter((line): line is string => Boolean(line))
    .join("\n");

  // [C2] The routable half of the same array: `check`/`lever`/`productRef`
  // and the `fixAction`/`actionKind`/`owner`/`engineProductId` routing,
  // fail-safe-parsed rather than thrown away. A record too malformed to be
  // even a `FiredRecommendation` (no `recId`/`recommendation`) is dropped
  // from this typed view — it still rendered above, from the raw payload.
  // Always populated (structured data — every unclassified record still
  // resolves to a real, honest `owner: "client_manual"`), unlike the prose
  // line below, which is gated on the wire actually carrying owner data.
  const routableRecommendations = recommendations
    .map(toRoutableRecommendation)
    .filter((r): r is NonNullable<typeof r> => r !== undefined);

  // THE SPRAYER (SCRUM-210 acceptance #3): sorts into the three owner
  // categories off `owner` alone — see groupRecommendationsByOwner's own
  // doc comment for why that is recId-blind by construction.
  const byOwner = groupRecommendationsByOwner(routableRecommendations);

  // GATED ON REAL DATA, not merely on there being recommendations at all
  // (R1 review finding: today's real agent-engine payload carries ZERO
  // owner/fixAction/engineProductId fields — see `hasClassifiedOwner`'s own
  // doc comment — so an unconditional line here would show every real report
  // "0 we run automatically · 0 tool/connector · N client action", which
  // reads as a genuine triage result when it is actually nothing but the
  // fail-safe default. Rendering nothing until the wire actually carries an
  // `owner` is the honest version of this line: accurate zero counts once
  // T-A4/SCRUM-257 ships classified data are fine to show, an all-default
  // batch dressed up as a triage is not.
  const anyClassified = recommendations.some(hasClassifiedOwner);
  const ownerMixLine = anyClassified
    ? `**Owner mix:** ${byOwner.karos_agent.length} we run automatically · ${byOwner.karos_tool.length} tool/connector · ${byOwner.client_manual.length} client action`
    : undefined;

  return {
    title: "SEO and GEO visibility report",
    content: joinBlocks([
      scoreLine ? `**${scoreLine}**` : undefined,
      str(deliverable["narrative"]),
      recommendationBlock ? `## Recommendations (${recommendations.length})\n\n${recommendationBlock}` : undefined,
      ownerMixLine,
    ]),
    meta: {
      ...metaFrom(deliverable, [
        "seoScore",
        "geoReadiness",
        "visibility",
        "geoScoreModel",
        "connectorOverlay",
        "firedRecommendations",
        "fixDrafts",
        "promptSet",
        "reproducibility",
      ]),
      // Structured, typed, routable — always present (even when every record
      // fails safe to client_manual) so a consumer that reads meta directly
      // never has to guess whether this run predates C2. What is withheld
      // above is the PROSE claim, not this data.
      routableRecommendations,
    },
  };
}

/**
 * The campaign bundle. ONE asset for the orchestrator's own run, indexing each
 * channel slot's outcome — the per-channel drafts are their own nested slots
 * with their own deliverables, so this asset points at them rather than
 * duplicating their text (which would put the same draft in the library twice,
 * with two different approval states).
 */
function materializeCampaignBundle(deliverable: Record<string, unknown>): AssetMaterialization {
  const channelResults = objArray(deliverable["channelResults"]);
  const rows = channelResults
    .map((result) => {
      const channel = firstOf(result["channel"], result["slotId"], result["productId"]);
      if (!channel) return undefined;
      const status = str(result["status"]);
      const topic = firstOf(result["topic"], result["mainStory"], result["title"]);
      return `- **${channel}**${status ? ` · ${status}` : ""}${topic ? ` — ${topic}` : ""}`;
    })
    .filter((row): row is string => Boolean(row))
    .join("\n");

  const pillars = strArray(deliverable["targetPillars"]);
  const theme = str(deliverable["theme"]);

  return {
    title: fallbackTitle(firstOf(deliverable["campaignName"], deliverable["theme"]), "Campaign bundle"),
    content: joinBlocks([
      theme ? `**Theme:** ${theme}` : undefined,
      pillars ? `**Pillars:** ${pillars.join(", ")}` : undefined,
      rows ? `## Channels (${channelResults.length})\n\n${rows}` : undefined,
    ]),
    meta: metaFrom(deliverable, ["campaignName", "theme", "targetPillars", "channelResults"]),
  };
}

/**
 * The reputation pulse, as `create-reputation-pulse-workflow.ts`'s
 * `ledger.writeDeliverable` call actually writes it (verified against
 * agent-engine, `create-reputation-pulse-workflow.ts:762`): `summary` is the
 * triage counts, `crisis` names whether an escalation fired, `flagged` is
 * every review the run decided NOT to draft a reply for (the part with a
 * deadline — a human has to act on it), and `approvedDrafts` is the batch of
 * `{ reviewId, draftText }` pairs a human copies onto the real review
 * platform. Every field is asked for, never asserted, same rule as every
 * other cross-boundary materializer in this file.
 *
 * Rendered to markdown rather than shipped as raw JSON, same choice as
 * `materializeIntelReport`/`materializeSeoGeoReport`: this portal has no
 * pulse-specific viewer, and a reviewer handed the bare object would see
 * braces, not the two things that matter — what needs action now, and what
 * the drafted replies actually say. The crisis line leads when it fired,
 * because that is the one fact in a pulse with a same-day cost.
 */
function materializeReputationPulse(deliverable: Record<string, unknown>): AssetMaterialization {
  const summary = rec(deliverable["summary"]);
  const crisis = rec(deliverable["crisis"]);
  const crisisFired = crisis["fired"] === true;
  const flagged = objArray(deliverable["flagged"]);
  const approvedDrafts = objArray(deliverable["approvedDrafts"]);
  const pulseNumber = str(deliverable["pulseNumber"]);

  const summaryLine = (
    [
      ["responded", "respond"],
      ["flagged", "flag"],
      ["no action", "no_action"],
      ["unavailable", "unavailable"],
    ] as const
  )
    .map(([label, field]) => {
      const value = summary[field];
      return typeof value === "number" ? `${value} ${label}` : undefined;
    })
    .filter((part): part is string => Boolean(part))
    .join(" · ");

  const flaggedBlock = flagged
    .map((row) => {
      const reason = str(row["reason"]);
      if (!reason) return undefined;
      const urgency = row["urgencyScore"];
      return `- ${reason}${typeof urgency === "number" ? ` (urgency ${urgency}/100)` : ""}`;
    })
    .filter((line): line is string => Boolean(line))
    .join("\n");

  const draftsBlock = approvedDrafts
    .map((row) => str(row["draftText"]))
    .filter((text): text is string => Boolean(text))
    .join("\n\n---\n\n");

  return {
    title: pulseNumber ? `Reputation pulse ${pulseNumber}` : "Reputation pulse",
    content: joinBlocks([
      crisisFired ? "**A crisis trigger fired on this pulse — see flagged items below.**" : undefined,
      summaryLine ? `**${summaryLine}**` : undefined,
      flaggedBlock ? `## Flagged — needs a person (${flagged.length})\n\n${flaggedBlock}` : undefined,
      draftsBlock ? `## Drafted replies (${approvedDrafts.length})\n\n${draftsBlock}` : undefined,
    ]),
    meta: metaFrom(deliverable, [
      "pulseNumber",
      "generatedAt",
      "summary",
      "crisis",
      "captureLegs",
      "unavailableLegs",
      "flagged",
      "approvedDrafts",
      "draftManifest",
    ]),
  };
}

async function buildMaterialization(job: Job, productId: string, deliverable: unknown): Promise<AssetMaterialization | undefined> {
  const fields = rec(deliverable);
  switch (productId) {
    case "x-agent":
      return materializeXPost(fields);
    case "linkedin-agent":
      return materializeLinkedInPost(fields);
    case "reddit-agent":
      return materializeRedditReply(fields);
    case "blog-agent":
      return materializeBlogPost(fields);
    case "newsletter-agent":
      return materializeNewsletterEdition(fields);
    case "instagram-agent":
      return materializeInstagramCarousel(job, deliverable as InstagramCarouselDeliverable);
    case "branded-shorts-agent":
      return materializeBrandedShortsVideo(job, deliverable as BrandedShortsVideoDeliverable);
    case "tiktok-agent":
      return materializeTiktokClip(job, deliverable as TiktokClipDeliverable);
    case "landing-builder-agent":
      return materializeLandingPageSite(deliverable as LandingPageSiteDeliverable);
    case "intel-report-agent":
      return materializeIntelReport(fields);
    case "seo-geo-agent":
      return materializeSeoGeoReport(fields);
    case "campaign-orchestrator":
      return materializeCampaignBundle(fields);
    case "reputation-agent":
      return materializeReputationPulse(fields);
    default:
      return undefined;
  }
}

/**
 * Fetches a completed run's deliverable, rehosts its media, creates the
 * karosCMO asset, attaches it to the job, and reflows the client's calendar
 * chain — the Task 3 counterpart to the legacy webhook's own pipeline.
 * Idempotent by the same convention `dispatchAgentEngineRun` already
 * establishes (a freshly dispatched job starts with `assetIds: []`): a job
 * that already has at least one asset is treated as already materialized
 * (or as a job type this module was never meant to touch), and this is a
 * pure no-op. Returns the new asset id, or `undefined` when nothing was
 * materialized (no known deliverable shape, deliverable not found yet, or
 * already materialized) — never throws, since a materialization failure
 * must not block the job from reaching `status: "review"`.
 */
export async function materializeAgentEngineDeliverable(job: Job): Promise<string | undefined> {
  if (!job.agentEngineRunId || !job.agentEngineProductId) return undefined;
  if (job.assetIds.length > 0) return undefined;

  // Widened to a plain index signature for this one lookup: `job.agentEngineProductId`
  // is an arbitrary string that crossed a service boundary, not a key of the
  // literal-typed `PRODUCT_DELIVERABLES` (that literal typing is what makes
  // `EngineProductWithDeliverable` — and `product-mapping.ts`'s build-time guard
  // — possible in the first place).
  const spec = (PRODUCT_DELIVERABLES as Readonly<Record<string, ProductDeliverableSpec>>)[job.agentEngineProductId];
  if (!spec) return undefined;

  try {
    const deliverable = await getAgentEngineDeliverable(job.agentEngineRunId, spec.kind);
    if (!deliverable) return undefined;

    const materialization = await buildMaterialization(job, job.agentEngineProductId, deliverable);
    if (!materialization) return undefined;

    // The one shared point every runtime-derived asset type in this codebase goes
    // through (platforms-publishable.test.ts's governance scan, PINNED_DERIVATIONS)
    // — applies the Reddit draft-only fence unconditionally, exactly as the webhook and
    // MCP upload_asset paths already do. `reddit-agent` is now a real entry in
    // PRODUCT_DELIVERABLES, so that fence is load-bearing here rather than theoretical:
    // it is what keeps a reply written for one thread off twitter/linkedin/facebook/tiktok.
    const assetType = deliverableAssetType({
      taskType: spec.taskType,
      hint: spec.assetTypeHint ?? null,
      content: materialization.content,
      identity: [job.agentEngineProductId],
    });

    // The same titler the webhook uses, so a deliverable delivered through agent-engine
    // and one delivered through agent-service are named under one contract instead of
    // two. Failure is free by that function's own construction (null on any error,
    // timeout, or unusable completion) — the deterministic field-derived title stands in,
    // and an empty-content deliverable never spends the call at all.
    const generatedTitle = materialization.content
      ? await generateAssetTitle({ content: materialization.content, clientId: job.clientId, agentName: job.agentName })
      : null;

    const now = Date.now();
    const assetId = await createAsset({
      clientId: job.clientId,
      jobId: job.id,
      agentId: "agent-engine",
      type: assetType,
      title: generatedTitle ?? materialization.title,
      content: materialization.content,
      meta: { ...materialization.meta, agentEngineRunId: job.agentEngineRunId, agentEngineProductId: job.agentEngineProductId },
      imageUrl: materialization.imageUrl ?? null,
      ...(materialization.videoUrl ? { videoUrl: materialization.videoUrl } : {}),
      ...(materialization.channels ? { channels: materialization.channels } : {}),
      status: "draft",
      orderKey: orderKeyForCreatedAt(now, job.id),
      ...recommendedScheduleFields(assetType, 0, materialization.channels?.[0]),
      createdBy: "agent-engine",
      createdAt: now,
      updatedAt: now,
    });

    await updateJob(job.id, { assetIds: [...job.assetIds, assetId], updatedAt: Date.now() });

    // Best-effort, same as the legacy webhook's own reflow call: the job already has its
    // asset and its "review" status regardless of whether the calendar slot lands.
    await reflowClientChain(job.clientId).catch((e: unknown) => {
      console.error(`[agent-engine materialize] calendar reflow failed for client "${job.clientId}" — run the staff reflow action`, e);
    });

    return assetId;
  } catch (e) {
    // SCRUM-330: a credential failure is a MISCONFIGURATION, not "the
    // deliverable isn't ready" — every job on this instance will fail the same
    // way until someone fixes the runtime identity. This function's
    // never-throws contract is deliberate and load-bearing (a materialization
    // failure must not keep a job out of `review`), so we honour it rather than
    // rethrowing — but the two cases must not read alike in the logs, or the
    // one that needs an operator hides inside the one that needs nobody.
    if (e instanceof AgentEngineCredentialError) {
      console.error(
        `[agent-engine materialize] CREDENTIAL FAILURE for job "${job.id}" (run "${job.agentEngineRunId}") — ` +
          `the portal could not mint an agent-engine ID token, so NO deliverable will materialize on this instance ` +
          `until its runtime service account can reach the metadata server. This is not a per-job problem.`,
        e,
      );
      return undefined;
    }
    console.error(`[agent-engine materialize] failed to materialize deliverable for job "${job.id}" (run "${job.agentEngineRunId}")`, e);
    return undefined;
  }
}
