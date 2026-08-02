import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { stripComments } from "./source-scan";

/**
 * THE LINK ON A TASK THE COPILOT JUST ADDED (#122).
 *
 * F65's verdict recorded two surfaces landing the "name the card that was
 * actually created" fix: QuickAddTaskBar, which sits ON the board and moves it
 * to the tab the router chose, and the copilot, which is a dock over some other
 * page and therefore carried a link. A later refactor dropped the copilot's
 * half: the reply went back to plain text and the `taskId` the action returns
 * was fetched and discarded. That is a silent revert of a verdicted fix, and it
 * leaves a message naming a card with no way to reach it.
 *
 * ASSERTED IN THREE PLACES, because there are three ways it can die:
 *
 *  1. the id can go missing from the sentence;
 *  2. the sentence can stop being turned into an anchor — the transcript is
 *     rendered by `renderSectionBody`, which escapes first and only then makes
 *     links, and refuses any href `isSafeHref` does not like;
 *  3. the link can point at the WRONG BOARD TAB. The board's two tabs are
 *     disjoint (`?owner=client` picks one, everything else picks the other), so
 *     a link that names an owner it guessed at opens a board that does not hold
 *     the card. `?task=` is the ruling — the board resolves the tab from the
 *     task itself — and this file pins that the copilot obeys it.
 */

vi.mock("server-only", () => ({}));
vi.mock("@/lib/actions", () => ({ ingestCustomUserTaskAction: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));

const { addTaskReply } = await import("@/components/chatbot-widget");
const { renderSectionBody, isSafeHref } = await import("@/lib/doc-render");

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
  it("carries a link to the card it just named", () => {
    const reply = addTaskReply({ ok: true, title: "Book the venue", taskId: "task-42" });

    expect(reply).toBe('Added "Book the venue" to your task board. [View](/tasks?task=task-42)');
  });

  it("renders that link as an anchor the reader can press", () => {
    // The half a string assertion cannot see: `renderSectionBody` escapes before
    // it formats, and only makes an anchor of an href `isSafeHref` accepts.
    const markup = renderSectionBody(
      addTaskReply({ ok: true, title: "Book the venue", taskId: "task-42" }),
    );

    expect(anchors(markup)).toEqual([["/tasks?task=task-42", "View"]]);
  });

  it("keys the board on the TASK, never on a guessed owner tab", () => {
    const [[href]] = anchors(
      renderSectionBody(addTaskReply({ ok: true, title: "Book the venue", taskId: "task-42" })),
    );

    expect(href.startsWith("/tasks?task=")).toBe(true);
    expect(href).not.toMatch(/owner=/);
    // Same-origin by `isSafeHref`'s own reckoning, which is what decides whether
    // an anchor is produced at all.
    expect(isSafeHref(href)).toBe(true);
  });

  it("percent-encodes the id rather than pasting it into the query", () => {
    const [[href]] = anchors(
      renderSectionBody(addTaskReply({ ok: true, title: "T", taskId: "a b&c" })),
    );

    expect(href).toContain("task=a%20b%26c");
  });

  it("ends the sentence cleanly when the action returned no id", () => {
    const reply = addTaskReply({ ok: true, title: "Book the venue" });

    expect(reply).toBe('Added "Book the venue" to your task board.');
    expect(anchors(renderSectionBody(reply))).toEqual([]);
  });

  it("links nothing on a refusal, and keeps the two refusals distinct", () => {
    expect(addTaskReply({ ok: false, duplicate: true })).toBe(
      "That's already on your task board.",
    );
    expect(addTaskReply({ ok: false })).toBe("Couldn't add that task — try again.");
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
