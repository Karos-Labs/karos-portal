import { createWriteStream } from "node:fs";
import { copyFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import type { ContextFileRef } from "../../src/types.js";
import {
  MAX_CONTEXT_FILE_BYTES,
  MAX_CONTEXT_TOTAL_BYTES,
} from "../../src/schemas/validate.js";

export interface DownloadedContextFile {
  name: string;
  description?: string;
  bytes: number;
  clientPath?: string;
}

export function sanitizeFileName(name: string): string {
  const base = path.basename(name).replace(/^\.+/, "").replace(/[^\w.\- ]+/g, "_");
  return base || "file";
}

/**
 * Resolves client_path to an absolute path guaranteed to stay under
 * clients/<slug>/, re-checking what the schema (validate.ts) already
 * constrains — the same belt-and-suspenders the artifact store's
 * sanitizeRelPath applies, kept local since this module has no existing
 * dependency on agent-service's server-side code.
 */
function resolveClientPath(repoDir: string, clientSlug: string, clientPath: string): string {
  const base = path.resolve(repoDir, "clients", clientSlug);
  const resolved = path.resolve(base, clientPath);
  if (resolved !== base && !resolved.startsWith(base + path.sep)) {
    throw new Error(`context file client_path escapes the client folder: ${clientPath}`);
  }
  return resolved;
}

/**
 * Downloads job input files into client_context/files/ before the agent
 * starts. Content is untrusted data; the prompt says so explicitly. A file
 * carrying client_path is ALSO written there — for a skill with a fixed-path
 * contract (reads a specific file at a specific location every run) rather
 * than a generic attached reference document.
 */
export async function downloadContextFiles(
  repoDir: string,
  clientSlug: string,
  files: ContextFileRef[],
): Promise<DownloadedContextFile[]> {
  const targetDir = path.join(repoDir, "client_context", "files");
  await mkdir(targetDir, { recursive: true });
  const results: DownloadedContextFile[] = [];
  const usedNames = new Set<string>();
  let totalBytes = 0;

  for (const file of files) {
    let name = sanitizeFileName(file.name);
    for (let i = 2; usedNames.has(name); i++) {
      const ext = path.extname(name);
      name = `${path.basename(name, ext)}-${i}${ext}`;
    }
    usedNames.add(name);

    const response = await fetch(file.url, { signal: AbortSignal.timeout(60_000) });
    if (!response.ok || !response.body) {
      throw new Error(`context file "${file.name}" download failed (${response.status})`);
    }
    let bytes = 0;
    const counter = new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        bytes += chunk.byteLength;
        if (bytes > MAX_CONTEXT_FILE_BYTES) {
          controller.error(new Error(`context file "${file.name}" exceeds the per-file size limit`));
          return;
        }
        controller.enqueue(chunk);
      },
    });
    const primaryPath = path.join(targetDir, name);
    await pipeline(
      Readable.fromWeb(response.body.pipeThrough(counter) as import("node:stream/web").ReadableStream),
      createWriteStream(primaryPath),
    );
    totalBytes += bytes;
    if (totalBytes > MAX_CONTEXT_TOTAL_BYTES) {
      throw new Error("context files exceed the total size limit");
    }
    const entry: DownloadedContextFile = { name, bytes };
    if (file.description) entry.description = file.description;
    if (file.client_path) {
      const dest = resolveClientPath(repoDir, clientSlug, file.client_path);
      await mkdir(path.dirname(dest), { recursive: true });
      await copyFile(primaryPath, dest);
      entry.clientPath = file.client_path;
    }
    results.push(entry);
  }
  return results;
}

export function contextFileList(files: DownloadedContextFile[]): string {
  if (files.length === 0) return "  (none supplied)";
  return files
    .map((f) => {
      const location = f.clientPath ? `clients/<slug>/${f.clientPath}` : `client_context/files/${f.name}`;
      return `  - ${location}${f.description ? ` — ${f.description}` : ""}`;
    })
    .join("\n");
}
