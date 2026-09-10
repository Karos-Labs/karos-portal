import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * T-B3 / SCRUM-246's manual model picker, on the client side.
 *
 * No React rendering harness is configured in this repo (vitest.config.ts
 * runs `environment: "node"`), so — same precedent as the chat-route source
 * scans — this pins the widget's STRUCTURE: the picker's options must come
 * from the shared allowlist module (never a second, hand-copied list of
 * labels/keys), and the chosen key must ride the same untrusted `model`
 * field the server-side tests (chat-route-model-routing.test.ts) verify is
 * validated on arrival.
 */

const REPO = join(__dirname, "..", "..", "..");
const WIDGET = "src/components/chatbot-widget.tsx";
const source = () => readFileSync(join(REPO, WIDGET), "utf8");

describe("chatbot-widget's manual model picker reads the shared allowlist rather than duplicating it", () => {
  it("imports the picker options from lib/ai/chat-models, not a local copy", () => {
    expect(source()).toContain(
      'import { CHAT_MODEL_KEYS, CHAT_MODEL_OPTIONS, type ChatModelKey } from "@/lib/ai/chat-models"',
    );
  });

  it("renders one button per CHAT_MODEL_KEYS entry, not a hardcoded pair of labels", () => {
    const src = source();
    expect(src).toMatch(/CHAT_MODEL_KEYS\.map\(/);
    expect(src).toContain("CHAT_MODEL_OPTIONS[key].label");
  });

  it("sends the picked key as `model` on the chat request, only when one is actually picked", () => {
    const src = source();
    expect(src).toMatch(/\.\.\.\(preferredModel \? \{ model: preferredModel \} : \{\}\)/);
  });

  it("defaults to Auto (null) — the server's own cost-based routing decides absent a pick", () => {
    const src = source();
    expect(src).toMatch(/useState<ChatModelKey \| null>\(null\)/);
  });
});
