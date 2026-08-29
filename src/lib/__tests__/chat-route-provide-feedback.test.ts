import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * T-B18: the copilot chat's `provide_feedback` tool must write `agentId` on
 * its `data-feedback` part - the field client-stream.ts's `feedback` event
 * (and chatbot-widget.tsx's `FeedbackChip`) needs to link into the agent's
 * own detail page (`/clients/[id]/agents/[agentId]`).
 *
 * `agentId` here is deliberately `umbrella.customAgentId`, NOT `umbrella.id`:
 * that page resolves its `[agentId]` param via `getCustomAgent(agentId)`
 * (see the page itself), and `ClientAgent.customAgentId` is the field that
 * points into that same collection (src/lib/types.ts's own doc comment on
 * it: "customAgents doc id at bind time"). `umbrella.id` is the ClientAgent
 * document's own id, a different id space entirely - the same distinction
 * agent-detail-archetypes.ts's `umbrellaForAgent` already keys off of.
 *
 * Source-scanned, matching this file's existing precedent for this same
 * 1000+ line, Firestore-heavy route (chat-route-agent-guard.test.ts,
 * chat-route-run-agent-now.test.ts).
 */

const REPO = join(__dirname, "..", "..", "..");
const CHAT_ROUTE = "src/app/api/clients/[id]/chat/route.ts";
const source = () => readFileSync(join(REPO, CHAT_ROUTE), "utf8");

function provideFeedbackToolBody(src: string): string {
  const start = src.indexOf("const provideFeedbackTool");
  expect(start, "provideFeedbackTool not found").toBeGreaterThan(-1);
  const end = src.indexOf("const setAgentFocusTool", start);
  expect(end, "setAgentFocusTool (end marker) not found").toBeGreaterThan(start);
  return src.slice(start, end);
}

describe("copilot chat's provide_feedback writes agentId onto its data-feedback part", () => {
  it("writes a data-feedback chunk via the chat writer", () => {
    const body = provideFeedbackToolBody(source());
    expect(body).toMatch(/chatWriter\?\.\s*write\(\s*\{\s*type:\s*"data-feedback"/);
  });

  it("carries agentId as umbrella.customAgentId, not umbrella.id", () => {
    const body = provideFeedbackToolBody(source());
    const dataStart = body.indexOf('type: "data-feedback"');
    const dataEnd = body.indexOf("});", dataStart);
    const payload = body.slice(dataStart, dataEnd);
    expect(payload).toMatch(/agentId:\s*umbrella\.customAgentId/);
    // Never the umbrella's own doc id - that id space 404s on the detail page.
    expect(payload).not.toMatch(/agentId:\s*umbrella\.id\b/);
  });

  it("still carries the fields the shape had before T-B18 (agentName, scope, templateKey, category)", () => {
    const body = provideFeedbackToolBody(source());
    const dataStart = body.indexOf('type: "data-feedback"');
    const dataEnd = body.indexOf("});", dataStart);
    const payload = body.slice(dataStart, dataEnd);
    expect(payload).toMatch(/agentName:\s*umbrella\.displayName/);
    expect(payload).toMatch(/scope,/);
    expect(payload).toMatch(/templateKey/);
    expect(payload).toMatch(/category/);
  });
});
