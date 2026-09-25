import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * The staff lessons panel (SCRUM-508), painted in each state. The assertion
 * that matters most: the lessons a draft actually reads (the last eight the
 * middleware stores) are the ones marked, shown first.
 */

vi.mock("server-only", () => ({}));
vi.mock("@/lib/actions/learning-lessons-actions", () => ({ setVoiceLessonRetiredAction: vi.fn() }));

import { LearnedLessonsPanel } from "@/components/learned-lessons-panel";
import type { LearnedLessons } from "@/lib/agent-engine/learning-lessons";

const paint = (initial: LearnedLessons | null | undefined) => renderToStaticMarkup(<LearnedLessonsPanel clientId="c1" initial={initial} />);

describe("LearnedLessonsPanel", () => {
  it("says the control plane did not answer, rather than that nothing was learned", () => {
    expect(paint(undefined)).toContain("did not answer");
    expect(paint(null)).toContain("Nothing learned yet");
    expect(paint({ voiceLessons: [], likes: [], retired: [] })).toContain("Nothing learned yet");
  });

  it("shows the strongest lessons first and marks only the eight a draft reads", () => {
    const voiceLessons = Array.from({ length: 10 }, (_, i) => ({ lesson: `lesson ${i}`, source: "note" as const }));
    const html = paint({ voiceLessons, likes: [], retired: [] });
    expect(html.indexOf("lesson 9")).toBeLessThan(html.indexOf("lesson 0"));
    expect(html.match(/read by drafts/g)).toHaveLength(8);
    expect(html).toContain("10 held · the top 8 reach every draft");
    expect(html.match(/>Retire</g)).toHaveLength(10);
  });

  it("says where a lesson came from and how many times, and lists the retired ones with Restore", () => {
    const html = paint({
      voiceLessons: [{ lesson: "Takes synergy out", source: "edits", evidence: 4 }, { lesson: "less jargon", source: "change_request" }],
      likes: [{ subject: "why pilots stall", runId: "r1" }],
      retired: ["open with a question"],
    });
    expect(html).toContain("counted from the client&#x27;s edits · 4 times");
    expect(html).toContain("change request");
    expect(html).toContain("why pilots stall");
    expect(html).toContain("open with a question");
    expect(html).toContain(">Restore<");
  });
});
