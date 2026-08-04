import { readdir, stat } from "node:fs/promises";
import path from "node:path";

const MAX_ARTIFACTS = 500;
const MAX_SINGLE_ARTIFACT_BYTES = 100 * 1024 * 1024;

export interface WorkspaceSnapshot {
  files: Map<string, { size: number; mtimeMs: number }>;
}

export interface CollectedArtifact {
  absPath: string;
  relPath: string;
  clientFacing: boolean;
  bytes: number;
}

/**
 * Directories (repo-relative) that agents write deliverables into, PLUS the
 * two client-folder trees where cross-run durable state actually lives per
 * the client profile contract: `skills/<agent>/` (ledgers, topic catalogs,
 * per-client engine config) and `profile/` (voice profiles, learning-log
 * appends on executive profiles). Neither is captured by the platform today
 * without this — a fresh container clones the baked repo on every run, so
 * anything an agent appends to its own ledger or voice profile is otherwise
 * discarded the moment the container exits. Safe to always include: the
 * before/after diff in collectArtifacts only uploads files that actually
 * changed, so an untouched baked-in tree (e.g. a large per-client engine
 * clone under skills/) costs nothing extra per run.
 */
export function outputRoots(clientSlug: string): string[] {
  return [
    `clients/${clientSlug}/outputs`,
    `clients/${clientSlug}/skills`,
    `clients/${clientSlug}/profile`,
    // `internal/` holds two more pieces of durable state the same argument
    // covers: the LinkedIn v2 manager's AGENT-MEMORY.md (which it is the sole
    // author of, and which nothing wrote at all in v1) and the per-identity live
    // sections. Everything under it is `client_facing: false` by
    // `isClientFacing` below, so widening the WALK does not widen what a client
    // can see — it only makes the files reachable at all.
    `clients/${clientSlug}/internal`,
    // The v2 writer's suggested posting order
    // (`<agent>/calendar/CALENDAR-<YYYY-MM>.md`) lives directly under the client
    // folder, outside all four roots above, so without this the one output that
    // says WHEN each post should go out was collected from nowhere.
    `clients/${clientSlug}/linkedin-agent`,
    "outputs",
  ];
}

async function walk(dir: string, out: Map<string, { size: number; mtimeMs: number }>, base: string): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const abs = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      if (entry.name === ".git" || entry.name === "node_modules") continue;
      await walk(abs, out, base);
    } else if (entry.isFile()) {
      const info = await stat(abs);
      const rel = path.relative(base, abs).split(path.sep).join("/");
      out.set(rel, { size: info.size, mtimeMs: info.mtimeMs });
    }
  }
}

export async function snapshotOutputs(repoDir: string, clientSlug: string): Promise<WorkspaceSnapshot> {
  const files = new Map<string, { size: number; mtimeMs: number }>();
  for (const root of outputRoots(clientSlug)) {
    await walk(path.join(repoDir, root), files, repoDir);
  }
  return { files };
}

export function isClientFacing(relPath: string): boolean {
  const p = relPath.split(path.sep).join("/");
  if (p.includes("/_ledger/") || p.includes("/internal/")) return false;
  if (p.includes("/client/")) return true;
  return p.startsWith("outputs/");
}

/** New or changed files under the output roots since the pre-run snapshot. */
export async function collectArtifacts(
  repoDir: string,
  clientSlug: string,
  before: WorkspaceSnapshot,
): Promise<{ artifacts: CollectedArtifact[]; skipped: string[] }> {
  const after = await snapshotOutputs(repoDir, clientSlug);
  const artifacts: CollectedArtifact[] = [];
  const skipped: string[] = [];
  for (const [relPath, info] of after.files) {
    const prev = before.files.get(relPath);
    if (prev && prev.size === info.size && prev.mtimeMs === info.mtimeMs) continue;
    if (info.size > MAX_SINGLE_ARTIFACT_BYTES) {
      skipped.push(`${relPath} (too large: ${info.size} bytes)`);
      continue;
    }
    if (artifacts.length >= MAX_ARTIFACTS) {
      skipped.push(`${relPath} (artifact cap reached)`);
      continue;
    }
    artifacts.push({
      absPath: path.join(repoDir, relPath),
      relPath,
      clientFacing: isClientFacing(relPath),
      bytes: info.size,
    });
  }
  return { artifacts, skipped };
}

export function guessContentType(relPath: string): string | undefined {
  const ext = path.extname(relPath).toLowerCase();
  const map: Record<string, string> = {
    ".md": "text/markdown",
    ".txt": "text/plain",
    ".html": "text/html",
    ".css": "text/css",
    ".js": "text/javascript",
    ".json": "application/json",
    ".jsonl": "application/x-ndjson",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif",
    ".svg": "image/svg+xml",
    ".pdf": "application/pdf",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".csv": "text/csv",
    ".yaml": "application/yaml",
    ".yml": "application/yaml",
    ".mp4": "video/mp4",
  };
  return map[ext];
}
