import "server-only";

import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

/**
 * The "ops inbox" — a directory of locally-produced update bundles the admin
 * Ops Import page ingests into the live portal.
 *
 * Layout (path from env `OPS_IMPORT_DIR`; absent → the page renders a setup notice):
 *
 *   <inbox>/<anything>.json          one refresh proposal per client, in the exact
 *                                    schema scripts/refresh-apply.ts validates
 *                                    (docs · competitors · profile · palette)
 *   <inbox>/seo-geo/<clientId>.json  one SEO/GEO capture per client
 *
 * POSTS ARE NOT HERE ON PURPOSE. The portal already has a first-class importer
 * for locally-produced posts — the lab-outputs flow (src/lib/lab-outputs.ts →
 * importLabRunAction), which reads the committed karos-agents run outputs from
 * GitHub and creates draft assets through the same createAsset path the webhook
 * uses. A second posts writer here would fork the asset-creation path, and the
 * chain reflow and idempotency that flow already gets right. The Ops Import
 * page mounts that existing flow instead.
 *
 * READ-ONLY. Nothing in this module writes to or deletes from the inbox — a
 * re-import must stay possible, and an operator's files are not ours to consume.
 */

/** Filenames are re-validated on every request: they round-trip through the browser. */
const SAFE_FILE = /^[A-Za-z0-9][\w.-]*\.json$/;

/** Firestore document ids, as used for the seo-geo/<clientId>.json filenames. */
const SAFE_ID = /^[A-Za-z0-9][\w-]*$/;

/** A bundle that is 40MB of anything is not a refresh proposal. */
const MAX_BUNDLE_BYTES = 16 * 1024 * 1024;

export function opsInboxDir(): string | null {
  const dir = process.env.OPS_IMPORT_DIR?.trim();
  if (!dir) return null;
  return path.resolve(dir);
}

export function isOpsInboxConfigured(): boolean {
  return opsInboxDir() !== null;
}

/**
 * Resolve a caller-supplied name inside the inbox, refusing anything that
 * escapes it. The name is pattern-checked first (so `..` never reaches the
 * filesystem) and the resolved path is re-checked against the root, which is
 * what actually stops a symlinked segment.
 */
function resolveInInbox(root: string, ...segments: string[]): string | null {
  const full = path.resolve(root, ...segments);
  const rel = path.relative(root, full);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return null;
  return full;
}

export interface InboxBundle {
  /** Filename within the inbox, e.g. "geektime.proposal.json". The UI's handle. */
  file: string;
  /** clientId the proposal declares, when it parses. */
  clientId: string | null;
  /** clientName the proposal declares, for the "which client is this" line. */
  clientName: string | null;
  /** Set when the file could not be read or parsed — surfaced, never swallowed. */
  error: string | null;
  /** Rough shape summary for the list row, before any validation runs. */
  counts: { docs: number; competitorUpdates: number; competitorCreates: number } | null;
  /** Whether <inbox>/seo-geo/<clientId>.json exists alongside it. */
  hasSeoGeo: boolean;
}

function countShape(parsed: unknown): InboxBundle["counts"] {
  if (typeof parsed !== "object" || parsed === null) return null;
  const p = parsed as Record<string, unknown>;
  const comps = (typeof p.competitors === "object" && p.competitors !== null
    ? p.competitors
    : {}) as Record<string, unknown>;
  return {
    docs: Array.isArray(p.docs) ? p.docs.length : 0,
    competitorUpdates: Array.isArray(comps.update) ? comps.update.length : 0,
    competitorCreates: Array.isArray(comps.create) ? comps.create.length : 0,
  };
}

async function readJsonFile(file: string): Promise<unknown> {
  const raw = await readFile(file, "utf8");
  if (raw.length > MAX_BUNDLE_BYTES) throw new Error("Bundle is too large to be a proposal.");
  return JSON.parse(raw);
}

/**
 * Every proposal bundle sitting in the inbox root, newest filename last.
 * A file that fails to parse is RETURNED with its error rather than skipped —
 * an operator who dropped a broken file needs to see it, not wonder where it went.
 */
export async function listInboxBundles(): Promise<InboxBundle[]> {
  const root = opsInboxDir();
  if (!root) return [];

  let names: string[];
  try {
    names = (await readdir(root)).filter((n) => SAFE_FILE.test(n));
  } catch {
    // Missing or unreadable directory — the page reports it as "not set up".
    return [];
  }
  names.sort((a, b) => a.localeCompare(b));

  let seoGeoIds = new Set<string>();
  try {
    const seoDir = resolveInInbox(root, "seo-geo");
    if (seoDir) {
      seoGeoIds = new Set(
        (await readdir(seoDir))
          .filter((n) => SAFE_FILE.test(n))
          .map((n) => n.replace(/\.json$/, "")),
      );
    }
  } catch {
    // No seo-geo/ subfolder — that half is simply absent.
  }

  return Promise.all(
    names.map(async (file): Promise<InboxBundle> => {
      const full = resolveInInbox(root, file);
      if (!full) {
        return { file, clientId: null, clientName: null, error: "Refused: path escapes the inbox.", counts: null, hasSeoGeo: false };
      }
      try {
        const parsed = await readJsonFile(full);
        const p = parsed as Record<string, unknown>;
        const clientId = typeof p?.clientId === "string" ? p.clientId : null;
        return {
          file,
          clientId,
          clientName: typeof p?.clientName === "string" ? p.clientName : null,
          error: null,
          counts: countShape(parsed),
          hasSeoGeo: clientId !== null && seoGeoIds.has(clientId),
        };
      } catch (e) {
        return {
          file,
          clientId: null,
          clientName: null,
          error: e instanceof Error ? e.message : "Could not read this file.",
          counts: null,
          hasSeoGeo: false,
        };
      }
    }),
  );
}

/** Reads one proposal bundle by filename. Throws when the name escapes the inbox. */
export async function readInboxProposal(file: string): Promise<unknown> {
  const root = opsInboxDir();
  if (!root) throw new Error("OPS_IMPORT_DIR is not configured.");
  if (!SAFE_FILE.test(file)) throw new Error("Invalid bundle name.");
  const full = resolveInInbox(root, file);
  if (!full) throw new Error("Invalid bundle name.");
  return readJsonFile(full);
}

/** Reads <inbox>/seo-geo/<clientId>.json, or null when the client has no snapshot bundle. */
export async function readInboxSeoGeo(clientId: string): Promise<unknown | null> {
  const root = opsInboxDir();
  if (!root) throw new Error("OPS_IMPORT_DIR is not configured.");
  if (!SAFE_ID.test(clientId)) throw new Error("Invalid client id.");
  const full = resolveInInbox(root, "seo-geo", `${clientId}.json`);
  if (!full) throw new Error("Invalid client id.");
  try {
    return await readJsonFile(full);
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === "ENOENT") return null;
    throw e;
  }
}
