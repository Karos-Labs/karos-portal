/**
 * What a short-video gate (tiktok-agent's `11-clip-review`) carries, read
 * defensively off the gate payload so the approval component can show a
 * reviewer the clip, its cost and its provenance instead of a raw link and
 * three collapsed JSON blobs (audit 2026-09-09).
 *
 * Pure, so it is unit-tested without a DOM; the component only renders what
 * comes back. Every field is optional: an older engine build that sends fewer
 * keys renders fewer facts, never an error. Shapes mirror agent-engine's
 * `create-tiktok-agent-workflow.ts` gate payload and are NOT imported
 * (separate repos), same as the style-directive readers beside this file.
 */

export type ClipBudgetPlan = "original" | "replan" | "stock-only" | "stock-only-silent";

export interface ClipWeakBeat {
  index: number;
  relevance: number;
  note?: string;
}

export interface ClipVisualQa {
  passed: boolean;
  reason?: string;
  evidence: string[];
  /** Beats whose footage the QA model scored as not fitting the line said over it (engine `visualQa.weakBeats`, 2026-09-10). */
  weakBeats?: ClipWeakBeat[];
}

export interface ClipScriptBeat {
  narration: string;
  onScreenText?: string;
  seconds?: number;
}

export interface ClipReview {
  /** A signed https URL a `<video>` can play. Absent when the engine could not upload (the gate then carries only a container path). */
  videoUrl?: string;
  format?: "original-short" | "commentary-clip";
  sourceTier?: string;
  durationSeconds?: number;
  voiceover?: boolean;
  topic?: string;
  /** What the run had spent when the clip reached the gate, in USD. */
  costSoFarUsd?: number;
  /** The pre-purchase estimate for the whole run, in USD. */
  estimatedCostUsd?: number;
  /** The run's ceiling, in USD. */
  maxCostUsd?: number;
  budgetPlan?: ClipBudgetPlan;
  replans?: number;
  /** Per shot, `stock` (a real library clip) or `still` (a generated photograph with a push-in). */
  plateSources?: string[];
  music?: { applied: boolean; note?: string };
  visualQa?: ClipVisualQa;
  /** The engine flagged the clip (the visual QA failed); the human decides. */
  flagged: boolean;
  script?: { hook?: string; format?: "footage" | "text-led"; beats: ClipScriptBeat[] };
}

/** The payload keys the clip block renders itself, so the generic fact grid does not repeat them. */
export const CLIP_REVIEW_KEYS: ReadonlySet<string> = new Set([
  "videoUrl",
  "gcsUri",
  "clipPath",
  "format",
  "sourceTier",
  "durationSeconds",
  "voiceover",
  "costSoFarUsd",
  "estimatedCostUsd",
  "maxCostUsd",
  "budgetPlan",
  "replans",
  "plateSources",
  "music",
  "visualQa",
  "flagged",
  "script",
  "revision",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

/**
 * Reads a clip review off a gate payload. Returns `undefined` when the payload
 * is not a short-video gate at all: no `format` naming a clip pipeline and no
 * playable `videoUrl`. A commentary clip from a client's own footage and an
 * original short both count.
 */
export function readClipReview(payload: unknown): ClipReview | undefined {
  if (!isRecord(payload)) return undefined;
  const format = payload["format"] === "original-short" || payload["format"] === "commentary-clip" ? payload["format"] : undefined;
  const videoUrl = str(payload["videoUrl"]);
  const playable = videoUrl !== undefined && /^https:\/\//i.test(videoUrl) ? videoUrl : undefined;
  if (format === undefined && playable === undefined) return undefined;

  const budgetPlanRaw = payload["budgetPlan"];
  const budgetPlan =
    budgetPlanRaw === "original" || budgetPlanRaw === "replan" || budgetPlanRaw === "stock-only" || budgetPlanRaw === "stock-only-silent" ? budgetPlanRaw : undefined;

  const musicRaw = payload["music"];
  const music = isRecord(musicRaw) && typeof musicRaw["applied"] === "boolean" ? { applied: musicRaw["applied"], ...(str(musicRaw["note"]) !== undefined ? { note: str(musicRaw["note"])! } : {}) } : undefined;

  const qaRaw = payload["visualQa"];
  const visualQa: ClipVisualQa | undefined =
    isRecord(qaRaw) && typeof qaRaw["passed"] === "boolean"
      ? {
          passed: qaRaw["passed"],
          ...(str(qaRaw["reason"]) !== undefined ? { reason: str(qaRaw["reason"])! } : {}),
          evidence: Array.isArray(qaRaw["evidence"]) ? qaRaw["evidence"].filter((e): e is string => typeof e === "string") : [],
          ...(() => {
            const raw = qaRaw["weakBeats"];
            if (!Array.isArray(raw)) return {};
            const weakBeats = raw.flatMap((b): ClipWeakBeat[] => {
              if (!isRecord(b) || num(b["index"]) === undefined || num(b["relevance"]) === undefined) return [];
              return [{ index: num(b["index"])!, relevance: num(b["relevance"])!, ...(str(b["note"]) !== undefined ? { note: str(b["note"])! } : {}) }];
            });
            return weakBeats.length > 0 ? { weakBeats } : {};
          })(),
        }
      : undefined;

  const plateSources = Array.isArray(payload["plateSources"]) ? payload["plateSources"].filter((p): p is string => typeof p === "string") : undefined;

  const scriptRaw = payload["script"];
  const script =
    isRecord(scriptRaw) && Array.isArray(scriptRaw["beats"])
      ? {
          ...(str(scriptRaw["hook"]) !== undefined ? { hook: str(scriptRaw["hook"])! } : {}),
          ...(scriptRaw["format"] === "footage" || scriptRaw["format"] === "text-led" ? { format: scriptRaw["format"] as "footage" | "text-led" } : {}),
          beats: scriptRaw["beats"].flatMap((b): ClipScriptBeat[] => {
            if (!isRecord(b) || str(b["narration"]) === undefined) return [];
            return [
              {
                narration: str(b["narration"])!,
                ...(str(b["onScreenText"]) !== undefined ? { onScreenText: str(b["onScreenText"])! } : {}),
                ...(num(b["seconds"]) !== undefined ? { seconds: num(b["seconds"])! } : {}),
              },
            ];
          }),
        }
      : undefined;

  return {
    ...(playable !== undefined ? { videoUrl: playable } : {}),
    ...(format !== undefined ? { format } : {}),
    ...(str(payload["sourceTier"]) !== undefined ? { sourceTier: str(payload["sourceTier"])! } : {}),
    ...(num(payload["durationSeconds"]) !== undefined ? { durationSeconds: num(payload["durationSeconds"])! } : {}),
    ...(typeof payload["voiceover"] === "boolean" ? { voiceover: payload["voiceover"] } : {}),
    ...(str(payload["topic"]) !== undefined ? { topic: str(payload["topic"])! } : {}),
    ...(num(payload["costSoFarUsd"]) !== undefined ? { costSoFarUsd: num(payload["costSoFarUsd"])! } : {}),
    ...(num(payload["estimatedCostUsd"]) !== undefined ? { estimatedCostUsd: num(payload["estimatedCostUsd"])! } : {}),
    ...(num(payload["maxCostUsd"]) !== undefined ? { maxCostUsd: num(payload["maxCostUsd"])! } : {}),
    ...(budgetPlan !== undefined ? { budgetPlan } : {}),
    ...(num(payload["replans"]) !== undefined ? { replans: num(payload["replans"])! } : {}),
    ...(plateSources !== undefined && plateSources.length > 0 ? { plateSources } : {}),
    ...(music !== undefined ? { music } : {}),
    ...(visualQa !== undefined ? { visualQa } : {}),
    flagged: payload["flagged"] === true || (visualQa !== undefined && !visualQa.passed),
    ...(script !== undefined && script.beats.length > 0 ? { script } : {}),
  };
}

/**
 * A USD figure for the gate block. Client-safe on purpose: the component is a
 * client module and `@/lib/data-analytics` (where `fmtCost` lives) is
 * server-only, so the same rules are restated here: two decimals from a
 * dollar up, four under a dollar, six under a cent, "$0.00" for zero.
 */
export function formatUsd(usd: number): string {
  if (!Number.isFinite(usd) || usd === 0) return "$0.00";
  if (usd < 0.01) return `$${usd.toFixed(6)}`;
  if (usd < 1) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

/** "0:31" for 31.2 seconds; what a reviewer expects beside a play button. */
export function formatClipDuration(seconds: number): string {
  const whole = Math.max(0, Math.round(seconds));
  const m = Math.floor(whole / 60);
  const s = whole % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

/** One line on how the run was kept under its ceiling, for the reviewer. */
export function describeBudgetPlan(review: Pick<ClipReview, "budgetPlan" | "replans">): string | undefined {
  switch (review.budgetPlan) {
    case "original":
      return "Plan fit the ceiling as written.";
    case "replan":
      return `Re-planned ${review.replans ?? 1} time${(review.replans ?? 1) === 1 ? "" : "s"} to fit the ceiling.`;
    case "stock-only":
      return "Two re-plans still priced over the ceiling; finished on free stock footage only.";
    case "stock-only-silent":
      return "Two re-plans still priced over the ceiling; finished on free stock footage, without a voice.";
    default:
      return undefined;
  }
}

/** A `plateSources` list summarised: "4 stock, 1 still". */
export function summarisePlateSources(plateSources: readonly string[]): string {
  const counts = new Map<string, number>();
  for (const source of plateSources) counts.set(source, (counts.get(source) ?? 0) + 1);
  return [...counts.entries()].map(([source, count]) => `${count} ${source}`).join(", ");
}
