"use server";

import { labImportTitle } from "@/lib/activity-titles";
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
import { labImportAssetId } from "@/lib/lab-outputs-shared";
import { uploadBytes } from "@/lib/storage";
import { labImportAssetType } from "@/lib/agent-service/deliverable-asset-type";
import { recommendedScheduleFields } from "@/lib/scheduling";
import {
  chainFamilyFor,
  orderKeyForLabItem,
  templateForAsset,
  templateFromItemKey,
} from "@/lib/post-chain";
import { reflowClientChain } from "@/lib/chain";
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

/** "By The Numbers" → "by-the-numbers" (template key from a data.json format). */
function slugifyFormat(s: string): string {
  return s
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** "by the numbers" → "By The Numbers" (template chip label from a data.json format). */
function titleCaseFormat(s: string): string {
  return s
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/** Optional per-item metadata the lab may emit as data.json alongside deliverables. */
interface LabItemData {
  /** Declared template/format name — authoritative over the folder-key slug. */
  format?: string;
  /** Internal generation date (YYYY-MM-DD) — sorts bare-slug items in the chain. */
  date?: string;
}

/** Parse + validate a data.json body; returns null when nothing usable is present. */
function parseLabItemData(raw: string): LabItemData | null {
  try {
    const parsed = JSON.parse(raw) as { format?: unknown; date?: unknown };
    const format =
      typeof parsed.format === "string" && parsed.format.trim() ? parsed.format.trim() : undefined;
    const date =
      typeof parsed.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(parsed.date)
        ? parsed.date
        : undefined;
    if (!format && !date) return null;
    return { ...(format ? { format } : {}), ...(date ? { date } : {}) };
  } catch {
    // Malformed data.json — template/date fall back to the item folder key.
    return null;
  }
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
      error: "This client has no lab repo slug yet - set it via the client's Edit dialog (Lab repo slug).",
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
    // Template keys this client already has, so one-off run slugs collapse onto
    // an existing template (e.g. "voce-sabia-renda-fixa-…" → "voce-sabia")
    // instead of minting a near-duplicate chip. Seeded from existing assets and
    // extended as this import derives new templates.
    const knownTemplateKeys = new Set<string>();
    for (const a of existing) {
      const t = templateForAsset(a);
      if (t) knownTemplateKeys.add(t.key);
    }

    // agentFolder is constant for the whole run, so the FOLDER'S answer is too.
    // The per-item answer is not: the draft-only fence below also reads each
    // item's own text, and either half saying "draft-only" wins.
    const folderAssetType = guessAssetType(input.agentFolder);

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
      const { captionFile, aboutFile, textFile, imageFiles, dataJsonFile } = pickPrimaryFiles(
        group.files,
      );

      const hosted: Array<{ name: string; relPath: string; url: string; bytes: number }> = [];
      let content = "";
      let about = "";
      let imageUrl: string | null = null;
      const imageUrls: string[] = [];
      let dataJson: LabItemData | null = null;

      for (const file of group.files) {
        if (file.size > MAX_LAB_FILE_BYTES || totalBytes + file.size > MAX_LAB_RUN_BYTES) continue;
        const bytes = await downloadLabFile(file.path);
        totalBytes += bytes.length;
        // ifAbsent: this path is deterministic (client/run/item/filename), so a
        // concurrent or retried import of this same item must not re-upload —
        // doing so would mint a fresh token on a NEW generation while an
        // already-created Firestore doc keeps pointing at the old one, which
        // Firebase Storage then answers with "Permission denied" forever
        // (production incident, Karos Labs' celebrity-comeups run: the racing
        // upload silently invalidated an already-surviving post's photos).
        const { url } = await uploadBytes({
          bytes,
          path: `lab-imports/${input.clientId}/${runKey}/${group.key}/${file.relPath.split("/").pop()}`,
          contentType: contentTypeFor(file.name),
          ifAbsent: true,
        });
        hosted.push({ name: file.name, relPath: file.relPath, url, bytes: bytes.length });
        if (file === captionFile || (!captionFile && file === textFile)) {
          content = bytes.toString("utf8").slice(0, CONTENT_CHAR_CAP);
        }
        if (file === aboutFile) about = bytes.toString("utf8").slice(0, 4000);
        if (file === dataJsonFile) dataJson = parseLabItemData(bytes.toString("utf8"));
        if (imageFiles.includes(file)) {
          imageUrls.push(url);
          imageUrl ??= url;
        }
      }
      if (hosted.length === 0) {
        skipped++;
        continue;
      }

      // Template chip: the lab's declared data.json `format` wins; otherwise the
      // item folder key (stripped of its date/index prefix), collapsed onto a
      // known template key when one matches. Never baked into the title (E).
      let template = templateFromItemKey(
        group.key === "run" ? input.runName : group.key,
        [...knownTemplateKeys],
      );
      if (dataJson?.format) {
        const key = slugifyFormat(dataJson.format);
        if (key) template = { key, name: titleCaseFormat(dataJson.format) };
      }
      if (template) knownTemplateKeys.add(template.key);

      /**
       * THE THIRD RUNTIME DERIVATION, now asked the same question as the other two.
       *
       * `guessAssetType` keys on the lab-repo FOLDER NAME — a location, not the
       * deliverable — and it never reads the item's text. It does check Reddit
       * before its social bucket, so a folder called `reddit-agent` lands on
       * `note`; but a Reddit batch exported under any other folder name (say
       * `social-replies`) was typed `social_post`, and `PUBLISHABLE_PLATFORMS`
       * then offers a reply written for one thread to twitter, linkedin and
       * tiktok. Reddit is draft-only by hard product rule.
       *
       * `isDraftOnlyDeliverable` is the same predicate the webhook and the MCP
       * upload ask, and its two halves are independent on purpose: the TEXT (the
       * batch carries its own heading) and the IDENTITY (loose word match). Asked
       * per ITEM because content is per item — the folder half was already
       * constant and is passed as the identity.
       *
       * This is what makes deliverable-asset-type.ts's claim to be the one copy
       * every runtime-derived type goes through TRUE rather than asserted; before
       * this it was the copy two of the three went through.
       */
      const assetType = labImportAssetType(folderAssetType, input.agentFolder, content);
      const chainFamily = chainFamilyFor(assetType);

      // Deterministic on itemKey, not an auto id: two overlapping imports of
      // this same item (a retry fired before the first request returned, a
      // double click on "Import") both compute this id and race the create,
      // which lets exactly one of them win. The in-memory `alreadyImported`
      // check above is a fast path for the ordinary case (a later, separate
      // import run) — it cannot see writes still in flight from a concurrent
      // invocation, which is exactly the gap this closes.
      const { created: didCreate } = await createAsset(
        {
          clientId: input.clientId,
          jobId: null,
          agentId: null,
          type: assetType,
          title: humanizeItemName(group.key === "run" ? input.runName : group.key),
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
          ...(template ? { templateKey: template.key, templateName: template.name } : {}),
          orderKey: orderKeyForLabItem(input.runName, group.key, dataJson?.date),
          // Chain-family types get their date + recommendedAt from the post-create
          // reflow (A8/A4); only non-chain types keep the advisory stagger.
          ...(chainFamily ? {} : recommendedScheduleFields(assetType, created)),
          createdBy: ctx.user.uid,
          createdAt: now,
          updatedAt: now,
        },
        labImportAssetId(input.clientId, itemKey),
      );
      if (didCreate) created++;
      else skipped++;
    }

    void logActivity({
      clientId: input.clientId,
      timestamp: Date.now(),
      type: "CAMPAIGN_CREATED",
      title: labImportTitle(runKey, created),
      actor: ctx.user.name,
      actorRole: "staff",
      metadata: { runKey, created, skipped },
    });
    // Auto-assign every new post its one-per-day chain date; later batches
    // interleave with existing unposted items by orderKey. Best-effort — a
    // reflow failure must never fail the import (staff can re-run it from the
    // "Re-plan calendar" action).
    await reflowClientChain(input.clientId).catch((e) =>
      console.error("[lab-import] chain reflow failed", e),
    );
    revalidatePath(`/clients/${input.clientId}`);
    revalidatePath("/assets");
    return { created, skipped };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Import failed." };
  }
}
