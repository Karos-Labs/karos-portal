import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * THE RUN CARD'S TWO NEW INPUTS, AND THE PROMISES THEY MAKE.
 *
 * A run-time direction and a media attachment are only worth adding if the
 * engine actually reads them. Two of the failures this file exists to catch are
 * silent by nature:
 *
 *  1. An attach control on an agent whose workflow never looks at
 *     `mediaAssets`. The file uploads, costs storage, and is ignored — nothing
 *     errors, and the client concludes their photo was rejected on quality.
 *  2. Slide-order wording on `tiktok-agent`, which reads the FIRST source asset
 *     and ignores the rest. "slide 2" beside a file that will never be used is
 *     a worse lie than no label at all.
 *
 * Asked of the RENDER rather than the source text: `acceptsMedia` being present
 * in the file proves nothing about which cards it lets through.
 */

vi.mock("server-only", () => ({}));
vi.mock("@/lib/actions/control-plane-actions", () => ({
  dispatchControlPlaneAgentAction: vi.fn(),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));

import { EngineAgentCard } from "@/components/agents/engine-agent-card";
import type { EngineAgentCardModel } from "@/lib/agent-engine/catalog-union";

function card(slug: string, overrides: Partial<EngineAgentCardModel> = {}): EngineAgentCardModel {
  return {
    slug,
    name: slug,
    description: null,
    status: "active",
    model: null,
    tags: [],
    icon: "Sparkles",
    category: null,
    creditCost: null,
    stageCount: 9,
    ...overrides,
  };
}

function markup(slug: string, overrides?: Partial<EngineAgentCardModel>): string {
  return renderToStaticMarkup(
    <EngineAgentCard agent={card(slug, overrides)} clients={[{ id: "c1", name: "Acme" }]} />,
  );
}

/** The engine workflows that actually read `mediaAssets` off the run input. */
const READS_MEDIA_ASSETS = ["instagram-agent", "tiktok-agent"];

/** Agents an attach control would be a lie on — including the near-misses. */
const DOES_NOT = [
  "blog-agent",
  "linkedin-agent",
  "x-agent",
  "newsletter-agent",
  "reddit-agent",
  // A video agent, and still no: it takes its source from the repo-side
  // `brandedShortsIntake`, never from a run attachment.
  "branded-shorts-agent",
  "landing-builder-agent",
  "intel-report-agent",
];

describe("the run card only offers what the workflow behind it reads", () => {
  it.each(READS_MEDIA_ASSETS)("offers the attach control on %s", (slug) => {
    expect(markup(slug)).toContain("type=\"file\"");
  });

  it.each(DOES_NOT)("offers no attach control on %s", (slug) => {
    expect(markup(slug)).not.toContain("type=\"file\"");
  });

  it("labels instagram attachments by slide, because upload order decides placement", () => {
    const html = markup("instagram-agent");
    expect(html).toContain("Attach images");
    // The whole affordance: someone picking which photo goes where has to see
    // the order they are creating.
    expect(html).toContain("first file on slide 1");
    // Images only — a slide is a picture, and the carousel renderer takes no video.
    expect(html).toContain("image/jpeg");
    expect(html).not.toContain("video/mp4");
  });

  it("asks tiktok for one video and says nothing about slides", () => {
    const html = markup("tiktok-agent");
    expect(html).toContain("Attach source video");
    expect(html).toContain("video/mp4");
    // No slide wording, and no `multiple`: the workflow reads the first source
    // asset and ignores every other, so offering more collects files to discard.
    expect(html).not.toContain("slide 1");
    expect(html).not.toContain("multiple");
  });

  it("offers the run direction on every agent in the catalog", () => {
    // No exceptions left. The two setup agents were the only cards whose
    // workflow had no model step to honour a sentence, and they stopped being
    // products when their setup routine moved inside linkedin-agent and
    // reddit-agent as the `00-channel-setup` pre-flight.
    for (const slug of [...READS_MEDIA_ASSETS, ...DOES_NOT, "campaign-orchestrator", "reputation-agent", "seo-geo-agent"]) {
      const html = markup(slug);
      expect(html, slug).toContain(`id="direction-${slug}"`);
      expect(html, slug).toContain("Direction for this run");
    }
  });

  /**
   * The brand logos are filled glyphs; every lucide icon is a stroked outline
   * with `fill="none"`. Asserting on `<svg` would pass for both, so it proves
   * nothing — this distinguishes them.
   */
  function isBrandLogo(html: string): boolean {
    const first = /<svg[^>]*>/.exec(html.slice(html.indexOf("<svg")))?.[0] ?? "";
    return first.includes('fill="currentColor"');
  }

  it("gives a platform agent its own logo and a generic one its control-plane icon", () => {
    // lucide has no brand glyphs, so a channel agent otherwise renders as a
    // stand-in (a camera for Instagram) — readable, but a catalog this size is
    // scanned by logo.
    expect(isBrandLogo(markup("instagram-agent"))).toBe(true);
    expect(isBrandLogo(markup("x-agent"))).toBe(true);
    // Prefix-matched rather than slug-exact, which is what lets a channel's
    // variants share its logo without an entry each.
    expect(isBrandLogo(markup("linkedin-agent"))).toBe(true);
    expect(isBrandLogo(markup("reddit-agent"))).toBe(true);
    // An agent with no single channel keeps whatever the control plane named.
    expect(isBrandLogo(markup("blog-agent", { icon: "FileText" }))).toBe(false);
    expect(isBrandLogo(markup("intel-report-agent"))).toBe(false);
  });
});
