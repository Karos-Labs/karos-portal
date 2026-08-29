import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * T-B23 / SCRUM-247: the chat route's copilot charge is priced on the model
 * that will actually run the turn, not the flat `CREDIT_COSTS.chatMessage`
 * every turn used to pay regardless of `deep`.
 *
 * Source-scan, matching the precedent this route is already tested under
 * (chat-route-turn-budget.test.ts, credit-attribution.test.ts's chat-route
 * checks): it is 1000+ lines with a heavy Firestore + streamText dependency
 * graph, so driving it end-to-end is not how this route is tested elsewhere
 * in this repo. The pure per-model pricing math itself (chatPricingFor /
 * chatMessageCreditCost) is exercised directly, with real inputs and
 * outputs, in credits.test.ts — this file only pins that the route actually
 * calls through to it rather than a re-typed literal.
 */

const REPO = join(__dirname, "..", "..", "..");
const CHAT_ROUTE = "src/app/api/clients/[id]/chat/route.ts";
const source = () => readFileSync(join(REPO, CHAT_ROUTE), "utf8");

describe("SCRUM-247: the copilot charge is priced on the model that will serve it", () => {
  it("resolves the model once, through T-B3's allowlist rather than a second resolver", () => {
    const src = source();
    // T-B3 (SCRUM-246) landed in the same round and owns this decision:
    // `body.model` is untrusted browser input and `resolveChatModel` holds the
    // mandatory server-side allowlist. T-B23's own `chatModelFor(body.deep)`
    // was deliberately not merged — pricing reads the resolution, it does not
    // repeat it, so the charge can never name a model the turn did not run.
    expect(src).toContain("const chatModel = resolveChatModel({ deep: body.deep, requestedModel: body.model });");
    expect(src).toContain("const chatPrice = chatPricingFor(chatModel.key);");
    expect(src).not.toContain("chatModelFor(");
  });

  it("prices the charge through chatMessageCreditCost, not a flat constant", () => {
    const src = source();
    expect(src).toContain("amount: chatMessageCreditCost(chatPrice.model, chatPrice.provider)");
    // The literal this replaces must be gone from the charge call itself —
    // matched narrowly (the exact call-site shape) so a reference to the old
    // constant in a comment explaining the change doesn't fail this.
    expect(src).not.toMatch(/amount:\s*CREDIT_COSTS\.chatMessage/);
  });

  it("carries which model actually served the call onto the charge, for telemetry", () => {
    const src = source();
    const open = src.indexOf("const chatCharge = await chargeClientModelCall({");
    expect(open, "chargeClientModelCall call site moved or was renamed").toBeGreaterThan(-1);
    const close = src.indexOf("\n  });", open);
    expect(close).toBeGreaterThan(open);
    const chargeCall = src.slice(open, close);
    expect(chargeCall).toContain("modelName: chatModel.option.modelId");
    // No longer a hardcoded "anthropic": T-B3's default option is Google's
    // Gemini Flash, so the ledger has to record which provider really served it.
    expect(chargeCall).toContain("provider: chatPrice.provider");
    expect(chargeCall).not.toContain('provider: "anthropic"');
  });

  it("still resolves the actual model call (aiFor) from the same chatModel, so pricing and generation cannot disagree on which model ran", () => {
    const src = source();
    expect(src).toContain("modelId: chatModel.option.modelId,");
    expect(src).toContain("vendor: chatModel.option.vendor,");
  });
});
