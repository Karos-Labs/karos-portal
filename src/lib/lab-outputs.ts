import "server-only";

import type { AssetType } from "@/lib/types";
import {
  groupRunFiles,
  guessAssetType,
  humanizeItemName,
  normalizeLabSlug,
  pickPrimaryFiles,
  type LabFile,
  type LabItemGroup,
} from "./lab-outputs-shared";

/**
 * Read-only access to the karos-agents lab repo's committed run outputs
 * (clients/<slug>/outputs/<agent>/<run>/client/ — the lab contract's
 * client-visible side), via the GitHub contents API. Used by the staff
 * "Import lab outputs" flow to pull manually-run deliverables into the
 * platform as reviewable assets.
 *
 * Auth: AGENTS_REPO_GITHUB_TOKEN (read access to the private repo). The repo
 * itself is never written to.
 */

const API = "https://api.github.com";
// Real runs are heavy: an IG carousel item ≈ 30MB of slides, 6+ items per run.
export const MAX_LAB_FILE_BYTES = 25 * 1024 * 1024;
export const MAX_LAB_RUN_BYTES = 500 * 1024 * 1024;
export const MAX_LAB_RUN_FILES = 120;

function config(): { repo: string; token: string } | null {
  const token = process.env.AGENTS_REPO_GITHUB_TOKEN;
  if (!token) return null;
  return { repo: process.env.AGENTS_REPO ?? "karoslabs/karos-agents", token };
}

export function isLabOutputsConfigured(): boolean {
  return config() !== null;
}

async function ghJson<T>(path: string): Promise<T> {
  const cfg = config();
  if (!cfg) throw new Error("AGENTS_REPO_GITHUB_TOKEN is not configured.");
  const res = await fetch(`${API}/repos/${cfg.repo}/${path}`, {
    headers: {
      authorization: `Bearer ${cfg.token}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
    },
    signal: AbortSignal.timeout(30_000),
    cache: "no-store",
  });
  if (res.status === 404) throw new Error("NOT_FOUND");
  if (!res.ok) throw new Error(`GitHub API ${path} failed (${res.status})`);
  return (await res.json()) as T;
}

interface GhEntry {
  type: "file" | "dir" | "symlink" | "submodule";
  name: string;
  path: string;
  size: number;
}

async function listDir(path: string): Promise<GhEntry[]> {
  try {
    const entries = await ghJson<GhEntry[] | GhEntry>(`contents/${encodeURI(path)}`);
    return Array.isArray(entries) ? entries : [];
  } catch (e) {
    if (e instanceof Error && e.message === "NOT_FOUND") return [];
    throw e;
  }
}

export interface LabRun {
  agentFolder: string;
  runName: string;
  /** repo-relative path of the run folder */
  path: string;
  /** whether the run has a client/ side to import */
  hasClientFolder: boolean;
}

/** Lists a client's committed lab runs, newest first (run names lead with YYYY-MM-DD). */
export async function listLabOutputRuns(slug: string): Promise<LabRun[]> {
  const agentFolders = (await listDir(`clients/${slug}/outputs`)).filter(
    (e) => e.type === "dir" && !e.name.startsWith("_"),
  );
  const perAgent = await Promise.all(
    agentFolders.map(async (agent) => {
      const runDirs = (await listDir(agent.path)).filter((e) => e.type === "dir");
      return Promise.all(
        runDirs.map(async (run): Promise<LabRun> => {
          const contents = await listDir(run.path);
          return {
            agentFolder: agent.name,
            runName: run.name,
            path: run.path,
            hasClientFolder: contents.some((e) => e.type === "dir" && e.name === "client"),
          };
        }),
      );
    }),
  );
  return perAgent.flat().sort((a, b) => b.runName.localeCompare(a.runName));
}

/** Recursively lists files under the run's client/ folder (the client-visible deliverables). */
export async function listRunClientFiles(
  slug: string,
  agentFolder: string,
  runName: string,
): Promise<LabFile[]> {
  const base = `clients/${slug}/outputs/${agentFolder}/${runName}/client`;
  const files: LabFile[] = [];
  async function walk(path: string, depth: number): Promise<void> {
    if (depth > 4 || files.length >= MAX_LAB_RUN_FILES) return;
    for (const entry of await listDir(path)) {
      if (files.length >= MAX_LAB_RUN_FILES) return;
      if (entry.type === "file") {
        files.push({ name: entry.name, path: entry.path, relPath: entry.path.slice(base.length + 1), size: entry.size });
      } else if (entry.type === "dir") {
        await walk(entry.path, depth + 1);
      }
    }
  }
  await walk(base, 0);
  return files;
}

/** Downloads one file's raw bytes (works for private repos at any blob size GitHub serves raw). */
export async function downloadLabFile(path: string): Promise<Buffer> {
  const cfg = config();
  if (!cfg) throw new Error("AGENTS_REPO_GITHUB_TOKEN is not configured.");
  const res = await fetch(`${API}/repos/${cfg.repo}/contents/${encodeURI(path)}`, {
    headers: {
      authorization: `Bearer ${cfg.token}`,
      accept: "application/vnd.github.raw",
      "x-github-api-version": "2022-11-28",
    },
    signal: AbortSignal.timeout(120_000),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`GitHub raw download failed (${res.status}) for ${path}`);
  return Buffer.from(await res.arrayBuffer());
}

export { groupRunFiles, guessAssetType, humanizeItemName, normalizeLabSlug, pickPrimaryFiles };
export type { LabFile, LabItemGroup, AssetType };
