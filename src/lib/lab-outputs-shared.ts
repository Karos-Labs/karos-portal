import type { AssetType } from "@/lib/types";

/**
 * Pure helpers for the lab-outputs import (no server-only import so they can
 * be unit-tested). File grouping mirrors the lab's CLIENT-PROFILE-CONTRACT:
 * a run's client/ side holds one folder per deliverable item (a carousel, an
 * article…), each with the deliverable file(s) + caption.txt + about.txt —
 * or occasionally flat files for single-item runs.
 */

export interface LabFile {
  name: string;
  /** repo-relative path */
  path: string;
  /** path relative to the run's client/ folder */
  relPath: string;
  size: number;
}

export interface LabItemGroup {
  /** item folder name, or "run" for flat files */
  key: string;
  files: LabFile[];
}

/** Groups client/ files by their top-level item folder; flat files form one "run" group. */
export function groupRunFiles(files: LabFile[]): LabItemGroup[] {
  const groups = new Map<string, LabFile[]>();
  for (const file of files) {
    const slash = file.relPath.indexOf("/");
    const key = slash === -1 ? "run" : file.relPath.slice(0, slash);
    const list = groups.get(key) ?? [];
    list.push(file);
    groups.set(key, list);
  }
  return [...groups.entries()]
    .map(([key, groupFiles]) => ({ key, files: groupFiles.sort((a, b) => a.relPath.localeCompare(b.relPath)) }))
    .sort((a, b) => a.key.localeCompare(b.key));
}

const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);
const TEXT_EXT = new Set([".md", ".txt", ".html"]);

function ext(name: string): string {
  const i = name.lastIndexOf(".");
  return i >= 0 ? name.slice(i).toLowerCase() : "";
}

/**
 * Picks the asset body + hero image for an item group. caption.txt wins as the
 * body (that's what the portal shows next to a post); otherwise the largest
 * text deliverable. about.txt is kept separately for meta, and data.json (when
 * the lab emits it) carries the item's declared template `format` and internal
 * `date` for the content chain.
 */
export function pickPrimaryFiles(files: LabFile[]): {
  captionFile?: LabFile;
  aboutFile?: LabFile;
  textFile?: LabFile;
  dataJsonFile?: LabFile;
  imageFiles: LabFile[];
} {
  const captionFile = files.find((f) => f.name.toLowerCase() === "caption.txt");
  const aboutFile = files.find((f) => f.name.toLowerCase() === "about.txt");
  const dataJsonFile = files.find((f) => f.name.toLowerCase() === "data.json");
  const textFile = files
    .filter((f) => TEXT_EXT.has(ext(f.name)) && f !== captionFile && f !== aboutFile)
    .sort((a, b) => b.size - a.size)[0];
  const imageFiles = files.filter((f) => IMAGE_EXT.has(ext(f.name)));
  const result: ReturnType<typeof pickPrimaryFiles> = { imageFiles };
  if (captionFile) result.captionFile = captionFile;
  if (aboutFile) result.aboutFile = aboutFile;
  if (textFile) result.textFile = textFile;
  if (dataJsonFile) result.dataJsonFile = dataJsonFile;
  return result;
}

/** Maps a lab agent folder to the platform's AssetType. */
export function guessAssetType(agentFolder: string): AssetType {
  const f = agentFolder.toLowerCase();
  if (f.includes("instagram") || f.includes("tiktok")) return "instagram_post";
  if (f.includes("newsletter") || f.includes("email")) return "email";
  if (f.includes("blog") || f.includes("seo")) return "article";
  if (f.includes("x-agent") || f.includes("linkedin") || f.includes("reddit") || f.includes("social")) {
    return "social_post";
  }
  return "note";
}

/**
 * Extracts the client folder slug from whatever staff typed into the "Lab repo
 * slug" field — a plain slug ("karoslabs"), a path ("clients/karoslabs/outputs"),
 * or a full GitHub URL (".../tree/main/clients/karoslabs/outputs"). Returns "" if
 * nothing usable is found.
 */
export function normalizeLabSlug(input: string | null | undefined): string {
  if (!input) return "";
  const s = input.trim();
  const inPath = s.match(/clients\/([^/\s?#]+)/i);
  if (inPath) return inPath[1].toLowerCase();
  const lastSegment = s.split(/[/\s]+/).filter(Boolean).pop() ?? s;
  return lastSegment.toLowerCase().replace(/[^a-z0-9._-]/g, "");
}

/** "01-template-launch-hero" → "Template launch hero"; "2026-07-06-template-launch" → "Template launch" */
export function humanizeItemName(key: string): string {
  const cleaned = key
    .replace(/^\d{4}-\d{2}-\d{2}[-_]?/, "") // run-name date prefix
    .replace(/^\d+[-_.]?\s*/, "") // item index prefix
    .replace(/[-_]+/g, " ")
    .trim();
  if (!cleaned) return key;
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}
