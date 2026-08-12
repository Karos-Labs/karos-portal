import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * GenerateFromTextPanel (Feature 2 UI): the free-text → draft generator's
 * form. Same `renderToStaticMarkup` recipe as
 * step-pipeline-builder-capabilities-render.test.tsx — this repo has no
 * jsdom/testing-library in its vitest config (see vitest.config.ts:
 * `environment: "node"`), so these are static-markup assertions of the
 * INITIAL render only, not click/interaction tests. The server action is
 * mocked so importing the component never reaches into auth/Firestore.
 */

vi.mock("server-only", () => ({}));
vi.mock("@/lib/actions", () => ({ generateDynamicAgentDraftAction: vi.fn() }));

import { GenerateFromTextPanel } from "@/components/admin/agent-studio/generate-from-text-panel";

function paint(hasExistingContent: boolean): string {
  return renderToStaticMarkup(
    <GenerateFromTextPanel hasExistingContent={hasExistingContent} onApply={() => {}} />,
  );
}

describe("GenerateFromTextPanel — initial render", () => {
  it("renders the description textarea and a disabled Generate button (empty description)", () => {
    const html = paint(false);
    expect(html).toContain("<textarea");
    expect(html).toContain("Generate");
    // The button carries `disabled` because description.trim() is empty on mount.
    const buttonMatch = html.match(/<button[^>]*>[\s\S]*?Generate[\s\S]*?<\/button>/);
    expect(buttonMatch).not.toBeNull();
    expect(buttonMatch![0]).toContain("disabled");
  });

  it("shows no error, no notes list, and no replace-confirmation on first render", () => {
    const html = paint(false);
    expect(html).not.toContain("role=\"alert\"");
    expect(html).not.toContain("Assumptions made");
    expect(html).not.toContain("Replace with generated draft");
  });

  it("does not pre-render the destructive-replace confirmation just because the spec already has content — that only appears after a generation result comes back", () => {
    // hasExistingContent only matters inside runGeneration's callback, which
    // renderToStaticMarkup never fires — so the prop alone must not change
    // what paints before any generation has happened.
    const html = paint(true);
    expect(html).not.toContain("Replace with generated draft");
    expect(html).not.toContain("already has inputs or pipeline steps");
  });

  it("shows the character counter against the same cap the server action enforces", () => {
    const html = paint(false);
    expect(html).toContain("0 / 5,000");
  });
});
