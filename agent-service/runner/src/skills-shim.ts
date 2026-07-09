import { mkdir, readdir, symlink, access } from "node:fs/promises";
import path from "node:path";

const MAX_DEPTH = 4;

/** Recursively find directories containing a SKILL.md under root. */
export async function collectSkillDirs(root: string, depth = 0): Promise<string[]> {
  if (depth > MAX_DEPTH) return [];
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const found: string[] = [];
  if (entries.some((e) => e.isFile() && e.name === "SKILL.md")) {
    found.push(root);
  }
  for (const entry of entries) {
    if (entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== "node_modules") {
      found.push(...(await collectSkillDirs(path.join(root, entry.name), depth + 1)));
    }
  }
  return found;
}

/**
 * Builds the .claude/skills/ shim: relative symlinks pointing at every skill
 * directory this task type needs. Nothing in the source repo is modified —
 * the shim exists only in the throwaway job workspace, and the SDK discovers
 * skills through it exactly as authored.
 */
export async function buildSkillsShim(params: {
  repoDir: string;
  entrySkillDir: string;
  skillRoots: string[];
  clientSlug: string;
  includeClientSkills: boolean;
}): Promise<string[]> {
  const shimDir = path.join(params.repoDir, ".claude", "skills");
  await mkdir(shimDir, { recursive: true });

  const roots = [params.entrySkillDir, ...params.skillRoots];
  if (params.includeClientSkills) roots.push(`clients/${params.clientSlug}/skills`);

  const skillDirs = new Set<string>();
  const entryAbs = path.join(params.repoDir, params.entrySkillDir);
  for (const root of roots) {
    const abs = path.join(params.repoDir, root);
    try {
      await access(path.join(abs, "SKILL.md"));
      skillDirs.add(abs);
      continue;
    } catch {
      // not itself a skill dir — scan below it
    }
    for (const dir of await collectSkillDirs(abs)) skillDirs.add(dir);
  }

  // The entry skill is the whole point of the run — if its configured path
  // resolved to nothing (a stale task-types.ts path after a repo reorg), fail
  // loudly instead of silently running the agent with no skill to execute.
  if (!skillDirs.has(entryAbs)) {
    throw new Error(
      `entry skill not found at "${params.entrySkillDir}" (no SKILL.md) — ` +
        `the task-type config points at a path missing from the agents repo`,
    );
  }

  const used = new Set<string>();
  const linked: string[] = [];
  for (const target of [...skillDirs].sort()) {
    let name = path.basename(target);
    if (used.has(name)) name = `${path.basename(path.dirname(target))}-${name}`;
    let candidate = name;
    for (let i = 2; used.has(candidate); i++) candidate = `${name}-${i}`;
    used.add(candidate);
    await symlink(path.relative(shimDir, target), path.join(shimDir, candidate), "dir");
    linked.push(candidate);
  }
  return linked;
}
