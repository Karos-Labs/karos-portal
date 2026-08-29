import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * T-B18: the copilot chat's client-facing surface for the `data-feedback`
 * part `provide_feedback` writes (chat/route.ts, T-B4).
 *
 * PRIOR ROUND'S REJECTION, restated as the thing this file pins: T-B4 already
 * built the writer (`provide_feedback` -> `addClientAgentFeedbackAction` ->
 * `data-feedback` chunk) and named T-B18 as the consumer, in comments in
 * three files (stream-protocol.ts's `ChatDataParts` doc comment, route.ts's
 * provideFeedbackTool, client-stream.ts's mapChunk doc comment). The first
 * attempt at this ticket never touched client-stream.ts or chatbot-widget.tsx
 * at all and built an unrelated second feedback system instead - so
 * client-stream.ts's own comment ("the parts no current UI reads yet")
 * stayed true for `data-feedback` after that PR shipped. This file (plus the
 * new client-stream.test.ts cases) is what makes it false.
 *
 * No React rendering harness is configured in this repo (vitest.config.ts
 * runs `environment: "node"`) - same precedent as
 * chatbot-widget-model-picker.test.ts - so this pins STRUCTURE: the widget
 * reads the typed `feedback` event (not the model's prose), attaches it to
 * the assistant message it arrived on, and renders a chip that links to the
 * agent's own feedback-management surface. The event's own parsing (data ->
 * `feedback`) has real behavioral coverage in
 * src/lib/chat/__tests__/client-stream.test.ts.
 */

const REPO = join(__dirname, "..", "..", "..");
const WIDGET = "src/components/chatbot-widget.tsx";
const source = () => readFileSync(join(REPO, WIDGET), "utf8");

describe("chatbot-widget consumes the data-feedback part instead of leaving it unread", () => {
  it("imports ChatStreamEvent (the typed event client-stream.ts now emits for data-feedback)", () => {
    expect(source()).toContain(
      'import { readChatStream, type ChatStreamEvent } from "@/lib/chat/client-stream"',
    );
  });

  it("derives its feedback-note type from ChatStreamEvent rather than hand-rolling a second shape", () => {
    expect(source()).toMatch(
      /type FeedbackNote = Extract<ChatStreamEvent, \{ type: "feedback" \}>\["feedback"\]/,
    );
  });

  it("handles the 'feedback' stream event in the turn's event switch", () => {
    const src = source();
    expect(src).toMatch(/case "feedback":/);
    expect(src).toMatch(/feedbackNotes\.push\(evt\.feedback\)/);
  });

  it("attaches the collected feedback notes onto the assistant message that produced them", () => {
    const src = source();
    // The exact call that writes them onto state, keyed by assistantId - not
    // a queue rendered somewhere disconnected from the turn that wrote it.
    expect(src).toMatch(
      /m\.id === assistantId \? \{ \.\.\.m, feedbackNotes \} : m/,
    );
  });

  it("Message carries an optional feedbackNotes field, and the persisted-message guard validates it", () => {
    const src = source();
    expect(src).toMatch(/feedbackNotes\?:\s*FeedbackNote\[\]/);
    expect(src).toContain("isPersistedFeedbackNote");
    // A malformed/older-shape restore is dropped, not accepted as-is.
    expect(src).toMatch(
      /m\.feedbackNotes === undefined \|\|\s*\n?\s*\(Array\.isArray\(m\.feedbackNotes\) && m\.feedbackNotes\.every\(isPersistedFeedbackNote\)\)/,
    );
  });

  it("renders one FeedbackChip per note, only on the assistant message that carries them", () => {
    const src = source();
    expect(src).toMatch(
      /msg\.role === "assistant" && msg\.feedbackNotes && msg\.feedbackNotes\.length > 0/,
    );
    expect(src).toMatch(/msg\.feedbackNotes\.map\(\(note, i\) => \(\s*<FeedbackChip key=\{i\} clientId=\{clientId\} note=\{note\} \/>/);
  });

  it("FeedbackChip links into the agent's OWN detail page (its existing ClientAgentFeedbackModal), not a new surface", () => {
    const src = source();
    const start = src.indexOf("function FeedbackChip(");
    expect(start, "FeedbackChip not found").toBeGreaterThan(-1);
    const body = src.slice(start, start + 1200);
    expect(body).toMatch(/href=\{`\/clients\/\$\{clientId\}\/agents\/\$\{note\.agentId\}`\}/);
  });
});
