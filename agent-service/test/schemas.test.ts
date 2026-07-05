import { describe, expect, it } from "vitest";
import { validateJobRequest } from "../src/schemas/validate.js";

function baseRequest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    task_type: "blog_article",
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
      validateJobRequest(baseRequest({ task_type: "newsletter_issue", brief: { issue_theme: "May recap" } })).ok,
    ).toBe(true);
    expect(
      validateJobRequest(baseRequest({ task_type: "landing_page", brief: { page_goal: "Book demo calls" } })).ok,
    ).toBe(true);
  });

  it("rejects unknown task types", () => {
    const result = validateJobRequest(baseRequest({ task_type: "seo_audit" }));
    expect(result.ok).toBe(false);
  });

  it("rejects a brief that misses required fields", () => {
    const result = validateJobRequest(baseRequest({ brief: {} }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join(" ")).toContain("topic");
  });

  it("rejects unknown brief fields", () => {
    const result = validateJobRequest(baseRequest({ brief: { topic: "x", hack: true } }));
    expect(result.ok).toBe(false);
  });

  it("rejects missing callback_url and non-URL callback", () => {
    expect(validateJobRequest(baseRequest({ callback_url: undefined })).ok).toBe(false);
    expect(validateJobRequest(baseRequest({ callback_url: "not-a-url" })).ok).toBe(false);
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
});
