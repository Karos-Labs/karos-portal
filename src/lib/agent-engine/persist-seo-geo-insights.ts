import "server-only";
import { getClient, listClientCompetitors, upsertClientSeoGeo } from "@/lib/data";
import { readAgentEngineRun, isArchivedOutput, type AgentEngineStepRecord } from "./read-run";
import { mapAgentEngineSeoGeoToInsights } from "./seo-geo-insights-mapping";
import type { AgentEngineCaptureCell, AgentEngineSeoGeoReport } from "./seo-geo-deliverable-types";

/**
 * T-B16/SCRUM-271 — the second half of "note only" -> "full rendering in the
 * C5 table" (see `materialize.ts`'s `materializeSeoGeoReport` for the first
 * half, the staff-facing note asset, which this function does not replace).
 *
 * `getAgentEngineDeliverable` (Task 1's plumbing) only ever returns the ONE
 * named deliverable a workflow persisted — it has no notion of a step's own
 * checkpoint. The raw (prompt × engine) capture cells this mapping needs
 * (`seo-geo-insights-mapping.ts`'s header explains why) live only in step
 * `08-assemble-visibility-cells`'s own recorded output, which is why this
 * reads `readAgentEngineRun` — the SAME read path the Job page's "Agent
 * transcript" / step-output panel already uses (`read-run.ts`,
 * `step-transcript.ts`) — rather than a second HTTP endpoint.
 */

const VISIBILITY_CELLS_STEP_ID = "08-assemble-visibility-cells";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asCells(output: unknown): AgentEngineCaptureCell[] | undefined {
  if (!isRecord(output) || !Array.isArray(output["cells"])) return undefined;
  const cells: AgentEngineCaptureCell[] = [];
  for (const raw of output["cells"]) {
    if (!isRecord(raw)) continue;
    const promptId = raw["promptId"];
    const engine = raw["engine"];
    const captureTier = raw["captureTier"];
    if (typeof promptId !== "string" || typeof engine !== "string" || typeof captureTier !== "string") continue;
    cells.push({
      promptId,
      engine,
      captureTier: captureTier as AgentEngineCaptureCell["captureTier"],
      brandMentioned: raw["brandMentioned"] === true,
      brandFirstMentionCharOffset:
        typeof raw["brandFirstMentionCharOffset"] === "number" ? raw["brandFirstMentionCharOffset"] : undefined,
      brandCited: raw["brandCited"] === true,
      competitorsNamed: Array.isArray(raw["competitorsNamed"])
        ? raw["competitorsNamed"].filter(
            (c): c is { brandId: string; charOffset: number } =>
              isRecord(c) && typeof c["brandId"] === "string" && typeof c["charOffset"] === "number",
          )
        : undefined,
      citations: Array.isArray(raw["citations"])
        ? raw["citations"].filter(
            (c): c is { domain: string; ordinal: number } =>
              isRecord(c) && typeof c["domain"] === "string" && typeof c["ordinal"] === "number",
          )
        : undefined,
      mentionCounts: isRecord(raw["mentionCounts"]) ? (raw["mentionCounts"] as Record<string, number>) : undefined,
      sentimentPerMention: Array.isArray(raw["sentimentPerMention"])
        ? raw["sentimentPerMention"].filter(
            (s): s is { mentionIndex: number; label: "pos" | "neg" | "neutral" } =>
              isRecord(s) &&
              typeof s["mentionIndex"] === "number" &&
              (s["label"] === "pos" || s["label"] === "neg" || s["label"] === "neutral"),
          )
        : undefined,
      aioAbsent: typeof raw["aioAbsent"] === "boolean" ? raw["aioAbsent"] : undefined,
    });
  }
  return cells;
}

/**
 * Finds step `08-assemble-visibility-cells`'s own checkpoint among a run's
 * steps and pulls its `cells`. Returns `undefined` — never throws — when the
 * step hasn't run yet, its output was offloaded to GCS
 * (`{archived:true,...}`, the dual-storage archive for an oversized
 * checkpoint), or the shape doesn't parse: every one of those is "map without
 * per-engine data" for the caller, not a mapping failure.
 */
function cellsFromSteps(steps: readonly AgentEngineStepRecord[]): AgentEngineCaptureCell[] | undefined {
  const step = steps.find((s) => s.stepId === VISIBILITY_CELLS_STEP_ID);
  if (!step || step.output === undefined || isArchivedOutput(step.output)) return undefined;
  return asCells(step.output);
}

/**
 * Fetches everything `mapAgentEngineSeoGeoToInsights` needs beyond the
 * deliverable itself, builds the typed `SeoGeoInsights`, and persists it to
 * `clientSeoGeo` (`upsertClientSeoGeo`, which already carries forward
 * `visibilityHistory`/`approvedRecIds` across a re-capture — see that
 * function's own doc in `data.ts`).
 *
 * BEST-EFFORT AND NEVER THROWS, matching `materializeAgentEngineDeliverable`'s
 * own contract (its caller): a failure here must not keep the run's job out
 * of `status: "review"`, and the staff-facing note asset
 * (`materializeSeoGeoReport`) already carries the run's content on its own.
 */
export async function persistSeoGeoInsightsFromDeliverable(
  clientId: string,
  runId: string,
  report: AgentEngineSeoGeoReport,
  capturedAt: number,
): Promise<void> {
  try {
    const [client, competitors, runView] = await Promise.all([
      getClient(clientId),
      listClientCompetitors(clientId),
      readAgentEngineRun(runId),
    ]);
    if (!client) {
      console.error(`[seo-geo-insights] client "${clientId}" not found — skipping clientSeoGeo write for run "${runId}"`);
      return;
    }
    const cells = runView ? cellsFromSteps(runView.steps) : undefined;

    const insights = mapAgentEngineSeoGeoToInsights({
      clientId,
      clientName: client.name,
      clientWebsite: client.website,
      competitors: competitors.map((c) => ({ company: c.company, url: c.url })),
      report,
      cells,
      capturedAt,
    });

    await upsertClientSeoGeo(insights);
  } catch (e) {
    console.error(`[seo-geo-insights] failed to map/persist clientSeoGeo for client "${clientId}" (run "${runId}")`, e);
  }
}
