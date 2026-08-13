import { describe, expect, it } from "vitest";
import { extractWriteCheckpoint } from "../runner/src/transcript.js";

/**
 * The hardcoded path's step-boundary signal — see extractWriteCheckpoint's
 * own doc comment. Only a `Write` tool call targeting the client's own
 * `outputs/` tree counts; everything else (a different tool, a Write
 * outside that tree, a non-assistant message) must be `null`.
 */

function assistantWrite(filePath: string): unknown {
  return {
    type: "assistant",
    message: { content: [{ type: "tool_use", name: "Write", input: { file_path: filePath } }] },
  };
}

const REPO_DIR = "/work/repo";
const CLIENT_SLUG = "acme";

describe("extractWriteCheckpoint", () => {
  it("returns the repo-relative path for a Write under the client's outputs/ tree", () => {
    const path = extractWriteCheckpoint(
      assistantWrite(`${REPO_DIR}/clients/${CLIENT_SLUG}/outputs/linkedin-agent-v2/run/internal/06-angles.json`),
      REPO_DIR,
      CLIENT_SLUG,
    );
    expect(path).toBe(`clients/${CLIENT_SLUG}/outputs/linkedin-agent-v2/run/internal/06-angles.json`);
  });

  it("returns null for a Write outside the client's outputs/ tree (skill scratch files, .claude/ config)", () => {
    const path = extractWriteCheckpoint(
      assistantWrite(`${REPO_DIR}/.claude/settings.json`),
      REPO_DIR,
      CLIENT_SLUG,
    );
    expect(path).toBeNull();
  });

  it("returns null for a different tool call (Edit, Bash, etc.)", () => {
    const message = {
      type: "assistant",
      message: {
        content: [
          { type: "tool_use", name: "Edit", input: { file_path: `${REPO_DIR}/clients/${CLIENT_SLUG}/outputs/x.json` } },
        ],
      },
    };
    expect(extractWriteCheckpoint(message, REPO_DIR, CLIENT_SLUG)).toBeNull();
  });

  it("returns null for a non-assistant message (result, system, user)", () => {
    expect(extractWriteCheckpoint({ type: "result", subtype: "success" }, REPO_DIR, CLIENT_SLUG)).toBeNull();
    expect(extractWriteCheckpoint({ type: "system", subtype: "init" }, REPO_DIR, CLIENT_SLUG)).toBeNull();
    expect(extractWriteCheckpoint(null, REPO_DIR, CLIENT_SLUG)).toBeNull();
    expect(extractWriteCheckpoint("not an object", REPO_DIR, CLIENT_SLUG)).toBeNull();
  });

  it("returns null for an assistant message with only text, no tool_use", () => {
    const message = { type: "assistant", message: { content: [{ type: "text", text: "thinking..." }] } };
    expect(extractWriteCheckpoint(message, REPO_DIR, CLIENT_SLUG)).toBeNull();
  });

  it("finds a Write among multiple content blocks in the same turn", () => {
    const message = {
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "Writing the angles file now." },
          { type: "tool_use", name: "Write", input: { file_path: `${REPO_DIR}/clients/${CLIENT_SLUG}/outputs/06-angles.json` } },
        ],
      },
    };
    expect(extractWriteCheckpoint(message, REPO_DIR, CLIENT_SLUG)).toBe(`clients/${CLIENT_SLUG}/outputs/06-angles.json`);
  });
});
