import "server-only";

import { middlewareBaseUrl, middlewareFetch, MiddlewareRequestError } from "./middleware-http";
import type { Client } from "@/lib/types";

/**
 * WHAT THE AGENTS LEARNED ABOUT A CLIENT, FOR A PERSON (SCRUM-508).
 *
 * `client_preferences.voice_notes` is derived: every feedback event rebuilds it
 * from the log and the collected run records, and every draft on every
 * platform reads the newest eight. Since SCRUM-508 a revision note typed at the
 * gate and a change request both become one of them, including a note that was
 * only ever true of one post. This is the reader and the one control over it:
 * retiring a lesson (middleware 0009), which keeps it out of every later
 * derivation until someone restores it.
 *
 * Staff only, by product decision. A lesson can be a reviewer's internal note,
 * or a counted one ("Takes X out: removed in 4 edits"), and neither is written
 * for a client. The client's own say over the agent is the standing feedback
 * they already write and manage.
 */

/** Where a lesson came from, in the middleware's own vocabulary. */
export type LessonSource = "review" | "note" | "change_request" | "edits" | "skips";

export interface VoiceLesson {
  lesson: string;
  source?: LessonSource;
  /** How many separate events it rests on. Absent on a stated lesson, which is one. */
  evidence?: number;
  fromRunId?: string;
}

export interface LikedPost {
  subject?: string;
  runId?: string;
  at?: string;
}

export interface LearnedLessons {
  /** Oldest-evidence first, strongest last, as the middleware orders them (the engine reads the last eight). */
  voiceLessons: VoiceLesson[];
  likes: LikedPost[];
  retired: string[];
  derivedAt?: string;
  derivedFromCount?: number;
}

const SOURCES = new Set<LessonSource>(["review", "note", "change_request", "edits", "skips"]);

function text(v: unknown): string | undefined {
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : undefined;
}

/** The preferences body as the middleware's `_preferences_row` serialises it, tolerating any field being absent. */
export function parseLearnedLessons(body: unknown): LearnedLessons {
  const raw = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const voiceLessons: VoiceLesson[] = [];
  for (const item of Array.isArray(raw.voiceNotes) ? raw.voiceNotes : []) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const lesson = text(o.lesson);
    if (!lesson) continue;
    const source = typeof o.source === "string" && SOURCES.has(o.source as LessonSource) ? (o.source as LessonSource) : undefined;
    const evidence = typeof o.evidence === "number" && Number.isFinite(o.evidence) ? o.evidence : undefined;
    const fromRunId = text(o.fromRunId);
    voiceLessons.push({ lesson, ...(source ? { source } : {}), ...(evidence !== undefined ? { evidence } : {}), ...(fromRunId ? { fromRunId } : {}) });
  }
  const likes: LikedPost[] = [];
  for (const item of Array.isArray(raw.likes) ? raw.likes : []) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const subject = text(o.subject);
    const runId = text(o.runId);
    const at = text(o.at);
    if (!subject && !runId) continue;
    likes.push({ ...(subject ? { subject } : {}), ...(runId ? { runId } : {}), ...(at ? { at } : {}) });
  }
  const retired = (Array.isArray(raw.retiredLessons) ? raw.retiredLessons : []).flatMap((t) => (text(t) ? [text(t)!] : []));
  const derivedAt = text(raw.derivedAt);
  return {
    voiceLessons,
    likes,
    retired,
    ...(derivedAt ? { derivedAt } : {}),
    ...(typeof raw.derivedFromCount === "number" ? { derivedFromCount: raw.derivedFromCount } : {}),
  };
}

/**
 * `GET /clients/{slug}/learning/preferences`. `null` when the client has no
 * preferences row yet (nothing learned, an ordinary state); `undefined` when
 * the control plane could not be asked. Never throws.
 */
export async function readLearnedLessons(client: Pick<Client, "agentsRepoSlug">): Promise<LearnedLessons | null | undefined> {
  const slug = client.agentsRepoSlug;
  if (!slug || !middlewareBaseUrl()) return undefined;
  try {
    const body = await middlewareFetch(`/clients/${encodeURIComponent(slug)}/learning/preferences`);
    return body == null ? null : parseLearnedLessons(body);
  } catch (e) {
    const detail = e instanceof MiddlewareRequestError ? `${e.status ?? "no response"}: ${e.detail}` : String(e);
    console.error(`[agent-engine] reading learned lessons failed for ${slug}: ${detail}`);
    return undefined;
  }
}

/**
 * Retire or restore one lesson. Reports failure to the caller, unlike the
 * best-effort feedback writes: a person who presses "Retire" and is told it
 * worked, when it did not, will believe the agent ignored them next week.
 */
export async function setLessonRetired(
  client: Pick<Client, "agentsRepoSlug">,
  input: { lesson: string; retired: boolean; updatedBy?: string },
): Promise<{ ok: true; lessons: LearnedLessons } | { ok: false; error: string }> {
  const slug = client.agentsRepoSlug;
  if (!slug) return { ok: false, error: "This client is not set up for agent runs." };
  if (!middlewareBaseUrl()) return { ok: false, error: "The control plane is not configured in this environment." };
  const lesson = input.lesson.trim();
  if (!lesson) return { ok: false, error: "There is no lesson to change." };
  try {
    const body = await middlewareFetch(
      `/clients/${encodeURIComponent(slug)}/learning/preferences/lessons/${input.retired ? "retire" : "restore"}`,
      {
        method: "POST",
        body: { lesson: lesson.slice(0, 4000), ...(input.updatedBy ? { updatedBy: input.updatedBy.slice(0, 255) } : {}) },
      },
    );
    return { ok: true, lessons: parseLearnedLessons(body) };
  } catch (e) {
    const detail = e instanceof MiddlewareRequestError ? `${e.status ?? "no response"}: ${e.detail}` : String(e);
    console.error(`[agent-engine] ${input.retired ? "retiring" : "restoring"} a lesson failed for ${slug}: ${detail}`);
    return { ok: false, error: "The control plane did not accept the change. Nothing was changed; try again in a moment." };
  }
}
