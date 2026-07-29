import { describe, expect, it } from "vitest";
import { AGENT_BLURB_FALLBACKS, clientAgentBlurb } from "@/lib/agent-blurbs";

/**
 * CD-G2 — what a client reads about an agent.
 *
 * The defect these lock down: the roster fell back to `customAgent.description`,
 * the lab repo's own manifest line, so clients read "Master content-social
 * skill. Given a brand's guidelines + any past competitor research…" on their
 * own agent cards.
 */

const MANIFEST =
  "Master content-social skill. Given a brand's guidelines + any past competitor research, it does a deep competitor + industry-trend dive.";

describe("clientAgentBlurb", () => {
  it("prefers curated copy over everything else", () => {
    expect(
      clientAgentBlurb({
        key: "karos-x-agent",
        name: "X Agent",
        clientBlurb: "  Your daily post on X.  ",
      }),
    ).toBe("Your daily post on X.");
  });

  it("never falls back to the lab manifest description", () => {
    // The signature has no description parameter at all — the manifest is out
    // of the chain by construction, not by a branch someone can re-add.
    const blurb = clientAgentBlurb({
      key: "karos-instagram-tiktok-content-agent",
      name: "Instagram + TikTok Content Agent",
      clientBlurb: "",
    });
    expect(blurb).not.toBe(MANIFEST);
    expect(blurb).not.toMatch(/skill|manifest|sub-agent|pipeline/i);
  });

  it("matches the combined content engine before either single-platform pattern", () => {
    const blurb = clientAgentBlurb({
      key: "karos-instagram-tiktok-content-agent",
      name: "Instagram + TikTok Content Agent",
    });
    expect(blurb).toContain("Instagram reach");
    // Albert's own example line is the pattern every blurb follows.
    expect(blurb).toContain("daily post");
  });

  it("gives the X agent and each LinkedIn shape its own line", () => {
    const x = clientAgentBlurb({ key: "karos-x-agent", name: "X Agent" });
    const company = clientAgentBlurb({
      key: "karos-linkedin-company-acme",
      name: "LinkedIn Company Agent",
    });
    const seats = clientAgentBlurb({ key: "karos-linkedin-agent", name: "LinkedIn Agent" });

    expect(x).toMatch(/on X/);
    expect(company).toMatch(/company page/);
    expect(seats).toMatch(/team/);
    expect(new Set([x, company, seats]).size).toBe(3);
  });

  it("resolves managed products by task type", () => {
    expect(clientAgentBlurb({ key: "", name: "Newsletter issue", productType: "newsletter_issue" }))
      .toMatch(/newsletter/i);
    expect(clientAgentBlurb({ key: "", name: "Blog article", productType: "blog_article" }))
      .toMatch(/articles/i);
  });

  it("falls back to a line that promises nothing specific for an unknown agent", () => {
    const blurb = clientAgentBlurb({ key: "karos-mystery-agent", name: "Mystery Agent" });
    expect(blurb).toContain("Mystery Agent");
    expect(blurb).toMatch(/reviews/);
  });
});

describe("the fallback copy itself obeys the CD-G2 rules", () => {
  const all = [
    ...AGENT_BLURB_FALLBACKS.BLURBS.map((b) => b.blurb),
    ...Object.values(AGENT_BLURB_FALLBACKS.PRODUCT_BLURBS),
  ];

  it("is one short sentence each", () => {
    for (const blurb of all) {
      expect(blurb.length).toBeLessThanOrEqual(160);
      // One sentence: a single terminal period, at the end.
      expect(blurb.trimEnd().endsWith(".")).toBe(true);
      expect(blurb.slice(0, -1)).not.toContain(". ");
    }
  });

  it("carries no lab or marketing jargon", () => {
    // "skill" and "sub-skill" are the manifest's vocabulary; the rest are the
    // buzzwords Albert rejected by name.
    const banned =
      /\bskill\b|sub-skill|\bpipeline\b|\bleverage\b|\bsynerg|\bseamless\b|\bcutting.edge\b|\bAI-powered\b|\bempower\b|\bunlock\b|\bsupercharge\b/i;
    for (const blurb of all) {
      expect(blurb).not.toMatch(banned);
    }
  });

  it("speaks to the buyer — every line addresses 'you' or 'your'", () => {
    for (const blurb of all) {
      expect(blurb).toMatch(/\byou\b|\byour\b/i);
    }
  });
});
