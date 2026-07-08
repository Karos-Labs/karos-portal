"use server";

import { revalidatePath } from "next/cache";
import { createAsset, getClient, listAssets } from "@/lib/data";
import {
  MAX_LAB_FILE_BYTES,
  MAX_LAB_RUN_BYTES,
  downloadLabFile,
  groupRunFiles,
  guessAssetType,
  humanizeItemName,
  isLabOutputsConfigured,
  listLabOutputRuns,
  listRunClientFiles,
  normalizeLabSlug,
  pickPrimaryFiles,
  type LabRun,
} from "@/lib/lab-outputs";
import { uploadBytes } from "@/lib/storage";
import { logActivity, requireStaff } from "./_shared";

const CONTENT_CHAR_CAP = 100_000;

const CONTENT_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".md": "text/markdown",
  ".txt": "text/plain",
  ".html": "text/html",
  ".json": "application/json",
  ".pdf": "application/pdf",
  ".mp4": "video/mp4",
};

function contentTypeFor(name: string): string {
  const i = name.lastIndexOf(".");
  return (i >= 0 && CONTENT_TYPES[name.slice(i).toLowerCase()]) || "application/octet-stream";
}

async function requireLabClient(clientId: string) {
  const user = await requireStaff();
  if (!isLabOutputsConfigured()) {
    return { error: "Lab imports are not configured (AGENTS_REPO_GITHUB_TOKEN)." } as const;
  }
  const client = await getClient(clientId);
  if (!client) return { error: "Client not found." } as const;
  const slug = normalizeLabSlug(client.agentsRepoSlug);
  if (!slug) {
    return {
      error: "This client has no lab repo slug yet — set it via the client's Edit dialog (Lab repo slug).",
    } as const;
  }
  return { user, client, slug } as const;
}

/** Lists the client's committed lab runs (clients/<slug>/outputs/** in karos-agents). */
export async function listLabOutputRunsAction(
  clientId: string,
): Promise<{ runs?: LabRun[]; importedRunKeys?: string[]; error?: string }> {
  const ctx = await requireLabClient(clientId);
  if ("error" in ctx) return { error: ctx.error };
  try {
    const [runs, assets] = await Promise.all([listLabOutputRuns(ctx.slug), listAssets({ clientId })]);
    // Which runs already have imported assets (meta.labRun = "<agent>/<run>")
    const importedRunKeys = [
      ...new Set(
        assets
          .map((a) => (a.meta as { labRun?: string } | undefined)?.labRun)
          .filter((v): v is string => typeof v === "string")
          .map((v) => v.split("#")[0]!),
      ),
    ];
    return { runs, importedRunKeys };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Could not list lab runs." };
  }
}

/**
 * Imports one lab run's client/ deliverables: downloads each file from the
 * repo, re-hosts it in the platform's own storage, and creates one draft
 * asset per deliverable item (per the lab contract's item folders).
 * Idempotent per item — already-imported items are skipped.
 */
export async function importLabRunAction(input: {
  clientId: string;
  agentFolder: string;
  runName: string;
}): Promise<{ created?: number; skipped?: number; error?: string }> {
  const ctx = await requireLabClient(input.clientId);
  if ("error" in ctx) return { error: ctx.error };
  // Folder names come from the GitHub listing, but re-validate since they round-trip the client.
  if (!/^[\w.-]+$/.test(input.agentFolder) || !/^[\w.-]+$/.test(input.runName)) {
    return { error: "Invalid run reference." };
  }
  const runKey = `${input.agentFolder}/${input.runName}`;

  try {
    const files = await listRunClientFiles(ctx.slug, input.agentFolder, input.runName);
    if (files.length === 0) {
      return { error: "This run has no client/ deliverables to import." };
    }

    const existing = await listAssets({ clientId: input.clientId });
    const alreadyImported = new Set(
      existing
        .map((a) => (a.meta as { labRun?: string } | undefined)?.labRun)
        .filter((v): v is string => typeof v === "string"),
    );

    const now = Date.now();
    let created = 0;
    let skipped = 0;
    let totalBytes = 0;

    for (const group of groupRunFiles(files)) {
      const itemKey = `${runKey}#${group.key}`;
      if (alreadyImported.has(itemKey)) {
        skipped++;
        continue;
      }
      const { captionFile, aboutFile, textFile, imageFiles } = pickPrimaryFiles(group.files);

      const hosted: Array<{ name: string; relPath: string; url: string; bytes: number }> = [];
      let content = "";
      let about = "";
      let imageUrl: string | null = null;
      const imageUrls: string[] = [];

      for (const file of group.files) {
        if (file.size > MAX_LAB_FILE_BYTES || totalBytes + file.size > MAX_LAB_RUN_BYTES) continue;
        const bytes = await downloadLabFile(file.path);
        totalBytes += bytes.length;
        const { url } = await uploadBytes({
          bytes,
          path: `lab-imports/${input.clientId}/${runKey}/${group.key}/${file.relPath.split("/").pop()}`,
          contentType: contentTypeFor(file.name),
        });
        hosted.push({ name: file.name, relPath: file.relPath, url, bytes: bytes.length });
        if (file === captionFile || (!captionFile && file === textFile)) {
          content = bytes.toString("utf8").slice(0, CONTENT_CHAR_CAP);
        }
        if (file === aboutFile) about = bytes.toString("utf8").slice(0, 4000);
        if (imageFiles.includes(file)) {
          imageUrls.push(url);
          imageUrl ??= url;
        }
      }
      if (hosted.length === 0) {
        skipped++;
        continue;
      }

      await createAsset({
        clientId: input.clientId,
        jobId: null,
        agentId: null,
        type: guessAssetType(input.agentFolder),
        title: `${humanizeItemName(group.key === "run" ? input.runName : group.key)} — ${input.runName}`,
        content,
        meta: {
          source: "lab-import",
          labRun: itemKey,
          agentFolder: input.agentFolder,
          ...(about ? { about } : {}),
          ...(imageUrls.length > 0 ? { images: imageUrls } : {}),
          files: hosted,
        },
        imageUrl,
        status: "draft",
        createdBy: ctx.user.uid,
        createdAt: now,
        updatedAt: now,
      });
      created++;
    }

    void logActivity({
      clientId: input.clientId,
      timestamp: Date.now(),
      type: "CAMPAIGN_CREATED",
      title: `Imported lab run: ${runKey} (${created} item${created !== 1 ? "s" : ""})`,
      actor: ctx.user.name,
      actorRole: "staff",
      metadata: { runKey, created, skipped },
    });
    revalidatePath(`/clients/${input.clientId}`);
    revalidatePath("/assets");
    return { created, skipped };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Import failed." };
  }
}
