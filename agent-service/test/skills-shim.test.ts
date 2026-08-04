import { mkdtemp, mkdir, writeFile, readlink, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildSkillsShim, collectSkillDirs } from "../runner/src/skills-shim.js";

async function makeSkill(root: string, rel: string, name?: string): Promise<void> {
  const dir = path.join(root, rel);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "SKILL.md"), `---\nname: ${name ?? path.basename(rel)}\n---\nbody\n`);
}

describe("skills shim", () => {
  it("links entry skill, vendor trees, and client skills with collision handling", async () => {
    const repo = await mkdtemp(path.join(tmpdir(), "shim-test-"));
    await makeSkill(repo, "products/social/blog-agent", "karos-blog-agent");
    await makeSkill(repo, "skills/vendors/pack/skills/seo-audit");
    await makeSkill(repo, "skills/vendors/otherpack/skills/seo-audit");
    await makeSkill(repo, "clients/acme/skills/blog/how-to");

    const linked = await buildSkillsShim({
      repoDir: repo,
      entrySkillDir: "products/social/blog-agent",
      skillRoots: ["skills/vendors/pack", "skills/vendors/otherpack"],
      clientSlug: "acme",
      includeClientSkills: true,
    });

    expect(linked).toContain("blog-agent");
    expect(linked).toContain("how-to");
    expect(linked.filter((n) => n.includes("seo-audit"))).toHaveLength(2);

    const shimDir = path.join(repo, ".claude", "skills");
    const entries = await readdir(shimDir);
    expect(entries.sort()).toEqual([...linked].sort());

    for (const entry of entries) {
      const target = await readlink(path.join(shimDir, entry));
      expect(path.isAbsolute(target)).toBe(false);
      const content = await readFile(path.join(shimDir, entry, "SKILL.md"), "utf8");
      expect(content).toContain("name:");
    }
  });

  it("throws when the entry skill path resolves to no SKILL.md", async () => {
    const repo = await mkdtemp(path.join(tmpdir(), "shim-missing-"));
    // Only a vendor skill exists; the configured entry path is absent (the
    // stale-path regression that silently ran the agent with no entry skill).
    await makeSkill(repo, "skills/vendors/pack/skills/seo-audit");

    await expect(
      buildSkillsShim({
        repoDir: repo,
        entrySkillDir: "products/social/instagram-tiktok-agent",
        skillRoots: ["skills/vendors/pack"],
        clientSlug: "acme",
        includeClientSkills: false,
      }),
    ).rejects.toThrow(/entry skill not found/);
  });

  it("refuses roots that resolve outside the repo copy", async () => {
    const repo = await mkdtemp(path.join(tmpdir(), "shim-escape-"));
    await makeSkill(repo, "products/social/blog-agent", "karos-blog-agent");
    await expect(
      buildSkillsShim({
        repoDir: repo,
        entrySkillDir: "../outside",
        skillRoots: [],
        clientSlug: "acme",
        includeClientSkills: false,
      }),
    ).rejects.toThrow(/escapes the agents repo/);
    await expect(
      buildSkillsShim({
        repoDir: repo,
        entrySkillDir: "products/social/blog-agent",
        skillRoots: ["products/../../etc"],
        clientSlug: "acme",
        includeClientSkills: false,
      }),
    ).rejects.toThrow(/escapes the agents repo/);
  });

  it("collectSkillDirs finds nested skills but respects the depth cap", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "collect-test-"));
    await makeSkill(root, "a");
    await makeSkill(root, "b/c/d");
    await makeSkill(root, "x/1/2/3/4/5/too-deep");
    const dirs = await collectSkillDirs(root);
    const rels = dirs.map((d) => path.relative(root, d).split(path.sep).join("/")).sort();
    expect(rels).toContain("a");
    expect(rels).toContain("b/c/d");
    expect(rels.find((r) => r.includes("too-deep"))).toBeUndefined();
  });
});
