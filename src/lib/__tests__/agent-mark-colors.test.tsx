import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { AgentIdentity, AgentMark, ContentPlatformMark, SocialPlatformMark } from "@/components/agent-identity";

/**
 * Every agent in its own colour, wherever its icon is drawn (Albert,
 * 2026-09-10: "always have the agents be of their color"). The marks used to be
 * light grey on every surface, so a roster of six agents read as six grey
 * glyphs. A platform logo that is NOT an agent's icon keeps its surface's own
 * colour: a calendar chip tints its logo by the post's status.
 */
describe("an agent's mark", () => {
  it("wears its platform's colour, with the white showing through the logo", () => {
    const reddit = renderToStaticMarkup(<AgentMark identity="karos-reddit-runner Reddit Agent" />);
    expect(reddit).toContain('fill="#FF4500"');
    expect(reddit).toContain('fill="#fff"');
    const linkedin = renderToStaticMarkup(<AgentMark identity="karos-linkedin-writer-v2 LinkedIn Agent" />);
    expect(linkedin).toContain('fill="#0A66C2"');
    expect(linkedin).toContain('fill="#fff"');
  });

  it("draws X in the ink, not in the caller's grey", () => {
    const x = renderToStaticMarkup(<AgentMark identity="karos-x-agent-v2 X Agent" className="text-muted-2" />);
    expect(x).toContain('fill="currentColor"');
    expect(x).toContain("color:var(--foreground)");
  });

  it("gives the agents with no platform a glyph and a colour of their own", () => {
    const seo = renderToStaticMarkup(<AgentMark identity="seo-geo-agent-v2 SEO & GEO Agent" icon="Bot" />);
    expect(seo).toContain("lucide-globe");
    expect(seo).toContain("color:#4F9CF9");
    // A blog tagline that says "SEO-aware" is still the blog agent.
    const blog = renderToStaticMarkup(<AgentMark identity="karos-blog-writer-v2 SEO-aware Blog Agent" />);
    expect(blog).toContain("lucide-pen-line");
    // And an agent nobody has a colour for keeps its stored icon, in the ink.
    const other = renderToStaticMarkup(<AgentMark identity="karos-campaign-orchestrator Campaign" icon="Megaphone" />);
    expect(other).toContain("lucide-megaphone");
    expect(other).not.toContain("color:#");
  });

  it("reaches the avatar tile every roster row and agent page draws", () => {
    const tile = renderToStaticMarkup(<AgentIdentity identity="karos-reddit-runner Reddit Agent" size="sm" />);
    expect(tile).toContain('fill="#FF4500"');
  });
});

describe("a platform logo that is not an agent's icon", () => {
  it("stays in the ink, so its surface can tint it", () => {
    const logo = renderToStaticMarkup(<SocialPlatformMark platform="reddit" />);
    expect(logo).toContain('fill="currentColor"');
    expect(logo).not.toContain("#FF4500");
    expect(logo).not.toContain('fill="#fff"');
    // The calendar's post and run chips: published green, failed red.
    const chip = renderToStaticMarkup(<ContentPlatformMark platform="reddit" identity="Reddit Agent" />);
    expect(chip).toContain('fill="currentColor"');
    const family = renderToStaticMarkup(<ContentPlatformMark identity="seo-geo-agent-v2 SEO & GEO Agent" />);
    expect(family).not.toContain("color:#");
  });

  it("takes the colour where the tile is the agent's (a run card)", () => {
    const tile = renderToStaticMarkup(<ContentPlatformMark platform="reddit" identity="Reddit Agent" tone="brand" />);
    expect(tile).toContain('fill="#FF4500"');
  });
});
