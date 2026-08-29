import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * SCRUM-249 [T-B5]: the copilot chat's file upload surface.
 *
 * Before this ticket there was no file input in the chat at all, and the
 * only path from a client-attached file to agent-engine's `mediaAssets` was
 * the run dialog's raw-JSON textarea (`withEngineRunFields`,
 * custom-agent-launch.ts) — nothing turned an actual upload into a
 * `MediaAsset.uri`. This pins the things that make the wiring real rather
 * than cosmetic:
 *
 *  1. the route parses and validates an `attachments` request-body field,
 *     SCOPED TO clientId (chat-attachments.test.ts covers `parseChatAttachments`
 *     itself in isolation; this file confirms the ROUTE actually calls it
 *     that way, on the untyped `body.attachments`, not a re-implementation
 *     and not a call that drops the clientId tenancy argument);
 *  2. `run_agent_now`'s executor folds the parsed attachments into
 *     `briefValues.mediaAssets` itself — never by handing the model a URI to
 *     retype, which is the exact failure mode of the textarea this replaces;
 *  3. that wiring is gated on `resolveDispatchedAgentEngineProductId` — the
 *     REAL per-run dispatch decision (agent-engine dispatch enabled AND this
 *     client cut over AND this agent key mapped), not on
 *     `resolveAgentEngineProductIdForCustomAgent(match.key)` alone. A prior
 *     version of this route used the narrower predicate, which is true
 *     whenever agent-engine has ANY workflow for the agent key, regardless of
 *     whether THIS client's runs actually reach agent-engine — so a client
 *     not yet cut over (AGENT_ENGINE_CUSTOM_AGENT_CLIENTS not naming them,
 *     the normal state mid-migration) was told "Attached ... as source media
 *     for this run" for a run that silently fell through to the legacy
 *     agent-service path, which never reads `mediaAssets` at all. This test
 *     fails against that narrower call and only passes against the corrected
 *     one.
 *
 * Same source-scan approach as chat-route-run-agent-now.test.ts and
 * chat-route-agent-guard.test.ts for this same 1000+ line file, rather than
 * executing the handler (which needs a live Firestore + AI SDK stream).
 */

const REPO = join(__dirname, "..", "..", "..");
const CHAT_ROUTE = "src/app/api/clients/[id]/chat/route.ts";
const source = () => readFileSync(join(REPO, CHAT_ROUTE), "utf8");

function runAgentNowToolBody(src: string): string {
  const start = src.indexOf("const runAgentNowTool");
  expect(start, "runAgentNowTool not found").toBeGreaterThan(-1);
  const end = src.indexOf("const rescheduleOutputTool", start);
  expect(end, "rescheduleOutputTool (end marker) not found").toBeGreaterThan(start);
  return src.slice(start, end);
}

describe("chat route wires a real chat-turn upload into run_agent_now's mediaAssets", () => {
  it("imports the shared attachment parser instead of re-implementing validation inline", () => {
    expect(source()).toMatch(/import\s*\{\s*parseChatAttachments\s*\}\s*from\s*["']@\/lib\/chat\/chat-attachments["']/);
  });

  it("parses body.attachments once, SCOPED TO clientId, ahead of any tool, rather than trusting it raw", () => {
    const src = source();
    expect(src).toMatch(/const\s+turnAttachments\s*=\s*parseChatAttachments\(body\.attachments,\s*clientId\)/);
  });

  it("tells the model attachments exist without ever handing it a URI to retype", () => {
    const src = source();
    const idx = src.indexOf("attachmentsAppendix");
    expect(idx, "attachmentsAppendix not found").toBeGreaterThan(-1);
    const appendixDecl = src.slice(idx, src.indexOf("styleAppendix", idx));
    // The appendix must reference the attachment COUNT/labels, never `.uri`.
    expect(appendixDecl).toMatch(/turnAttachments\.length/);
    expect(appendixDecl).not.toMatch(/\.uri\b/);
    // The appendix must actually be threaded into the composed systemPrompt.
    expect(src).toMatch(/systemPrompt\s*=[\s\S]*?attachmentsAppendix/);
  });

  it("imports resolveDispatchedAgentEngineProductId from agent-engine/health, the REAL per-run dispatch gate", () => {
    expect(source()).toMatch(
      /import\s*\{\s*resolveDispatchedAgentEngineProductId\s*\}\s*from\s*["']@\/lib\/agent-engine\/health["']/,
    );
  });

  it("decides media-wiring from resolveDispatchedAgentEngineProductId(match.key, client.agentsRepoSlug), not the narrower per-agent-only predicate", () => {
    const body = runAgentNowToolBody(source());
    expect(body).toMatch(/resolveDispatchedAgentEngineProductId\(\s*match\.key\s*,\s*client\.agentsRepoSlug\s*\)/);
    expect(body).toMatch(/agentEngineProductAcceptsMediaAssets\(engineProductId\)/);
    // The regression this test exists to catch: a call to the narrower,
    // client-blind predicate as the thing `mediaCapable` is decided from.
    expect(body).not.toMatch(/mediaCapable\s*=\s*agentEngineProductAcceptsMediaAssets\(\s*resolveAgentEngineProductIdForCustomAgent/);
  });

  it("builds briefValues.mediaAssets from turnAttachments, not from the model's own briefValues", () => {
    const body = runAgentNowToolBody(source());
    expect(body).toMatch(/mediaAssets:\s*JSON\.stringify\(turnAttachments\)/);
  });

  it("threads the resulting briefValues into runCustomAgentAction under the effective (not raw) name", () => {
    const body = runAgentNowToolBody(source());
    const callStart = body.indexOf("runCustomAgentAction({");
    expect(callStart, "runCustomAgentAction call not found").toBeGreaterThan(-1);
    const callEnd = body.indexOf("});", callStart);
    const call = body.slice(callStart, callEnd);
    expect(call).toMatch(/briefValues:\s*effectiveBriefValues/);
  });

  it("still runs (does not refuse) when attachments exist but the matched agent has no use for media", () => {
    const body = runAgentNowToolBody(source());
    // The non-media-capable branch only sets a note, and does not `return`
    // out of the tool early - the run proceeds either way, whether that is
    // because the product itself doesn't read media or because this
    // client's runs of it don't reach agent-engine at all.
    const branchStart = body.indexOf("if (mediaCapable)");
    expect(branchStart).toBeGreaterThan(-1);
    const elseBranch = body.slice(body.indexOf("} else {", branchStart), body.indexOf("}", body.indexOf("attachmentNote =", branchStart) + 1) + 1);
    expect(elseBranch).not.toMatch(/\breturn\b/);
  });

  it("surfaces what happened to the attachment in the confirmation the client actually reads", () => {
    const body = runAgentNowToolBody(source());
    const returnIdx = body.lastIndexOf("Started a run of");
    expect(returnIdx).toBeGreaterThan(-1);
    expect(body.slice(returnIdx, returnIdx + 400)).toMatch(/attachmentNote/);
  });
});
