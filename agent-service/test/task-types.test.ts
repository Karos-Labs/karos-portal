import { describe, expect, it } from "vitest";
import { resolveTaskConfig, getTaskTypeConfig } from "../src/task-types.js";
import { TASK_TYPES } from "../src/types.js";
import type { JobSpec } from "../src/types.js";

const CUSTOM_BRIEF = {
  agent_key: "instagram-agent",
  label: "Instagram Agent",
  entry_skill_dir: "products/live/instagram-agent",
  skill_roots: ["skills/vendors/taste-skill"],
  instructions: "Produce carousels per the client's content system.",
  prompt: "3 posts about the new offer",
};

describe("resolveTaskConfig", () => {
  it("returns the static config untouched for catalog task types", () => {
    expect(resolveTaskConfig("social_post", {})).toBe(getTaskTypeConfig("social_post"));
  });

  it("registers a research stepModel for social_post pending the matching skill-side subagent name", () => {
    expect(getTaskTypeConfig("social_post").stepModels).toEqual({ research: "claude-sonnet-4-6" });
  });

  it("dials every task type down from the SDK's high-effort default", () => {
    for (const taskType of TASK_TYPES) {
      expect(getTaskTypeConfig(taskType).effort).toBe("medium");
    }
  });

  it("resolves entry skill and merges skill roots for custom", () => {
    const config = resolveTaskConfig("custom", CUSTOM_BRIEF);
    expect(config.entrySkillDir).toBe("products/live/instagram-agent");
    expect(config.entrySkill).toBe("instagram-agent");
    expect(config.skillRoots).toContain("skills/vendors/taste-skill");
    expect(config.skillRoots).toContain("skills/vendors/last30days");
    expect(config.includeClientSkills).toBe(true);
    // Safety envelope stays service-defined regardless of brief content.
    expect(config.maxBudgetUsd).toBe(getTaskTypeConfig("custom").maxBudgetUsd);
    expect(config.allowedTools).toEqual(getTaskTypeConfig("custom").allowedTools);
  });

  it("normalizes a SKILL.md-suffixed entry path", () => {
    const config = resolveTaskConfig("custom", {
      ...CUSTOM_BRIEF,
      entry_skill_dir: "products/live/blog-agent/SKILL.md",
    });
    expect(config.entrySkillDir).toBe("products/live/blog-agent");
  });

  it("honours include_client_skills=false", () => {
    const config = resolveTaskConfig("custom", { ...CUSTOM_BRIEF, include_client_skills: false });
    expect(config.includeClientSkills).toBe(false);
  });

  it("defaults custom agents onto the same research stepModel, overridable per-brief", () => {
    expect(resolveTaskConfig("custom", CUSTOM_BRIEF).stepModels).toEqual({ research: "claude-sonnet-4-6" });
    const overridden = resolveTaskConfig("custom", {
      ...CUSTOM_BRIEF,
      step_models: { research: "claude-haiku-4-5-20251001" },
    });
    expect(overridden.stepModels).toEqual({ research: "claude-haiku-4-5-20251001" });
  });

  it("throws on traversal or out-of-tree paths", () => {
    expect(() => resolveTaskConfig("custom", { ...CUSTOM_BRIEF, entry_skill_dir: "products/../../etc" })).toThrow(
      /invalid entry_skill_dir/,
    );
    expect(() => resolveTaskConfig("custom", { ...CUSTOM_BRIEF, entry_skill_dir: "/etc" })).toThrow(
      /invalid entry_skill_dir/,
    );
    expect(() => resolveTaskConfig("custom", { ...CUSTOM_BRIEF, entry_skill_dir: "docs/notes" })).toThrow(
      /invalid entry_skill_dir/,
    );
    expect(() =>
      resolveTaskConfig("custom", { ...CUSTOM_BRIEF, skill_roots: ["clients/../escape"] }),
    ).toThrow(/invalid skill_roots/);
    expect(() => resolveTaskConfig("custom", { ...CUSTOM_BRIEF, entry_skill_dir: undefined })).toThrow(
      /invalid entry_skill_dir/,
    );
  });

  it("allowlists the `which` probe for the media/render task types", () => {
    expect(getTaskTypeConfig("social_post").allowedTools).toContain("Bash(which:*)");
    expect(getTaskTypeConfig("custom").allowedTools).toContain("Bash(which:*)");
  });

  it("injects the runner-environment manifest and photo requirement into the social_post prompt", () => {
    const spec: JobSpec = {
      jobId: "job-abcdef01",
      taskType: "social_post",
      clientId: "client-1",
      clientSlug: "xodigital",
      brief: { count: 1 },
      contextFiles: [],
      timeoutMs: 60_000,
      callbackBaseUrl: "http://localhost:8080",
      runnerToken: "t",
      attempt: 1,
      maxAttempts: 2,
    };
    const prompt = getTaskTypeConfig("social_post").buildPrompt(spec, {
      clientSlug: "xodigital",
      runFolder: "2026-07-09-job-abcdef01",
      isoDate: "2026-07-09",
      contextFileList: "- (none)",
      clientScaffolded: false,
    });
    // Ground-truth manifest: Chromium is present and a denied probe != missing tool.
    expect(prompt).toContain("RUNNER ENVIRONMENT");
    expect(prompt).toContain("Headless Chromium IS installed");
    expect(prompt).toContain('NEVER "the tool is missing"');
    // The photo-less fallback is no longer an acceptable normal deliverable.
    expect(prompt).toContain("PHOTO REQUIREMENT");
    expect(prompt).toContain("report the run as failed");
  });

  it("injects the runner-environment manifest into the custom prompt", () => {
    const config = resolveTaskConfig("custom", CUSTOM_BRIEF);
    const spec: JobSpec = {
      jobId: "job-12345678",
      taskType: "custom",
      clientId: "client-1",
      clientSlug: "xodigital",
      brief: CUSTOM_BRIEF,
      contextFiles: [],
      timeoutMs: 60_000,
      callbackBaseUrl: "http://localhost:8080",
      runnerToken: "t",
      attempt: 1,
      maxAttempts: 2,
    };
    const prompt = config.buildPrompt(spec, {
      clientSlug: "xodigital",
      runFolder: "2026-07-09-job-12345678",
      isoDate: "2026-07-09",
      contextFileList: "- (none)",
      clientScaffolded: false,
    });
    expect(prompt).toContain("RUNNER ENVIRONMENT");
    expect(prompt).toContain("Headless Chromium IS installed");
  });

  it("builds a prompt embedding instructions and the user request", () => {
    const config = resolveTaskConfig("custom", CUSTOM_BRIEF);
    const spec: JobSpec = {
      jobId: "job-12345678",
      taskType: "custom",
      clientId: "client-1",
      clientSlug: "xodigital",
      brief: CUSTOM_BRIEF,
      contextFiles: [],
      timeoutMs: 60_000,
      callbackBaseUrl: "http://localhost:8080",
      runnerToken: "t",
      attempt: 1,
      maxAttempts: 2,
    };
    const prompt = config.buildPrompt(spec, {
      clientSlug: "xodigital",
      runFolder: "2026-07-09-job-job12345",
      isoDate: "2026-07-09",
      contextFileList: "- (none)",
      clientScaffolded: false,
    });
    expect(prompt).toContain("Instagram Agent for xodigital");
    expect(prompt).toContain("Produce carousels per the client's content system.");
    expect(prompt).toContain("3 posts about the new offer");
    expect(prompt).toContain("products/live/instagram-agent/SKILL.md");
    expect(prompt).toContain("CLIENT REQUEST");
  });
});
