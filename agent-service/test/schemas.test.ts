import { describe, expect, it } from "vitest";
import { validateJobRequest } from "../src/schemas/validate.js";

function baseRequest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    task_type: "social_post",
    client_id: "client-123",
    brief: { topic: "Why tokenized fixed income is growing" },
    callback_url: "https://platform.example.com/api/agent-service/webhook",
    ...overrides,
  };
}

describe("job request validation", () => {
  it("accepts a minimal valid request per task type", () => {
    expect(validateJobRequest(baseRequest()).ok).toBe(true);
    expect(
      validateJobRequest(baseRequest({ task_type: "social_post", brief: { count: 3, topic: "spring menu" } })).ok,
    ).toBe(true);
    expect(
      validateJobRequest(baseRequest({ task_type: "landing_page", brief: { page_goal: "Book demo calls" } })).ok,
    ).toBe(true);
  });

  it("rejects unknown task types", () => {
    const result = validateJobRequest(baseRequest({ task_type: "seo_audit" }));
    expect(result.ok).toBe(false);
  });

  it("rejects the RETIRED blog_article type", () => {
    // Removed 2026-08-06 with the newsletter's, when the blog became a custom
    // agent. Same distinction as below: this string was valid and real jobs
    // carry it, and the portal still ACCEPTS it inbound so a straggler can
    // report. What must no longer be possible is STARTING one.
    const result = validateJobRequest(
      baseRequest({ task_type: "blog_article", brief: { topic: "Anything" } }),
    );
    expect(result.ok).toBe(false);
  });

  it("rejects the RETIRED newsletter_issue type", () => {
    // Removed 2026-08-06 when the newsletter became a custom agent. It is a
    // separate assertion from "unknown type" above because it is a different
    // claim: this string was valid, real jobs carry it, and the portal still
    // ACCEPTS it inbound so a straggler can report its status. What must no
    // longer be possible is STARTING one.
    const result = validateJobRequest(
      baseRequest({ task_type: "newsletter_issue", brief: { issue_theme: "May recap" } }),
    );
    expect(result.ok).toBe(false);
  });

  it("rejects a brief that misses required fields", () => {
    // Asked of `landing_page`, which is now the only remaining task type with a
    // REQUIRED brief field. The base request used to be `blog_article`, whose
    // `topic` was required — when that type was retired the base moved to
    // `social_post`, which requires nothing, and this assertion would have
    // passed an empty brief and proved nothing.
    const result = validateJobRequest(baseRequest({ task_type: "landing_page", brief: {} }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join(" ")).toContain("page_goal");
  });

  it("rejects unknown brief fields", () => {
    const result = validateJobRequest(baseRequest({ brief: { topic: "x", hack: true } }));
    expect(result.ok).toBe(false);
  });

  it("rejects missing callback_url and non-URL callback", () => {
    expect(validateJobRequest(baseRequest({ callback_url: undefined })).ok).toBe(false);
    expect(validateJobRequest(baseRequest({ callback_url: "not-a-url" })).ok).toBe(false);
  });

  it("requires https callbacks unless insecure callbacks are explicitly allowed", () => {
    const insecure = baseRequest({ callback_url: "http://internal-host/webhook" });
    expect(validateJobRequest(insecure).ok).toBe(false);
    expect(validateJobRequest(insecure, { allowInsecureCallbacks: true }).ok).toBe(true);
    expect(validateJobRequest(baseRequest()).ok).toBe(true);
  });

  it("enforces context file rules", () => {
    const good = baseRequest({
      context_files: [{ name: "photo.jpg", url: "https://files.example.com/p.jpg", description: "hero" }],
    });
    expect(validateJobRequest(good).ok).toBe(true);

    const traversal = baseRequest({
      context_files: [{ name: "../../etc/passwd", url: "https://files.example.com/p" }],
    });
    expect(validateJobRequest(traversal).ok).toBe(false);

    const insecure = baseRequest({
      context_files: [{ name: "a.txt", url: "http://files.example.com/a.txt" }],
    });
    expect(validateJobRequest(insecure).ok).toBe(false);

    const tooMany = baseRequest({
      context_files: Array.from({ length: 21 }, (_, i) => ({
        name: `f${i}.txt`,
        url: "https://files.example.com/f",
      })),
    });
    expect(validateJobRequest(tooMany).ok).toBe(false);
  });

  it("rejects bad client_slug values", () => {
    expect(validateJobRequest(baseRequest({ client_slug: "Bad Slug" })).ok).toBe(false);
    expect(validateJobRequest(baseRequest({ client_slug: "../escape" })).ok).toBe(false);
    expect(validateJobRequest(baseRequest({ client_slug: "xodigital" })).ok).toBe(true);
  });

  it("applies schema defaults into the brief", () => {
    const result = validateJobRequest(baseRequest({ task_type: "social_post", brief: {} }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.request.brief.count).toBe(3);
      expect(result.request.brief.platform).toBe("both");
    }
  });

  describe("custom task type", () => {
    function customRequest(brief: Record<string, unknown>): Record<string, unknown> {
      return baseRequest({
        task_type: "custom",
        brief: {
          entry_skill_dir: "products/live/instagram-agent",
          instructions: "Run the instagram agent end to end.",
          prompt: "3 posts about the new offer",
          ...brief,
        },
      });
    }

    it("accepts a valid custom brief and defaults include_client_skills", () => {
      const result = validateJobRequest(customRequest({}));
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.request.brief.include_client_skills).toBe(true);
    });

    it("requires entry_skill_dir, instructions, and prompt", () => {
      expect(validateJobRequest(customRequest({ entry_skill_dir: undefined })).ok).toBe(false);
      expect(validateJobRequest(customRequest({ instructions: undefined })).ok).toBe(false);
      expect(validateJobRequest(customRequest({ prompt: undefined })).ok).toBe(false);
    });

    it("rejects traversal and out-of-tree skill paths", () => {
      expect(validateJobRequest(customRequest({ entry_skill_dir: "products/../../../etc" })).ok).toBe(false);
      expect(validateJobRequest(customRequest({ entry_skill_dir: "/etc/passwd" })).ok).toBe(false);
      expect(validateJobRequest(customRequest({ entry_skill_dir: "docs/whatever" })).ok).toBe(false);
      expect(validateJobRequest(customRequest({ entry_skill_dir: "products//live" })).ok).toBe(false);
      expect(
        validateJobRequest(customRequest({ skill_roots: ["skills/vendors/ok", "clients/../escape"] })).ok,
      ).toBe(false);
    });
  });
});
