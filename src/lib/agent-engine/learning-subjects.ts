import "server-only";

import { middlewareBaseUrl, middlewareFetch, MiddlewareRequestError } from "./middleware-http";
import type { LearningPlatform } from "./learning-feedback";
import type { Client } from "@/lib/types";

/**
 * READING THE SUBJECT TABLE (B1, SCRUM-493) — the half that had no caller.
 *
 * The writing half has been live for a while and is now complete: the engine
 * upserts a row per deliverable through `collect`, and every publish door moves
 * its status (`asset-posted.ts`). The reading half did not exist in this repo at
 * all — `GET /clients/{slug}/learning/{platform}/subjects` was served by the
 * middleware and called by nothing.
 *
 * That is worth more than a missing screen. The subject table is the only place
 * that answers "what have we already said to this client's audience, and how did
 * it land" as one list: every draft with the goal it was written for, the funnel
 * stage it belongs to, and what happened to it. Without a reader, the anti-
 * repetition window was a thing the agents could see and the people running the
 * account could not — so a client asking "haven't we posted this already?" had
 * to be answered from memory.
 *
 * ## The projection is not this
 *
 * `project` writes a WINDOW — the rows inside `anti_repeat_days` — into the
 * engine's workspace for the next draft to read. This is the whole table, newest
 * first, for a person. They answer different questions and neither is a cache of
 * the other.
 *
 * ## Failure posture
 *
 * `undefined` for "could not ask", never an exception and never an empty array
 * standing in for one. A client with no rows and a control plane that is down
 * must not render the same, because the first is a real answer ("nothing drafted
 * yet") and the second is a broken pane; the caller renders them differently and
 * can only do that if this keeps them apart.
 */

/** One row of `config.subject_rows`, as the middleware's `_subject_row` serialises it. */
export interface SubjectRow {
  id: string;
  runId: string;
  subject: string;
  angle?: string;
  type?: string;
  /** The funnel stage — the middleware's own three-value vocabulary. */
  stage: "attention" | "expertise" | "decide";
  goal?: string;
  status: "drafted" | "approved" | "posted" | "skipped" | "change_requested";
  assetKind?: string;
  strategyRowId?: string;
  audience?: string;
  whyNow?: string;
  /** ISO 8601 — the middleware serialises timestamps, not epoch millis. */
  draftedAt?: string;
  postedAt?: string;
}

/** The middleware caps `limit` at 500; this is the page a staff surface actually reads. */
const DEFAULT_LIMIT = 100;

const STAGES = new Set(["attention", "expertise", "decide"]);
const STATUSES = new Set(["drafted", "approved", "posted", "skipped", "change_requested"]);

/**
 * One row, validated rather than cast.
 *
 * The two enums are CHECK constraints on the table, so a value outside them
 * means the contract moved and this file has not caught up — dropping the row is
 * better than rendering a status nothing in the UI knows how to colour. Every
 * optional field is checked for its type because `_clean` omits nulls, so an
 * absent field and a wrongly-typed one look the same from here.
 */
function toSubjectRow(value: unknown): SubjectRow | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const r = value as Record<string, unknown>;
  const str = (key: string): string | undefined => (typeof r[key] === "string" ? (r[key] as string) : undefined);

  const id = str("id");
  const runId = str("runId");
  const subject = str("subject");
  const stage = str("stage");
  const status = str("status");
  if (!id || !runId || !subject || !stage || !status) return undefined;
  if (!STAGES.has(stage) || !STATUSES.has(status)) return undefined;

  return {
    id,
    runId,
    subject,
    stage: stage as SubjectRow["stage"],
    status: status as SubjectRow["status"],
    ...(str("angle") ? { angle: str("angle")! } : {}),
    ...(str("type") ? { type: str("type")! } : {}),
    ...(str("goal") ? { goal: str("goal")! } : {}),
    ...(str("assetKind") ? { assetKind: str("assetKind")! } : {}),
    ...(str("strategyRowId") ? { strategyRowId: str("strategyRowId")! } : {}),
    ...(str("audience") ? { audience: str("audience")! } : {}),
    ...(str("whyNow") ? { whyNow: str("whyNow")! } : {}),
    ...(str("draftedAt") ? { draftedAt: str("draftedAt")! } : {}),
    ...(str("postedAt") ? { postedAt: str("postedAt")! } : {}),
  };
}

/**
 * `GET /clients/{slug}/learning/{platform}/subjects`, newest first.
 *
 * `undefined` means the question could not be asked — not an engine client, no
 * control plane in this environment, or the call failed. An empty array means it
 * was asked and the answer is nothing.
 */
export async function readSubjectRows(
  client: Pick<Client, "agentsRepoSlug">,
  platform: LearningPlatform,
  opts?: { limit?: number },
): Promise<SubjectRow[] | undefined> {
  const slug = client.agentsRepoSlug;
  if (!slug) return undefined;
  if (!middlewareBaseUrl()) return undefined;

  const limit = Math.min(Math.max(opts?.limit ?? DEFAULT_LIMIT, 1), 500);
  try {
    const body = (await middlewareFetch(
      `/clients/${encodeURIComponent(slug)}/learning/${platform}/subjects?limit=${limit}`,
    )) as { rows?: unknown };
    if (!Array.isArray(body?.rows)) return [];
    return body.rows.map(toSubjectRow).filter((row): row is SubjectRow => row !== undefined);
  } catch (e) {
    const detail = e instanceof MiddlewareRequestError ? `${e.status ?? "no response"}: ${e.detail}` : String(e);
    console.error(`[agent-engine] reading subject rows failed for ${slug}/${platform}: ${detail}`);
    return undefined;
  }
}

/**
 * Every platform's table in one call, for a surface that shows a client whole.
 *
 * Asked in PARALLEL and one platform's failure is its own: a client with five
 * channels and one unreachable platform still gets four tables, and the fifth
 * says so. Sequential would also mean five round trips in series on a page load.
 */
export async function readSubjectRowsByPlatform(
  client: Pick<Client, "agentsRepoSlug">,
  platforms: readonly LearningPlatform[],
  opts?: { limit?: number },
): Promise<Record<string, SubjectRow[] | undefined>> {
  const entries = await Promise.all(
    platforms.map(async (platform) => [platform, await readSubjectRows(client, platform, opts)] as const),
  );
  return Object.fromEntries(entries);
}

/**
 * What a reader wants to know at a glance, derived here so two surfaces cannot
 * disagree about it: how many subjects, how many actually went out, and the
 * stage mix against D32's default of three attention, two expertise, one decide
 * per six posts.
 *
 * `posted` counts the STATUS, not the presence of `postedAt`: a row can carry a
 * timestamp from a later correction, and the status is what the loop reads.
 */
export function summariseSubjects(rows: readonly SubjectRow[]): {
  total: number;
  posted: number;
  stages: Record<SubjectRow["stage"], number>;
  newestDraftedAt?: string;
} {
  const stages: Record<SubjectRow["stage"], number> = { attention: 0, expertise: 0, decide: 0 };
  let posted = 0;
  let newest: string | undefined;
  for (const row of rows) {
    stages[row.stage] += 1;
    if (row.status === "posted") posted += 1;
    if (row.draftedAt && (newest === undefined || row.draftedAt > newest)) newest = row.draftedAt;
  }
  return { total: rows.length, posted, stages, ...(newest ? { newestDraftedAt: newest } : {}) };
}
