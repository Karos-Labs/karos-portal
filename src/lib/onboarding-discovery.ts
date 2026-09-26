import "server-only";

import { generateObject } from "ai";
import { z } from "zod";
import type { SocialPlatform } from "@/components/agent-identity";
import { aiFor, usageFor } from "@/lib/ai/provider";
import { isScrappycocoConfigured, scrappycocoSearchUrls } from "@/lib/branding-scrappycoco";
import { HANDLE_PLATFORMS, emptyDiscovery, type ChatLang, type Discovery } from "@/lib/onboarding-chat";
import {
  extractSiteMeta,
  extractSocialProfiles,
  publicWebsiteUrl,
  socialProfileFromUrl,
  type SiteMeta,
} from "@/lib/onboarding-discovery-parse";
import { logger } from "@/services/logger";

/**
 * THE ONBOARDING WEBSITE SCAN (2026-09-26).
 *
 * The chat asks for a website and answers, a few seconds later, with the
 * company's accounts, brand and competitors for the client to confirm. Every
 * answer is a SUGGESTION the client confirms or edits in the next card, so
 * this module prefers "found nothing" to a guess: an empty field makes the
 * chat ask, a wrong one makes the client correct us on their first screen.
 *
 * Sources, cheapest and most reliable first:
 *   1. The site's own HTML: header/footer links to its profiles (free, and the
 *      brand's own statement of which accounts are theirs), the logo, the
 *      page text.
 *   2. ScrappyCoco web search, one call per network the site did not link
 *      (~$0.007 each; owner ruling 2026-09-26: "costs very little"). A result
 *      only counts when its handle carries the brand's name.
 *   3. The colour the site declares for itself (`<meta name="theme-color">`).
 *      NOT `observeSitePalette`: on stripe.com it spends ~100s of synchronous
 *      CPU on the stylesheets (measured 2026-09-26), which freezes the whole
 *      server process and no deadline can cut. The branding pipeline that runs
 *      after Finish computes the real palette in the background.
 *   4. One small model call over the page text: category, a one-line
 *      description, competitors, and three sample posts in the chat language.
 *
 * NEVER THROWS. Each source fails on its own into an empty field.
 */

const FETCH_TIMEOUT_MS = 10_000;
const MAX_HTML_BYTES = 1_500_000;
const SEARCH_TIMEOUT_MS = 14_000;
const SEARCH_CONCURRENCY = 3;
/**
 * The most any one source may take once the page is read. The client is
 * watching a typing indicator: stripe.com's palette sweep alone ran past three
 * minutes before this cap (2026-09-26), and an answer that late is no answer.
 * A source past its deadline counts as "found nothing".
 */
const SOURCE_DEADLINE_MS = 30_000;

function withDeadline<T>(work: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    work.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      () => {
        clearTimeout(timer);
        resolve(fallback);
      },
    );
  });
}

const PLATFORM_NAME: Record<SocialPlatform, string> = {
  instagram: "Instagram",
  linkedin: "LinkedIn",
  facebook: "Facebook",
  x: "X Twitter",
  tiktok: "TikTok",
  youtube: "YouTube",
  reddit: "Reddit",
};

const PLATFORM_DOMAINS: Partial<Record<SocialPlatform, string[]>> = {
  instagram: ["instagram.com"],
  linkedin: ["linkedin.com"],
  facebook: ["facebook.com"],
  x: ["x.com", "twitter.com"],
  tiktok: ["tiktok.com"],
  youtube: ["youtube.com"],
};

async function fetchHtml(url: URL): Promise<{ html: string; finalUrl: string } | null> {
  try {
    const res = await fetch(url, {
      headers: {
        "user-agent": "Mozilla/5.0 (compatible; KarosCMO-Onboarding/1.0; +https://karoslabs.com)",
        accept: "text/html,application/xhtml+xml",
      },
      redirect: "follow",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    // A redirect may leave the public web; the final address is held to the same rule.
    if (!res.ok || !publicWebsiteUrl(res.url || url.toString())) return null;
    if (!/html/i.test(res.headers.get("content-type") ?? "text/html")) return null;
    const buf = await res.arrayBuffer();
    return { html: new TextDecoder().decode(buf.slice(0, MAX_HTML_BYTES)), finalUrl: res.url || url.toString() };
  } catch {
    return null;
  }
}

/** Lowercase letters and digits only - how a handle and a company name are compared. */
function squash(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Does a found handle carry the brand's name? Searched results are only
 * trusted when it does: "acme" matches `acmehq` and `company/acme-inc`, not
 * `bestmarketingtips`.
 */
export function handleMatchesBrand(value: string, companyName: string, host: string): boolean {
  const h = squash(value.split("/").pop() ?? value);
  if (!h) return false;
  const keys = [squash(host.replace(/^www\./, "").split(".")[0] ?? ""), squash(companyName)].filter((k) => k.length >= 3);
  return keys.some((k) => h.includes(k) || (h.length >= 4 && k.includes(h)));
}

async function searchHandle(platform: SocialPlatform, companyName: string, host: string): Promise<string | null> {
  const domains = PLATFORM_DOMAINS[platform];
  if (!domains) return null;
  const urls = await scrappycocoSearchUrls(`${companyName} ${PLATFORM_NAME[platform]}`, {
    includeDomains: domains,
    limit: 5,
    timeoutMs: SEARCH_TIMEOUT_MS,
  });
  for (const u of urls ?? []) {
    const profile = socialProfileFromUrl(u);
    if (profile?.platform === platform && handleMatchesBrand(profile.value, companyName, host)) return profile.value;
  }
  return null;
}

async function findHandles(
  fromSite: Partial<Record<SocialPlatform, string>>,
  companyName: string,
  host: string,
): Promise<Discovery["handles"]> {
  const handles: Discovery["handles"] = {};
  const missing: SocialPlatform[] = [];
  for (const p of HANDLE_PLATFORMS) {
    if (fromSite[p]) handles[p] = fromSite[p];
    else missing.push(p);
  }
  if (missing.length && isScrappycocoConfigured() && companyName.trim()) {
    // Three at a time: six at once drew a 429 from ScrappyCoco (wix.com, 2026-09-26).
    for (let i = 0; i < missing.length; i += SEARCH_CONCURRENCY) {
      const batch = missing.slice(i, i + SEARCH_CONCURRENCY);
      const found = await Promise.all(batch.map((p) => searchHandle(p, companyName, host).catch(() => null)));
      batch.forEach((p, j) => {
        handles[p] = found[j] ?? null;
      });
    }
  } else {
    for (const p of missing) handles[p] = null;
  }
  return handles;
}

const DescribeSchema = z.object({
  category: z.string().describe("The company's industry or niche in 2-5 words, e.g. 'B2B payroll software'."),
  description: z.string().describe("One sentence saying what the company does and for whom."),
  competitors: z.array(z.string()).max(5).describe("Up to 5 real, named direct competitors. Empty if unsure."),
  posts: z
    .object({
      bold: z.string(),
      warm: z.string(),
      expert: z.string(),
    })
    .describe("Three short social posts about this company, one per tone."),
});

async function describe(
  meta: SiteMeta,
  input: { companyName: string; website: string; language: ChatLang; clientId: string | null },
): Promise<Pick<Discovery, "category" | "description" | "competitors" | "voiceSamples">> {
  const empty = { category: "", description: "", competitors: [], voiceSamples: [] };
  const usageMeta = {
    clientId: input.clientId,
    agentId: null,
    agentName: "Onboarding · Website scan",
    ...usageFor("onboarding.discover"),
    operation: "onboarding_discovery",
  };
  const language = input.language === "he" ? "Hebrew" : "English";
  try {
    const { object, usage } = await generateObject({
      model: aiFor("onboarding.discover").model,
      schema: DescribeSchema,
      prompt:
        `A new client is onboarding. Company: "${input.companyName}". Website: ${input.website}.\n` +
        `Page title: ${meta.title || "(none)"}\nMeta description: ${meta.description || "(none)"}\n` +
        `Page text (truncated):\n${meta.text || "(the page could not be read)"}\n\n` +
        `Write category, description and posts in ${language}. Company and competitor names stay as they are spelled.\n` +
        `Posts: one to three sentences each, about what THIS company actually does according to the page, ` +
        `no hashtags, no emoji. bold = direct and confident; warm = human and empathetic; expert = evidence-led and precise.\n` +
        `Competitors: only companies you are confident compete directly; never invent names.`,
    });
    logger.logUsage({ ...usageMeta, inputTokens: usage.inputTokens ?? 0, outputTokens: usage.outputTokens ?? 0 });
    return {
      category: object.category.trim().slice(0, 80),
      description: object.description.trim().slice(0, 400),
      competitors: object.competitors.map((c) => c.trim()).filter(Boolean).slice(0, 5),
      voiceSamples: (["bold", "warm", "expert"] as const).map((id) => ({ id, post: object.posts[id].trim().slice(0, 600) })),
    };
  } catch (err) {
    logger.logGenerationFailure(usageMeta, err);
    return empty;
  }
}

export async function discoverOnboardingProfile(input: {
  website: string;
  companyName: string;
  language: ChatLang;
  /** For cost attribution; null in an admin simulation. */
  clientId: string | null;
}): Promise<Discovery> {
  const url = publicWebsiteUrl(input.website);
  if (!url) return emptyDiscovery();
  const page = await fetchHtml(url);
  const brand = input.companyName.trim() || url.hostname.replace(/^www\./, "").split(".")[0]!;
  const meta = page ? extractSiteMeta(page.html, page.finalUrl, brand) : extractSiteMeta("", url.toString(), brand);
  const companyName = input.companyName.trim() || meta.siteName || meta.title.split(/[|\-–·]/)[0]!.trim();
  const fromSite = page ? extractSocialProfiles(page.html) : {};

  const [handles, described] = await Promise.all([
    withDeadline(
      findHandles(fromSite, companyName, url.hostname),
      SOURCE_DEADLINE_MS,
      // Past the deadline the site's own links still stand; only the searches are lost.
      Object.fromEntries(HANDLE_PLATFORMS.map((p) => [p, fromSite[p] ?? null])) as Discovery["handles"],
    ),
    withDeadline(describe(meta, { ...input, companyName }), SOURCE_DEADLINE_MS, {
      category: "",
      description: "",
      competitors: [],
      voiceSamples: [],
    }),
  ]);

  return {
    handles,
    colors: meta.themeColor ? [meta.themeColor] : [],
    logoUrl: meta.logoUrl,
    category: described.category,
    // The site's own sentence about itself beats the model's paraphrase of it.
    description: (meta.description.length >= 20 && meta.description.length <= 300 && input.language === "en"
      ? meta.description
      : described.description
    ).trim(),
    competitors: described.competitors,
    voiceSamples: described.voiceSamples,
  };
}
