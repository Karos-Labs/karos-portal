import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { downloadContextFiles } from "../runner/src/context-files.js";
import type { ContextFileRef } from "../src/types.js";

const originalFetch = global.fetch;

function mockFetch(body: string) {
  global.fetch = vi.fn(async () => {
    return new Response(body, { status: 200 });
  }) as unknown as typeof fetch;
}

describe("downloadContextFiles", () => {
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("writes to client_context/files/ only when client_path is absent", async () => {
    mockFetch("hello");
    const repo = await mkdtemp(path.join(tmpdir(), "ctx-files-"));
    const files: ContextFileRef[] = [{ name: "notes.md", url: "https://example.com/notes.md" }];
    const results = await downloadContextFiles(repo, "acme", files);
    expect(results[0]?.clientPath).toBeUndefined();
    const content = await readFile(path.join(repo, "client_context", "files", "notes.md"), "utf8");
    expect(content).toBe("hello");
  });

  it("also materializes the file at clients/<slug>/<client_path> when set", async () => {
    mockFetch('{"takes":[]}');
    const repo = await mkdtemp(path.join(tmpdir(), "ctx-files-"));
    const files: ContextFileRef[] = [
      {
        name: "takes.json",
        url: "https://example.com/takes.json",
        client_path: "internal/x-agent/takes.json",
      },
    ];
    const results = await downloadContextFiles(repo, "acme", files);
    expect(results[0]?.clientPath).toBe("internal/x-agent/takes.json");
    const content = await readFile(path.join(repo, "clients", "acme", "internal", "x-agent", "takes.json"), "utf8");
    expect(content).toBe('{"takes":[]}');
    // Still lands in the generic location too.
    await readFile(path.join(repo, "client_context", "files", "takes.json"), "utf8");
  });

  it("rejects a client_path that escapes the client folder", async () => {
    mockFetch("x");
    const repo = await mkdtemp(path.join(tmpdir(), "ctx-files-"));
    const files: ContextFileRef[] = [
      { name: "evil.json", url: "https://example.com/evil.json", client_path: "../../etc/passwd" },
    ];
    await expect(downloadContextFiles(repo, "acme", files)).rejects.toThrow(/escapes the client folder/);
  });
});
