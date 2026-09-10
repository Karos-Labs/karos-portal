import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * T-B3 / SCRUM-246: the chat route must never trust a model identifier the
 * browser sent, and must route through `aiFor()` (the T-B1 capability-aware
 * provider layer) rather than a second, parallel model-selection path.
 *
 * The chat route is 1000+ lines with a heavy Firestore + streamText
 * dependency graph, so — matching the existing precedent for this exact file
 * (chat-route-agent-guard.test.ts, chat-route-turn-budget.test.ts,
 * credit-attribution.test.ts) — this pins the route's STRUCTURE via a source
 * scan rather than driving it end-to-end. `chat-model-routing.test.ts`
 * (src/lib/ai/__tests__/) is the behavioral half: it exercises the real
 * `resolveChatModel`/`aiFor` decision logic this route calls into.
 */

const REPO = join(__dirname, "..", "..", "..");
const CHAT_ROUTE = "src/app/api/clients/[id]/chat/route.ts";
const source = () => readFileSync(join(REPO, CHAT_ROUTE), "utf8");

describe("chat route: cost-based model routing goes through resolveChatModel + aiFor, never a raw browser value", () => {
  it("imports resolveChatModel from the shared allowlist module, not a local reimplementation", () => {
    expect(source()).toContain('import { resolveChatModel } from "@/lib/ai/chat-models"');
  });

  it("no longer hardcodes body.deep ? SONNET : HAIKU", () => {
    expect(source()).not.toMatch(/body\.deep\s*\?\s*MODELS\.SONNET\s*:\s*MODELS\.HAIKU/);
    // MODELS.SONNET is gone from this route entirely — a plain chatbot turn
    // (deep, manual-quality, or default) tops out at Haiku or the cheap
    // Gemini default; Sonnet was the old "quality" tier this ticket replaces.
    expect(source()).not.toContain("MODELS.SONNET");
    expect(source()).not.toContain("MODELS.HAIKU");
  });

  it("reads body.model as untrusted input and feeds it to resolveChatModel, not straight to aiFor", () => {
    const src = source();
    expect(src).toMatch(/model\?:\s*unknown/);
    const call = src.match(/const chatModel = resolveChatModel\(\{[^}]*\}\)/);
    expect(call, "resolveChatModel(...) call not found").not.toBeNull();
    expect(call![0]).toMatch(/requestedModel:\s*body\.model/);
    expect(call![0]).toMatch(/deep:\s*body\.deep/);
  });

  it("passes the RESOLVED option (not body.model) into aiFor — the allowlist lookup sits between them", () => {
    const src = source();
    const aiForCall = src.match(/aiFor\("chat\.client",\s*\{[^}]*\}/);
    expect(aiForCall, 'aiFor("chat.client", ...) call not found').not.toBeNull();
    const call = aiForCall![0];
    expect(call).toMatch(/modelId:\s*chatModel\.option\.modelId/);
    expect(call).toMatch(/vendor:\s*chatModel\.option\.vendor/);
    // The raw untrusted field must never reach this call directly.
    expect(call).not.toContain("body.model");
  });

  it("every model-usage log call carries BOTH the resolved id and the vendor that served it (usageFor), not a hand-written modelName", () => {
    const src = source();
    const usageForCalls = src.match(/usageFor\("chat\.client",\s*\{[^}]*\}\)/g) ?? [];
    // logCopilotUsage's onFinish AND the stream's onError — both logging
    // sites for this route's own model, not chat.followups' separate call.
    expect(usageForCalls.length).toBeGreaterThanOrEqual(2);
    for (const call of usageForCalls) {
      expect(call).toMatch(/modelId:\s*chatModel\.option\.modelId/);
      expect(call).toMatch(/vendor:\s*chatModel\.option\.vendor/);
    }
    // The old hand-rolled `modelName: modelId` (pre-T-B3 local variable) must
    // be gone — usageFor is the only source of a logged modelName now.
    expect(src).not.toMatch(/modelName:\s*modelId\b/);
  });

  it("chat.client is still resolved through aiFor — no parallel binding of anthropic()/vertexAnthropic()/googleVertex() in this route", () => {
    const src = source();
    expect(src).not.toMatch(/(?<![\w.])anthropic\(/);
    expect(src).not.toContain("vertexAnthropic(");
    expect(src).not.toContain("googleVertex(");
  });
});
