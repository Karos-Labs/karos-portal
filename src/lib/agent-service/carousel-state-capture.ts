/**
 * Which of a carousel v2 run's artifacts are DURABLE STATE, and how the run's
 * client-facing files become the one string the reader is handed.
 *
 * The sixth instance of the ephemeral-workspace capture. What is at stake is the
 * TOPIC CATALOGUE: the manifest says a run "flips one topic-catalog.yaml row
 * unused -> used", so losing it means the next press picks a topic the client
 * has already posted, on a channel where a repeat is visible to everyone who
 * follows them.
 *
 * Pure and dependency-free, so both halves are testable without a webhook.
 */

import type { CarouselAgentState } from "@/lib/types";

/**
 * The standing files, by the base name setup writes them under in
 * `clients/<slug>/skills/carousel-agent-v2/`.
 *
 * `templates/` is a DIRECTORY and is deliberately absent: one row holds one
 * file. Capturing a template set needs a row per file or an archive, and neither
 * is worth building before a pilot shows how often templates actually change.
 */
const STATE_BY_BASENAME: Record<string, CarouselAgentState["kind"]> = {
  "02-style-config.json": "style-config",
  "brand-tokens.json": "brand-tokens",
  "topic-catalog.yaml": "topic-catalog",
};

/**
 * `03-catalog-state.yaml`, matched separately and INSIDE the run's internal
 * trail, which is the one exception to the rule below.
 *
 * The integration spec named it as a file to sync. Against the manifest it is
 * not standing state — setup writes four things to the skills directory and this
 * is not one of them; it is a numbered artifact in the RUN's `internal/`. So it
 * is matched by exact base name rather than by the standing-path rule, and it is
 * captured because it was asked for and a run's own view of the catalogue is
 * cheap to keep.
 *
 * IT IS NOT WHAT PROTECTS AGAINST A REPEAT. `topic-catalog.yaml` is the file the
 * run mutates and the next run reads; this is a snapshot beside it. Anyone
 * tempted to drop one of the two should drop this one.
 */
const RUN_CATALOG_SNAPSHOT = "03-catalog-state.yaml";

/**
 * The state kind an artifact path carries, or null if it is not state.
 *
 * REFUSES THE RUN'S PINNED COPIES, as every sibling does: a frozen copy of what
 * the run READ, written back over what it PRODUCED, silently undoes the run's own
 * work — and for the topic catalogue that un-marks a topic the run just used.
 *
 * The `03-catalog-state.yaml` carve-out is checked BEFORE that refusal, because
 * the file legitimately lives in `internal/`. It is one exact base name, so the
 * exception cannot widen by accident.
 */
export function carouselStateKindFor(artifactPath: string): CarouselAgentState["kind"] | null {
  const path = artifactPath.split("\\").join("/").toLowerCase();
  const base = path.split("/").pop() ?? "";
  if (base === RUN_CATALOG_SNAPSHOT) {
    // Still refuse a PINNED copy of it — `internal/inputs/` is what the run read,
    // not what it produced.
    return path.includes("/inputs/") ? null : "catalog-state";
  }
  if (path.includes("/internal/")) return null;
  return STATE_BY_BASENAME[base] ?? null;
}

/** The content type to re-attach a captured file with. */
export function carouselStateContentType(path: string): string {
  const lower = path.toLowerCase();
  if (lower.endsWith(".json")) return "application/json";
  // YAML has no registered type that every reader agrees on; `text/yaml` is what
  // the rest of this repo's fixtures use and is what a runner will accept.
  if (lower.endsWith(".yaml") || lower.endsWith(".yml")) return "text/yaml";
  return "text/plain";
}

/** YYYY-MM-DD from the path when it carries one, else the delivery clock. */
export function carouselStateDateFor(artifactPath: string, fallbackMs: number): string {
  const match = artifactPath.match(/(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : new Date(fallbackMs).toISOString().slice(0, 10);
}

/** How many bytes of one state file we keep. Past any real one. */
export const CAROUSEL_STATE_MAX_CHARS = 400_000;

/* ─────────────────── the deliverable envelope the reader reads ───────────── */

export const CAROUSEL_ENVELOPE_KIND = "carousel-post-v2" as const;

/**
 * What the delivery handler stores as `asset.content` for one carousel post.
 *
 * ── WHY AN ENVELOPE, AND WHY THIS ONE IS DIFFERENT ────────────────────────
 *
 * The client folder is `client/01-<post-id>/` holding `slide-NN.png`, a
 * `caption.txt` and an `about.txt`. Unlike its five siblings the DELIVERABLE IS
 * IMAGES, and images do not travel through `asset.content` at all — they are
 * re-hosted by the webhook and reach the reader through `meta.artifacts`, the
 * same path every other image deliverable uses.
 *
 * So this envelope carries the TEXT half only: the caption a person copies, and
 * the about note. The slides are named rather than embedded, so a reader can
 * tell how many there should be and notice when one failed to re-host — which is
 * a real failure mode here, because a carousel missing slide 6 is broken in a way
 * a missing paragraph is not.
 */
export interface CarouselV2Envelope {
  kind: typeof CAROUSEL_ENVELOPE_KIND;
  /** The post number as the run named it, e.g. "004". */
  postNumber?: string;
  /** The caption, ready to paste. */
  caption?: string;
  /** The two lines the portal shows, leading with anything to confirm first. */
  about?: string;
  /**
   * The slide file names the run produced, in order. NOT the images: those are
   * re-hosted onto the asset. Kept so a reader can see that ten were made and
   * count how many arrived.
   */
  slideNames?: string[];
}

/** Is this asset content a carousel envelope? Cheap enough to run before parsing. */
export function isCarouselEnvelope(content: string): boolean {
  const head = content.trimStart().slice(0, 200);
  return head.startsWith("{") && head.includes(CAROUSEL_ENVELOPE_KIND);
}

/** One client-facing text file from the run, as the delivery handler has it. */
export interface CarouselClientFile {
  path: string;
  text: string;
}

/** Slide images are matched by name, since their bytes never reach this module. */
const SLIDE_NAME = /^slide-\d+\.(png|jpg|jpeg|webp)$/i;

/** Does this artifact name look like one of the run's slides? */
export function isCarouselSlideName(name: string): boolean {
  return SLIDE_NAME.test(name.split("/").pop() ?? "");
}

/**
 * Assemble the client-facing text into the envelope.
 *
 * `slideNames` is passed in rather than derived from `files`, because the slides
 * are images and never appear in the text list. The caller has the full artifact
 * manifest and is the only place that can count them.
 */
export function buildCarouselEnvelope(
  files: readonly CarouselClientFile[],
  slideNames: readonly string[] = [],
): CarouselV2Envelope {
  const env: CarouselV2Envelope = { kind: CAROUSEL_ENVELOPE_KIND };
  for (const file of files) {
    if (!file.text.trim()) continue;
    const path = file.path.split("\\").join("/");
    const base = (path.split("/").pop() ?? "").toLowerCase();
    if (base === "caption.txt") env.caption = file.text;
    else if (base === "about.txt") env.about = file.text;
    // `client/01-<post-id>/` — the folder carries the number; the file names do not.
    const num = path.match(/\/(\d{2,})-[^/]+\/[^/]+$/)?.[1];
    if (num && !env.postNumber) env.postNumber = num;
  }
  const slides = [...slideNames]
    .map((n) => n.split("/").pop() ?? n)
    .filter((n) => SLIDE_NAME.test(n))
    // Numeric, not lexicographic: slide-10 must follow slide-9, and a client
    // reading the list in the wrong order would think the story is scrambled.
    .sort((a, b) => Number(a.match(/\d+/)?.[0] ?? 0) - Number(b.match(/\d+/)?.[0] ?? 0));
  if (slides.length > 0) env.slideNames = slides;
  return env;
}

/**
 * Does this envelope carry anything worth storing as a deliverable?
 *
 * SLIDE NAMES ALONE COUNT. A run whose caption failed to write but whose ten
 * slides rendered has produced the expensive half, and the images are on the
 * asset regardless of this string. Refusing it would leave a client an asset with
 * pictures and no record of what they are.
 */
export function carouselEnvelopeHasContent(env: CarouselV2Envelope): boolean {
  return Boolean(env.caption || env.about || env.slideNames?.length);
}
