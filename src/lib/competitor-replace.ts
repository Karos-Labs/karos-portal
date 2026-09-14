/**
 * What `replaceReportCompetitors` (data.ts) writes, decided without Firestore —
 * pure and client-safe, so the merge rules can be proved on plain rows.
 *
 * The function used to decide and write in one loop over a write batch, which
 * made its rules testable only against a live database. The rules are
 * unchanged; they moved here, and data.ts applies the plan in one batch.
 *
 *  1. Every "report" row is deleted and the incoming analysis replaces it.
 *  2. A MANUAL row absorbs its analysis twin: an incoming row whose brand keys
 *     match it enriches it in place (canonical name when the manual one is a
 *     pasted URL/domain, url fill, fresh analysis fields) and is not created.
 *  3. A LAB row (imported from the client's karos-agents lab profile) is never
 *     deleted, and absorbs its twin the same way, except that the lab's own
 *     name and tier survive: only what the lab never supplies (url when
 *     missing, positioning, strengths, weaknesses) comes from the analysis.
 *     Without this a run either dropped the curated rows (they were imported as
 *     "report") or minted a twin beside each one.
 *  4. The measured AI-visibility signal survives: incoming rows inherit
 *     `llmMentions`/`llmMentionsAt` (and a missing `url`) from the old report
 *     row for the same brand, and old report rows the engines actually named
 *     (llmMentions > 0) that the new report dropped are kept, unless a manual
 *     or lab row now covers that brand.
 *
 * Brand identity is matched across ALL name/url keys (`competitorBrandKeys`) so
 * renamed spellings and domain-vs-name variants still merge.
 */
import type { ClientCompetitor } from "@/lib/types";
import { competitorBrandKeys, looksLikeUrlInput } from "@/lib/competitor-input";

/** A stored competitor as Firestore holds it: the document id beside its data. */
export interface StoredCompetitor {
  id: string;
  data: Omit<ClientCompetitor, "id">;
}

export interface CompetitorReplacementPlan {
  /**
   * Merge-writes into existing manual and lab rows, in the order they were
   * decided. Two analysis rows can match the same stored row; applied in order,
   * the later one wins field by field, exactly as sequential merge-sets do.
   */
  updates: Array<{ id: string; patch: Partial<Omit<ClientCompetitor, "id">> }>;
  /** Every existing "report" row. */
  deletes: string[];
  /** The analysis rows nothing absorbed, then the measured survivors. */
  creates: Array<Omit<ClientCompetitor, "id">>;
}

export function planReportCompetitorReplacement(
  existing: readonly StoredCompetitor[],
  rows: ReadonlyArray<Omit<ClientCompetitor, "id">>,
  now: number,
): CompetitorReplacementPlan {
  const reportDocs = existing.filter((d) => d.data.source === "report");
  const manualDocs = existing.filter((d) => d.data.source === "manual");
  const labDocs = existing.filter((d) => d.data.source === "lab");

  const oldRows = reportDocs.map((d) => d.data);
  const oldByKey = new Map<string, Omit<ClientCompetitor, "id">>();
  for (const r of oldRows) {
    for (const k of competitorBrandKeys(r.company, r.url)) if (!oldByKey.has(k)) oldByKey.set(k, r);
  }
  const byKey = (docs: readonly StoredCompetitor[]) => {
    const map = new Map<string, StoredCompetitor>();
    for (const d of docs) {
      for (const k of competitorBrandKeys(d.data.company, d.data.url)) if (!map.has(k)) map.set(k, d);
    }
    return (name: string, url?: string) => competitorBrandKeys(name, url).map((k) => map.get(k)).find(Boolean);
  };
  const manualKeyOf = byKey(manualDocs);
  const labKeyOf = byKey(labDocs);

  const updates: CompetitorReplacementPlan["updates"] = [];
  const carriedOld = new Set<Omit<ClientCompetitor, "id">>();
  const merged: Array<Omit<ClientCompetitor, "id">> = [];
  for (const row of rows) {
    const manualDoc = manualKeyOf(row.company, row.url);
    if (manualDoc) {
      // Enrich the manual row in place; never mint a report twin beside it.
      const m = manualDoc.data;
      updates.push({
        id: manualDoc.id,
        patch: {
          company: looksLikeUrlInput(m.company) && row.company ? row.company : m.company,
          ...(m.url || !row.url ? {} : { url: row.url }),
          ...(row.positioning ? { positioning: row.positioning } : {}),
          ...(row.keyStrengths?.length ? { keyStrengths: row.keyStrengths } : {}),
          ...(row.keyWeaknesses?.length ? { keyWeaknesses: row.keyWeaknesses } : {}),
          ...(row.threatLevel ? { threatLevel: row.threatLevel } : {}),
          marketTier: row.marketTier,
          overlap: row.overlap,
          updatedAt: now,
        },
      });
      continue;
    }
    const labDoc = labKeyOf(row.company, row.url);
    if (labDoc) {
      // The lab named this rival and placed it: company, marketTier, overlap
      // and threatLevel are curated and stay. The analysis adds what the lab
      // file never carries.
      updates.push({
        id: labDoc.id,
        patch: {
          ...(labDoc.data.url || !row.url ? {} : { url: row.url }),
          ...(row.positioning ? { positioning: row.positioning } : {}),
          ...(row.keyStrengths?.length ? { keyStrengths: row.keyStrengths } : {}),
          ...(row.keyWeaknesses?.length ? { keyWeaknesses: row.keyWeaknesses } : {}),
          updatedAt: now,
        },
      });
      continue;
    }
    const old = competitorBrandKeys(row.company, row.url)
      .map((k) => oldByKey.get(k))
      .find(Boolean);
    if (!old) {
      merged.push(row);
      continue;
    }
    carriedOld.add(old);
    merged.push({
      ...row,
      ...(!row.url && old.url ? { url: old.url } : {}),
      ...(old.llmMentions !== undefined
        ? { llmMentions: old.llmMentions, ...(old.llmMentionsAt !== undefined ? { llmMentionsAt: old.llmMentionsAt } : {}) }
        : {}),
    });
  }
  // Measured survivors also skip re-creation when a manual or lab row now covers them.
  const survivors = oldRows.filter(
    (r) =>
      !carriedOld.has(r) &&
      (r.llmMentions ?? 0) > 0 &&
      !manualKeyOf(r.company, r.url) &&
      !labKeyOf(r.company, r.url),
  );

  return {
    updates,
    deletes: reportDocs.map((d) => d.id),
    creates: [...merged, ...survivors],
  };
}
