import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { AgentIdentity, AgentMark, SocialPlatformMark } from "@/components/agent-identity";

/**
 * Every agent in its own colour, wherever its icon is drawn (Albert,
 * 2026-09-10: "always have the agents be of their color"). The marks used to be
 * light grey on every surface, so a roster of six agents read as six grey
 * glyphs.
 */
describe("an agent's mark", () => {
  it("wears its platform's colour, with the white showing through the logo", () => {
    const reddit = renderToStaticMarkup(<SocialPlatformMark platform="reddit" />);
    expect(reddit).toContain('fill="#FF4500"');
    expect(reddit).toContain('fill="#fff"');
    const linkedin = renderToStaticMarkup(<SocialPlatformMark platform="linkedin" />);
    expect(linkedin).toContain('fill="#0A66C2"');
    expect(linkedin).toContain('fill="#fff"');
  });

  it("draws X in the ink, not in the caller's grey", () => {
    const x = renderToStaticMarkup(<SocialPlatformMark platform="x" className="text-muted-2" />);
    expect(x).toContain('fill="currentColor"');
    expect(x).toContain("color:var(--foreground)");
  });

  it("stays in the ink on a platform-coloured button", () => {
    const onButton = renderToStaticMarkup(<SocialPlatformMark platform="reddit" tone="ink" />);
    expect(onButton).toContain('fill="currentColor"');
    expect(onButton).not.toContain("#FF4500");
    expect(onButton).not.toContain('fill="#fff"');
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
