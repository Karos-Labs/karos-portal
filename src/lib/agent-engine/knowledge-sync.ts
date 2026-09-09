import "server-only";
import { listClientContextDocs, listContextItems, listTranscripts } from "@/lib/data";
import { isWorkspaceWriterConfigured, writeWorkspaceJson } from "./workspace-writer";
import type { Client, ClientContextDoc } from "@/lib/types";

/**
 * Phase 4 — the client knowledge base, mirrored into the agent-engine
 * workspace so the engine's drafting agents ground themselves in the same
 * onboarding documents, meeting record and reference material this portal
 * holds, BEFORE any external source.
 *
 * ## Why a cron-driven mirror, not write hooks
 *
 * Three writers in this codebase batch context docs straight through the
 * Admin SDK without passing `data.ts`'s single-doc write path (the onboarding
 * pipeline's batch upsert, the lab importer, the branding backfill script) —
 * a hook on the write path would silently miss all three. The reconcile cron
 * already ticks for exactly the population that matters (clients with an
 * `agentsRepoSlug`), the three docs below are small, and a full overwrite per
 * tick is idempotent, so polling is both the complete seam and the cheap one.
 *
 * ## Why the layout is FLAT (three files, not a file per doc)
 *
 * The engine's `WorkspaceStoreLike.listJson` recursion diverges between its
 * GCS and local-file backends (recursive with slash-separated ids vs
 * non-recursive), so nothing on the engine side may depend on enumerating a
 * knowledge directory. One deterministic GET per file is the contract:
 * `knowledge/context-docs.json`, `knowledge/transcripts.json`,
 * `knowledge/assets.json`.
 *
 * ## What NEVER crosses
 *
 * - `internal-only` docs (client-guidelines, action-plan) — the staff-private
 *   tier, excluded by construction rather than by cap.
 * - Transcript `rawText` — meetings carry names, numbers and asides that were
 *   never cleared for an agent's drafting context; the summary/action-item
 *   layer is the distillation a human already reviewed.
 */

/** Per-doc content cap. Generous enough for a full strategy doc, small enough that seven docs stay one bounded read. */
const CONTEXT_DOC_CONTENT_CAP = 6_000;
/** The engine distills further; this bounds the file, not the prompt. */
const TRANSCRIPT_COUNT_CAP = 10;

export interface WorkspaceContextDoc {
  docType: string;
  tier: string;
  version: number;
  content: string;
}

export interface WorkspaceTranscript {
  title: string;
  meetingDate?: number;
  summary?: string;
  actionItems?: string[];
}

export interface WorkspaceAssetIndexEntry {
  name: string;
  mimeType: string;
  note?: string;
  purpose?: string;
  url: string;
}

/**
 * One row per docType: the condensed `client` form when it exists (already
 * written to be safe for non-staff readers), the full `internal` form
 * otherwise. `internal-only` rows never reach the candidate set at all.
 */
export function selectContextDocsForWorkspace(docs: ClientContextDoc[]): WorkspaceContextDoc[] {
  const byType = new Map<string, ClientContextDoc>();
  for (const doc of docs) {
    if (doc.tier !== "internal" && doc.tier !== "client") continue;
    const existing = byType.get(doc.docType);
    if (!existing || (existing.tier === "internal" && doc.tier === "client")) byType.set(doc.docType, doc);
  }
  return [...byType.values()]
    .sort((a, b) => a.docType.localeCompare(b.docType))
    .map((doc) => ({
      docType: doc.docType,
      tier: doc.tier,
      version: doc.version,
      content: doc.content.length > CONTEXT_DOC_CONTENT_CAP ? `${doc.content.slice(0, CONTEXT_DOC_CONTENT_CAP)}\n\n[truncated]` : doc.content,
    }));
}

export interface KnowledgeSyncResult {
  synced: boolean;
  contextDocs: number;
  transcripts: number;
  assets: number;
}

/**
 * Mirrors one client's knowledge into `clients/<agentsRepoSlug>/knowledge/`.
 * Full overwrite each call; a client with no `agentsRepoSlug` or a deployment
 * with no workspace bucket is a counted no-op, never an error.
 */
export async function syncClientKnowledgeToWorkspace(client: Client): Promise<KnowledgeSyncResult> {
  if (!client.agentsRepoSlug || !isWorkspaceWriterConfigured()) {
    return { synced: false, contextDocs: 0, transcripts: 0, assets: 0 };
  }

  const [docs, transcripts, items] = await Promise.all([
    listClientContextDocs(client.id),
    listTranscripts({ clientId: client.id }),
    listContextItems({ clientId: client.id }),
  ]);

  const contextDocs = selectContextDocsForWorkspace(docs);
  const recentTranscripts: WorkspaceTranscript[] = transcripts.slice(0, TRANSCRIPT_COUNT_CAP).map((t) => ({
    title: t.title,
    ...(t.meetingDate !== undefined ? { meetingDate: t.meetingDate } : {}),
    ...(t.summary !== undefined ? { summary: t.summary } : {}),
    ...(t.actionItems !== undefined && t.actionItems.length > 0 ? { actionItems: t.actionItems } : {}),
  }));
  const assets: WorkspaceAssetIndexEntry[] = items.map((item) => ({
    name: item.name,
    mimeType: item.mimeType,
    ...(item.note !== undefined ? { note: item.note } : {}),
    ...(item.purpose !== undefined ? { purpose: item.purpose } : {}),
    url: item.url,
  }));

  const prefix = `clients/${client.agentsRepoSlug}/knowledge`;
  const syncedAt = Date.now();
  await Promise.all([
    writeWorkspaceJson(`${prefix}/context-docs.json`, { syncedAt, docs: contextDocs }),
    writeWorkspaceJson(`${prefix}/transcripts.json`, { syncedAt, transcripts: recentTranscripts }),
    writeWorkspaceJson(`${prefix}/assets.json`, { syncedAt, assets }),
  ]);

  return { synced: true, contextDocs: contextDocs.length, transcripts: recentTranscripts.length, assets: assets.length };
}
