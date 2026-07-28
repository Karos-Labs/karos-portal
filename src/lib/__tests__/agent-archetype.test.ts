import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { agentArchetype } from "@/lib/agent-archetype";
import { AGENT_BLURB_FALLBACKS } from "@/lib/agent-blurbs";

/**
 * CD-I1: which page shape an agent opens onto.
 *
 * Two things are proven here, and the second is the one that matters. The
 * RULES — that Reddit is the daily finder, that a shorts editor is a clip
 * maker, that anything unrecognised falls back to today's shape. And the
 * WIRING — that the detail route actually asks this function, because a
 * resolver nobody calls is a rule that is not enforced anywhere.
 */

const REPO = path.resolve(__dirname, "../..", "..");
const source = (rel: string) => readFileSync(path.join(REPO, rel), "utf8");

describe("agentArchetype", () => {
  it("routes the Reddit agent to the daily finder through the §7.3 helper", () => {
    expect(agentArchetype({ key: "karos-reddit-agent", name: "Reddit Agent" })).toBe("daily_finder");
  });

  it("does NOT route a look-alike reddit key to the finder", () => {
    // isRedditAgentIdentity is an exact-key match by design (agent-intake-gate
    // .test.ts pins that), and this resolver must inherit it rather than
    // loosening it with a regex of its own.
    expect(agentArchetype({ key: "acme-reddit-ghostwriter", name: "Reddit Ghostwriter" })).not.toBe(
      "daily_finder",
    );
  });

  it("routes the clip family to the clip maker", () => {
    const clipAgents = [
      // The two keys that actually exist in the lab today — `branded-shorts`
      // carries no `karos-` prefix, which is exactly why the family is matched
      // on the identity rather than on a key convention.
      { key: "branded-shorts", name: "Branded Shorts" },
      { key: "karos-tiktok-agent", name: "TikTok Agent" },
      { key: "karos-shorts-editor", name: "Shorts Editor" },
      { key: "karos-interview-clips", name: "Interview Clips" },
      { key: "karos-video-clipper", name: "Video Clip Maker" },
    ];
    for (const agent of clipAgents) {
      expect(agentArchetype(agent), agent.key).toBe("clip_maker");
    }
  });

  it("keeps the combined Instagram/TikTok content engine on the template calendar", () => {
    // THE ORDERING HAZARD. This key contains "tiktok" and is the flagship
    // template-calendar agent — a daily feed post with a template set. Filing
    // it as a clip maker would replace the most-looked-at agent in the portal
    // with a video gallery that can never fill.
    expect(
      agentArchetype({
        key: "karos-instagram-tiktok-content-agent",
        name: "Instagram TikTok Content Agent",
      }),
    ).toBe("template_calendar");
    // And the same shape reached by rule rather than by literal key: a
    // per-client instance carries the client's slug and would not match the
    // literal above.
    expect(
      agentArchetype({
        key: "karos-instagram-tiktok-content-agent-geektime",
        name: "Geektime Content Engine",
      }),
    ).toBe("template_calendar");
    expect(
      agentArchetype({ key: "karos-social-engine", name: "Instagram + TikTok Engine" }),
    ).toBe("template_calendar");
  });

  it("falls back to today's shape for every unclassified agent", () => {
    const unclassified = [
      { key: "karos-x-agent", name: "X Agent" },
      { key: "karos-linkedin-agent", name: "LinkedIn Agent" },
      { key: "karos-newsletter", name: "Newsletter Agent" },
      { key: "karos-seo-geo", name: "SEO Agent" },
      { key: "some-agent-nobody-classified", name: "Mystery Agent" },
      { key: "", name: "" },
    ];
    for (const agent of unclassified) {
      expect(agentArchetype(agent), agent.key).toBe("template_calendar");
    }
  });

  it("matches on the identity string, so the NAME alone can classify an agent", () => {
    // §7.3: every per-agent decision in this codebase matches `"<key> <name>"`.
    // A lab agent imported under an opaque key is classified by what it is
    // called, exactly as launchProfileFor and clientAgentBlurb do it.
    expect(agentArchetype({ key: "e17", name: "Branded Shorts" })).toBe("clip_maker");
  });

  it("shares its clip vocabulary with the blurb a client reads", () => {
    // A client who reads "Turn one of your videos into short branded cuts"
    // on the roster must not open a page about post templates. The two
    // decisions are driven by the same words on purpose; this pins that they
    // still agree for the family agent-blurbs.ts already names.
    const clipBlurbs = AGENT_BLURB_FALLBACKS.BLURBS.filter((entry) =>
      /clips|cuts/.test(entry.blurb),
    );
    expect(clipBlurbs.length).toBeGreaterThan(0);
    for (const entry of clipBlurbs) {
      const sample = entry.matches("karos-branded-shorts branded shorts")
        ? { key: "karos-branded-shorts", name: "Branded Shorts" }
        : { key: "karos-interview-clips", name: "Interview Clips" };
      expect(agentArchetype(sample)).toBe("clip_maker");
    }
  });
});

describe("wiring", () => {
  it("the agent detail route selects its surface through agentArchetype", () => {
    const route = source("src/app/(app)/clients/[id]/agents/[agentId]/page.tsx");
    expect(route).toContain("agentArchetype");
  });
});
