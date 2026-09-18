import "server-only";

import { middlewareBaseUrl, middlewareFetch, MiddlewareRequestError } from "./middleware-http";
import type { Client } from "@/lib/types";
import { learningPlatformForProduct, type LearningPlatform } from "./learning-feedback";
import type { JobRunType } from "@/lib/types";

/**
 * ── THE ONE FIELD SEQUENCING OWNS (SCRUM-468, bullet 2). ──
 *
 * `docs/agent-architecture.md` §1.1 has said this since the standard was
 * written: *"A calendar run carries `slotStage` on its run input. A manual run
 * does not, and the engine derives a stage from the account's recent history
 * against the D32 mix."* The engine has read the field for as long
 * (`stageForRun`, `packages/workflow/src/primitives/learning-context.ts`).
 * Nothing in this repo has ever sent one, so every scheduled fire has been
 * indistinguishable from someone pressing Run, and the sequencing decision the
 * calendar exists to make was made by the fallback on every single run.
 *
 * WHERE THE STAGE COMES FROM. N4 (SCRUM-487) is the plan: the middleware lays
 * out the next slots from the strategy map and the subject rows, and the FIRST
 * slot in that plan is, by definition, what goes out next. A scheduled fire is
 * the run that fills it, so its stage is slot one's. The portal does not
 * compute this and must not: the plan is only correct in the light of the posts
 * either side of it, and only the control plane can see those.
 *
 * WHY EVERY FAILURE HERE IS SILENT. An absent `slotStage` is a defined, handled
 * state on the engine side — the agent derives a stage from history instead —
 * so a control plane that is down costs a scheduled run its sequencing and
 * nothing else. Failing the dispatch instead would trade a slightly worse post
 * for no post at all.
 *
 * AND WHY IT IS NOT SENT ON A MANUAL RUN. §1.1 again: *"Do not send `slotStage`
 * on a manual run to 'be helpful'. The absence is information."* A person who
 * presses Run has chosen this moment for a reason the calendar knows nothing
 * about, and handing them the calendar's next stage overrides that quietly.
 */

/** The funnel, in the vocabulary the slot, the subject row and the map all share. */
export type FunnelStage = "attention" | "expertise" | "decide";

const STAGES: readonly FunnelStage[] = ["attention", "expertise", "decide"];

export interface SequenceSlot {
  slot: number;
  stage: FunnelStage;
  subject: string;
  goal: string;
  /** The strategy-map row this slot came from, when it came from one. */
  rowId?: string;
  type?: string;
  problem?: string;
  whyNow?: string;
  /** `strategy-map` or `client-request`. */
  source?: string;
  reason?: string;
}

export interface Sequence {
  platform?: string;
  slots: SequenceSlot[];
  /** Slots the open map could not cover — the map needs rebuilding. */
  unfilled: number;
  mix?: Record<string, number>;
  /** What the plan could NOT take into account. Today: the missing what-works. */
  notes: string[];
}

function isStage(value: unknown): value is FunnelStage {
  return typeof value === "string" && (STAGES as readonly string[]).includes(value);
}

function toSlot(raw: unknown): SequenceSlot | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const row = raw as Record<string, unknown>;
  if (!isStage(row.stage)) return undefined;
  if (typeof row.subject !== "string" || !row.subject.trim()) return undefined;
  return {
    slot: typeof row.slot === "number" ? row.slot : 0,
    stage: row.stage,
    subject: row.subject.trim(),
    goal: typeof row.goal === "string" ? row.goal : row.stage,
    ...(typeof row.rowId === "string" ? { rowId: row.rowId } : {}),
    ...(typeof row.type === "string" ? { type: row.type } : {}),
    ...(typeof row.problem === "string" ? { problem: row.problem } : {}),
    ...(typeof row.whyNow === "string" ? { whyNow: row.whyNow } : {}),
    ...(typeof row.source === "string" ? { source: row.source } : {}),
    ...(typeof row.reason === "string" ? { reason: row.reason } : {}),
  };
}

/**
 * The plan for the next slots, or the two ways there isn't one.
 *
 * `null` — asked, and this client has no strategy map on this platform. An
 * ORDINARY state: the map is built lazily on the first drafting run, so every
 * client between setup and their first run is here.
 *
 * `undefined` — could not ask. Not an engine client, no control plane in this
 * environment, or the call failed.
 *
 * Kept apart for the same reason as everywhere else in this directory: a
 * surface (or a caller deciding whether to send `slotStage`) that treats "the
 * control plane is unreachable" as "this client has no plan" is quietly wrong
 * in the one case where being right matters.
 */
export async function readSequence(
  client: Pick<Client, "agentsRepoSlug">,
  platform: LearningPlatform,
  opts: { slots?: number } = {},
): Promise<Sequence | null | undefined> {
  const slug = client.agentsRepoSlug;
  if (!slug || !middlewareBaseUrl()) return undefined;

  // The endpoint refuses anything outside 1..60 with a 422, so an over-eager
  // caller gets a clamped plan rather than a broken one.
  const slots = Math.min(60, Math.max(1, Math.round(opts.slots ?? 6)));
  try {
    const body = await middlewareFetch(
      `/clients/${encodeURIComponent(slug)}/learning/${platform}/sequence?slots=${slots}`,
    );
    if (body === null || typeof body !== "object") return null;
    const raw = body as Record<string, unknown>;
    const slotsRaw = Array.isArray(raw.slots) ? raw.slots : [];
    return {
      ...(typeof raw.platform === "string" ? { platform: raw.platform } : {}),
      slots: slotsRaw.map(toSlot).filter((s): s is SequenceSlot => s !== undefined),
      unfilled: typeof raw.unfilled === "number" ? raw.unfilled : 0,
      ...(typeof raw.mix === "object" && raw.mix !== null
        ? { mix: raw.mix as Record<string, number> }
        : {}),
      notes: Array.isArray(raw.notes) ? raw.notes.filter((n): n is string => typeof n === "string") : [],
    };
  } catch (e) {
    const detail =
      e instanceof MiddlewareRequestError
        ? `${e.status ?? "?"} ${e.detail ?? e.message}`
        : e instanceof Error
          ? e.message
          : "unknown error";
    console.warn(`[learning] could not read the sequence for ${slug}/${platform}: ${detail}`);
    return undefined;
  }
}

/**
 * The stage a calendar run should be given, or `undefined` for every reason
 * there is not one.
 *
 * Deliberately collapses the three answers `readSequence` keeps apart: the
 * caller's question is "is there a stage to send", and "no map", "no control
 * plane" and "an exhausted pool" all answer it the same way. The distinction is
 * kept ONE level down, where it can be logged.
 */
export async function slotStageForRun(
  client: Pick<Client, "agentsRepoSlug">,
  platform: LearningPlatform,
): Promise<FunnelStage | undefined> {
  // One slot: a scheduled fire is filling the next one, and asking for six
  // would cost the middleware five more rows of planning nobody reads.
  const sequence = await readSequence(client, platform, { slots: 1 });
  return sequence?.slots[0]?.stage;
}

/**
 * `{ slotStage }` for a calendar fire, and `{}` for everything else.
 *
 * FOUR REASONS TO SEND NOTHING, and only one of them is a failure:
 *
 * 1. **This is not a calendar run.** `runType: "scheduled"` is what the cron
 *    stamps on a fire it made from a schedule row (`/api/run-scheduled`), and
 *    it is the only run type the calendar produces. A launch, a manual
 *    template run and someone pressing Run are all a person choosing this
 *    moment for a reason the calendar knows nothing about, and
 *    `docs/agent-architecture.md` §1.1 is explicit that the absence is
 *    information rather than an omission to be helpfully filled in.
 * 2. **The product has no platform** — the SEO audit, the landing builder.
 *    There is no funnel to take a stage from.
 * 3. **There is no plan**: no strategy map yet (every client between setup and
 *    their first run), or a pool the map has exhausted.
 * 4. **The control plane could not be asked.** Handled exactly like the three
 *    above, and deliberately: the engine's `stageForRun` falls back to the
 *    account's own history, so the cost of a middleware outage here is one run
 *    sequenced slightly worse. Failing the dispatch would make it no run.
 */
export async function slotStageForCalendarRun(
  client: Pick<Client, "agentsRepoSlug">,
  productId: string,
  runType: JobRunType | undefined,
): Promise<{ slotStage?: FunnelStage }> {
  if (runType !== "scheduled") return {};
  const platform = learningPlatformForProduct(productId);
  if (!platform) return {};
  const stage = await slotStageForRun(client, platform);
  return stage ? { slotStage: stage } : {};
}
