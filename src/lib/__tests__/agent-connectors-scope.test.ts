import path from "path";
import { describe, expect, it } from "vitest";
import { readSource } from "./source-scan";
import { socialPlatformsFor } from "@/components/agent-identity";

/**
 * "Connected accounts" on an agent's page lists THAT AGENT'S platform, or
 * nothing at all.
 *
 * PORTAL FEEDBACK ROUND 2, 2026-09. A previous pass scoped the card to the six
 * INTAKE FAMILIES (X, LinkedIn, Reddit, newsletter, blog, reputation) and let a
 * null family keep the full list — which meant the Instagram Agent, and every
 * custom agent, printed Google Analytics under "Connected accounts". That is
 * the exact defect the family scoping was written to fix, surviving on the
 * agents it did not cover.
 *
 * The fallback is now the agent's own identity, resolved by the SAME detector
 * that draws its logo everywhere else (agent-identity.tsx's
 * `socialPlatformsFor`, over `${key} ${name}`), so the mark in the header and
 * the connector in the sidebar cannot disagree about which platform the page is
 * about. An agent with neither a family nor a detectable platform renders no
 * section — not an empty one, and not the "Manage connections" link either.
 */

const page = readSource(
  path.resolve(__dirname, "../..", "app/(app)/clients/[id]/agents/[agentId]/page.tsx"),
);

/** Source without comments: the file's own notes name the words under test. */
const body = page.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("the agent page's connector scoping", () => {
  it("never falls back to the client's full connection list", () => {
    // The regression, spelled exactly as it used to read.
    expect(body).not.toMatch(/familyPlatforms\s*\?[\s\S]{0,200}:\s*connections\s*;/);
    expect(body).toContain("const scopedConnections");
  });

  it("resolves an agent with no intake family from its own identity", () => {
    expect(body).toContain("socialPlatformsFor(`${agent.key} ${agent.name}`)");
    expect(body).toContain("SOCIAL_TO_INTEGRATION_IDS");
  });

  it("maps every social platform onto integration-registry ids, Facebook to none", () => {
    const table = body.slice(
      body.indexOf("SOCIAL_TO_INTEGRATION_IDS: Record"),
      body.indexOf("const identityPlatformIds"),
    );
    expect(table).toContain('instagram: ["instagram"]');
    // The registry calls X "twitter" and carries a second LinkedIn connector.
    expect(table).toContain('x: ["twitter"]');
    expect(table).toContain('linkedin: ["linkedin", "linkedin_community"]');
    expect(table).toContain('tiktok: ["tiktok"]');
    expect(table).toContain('reddit: ["reddit"]');
    expect(table).toContain('youtube: ["youtube"]');
    // Retired as a Karos integration: nothing to link to, so nothing is listed.
    expect(table).toContain("facebook: []");
    // No analytics/auth connector may ever be named on an agent page.
    expect(table).not.toContain("google");
  });

  it("hides the whole section when the page cannot name a platform", () => {
    expect(body).toContain("{familyPlatforms && (");
    // "Manage connections" lives INSIDE that guard — the link is part of the
    // section, not a separate always-on row.
    const guarded = body.slice(body.indexOf("{familyPlatforms && ("));
    expect(guarded).toContain("Manage connections");
  });

  it("agrees with the detector every other surface brands the agent with", () => {
    expect(socialPlatformsFor("instagram_daily Instagram Agent")).toEqual(["instagram"]);
    expect(socialPlatformsFor("x_agent X Agent")).toEqual(["x"]);
    // A custom agent naming no platform at all: nothing detected, so the page
    // shows no connectors section.
    expect(socialPlatformsFor("weekly_digest Weekly Digest")).toEqual([]);
  });
});
