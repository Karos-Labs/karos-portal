import "server-only";

/**
 * Live brand evidence that a plain `fetch` cannot reach: a RENDERED screenshot
 * of the site, and the client's Instagram mark and grid.
 *
 * ## Why this exists
 *
 * `branding-site-palette.ts` reads what a site DECLARES, and that is not the
 * same question as what it PAINTS. karoslabs.com declares `--primary: #2f6bff`
 * and `--ring: #2f6bff` in `:root`. Nothing on the page is blue — a rendered
 * sweep finds that value on zero elements — but no amount of reading CSS can
 * establish that, because the CSS really does say it. It is a leftover scaffold
 * default, and it is the whole reason that client's brand guidelines said
 * "blue". A screenshot settles what CSS cannot.
 *
 * Instagram is the second source, and unreachable by fetch for a different
 * reason: logged out, instagram.com serves a JavaScript shell — 200 OK, ~620KB,
 * no `og:image`, no profile data, no CDN URLs at all.
 *
 * ## Shape of the answers
 *
 * The screenshot comes back as PNG, which `branding-image-palette.ts` decodes
 * to real per-area hexes with no dependency. Instagram images come back as
 * their original JPEG and are handed to the VISION model rather than decoded:
 * screenshotting an image URL letterboxes it against browser chrome, which
 * would contaminate an area count with a colour the brand never chose.
 *
 * ## Failure posture
 *
 * Every function returns null/empty instead of throwing, and an unset
 * `SCRAPPYCOCO_API_KEY` simply means no evidence from here. Branding is a
 * non-fatal side pipeline — `applyBrandingForClient`'s call site catches and
 * logs — and a scraper outage must cost a Regenerate nothing beyond the
 * sharpness of its palette.
 */

const DEFAULT_BASE_URL = "https://api.scrappycoco.ai/api/v1";
/** Undocumented but verified: returns records inline instead of the async job queue. */
const EXECUTE_PATH = "/scrapers/execute";

/** A screenshot render is browser work; it measured ~9s live. */
const SCREENSHOT_TIMEOUT_MS = 45_000;
/** Profile lookups measured ~7s; asset fetches ~2s. */
const PROFILE_TIMEOUT_MS = 30_000;
const ASSET_TIMEOUT_MS = 20_000;

/** How many recent posts to show the model. Enough to read a grid's palette; not so many that a Regenerate crawls. */
const MAX_POST_IMAGES = 4;
/** Anthropic rejects oversized image parts, and a 5MB brand photo teaches nothing a 1MB one does not. */
const MAX_IMAGE_BYTES = 3_000_000;

/** An image to hand to the vision model. */
export interface BrandImage {
  bytes: Uint8Array;
  mimeType: string;
  /** Where it came from, for the prompt and the logs. */
  label: string;
}

export interface InstagramBrandAssets {
  /** The account's avatar — on Instagram, this is the brand mark. */
  profileImage: BrandImage | null;
  /** Recent grid images, most recent first. */
  postImages: BrandImage[];
  handle: string;
}

export function isScrappycocoConfigured(): boolean {
  return Boolean(process.env.SCRAPPYCOCO_API_KEY);
}

/** Normalises "@karoslabs", a full profile URL, or a bare handle to the username. */
export function instagramUsername(raw: string | undefined | null): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const fromUrl = /instagram\.com\/([^/?#]+)/i.exec(trimmed)?.[1];
  const handle = (fromUrl ?? trimmed).replace(/^@/, "").replace(/\/+$/, "");
  return /^[A-Za-z0-9._]{1,100}$/.test(handle) ? handle : null;
}

interface ExecuteResult {
  records?: Array<{ outputs?: Record<string, unknown> } & Record<string, unknown>>;
}

/**
 * One synchronous capability call.
 *
 * `Idempotency-Key` is required on every billable POST. A fresh key per call is
 * deliberate: reusing one across different input is what makes an idempotent
 * API return somebody else's answer.
 */
async function execute(
  source: string,
  capability: string,
  input: Record<string, unknown>,
  timeoutMs: number,
): Promise<ExecuteResult | null> {
  const apiKey = process.env.SCRAPPYCOCO_API_KEY;
  if (!apiKey) return null;
  const baseUrl = process.env.SCRAPPYCOCO_BASE_URL ?? DEFAULT_BASE_URL;

  try {
    const response = await fetch(`${baseUrl}${EXECUTE_PATH}`, {
      method: "POST",
      headers: {
        "X-API-Key": apiKey,
        "content-type": "application/json",
        accept: "application/json",
        "Idempotency-Key": `karoscmo-branding-${capability}-${crypto.randomUUID()}`,
      },
      body: JSON.stringify({ source, capability, input }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      console.warn(`[branding] scrappycoco ${source}.${capability} returned ${response.status}`);
      return null;
    }
    return (await response.json()) as ExecuteResult;
  } catch (err) {
    console.warn(`[branding] scrappycoco ${source}.${capability} failed: ${(err as Error).message}`);
    return null;
  }
}

/** A base64 payload as delivered by `screenshot` and `fetch_asset`. */
interface Payload {
  mime_type?: unknown;
  encoding?: unknown;
  data?: unknown;
  bytes?: unknown;
}

function decodePayload(payload: unknown, label: string): BrandImage | null {
  if (typeof payload !== "object" || payload === null) return null;
  const { mime_type: mime, encoding, data } = payload as Payload;
  if (encoding !== "base64" || typeof data !== "string" || typeof mime !== "string") return null;
  try {
    const bytes = Buffer.from(data, "base64");
    if (bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES) return null;
    return { bytes, mimeType: mime, label };
  } catch {
    return null;
  }
}

/**
 * A rendered PNG of the site's homepage, or null.
 *
 * This is the only source in the branding pipeline that reports what a visitor
 * actually SEES rather than what the source code claims.
 */
export async function fetchSiteScreenshot(domain: string, fullPage = true): Promise<BrandImage | null> {
  const url = `https://${domain.replace(/^https?:\/\//, "").replace(/\/+$/, "")}`;
  // `full_page`, not the viewport. A viewport render answers "is this colour
  // above the fold", which is a different and much weaker question than "does
  // this site use this colour" — deel.com/the-pitch-by-deel paints its yellow
  // and its purple further down, and a first-screen render reported both as
  // never painted.
  const result = await execute("web", "screenshot", { url, full_page: fullPage }, SCREENSHOT_TIMEOUT_MS);
  const shot = result?.records?.[0]?.outputs?.["screenshot"];
  return decodePayload(shot, fullPage ? "rendered homepage (full page)" : "rendered homepage (first screen)");
}

/** Raw bytes for one asset URL, in its original format. */
async function fetchAsset(url: string, label: string): Promise<BrandImage | null> {
  const result = await execute("web", "fetch_asset", { url }, ASSET_TIMEOUT_MS);
  const asset = result?.records?.[0]?.outputs?.["asset"];
  return decodePayload(asset, label);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

/**
 * The client's Instagram mark and recent grid, or nulls.
 *
 * Only the account's own public profile is read, and only the handle the client
 * themselves recorded in `socialLinks.instagram`. Nothing here searches for an
 * account, follows one, or reads anything a logged-out visitor could not.
 */
export async function fetchInstagramBrandAssets(rawHandle: string | undefined | null): Promise<InstagramBrandAssets | null> {
  const handle = instagramUsername(rawHandle);
  if (!handle) return null;

  const result = await execute("instagram", "profile", { username: handle }, PROFILE_TIMEOUT_MS);
  const json = result?.records?.[0]?.outputs?.["json"];
  if (typeof json !== "object" || json === null) return null;
  const profile = json as Record<string, unknown>;

  const picUrl = asString(profile["profile_pic_url_hd"]) ?? asString(profile["profile_pic_url"]);
  const timeline = profile["edge_owner_to_timeline_media"];
  const edges = (typeof timeline === "object" && timeline !== null ? (timeline as Record<string, unknown>)["edges"] : undefined) ?? [];
  const postUrls = (Array.isArray(edges) ? edges : [])
    .map((edge) => {
      const node = (edge as Record<string, unknown> | null)?.["node"];
      return typeof node === "object" && node !== null ? asString((node as Record<string, unknown>)["display_url"]) : undefined;
    })
    .filter((url): url is string => Boolean(url))
    .slice(0, MAX_POST_IMAGES);

  const [profileImage, ...postImages] = await Promise.all([
    picUrl ? fetchAsset(picUrl, "Instagram profile picture") : Promise.resolve(null),
    ...postUrls.map((url, i) => fetchAsset(url, `Instagram post ${i + 1}`)),
  ]);

  return {
    handle,
    profileImage: profileImage ?? null,
    postImages: postImages.filter((image): image is BrandImage => image !== null),
  };
}
