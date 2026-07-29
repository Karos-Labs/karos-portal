import "server-only";

import { listClientActivityLogs } from "@/lib/data";

/**
 * "Have I already imported this?" — answered from the activity log rather than
 * from separate bookkeeping.
 *
 * Albert asked why Karos Labs was not listed on the Ops Import page. It had
 * been imported; the page simply had no memory of it, so an imported bundle was
 * indistinguishable from one that was never found. Every apply already writes
 * an activity row carrying `origin`, `ref` and the bundle's fingerprint, so the
 * page reads that back instead of keeping a second source of truth that could
 * disagree with the timeline.
 */

export interface PriorImport {
  importedAt: number;
  actor: string;
  /** True when the file has been edited since — the card offers it again. */
  changedSince: boolean;
  /** True when only a ticked subset was written that time. */
  partial: boolean;
}

/**
 * The most recent recorded import of one bundle, or null if never imported.
 *
 * Never throws: history is a nicety, and losing it must not break a plan or a
 * page load.
 */
export async function findPriorImport(
  clientId: string,
  origin: string,
  ref: string,
  fingerprint: string,
): Promise<PriorImport | null> {
  try {
    const logs = await listClientActivityLogs(clientId);
    const mine = logs
      .filter((l) => {
        const m = (l.metadata ?? {}) as { origin?: unknown; ref?: unknown };
        return m.origin === origin && m.ref === ref;
      })
      .sort((a, b) => b.timestamp - a.timestamp);

    const last = mine[0];
    if (!last) return null;

    const m = (last.metadata ?? {}) as { bundleFingerprint?: unknown; partial?: unknown };
    return {
      importedAt: last.timestamp,
      actor: last.actor,
      // A row written before fingerprinting shipped records nothing. Treat that
      // as "unknown, offer it again" rather than claiming it is up to date: a
      // needless re-import is recoverable, a silently skipped one is not.
      changedSince: typeof m.bundleFingerprint !== "string" || m.bundleFingerprint !== fingerprint,
      partial: m.partial === true,
    };
  } catch {
    return null;
  }
}

/**
 * Same question for many bundles at once, bounded so a page load does not fan
 * out one Firestore query per file without limit.
 */
export async function findPriorImports(
  bundles: Array<{ clientId: string; origin: string; ref: string; fingerprint: string }>,
): Promise<Map<string, PriorImport>> {
  const out = new Map<string, PriorImport>();
  // One query per distinct client, not per bundle: several bundles routinely
  // share a client, and listClientActivityLogs reads the whole collection.
  const byClient = new Map<string, typeof bundles>();
  for (const b of bundles) byClient.set(b.clientId, [...(byClient.get(b.clientId) ?? []), b]);

  await Promise.all(
    [...byClient.entries()].map(async ([clientId, group]) => {
      let logs: Awaited<ReturnType<typeof listClientActivityLogs>>;
      try {
        logs = await listClientActivityLogs(clientId);
      } catch {
        return;
      }
      for (const b of group) {
        const mine = logs
          .filter((l) => {
            const m = (l.metadata ?? {}) as { origin?: unknown; ref?: unknown };
            return m.origin === b.origin && m.ref === b.ref;
          })
          .sort((x, y) => y.timestamp - x.timestamp);
        const last = mine[0];
        if (!last) continue;
        const m = (last.metadata ?? {}) as { bundleFingerprint?: unknown; partial?: unknown };
        out.set(`${b.origin}:${b.ref}`, {
          importedAt: last.timestamp,
          actor: last.actor,
          changedSince: typeof m.bundleFingerprint !== "string" || m.bundleFingerprint !== b.fingerprint,
          partial: m.partial === true,
        });
      }
    }),
  );
  return out;
}
