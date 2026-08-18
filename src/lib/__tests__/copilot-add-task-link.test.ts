import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { stripComments } from "./source-scan";

/**
 * THE REPLY THE COPILOT GIVES AFTER ADDING A TASK (#122).
 *
 * This file used to pin a "[View]" link on the reply — F65's verdict, which
 * kept it in step with QuickAddTaskBar's own "name the card that was actually
 * created" fix, deliberately keyed on `?task=` rather than a guessed `?owner=`
 * tab (the board's two tabs are disjoint, so a guess could open a board that
 * did not hold the card).
 *
 * REVERSED 2026-08, not silently: the Workspace board the link opened is gone
 * entirely, and nothing replaced it as a screen that shows one task by id — the
 * same wall Home's own attention rows hit (client-home-overview.tsx's
 * `taskBoardHref` removal, notification-bell.tsx's `TaskAlertRow`). A link with
 * nowhere correct to land is worse than no link, so `addTaskReply` now drops it
 * and this file asserts the plain sentence instead of the anchor it used to
 * require.
 */

vi.mock("server-only", () => ({}));
vi.mock("@/lib/actions", () => ({ ingestCustomUserTaskAction: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));

const { addTaskReply } = await import("@/components/chatbot-widget");
const { renderSectionBody } = await import("@/lib/doc-render");

const REPO = path.resolve(__dirname, "../..", "..");
const WIDGET = "src/components/chatbot-widget.tsx";

/** Every anchor the rendered reply produced, as [href, text]. */
function anchors(markup: string): Array<[string, string]> {
  return [...markup.matchAll(/<a\s[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g)].map((m) => [
    m[1],
    m[2],
  ]);
}

describe("the copilot's /add-task reply", () => {
  it("names the card, without a link, whether or not the action returned an id", () => {
    // No screen shows one task by id any more, so a returned `taskId` no
    // longer changes the reply at all — the assertion is that BOTH shapes
    // produce the identical plain sentence, not that one degrades to the
    // other.
    const withId = addTaskReply({ ok: true, title: "Book the venue", taskId: "task-42" });
    const withoutId = addTaskReply({ ok: true, title: "Book the venue" });

    expect(withId).toBe('Added "Book the venue" to your task board.');
    expect(withoutId).toBe('Added "Book the venue" to your task board.');
    expect(anchors(renderSectionBody(withId))).toEqual([]);
    expect(anchors(renderSectionBody(withoutId))).toEqual([]);
  });

  it("links nothing on a refusal, and keeps the two refusals distinct", () => {
    expect(addTaskReply({ ok: false, duplicate: true })).toBe(
      "That's already on your task board.",
    );
    expect(addTaskReply({ ok: false })).toBe("Couldn't add that task. Try again.");
    expect(addTaskReply({ ok: false, error: "Forbidden" })).toBe("Forbidden");
    for (const reply of [
      addTaskReply({ ok: false, duplicate: true }),
      addTaskReply({ ok: false }),
    ]) {
      expect(anchors(renderSectionBody(reply))).toEqual([]);
    }
  });

  it("is what the transcript actually shows — one builder, called by /add-task", () => {
    // The wiring half. `addTaskReply` being correct is worth nothing if the
    // handler goes back to assembling the sentence inline, which is exactly how
    // the link was lost the first time. Comments are stripped so the prose above
    // this test's subject cannot satisfy the scan.
    const src = stripComments(readFileSync(path.join(REPO, WIDGET), "utf8"));

    expect(src).toContain("const reply = addTaskReply(result);");
    // And there is no second place building it: the literal appears once, inside
    // the builder.
    expect(src.split("to your task board.").length - 1).toBe(1);
  });
});
