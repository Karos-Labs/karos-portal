import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { restoreCheckpoint, saveCheckpoint, type CheckpointCallback } from "../runner/src/checkpoint.js";

/** In-memory stand-in for the service's checkpoint HTTP endpoints. */
function fakeCallback(): CheckpointCallback & { store: Map<string, Buffer> } {
  const store = new Map<string, Buffer>();
  return {
    store,
    async uploadCheckpointFile(params) {
      store.set(params.relPath, await readFile(params.absPath));
    },
    async fetchCheckpointManifest() {
      return { files: [...store.keys()].map((p) => ({ path: p, bytes: store.get(p)?.length ?? 0 })) };
    },
    async downloadCheckpointFile(relPath, destAbsPath) {
      const data = store.get(relPath);
      if (!data) throw new Error(`no such checkpoint file: ${relPath}`);
      await writeFile(destAbsPath, data);
    },
  };
}

function posix(relPath: string): string {
  return relPath.split(path.sep).join("/");
}

describe("saveCheckpoint + restoreCheckpoint", () => {
  it("round-trips every file under the output roots", async () => {
    const repo = await mkdtemp(path.join(tmpdir(), "checkpoint-test-"));
    const outDir = path.join(repo, "clients/acme/outputs/blog/run/client");
    await mkdir(outDir, { recursive: true });
    await writeFile(path.join(outDir, "draft.md"), "half-written draft");
    await mkdir(path.join(repo, "clients/acme/outputs/_ledger"), { recursive: true });
    await writeFile(path.join(repo, "clients/acme/outputs/_ledger/events.jsonl"), '{"step":1}\n');

    const callback = fakeCallback();
    await saveCheckpoint(callback, repo, "acme", 1);

    const savedPaths = [...callback.store.keys()].map(posix).sort();
    expect(savedPaths).toEqual([
      "clients/acme/outputs/_ledger/events.jsonl",
      "clients/acme/outputs/blog/run/client/draft.md",
    ]);

    const freshRepo = await mkdtemp(path.join(tmpdir(), "checkpoint-restore-"));
    const restoredCount = await restoreCheckpoint(callback, freshRepo);
    expect(restoredCount).toBe(2);
    const restoredDraft = await readFile(
      path.join(freshRepo, "clients/acme/outputs/blog/run/client/draft.md"),
      "utf8",
    );
    expect(restoredDraft).toBe("half-written draft");
  });

  it("restores nothing when no checkpoint exists", async () => {
    const callback = fakeCallback();
    const repo = await mkdtemp(path.join(tmpdir(), "checkpoint-empty-"));
    expect(await restoreCheckpoint(callback, repo)).toBe(0);
  });

  it("keeps saving the rest when one file's upload fails", async () => {
    const repo = await mkdtemp(path.join(tmpdir(), "checkpoint-partial-"));
    const outDir = path.join(repo, "clients/acme/outputs/blog/run/client");
    await mkdir(outDir, { recursive: true });
    await writeFile(path.join(outDir, "a.md"), "a");
    await writeFile(path.join(outDir, "b.md"), "b");

    const callback = fakeCallback();
    const originalUpload = callback.uploadCheckpointFile.bind(callback);
    callback.uploadCheckpointFile = async (params) => {
      if (params.relPath.endsWith("a.md")) throw new Error("simulated upload failure");
      return originalUpload(params);
    };

    await saveCheckpoint(callback, repo, "acme", 1);
    expect([...callback.store.keys()].map(posix)).toEqual(["clients/acme/outputs/blog/run/client/b.md"]);
  });
});
