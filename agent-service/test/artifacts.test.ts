import { mkdtemp, mkdir, writeFile, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { collectArtifacts, isClientFacing, snapshotOutputs } from "../runner/src/artifacts.js";

describe("isClientFacing", () => {
  it("classifies by the contract's path conventions", () => {
    expect(isClientFacing("clients/x/outputs/ig/2026-07-05-run/client/post-1.png")).toBe(true);
    expect(isClientFacing("clients/x/outputs/ig/2026-07-05-run/internal/notes.md")).toBe(false);
    expect(isClientFacing("clients/x/outputs/_ledger/deliverables.jsonl")).toBe(false);
    expect(isClientFacing("outputs/report.pdf")).toBe(true);
    expect(isClientFacing("outputs/internal/debug.txt")).toBe(false);
  });
});

describe("snapshot + collect", () => {
  it("collects only new and changed files under the output roots", async () => {
    const repo = await mkdtemp(path.join(tmpdir(), "artifacts-test-"));
    const outDir = path.join(repo, "clients/acme/outputs/blog/run/client");
    await mkdir(outDir, { recursive: true });
    const preexisting = path.join(outDir, "old.md");
    await writeFile(preexisting, "old content");
    await utimes(preexisting, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));

    const before = await snapshotOutputs(repo, "acme");
    await writeFile(path.join(outDir, "new.md"), "fresh");
    await writeFile(preexisting, "old content changed");
    await mkdir(path.join(repo, "clients/acme/outputs/_ledger"), { recursive: true });
    await writeFile(path.join(repo, "clients/acme/outputs/_ledger/events.jsonl"), "{}\n");

    const { artifacts, skipped } = await collectArtifacts(repo, "acme", before);
    const relPaths = artifacts.map((a) => a.relPath).sort();
    expect(relPaths).toEqual([
      "clients/acme/outputs/_ledger/events.jsonl",
      "clients/acme/outputs/blog/run/client/new.md",
      "clients/acme/outputs/blog/run/client/old.md",
    ]);
    expect(artifacts.find((a) => a.relPath.endsWith("events.jsonl"))?.clientFacing).toBe(false);
    expect(artifacts.find((a) => a.relPath.endsWith("new.md"))?.clientFacing).toBe(true);
    expect(skipped).toEqual([]);
  });

  it("also captures durable state under skills/ and profile/, never as client-facing", async () => {
    const repo = await mkdtemp(path.join(tmpdir(), "artifacts-test-"));
    const skillsDir = path.join(repo, "clients/acme/skills/x-agent");
    const profileDir = path.join(repo, "clients/acme/profile/executives");
    await mkdir(skillsDir, { recursive: true });
    await mkdir(profileDir, { recursive: true });
    await writeFile(path.join(skillsDir, "x-ledger.json"), "[]");

    const before = await snapshotOutputs(repo, "acme");
    await writeFile(path.join(skillsDir, "x-ledger.json"), '[{"id":1}]');
    await writeFile(path.join(profileDir, "jane-doe.md"), "# Jane Doe\n");

    const { artifacts } = await collectArtifacts(repo, "acme", before);
    const relPaths = artifacts.map((a) => a.relPath.split(path.sep).join("/")).sort();
    expect(relPaths).toEqual(["clients/acme/profile/executives/jane-doe.md", "clients/acme/skills/x-agent/x-ledger.json"]);
    expect(artifacts.every((a) => !a.clientFacing)).toBe(true);
  });
});
