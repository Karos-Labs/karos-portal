import { execFile } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readdir, readFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it, beforeAll } from "vitest";
import { deriveSlug, prepareWorkspace, writeClientContext } from "../runner/src/workspace.js";

const execFileAsync = promisify(execFile);

describe("deriveSlug", () => {
  it("passes through an explicit slug and sanitizes client ids", () => {
    expect(deriveSlug("whatever", "xodigital")).toBe("xodigital");
    expect(deriveSlug("Client ID_42!")).toBe("client-id-42");
    expect(deriveSlug("///")).toBe("client");
  });
});

describe("prepareWorkspace", () => {
  let bakedRepo: string;
  /** The first commit's sha — older than HEAD, only reachable with full history. */
  let firstCommitSha: string;

  beforeAll(async () => {
    bakedRepo = await mkdtemp(path.join(tmpdir(), "baked-repo-"));
    await writeFile(path.join(bakedRepo, "CLAUDE.md"), "# lab rules\n");
    for (const client of ["acme", "other", "_cso"]) {
      await mkdir(path.join(bakedRepo, "clients", client, "profile"), { recursive: true });
      await writeFile(path.join(bakedRepo, "clients", client, "README.md"), `# ${client}\n`);
    }
    await writeFile(path.join(bakedRepo, "clients", "EXPORT-NOTES.md"), "notes\n");
    await mkdir(path.join(bakedRepo, "products/social/blog-agent"), { recursive: true });
    await writeFile(path.join(bakedRepo, "products/social/blog-agent/SKILL.md"), "---\nname: x\n---\n");
    const git = (...args: string[]) => execFileAsync("git", ["-C", bakedRepo, ...args]);
    await execFileAsync("git", ["init", "-q", bakedRepo]);
    await git("config", "user.email", "t@t");
    await git("config", "user.name", "t");
    await git("add", "-A");
    await git("commit", "-qm", "init");
    firstCommitSha = (await git("rev-parse", "HEAD")).stdout.trim();
    // A second commit, so HEAD moves past firstCommitSha and there's real
    // history for the shallow-vs-full-clone tests below to tell apart.
    await writeFile(path.join(bakedRepo, "CLAUDE.md"), "# lab rules v2\n");
    await git("add", "-A");
    await git("commit", "-qm", "v2");
  });

  it("prunes every other client, keeps the target, records the sha", async () => {
    const workDir = await mkdtemp(path.join(tmpdir(), "work-"));
    const ws = await prepareWorkspace({ bakedRepoDir: bakedRepo, workDir, clientId: "c1", clientSlug: "acme" });
    expect(ws.clientSlug).toBe("acme");
    expect(ws.clientScaffolded).toBe(false);
    expect(ws.agentsRepoSha).toMatch(/^[0-9a-f]{40}$/);
    const clients = (await readdir(path.join(ws.repoDir, "clients"), { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
    expect(clients).toEqual(["acme"]);
    await access(path.join(ws.repoDir, "clients", "EXPORT-NOTES.md"));
  });

  it("scaffolds a client that has no lab folder", async () => {
    const workDir = await mkdtemp(path.join(tmpdir(), "work-"));
    const ws = await prepareWorkspace({ bakedRepoDir: bakedRepo, workDir, clientId: "New Client!" });
    expect(ws.clientSlug).toBe("new-client");
    expect(ws.clientScaffolded).toBe(true);
    const readme = await readFile(path.join(ws.repoDir, "clients/new-client/README.md"), "utf8");
    expect(readme).toContain("client_context/");
  });

  it("fails clearly when agent_version is not in the baked clone", async () => {
    const workDir = await mkdtemp(path.join(tmpdir(), "work-"));
    await expect(
      prepareWorkspace({
        bakedRepoDir: bakedRepo,
        workDir,
        clientId: "c1",
        clientSlug: "acme",
        agentVersion: "deadbeef",
      }),
    ).rejects.toThrow(/not present in the baked agents repo/);
  });

  it("clones shallow by default — only HEAD is reachable, not older history", async () => {
    const workDir = await mkdtemp(path.join(tmpdir(), "work-"));
    const ws = await prepareWorkspace({ bakedRepoDir: bakedRepo, workDir, clientId: "c1", clientSlug: "acme" });
    const { stdout } = await execFileAsync("git", ["-C", ws.repoDir, "rev-list", "--count", "HEAD"]);
    expect(stdout.trim()).toBe("1");
    await expect(
      execFileAsync("git", ["-C", ws.repoDir, "cat-file", "-e", firstCommitSha]),
    ).rejects.toThrow();
  });

  it("clones full history when agent_version is set, so an older ref is still reachable", async () => {
    const workDir = await mkdtemp(path.join(tmpdir(), "work-"));
    // A depth-1 clone of the baked repo's HEAD ("v2") wouldn't even contain
    // firstCommitSha's object, so this only succeeds if the clone fetched
    // full history for the checkout below to find it.
    const ws = await prepareWorkspace({
      bakedRepoDir: bakedRepo,
      workDir,
      clientId: "c1",
      clientSlug: "acme",
      agentVersion: firstCommitSha,
    });
    expect(ws.agentsRepoSha).toBe(firstCommitSha);
  });

  it("writes the brief into client_context", async () => {
    const workDir = await mkdtemp(path.join(tmpdir(), "work-"));
    const ws = await prepareWorkspace({ bakedRepoDir: bakedRepo, workDir, clientId: "c1", clientSlug: "acme" });
    await writeClientContext({ repoDir: ws.repoDir, brief: { topic: "hello", count: 2, skip: "" } });
    const brief = await readFile(path.join(ws.repoDir, "client_context/brief.md"), "utf8");
    expect(brief).toContain("**topic**: hello");
    expect(brief).toContain("**count**: 2");
    expect(brief).not.toContain("skip");
  });
});
