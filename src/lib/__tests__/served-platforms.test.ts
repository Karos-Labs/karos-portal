import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  isServedPlatform,
  servedPlatformKeys,
  unservedPlatformSkipNote,
  withoutAgentIds,
} from "@/lib/served-platforms";
import { buildProactiveSystemAppendix } from "@/lib/ai/prompts/proactive-assistant";

/**
 * "We are not doing YouTube agents. Why is it there." (Albert, 2026-09-11, of
 * a YouTube Shorts proposal on his calendar.) A proposal may only target a
 * channel an agent of the client's posts to, and the client reads names, never
 * ids. The rule is one module; the three writers and the calendar ask it.
 */
const X = { key: "karos-x-agent-v2", name: "X Agent" };
const LINKEDIN = { key: "karos-linkedin-writer-v2", name: "LinkedIn Agent" };
const BLOG = { key: "karos-blog-writer-v2", name: "Blog Agent" };

describe("the channels an agent posts to", () => {
  it("come off the agents' identities, in integration keys", () => {
    const served = servedPlatformKeys([X, LINKEDIN, BLOG]);
    // The X agent serves "twitter", which is what an integration row and a
    // task's platform call it.
    expect(served.has("twitter")).toBe(true);
    expect(served.has("linkedin")).toBe(true);
    // The managed social product covers these two.
    expect(served.has("instagram")).toBe(true);
    expect(served.has("tiktok")).toBe(true);
    // Nothing posts to YouTube.
    expect(served.has("youtube")).toBe(false);
    expect(served.has("x")).toBe(false);
  });

  it("honour an explicit descriptor too, and are empty with nothing to post from", () => {
    expect(servedPlatformKeys([{ name: "Studio agent", platforms: ["x"] }], []).has("twitter")).toBe(true);
    expect(servedPlatformKeys([], []).size).toBe(0);
  });

  it("let a task with no channel through, and stop one for a channel nobody serves", () => {
    const served = servedPlatformKeys([X]);
    expect(isServedPlatform(undefined, served)).toBe(true);
    expect(isServedPlatform("twitter", served)).toBe(true);
    expect(isServedPlatform("YouTube", served)).toBe(false);
  });

  it("say why in the client's words", () => {
    expect(unservedPlatformSkipNote(2)).toBe("2 not added: no agent of yours posts to that channel");
  });
});

describe("what the client reads", () => {
  it("names the agent where the model wrote its id", () => {
    const agents = [{ id: "Ji7p4nLTzDcbcKgDhtee", name: "X Agent" }];
    expect(withoutAgentIds("2-3 Shorts per week via Ji7p4nLTzDcbcKgDhtee: fast reactions", agents)).toBe(
      "2-3 Shorts per week via X Agent: fast reactions",
    );
    // A short id is left alone: rewriting every "Ji7p" in a sentence is worse.
    expect(withoutAgentIds("via ca_1", [{ id: "ca_1", name: "X Agent" }])).toBe("via ca_1");
  });
});

describe("the copilot's prompt", () => {
  const base = {
    agents: [],
    linkedSocialPlatforms: ["youtube", "linkedin"],
    servedPlatforms: ["linkedin"],
    integrations: [
      { platform: "youtube", status: "active" as const },
      { platform: "linkedin", status: "active" as const },
    ],
    scheduledNext14ByPlatform: {},
    hasGmailIntegration: false,
    hasScheduledContent: false,
    activeTaskCount: 0,
    maxActiveTasks: 10,
  };

  it("calls a connected channel nobody posts to what it is, and asks nothing for it", () => {
    const appendix = buildProactiveSystemAppendix(base);
    expect(appendix).toContain("youtube: connected, but no agent posts there");
    expect(appendix).toContain("linkedin: ⚠ NO content scheduled");
    expect(appendix).toContain("THE CHANNELS WE POST TO ARE EXACTLY: linkedin");
    // No onboarding task for a channel we would not post to either.
    expect(appendix).not.toContain("Connect YouTube account");
    expect(appendix).not.toContain("Connect Instagram account");
    expect(appendix).not.toContain("fill the empty youtube calendar");
    expect(appendix).toContain("fill the empty linkedin calendar");
  });

  it("asks for names, never identifiers, in a title or description", () => {
    expect(buildProactiveSystemAppendix(base)).toContain("NAMES, NEVER IDENTIFIERS");
  });
});

describe("every writer and the calendar ask the rule", () => {
  const src = (rel: string) => readFileSync(join(process.cwd(), "src", rel), "utf8");

  it("the copilot's create_tasks tool", () => {
    const route = src("app/api/clients/[id]/chat/route.ts");
    expect(route).toContain("if (!isServedPlatform(t.platform, servedPlatforms)) {");
    expect(route).toContain("title: withoutAgentIds(t.title, customAgents),");
    expect(route).toContain("servedPlatforms: [...servedPlatforms],");
  });

  it("the War Room's persist", () => {
    const swarm = src("lib/agent-swarm.ts");
    expect(swarm).toContain("if (!isServedPlatform(t.platform, served)) {");
    expect(swarm).toContain("title: withoutAgentIds(t.title, customAgents),");
    expect(swarm).toContain("CHANNELS WE POST TO:");
  });

  it("the calendar, before it offers a proposal for approval", () => {
    const calendar = src("app/(app)/calendar/calendar-body.tsx");
    expect(calendar).toMatch(/isServedPlatform\(t\.metadata\?\.platform as string \| undefined, servedPlatforms\)/);
  });
});
