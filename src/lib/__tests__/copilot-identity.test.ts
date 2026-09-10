import { describe, expect, it, vi } from "vitest";

// copilot-context.ts is server-only; same stub the agent-engine tests use.
vi.mock("server-only", () => ({}));
import { buildCopilotSystemPrompt } from "@/lib/copilot-context";
import type { Client } from "@/lib/types";

/**
 * The copilot answers "what are you?" from its system prompt or, failing that,
 * from the serving model's own pretraining. Before this block existed it did
 * the latter and said "Claude" — and after T-B3/SCRUM-246 put a Gemini option
 * on the same product, the answer changed depending on which model happened to
 * serve the turn.
 *
 * Two separate things are pinned here, and the distinction is the point:
 *
 *  1. BRANDING — the copilot is karosAI and does not name the vendor behind it.
 *  2. HONESTY — it is still an AI and must say so. Withholding which vendor's
 *     model runs you is a branding decision; pretending not to be software is
 *     not, and no product requirement makes it one.
 *
 * A future edit that tightens (1) into (2)'s territory fails the second test.
 */

const client = { name: "Acme Corp" } as unknown as Client;
const prompt = () => buildCopilotSystemPrompt(client, null, [], [], []);

describe("copilot identity", () => {
  it("introduces itself as karosAI, for the client it serves", () => {
    const p = prompt();
    expect(p).toContain("karosAI");
    expect(p).toContain("Acme Corp");
  });

  it("does not hand the model another assistant's name to answer with", () => {
    const p = prompt();
    // The instruction naming what NOT to say is allowed to mention vendors;
    // what must not appear is an identity CLAIM built from one.
    expect(p).not.toMatch(/You are\s+\*{0,2}(Claude|Gemini|GPT|ChatGPT)/i);
    expect(p).not.toMatch(/Your name is\s+\*{0,2}(Claude|Gemini|GPT|ChatGPT)/i);
  });

  it("tells the model to withhold the underlying model or vendor", () => {
    expect(prompt()).toMatch(/do not name the underlying model, vendor, or provider/i);
  });

  it("still requires it to admit being an AI — branding is not permission to deceive", () => {
    const p = prompt();
    expect(p).toMatch(/Never claim to be a human being/i);
    expect(p).toMatch(/say plainly that you are an AI/i);
  });
});
