/**
 * Which of a blog v2 run's artifacts are DURABLE STATE, and how the run's
 * client-facing files become the one string the reader is handed.
 *
 * The fourth instance of the ephemeral-workspace capture. What is at stake here
 * is the CLAIMS: a writer run claims a post number at step 01, a subject at step
 * 05 and a slug at step 10, and the framework is explicit about why the middle
 * one exists — without it two runs can each take a different post number and then
 * write the same article. "The number claim protects identity; the subject claim
 * protects content." Lose the post index and the clusters file and both claims
 * are gone, so two presses in one week produce one article twice.
 *
 * Pure and dependency-free, so both halves are testable without a webhook.
 */

import type { BlogAgentState } from "@/lib/types";

/** The state files, by the base name the contract writes them under. */
const STATE_BY_BASENAME: Record<string, BlogAgentState["kind"]> = {
  "post-index.json": "post-index",
  "clusters.json": "clusters",
  "voice-card.md": "voice-card",
  "v1-posts.json": "v1-posts",
  "next-request.md": "next-request",
};

/**
 * The state kind an artifact path carries, or null if it is not state.
 *
 * REFUSES A RUN'S PINNED COPY, exactly as the newsletter's matcher does. Writer
 * step 02 copies every standing document it reads into `internal/inputs/`,
 * frozen, and the framework calls those "the frozen copies" of what the run READ.
 * Capturing one writes the pre-run state back over the post-run state — and for
 * the post index that un-claims a number the run just took.
 *
 * IT ALSO REFUSES `blog/posts/`, which the newsletter's twin has no equivalent
 * of. Step 13 rebuilds the client's standing site into `clients/<slug>/blog/`
 * from the completed runs, and that tree contains a `<slug>.json` per post. Those
 * are DERIVED render payloads, not state; capturing one under a name that
 * happened to collide would overwrite a real file with a rendering artifact.
 */
export function blogStateKindFor(artifactPath: string): BlogAgentState["kind"] | null {
  const path = artifactPath.split("\\").join("/").toLowerCase();
  if (path.includes("/inputs/") || path.includes("/02-inputs/")) return null;
  if (path.includes("/blog/posts/")) return null;
  const base = path.split("/").pop() ?? "";
  return STATE_BY_BASENAME[base] ?? null;
}

/** The content type to re-attach a captured file with. */
export function blogStateContentType(path: string): string {
  return path.toLowerCase().endsWith(".json") ? "application/json" : "text/markdown";
}

/** YYYY-MM-DD from the path when it carries one, else the delivery clock. */
export function blogStateDateFor(artifactPath: string, fallbackMs: number): string {
  const match = artifactPath.match(/(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : new Date(fallbackMs).toISOString().slice(0, 10);
}

/** How many bytes of one state file we keep. Past any real one. */
export const BLOG_STATE_MAX_CHARS = 400_000;

/* ─────────────────── the deliverable envelope the reader reads ───────────── */

export const BLOG_ENVELOPE_KIND = "blog-post-v2" as const;

/**
 * What the delivery handler stores as `asset.content` for a blog v2 article.
 *
 * WHY AN ENVELOPE, and it is the same reasoning as the newsletter's. The
 * framework's D40+D56 contract is FIVE files per article — the standalone branded
 * page, the body fragment that pastes into a CMS, the markdown, `about.txt` and
 * `publish-notes.txt` — and the reader is handed a single string. The
 * largest-text-file heuristic would pick the standalone HTML and call it the
 * deliverable, losing the fragment the client actually pastes.
 *
 * `publishNotes` matters more here than any single field of the newsletter's
 * envelope. It carries the meta title, description, slug, canonical URL, keywords
 * and structured data as copy-pasteable text, and the framework records it as a
 * REGRESSION FIX: the first draft's four files carried none of that as data, so a
 * client publishing on WordPress — asked for all of it by their CMS — would have
 * had to view-source the page to recover it.
 */
export interface BlogV2Envelope {
  kind: typeof BLOG_ENVELOPE_KIND;
  /** The post number as the run named it, e.g. "004". */
  postNumber?: string;
  /** The article's slug, from the file names. */
  slug?: string;
  /** The standalone branded page. */
  html?: string;
  /** The fragment that pastes into any CMS — no head, no styles, no cover. */
  bodyHtml?: string;
  /** The markdown. */
  markdown?: string;
  /** The two lines the portal shows, leading with anything to confirm first. */
  about?: string;
  /** Meta title, description, slug, canonical, keywords, structured data. */
  publishNotes?: string;
}

/** Is this asset content a blog envelope? Cheap enough to run before parsing. */
export function isBlogEnvelope(content: string): boolean {
  const head = content.trimStart().slice(0, 200);
  return head.startsWith("{") && head.includes(BLOG_ENVELOPE_KIND);
}

/** One client-facing text file from the run, as the delivery handler has it. */
export interface BlogClientFile {
  path: string;
  text: string;
}

/**
 * Assemble the client-facing files into the envelope.
 *
 * The `-body.html` test runs BEFORE the bare `.html` test, for the same reason
 * the newsletter checks `-light.html` first: `<slug>-body.html` also ends in
 * `.html`, so testing for the standalone page first would claim both and the
 * second would overwrite the first — handing the client the fragment as their
 * whole page, or the page as their fragment.
 */
export function buildBlogEnvelope(files: readonly BlogClientFile[]): BlogV2Envelope {
  const env: BlogV2Envelope = { kind: BLOG_ENVELOPE_KIND };
  for (const file of files) {
    const base = (file.path.split("\\").join("/").split("/").pop() ?? "").toLowerCase();
    if (!file.text.trim()) continue;
    if (base === "about.txt") env.about = file.text;
    else if (base === "publish-notes.txt") env.publishNotes = file.text;
    else if (base.endsWith("-body.html")) env.bodyHtml = file.text;
    else if (base.endsWith(".html")) {
      env.html = file.text;
      if (!env.slug) env.slug = base.slice(0, -".html".length);
    } else if (base.endsWith(".md")) {
      env.markdown = file.text;
      if (!env.slug) env.slug = base.slice(0, -".md".length);
    }
    // `client/01-<slug>/` — the folder is where the post number lives, since the
    // file names carry the slug and not the number.
    const num = file.path.split("\\").join("/").match(/\/(\d{2,})-[^/]+\/[^/]+$/)?.[1];
    if (num && !env.postNumber) env.postNumber = num;
  }
  return env;
}

/** Does this envelope carry anything worth storing as a deliverable? */
export function blogEnvelopeHasContent(env: BlogV2Envelope): boolean {
  return Boolean(env.html || env.bodyHtml || env.markdown || env.about || env.publishNotes);
}
