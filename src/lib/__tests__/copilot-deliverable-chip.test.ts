import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * THE COPILOT HAS A WAY OUT OF ITSELF (flow audit 2026-09, R12 / F18).
 *
 * Its only link out was the "Feedback saved · Manage" chip. `find_output`,
 * `edit_output` and `reschedule_output` all terminated as model prose in the
 * transcript, so a client who asked the copilot to find their post was handed a
 * description of a deliverable and nothing to press — while the product has one
 * deliverable viewer, `AssetDetailModal`, with eight other openers.
 *
 * The fix is a MOUNT, and this file pins the three joints that make it one:
 *  1. the id the tools already name reaches the client (client-stream.ts now
 *     carries a tool call's INPUT beside its output — `edit_output` and
 *     `reschedule_output` name their asset only there);
 *  2. the widget turns that into a chip of the same family as the feedback one;
 *  3. the chip opens the SAME modal, fed by a route whose authorization is the
 *     gate the asset media routes already use — no new reach, no second viewer.
 *
 * Structure, not rendering: `vitest.config.ts` runs `environment: "node"` and
 * this widget imports server actions, which is the same reason
 * chatbot-widget-feedback-chip.test.ts and chatbot-widget-model-picker.test.ts
 * are written this way. The stream half has real behavioural coverage in
 * src/lib/chat/__tests__/client-stream.test.ts.
 */

const REPO = join(__dirname, "..", "..", "..");
const read = (rel: string) => readFileSync(join(REPO, rel), "utf8");

const WIDGET = "src/components/chatbot-widget.tsx";
const STREAM = "src/lib/chat/client-stream.ts";
const ROUTE = "src/app/api/assets/[id]/route.ts";
const CHAT_ROUTE = "src/app/api/clients/[id]/chat/route.ts";

describe("the asset id the tools already name reaches the widget", () => {
  it("carries a tool call's input through with its result", () => {
    const src = read(STREAM);
    expect(src).toMatch(/toolInputByCallId/);
    expect(src).toMatch(/type: "tool-result"[\s\S]{0,200}input/);
  });

  it("reads find_output's id out of the shape that tool actually prints", () => {
    // The premise, asserted against the producer rather than assumed: if the
    // tool stops printing `id: <id>` on its own line, this test fails HERE
    // instead of the chip silently never appearing.
    expect(read(CHAT_ROUTE)).toContain("`id: ${asset.id}`");
    expect(read(WIDGET)).toMatch(/\^id: \(\\S\+\)\$/);
  });

  it("reads edit/reschedule's id out of their input, since their result has none", () => {
    const chat = read(CHAT_ROUTE);
    // Both take `assetId` as an input field and answer in prose.
    expect(chat).toMatch(/assetId: z\.string\(\)/);
    const widget = read(WIDGET);
    expect(widget).toMatch(/evt\.toolName === "edit_output" \|\| evt\.toolName === "reschedule_output"/);
    expect(widget).toMatch(/input\.assetId/);
  });

  it("offers no chip where there is not exactly one thing to open", () => {
    const widget = read(WIDGET);
    // A multi-match find_output lists several ids; a refusal is still a tool
    // result. Both must produce nothing rather than a chip that opens the
    // wrong post or none.
    expect(widget).toMatch(/if \(ids\.length !== 1\) return null;/);
    expect(widget).toMatch(/Saved\\\.\|Moved to/);
  });
});

describe("the chip opens the portal's own deliverable viewer", () => {
  it("is a chip on the assistant turn that produced it, like the feedback one", () => {
    const src = read(WIDGET);
    expect(src).toMatch(/msg\.role === "assistant" && msg\.deliverables && msg\.deliverables\.length > 0/);
    expect(src).toMatch(/<DeliverableChip/);
  });

  it("mounts AssetDetailModal rather than a second viewer written for the chat", () => {
    const src = read(WIDGET);
    expect(src).toContain('import { AssetDetailModal } from "@/components/asset-detail-modal"');
    expect(src).toMatch(/<AssetDetailModal[\s\S]{0,400}viewerIsClient=/);
  });

  it("survives a reload with the rest of the transcript, or is dropped as malformed", () => {
    const src = read(WIDGET);
    expect(src).toContain("isPersistedDeliverable");
    expect(src).toMatch(/m\.deliverables === undefined \|\|/);
  });
});

describe("a chip that failed once can be pressed again", () => {
  it("keys the fetch on a per-press nonce, not on the id alone", () => {
    const src = read(WIDGET);
    // After a failure `openAssetId` is still set, so pressing the same chip set
    // state to the value it already held, React bailed out, and the effect
    // never re-ran — the chip went dead for the session over one dropped
    // request.
    expect(src).toMatch(/setAssetRequest\(\(n\) => n \+ 1\)/);
    expect(src).toMatch(/\}, \[openAssetId, assetRequest\]\)/);
  });
});

describe("the route the chip reads the asset from", () => {
  it("asks the same gate the asset media routes ask", () => {
    const src = read(ROUTE);
    expect(src).toContain("authorizeAssetMedia");
    // …and redacts for a client before answering, exactly as every page that
    // renders one does.
    expect(src).toContain("getClientLibraryAssets");
    expect(src).toMatch(/forClient: isClient/);
  });

  it("answers with the viewer, so the modal is not left to assume one", () => {
    expect(read(ROUTE)).toMatch(/viewerIsClient: isClient/);
  });

  it("refuses with the same 404 whether it is missing or withheld", () => {
    // A distinguishable refusal would confirm the asset exists.
    expect(read(ROUTE)).toMatch(/status: 404/);
  });
});
