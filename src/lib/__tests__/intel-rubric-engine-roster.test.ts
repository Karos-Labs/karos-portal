import { describe, expect, it, vi } from "vitest";
import { ENGINE_LABELS, ENGINE_PROVIDERS } from "@/lib/seo-geo";

vi.mock("server-only", () => ({}));

const { DEFAULT_INTEL_PROMPT, METRICS_RULES } = await import("@/lib/intel/brain");

/**
 * #142 — a scorer that outlived its engine.
 *
 * The Intel Report and the SEO/GEO dashboard are two Karos assessments of the
 * same thing, and a client can open both: the report is served to CLIENT_USERs
 * from `src/app/api/clients/[id]/report/route.ts` and loaded into the client
 * portal shell. Call directive B2 cut the tracked engine set to the ones with a
 * wired provider — `EngineId`, the chips, the scoring inputs — but the report's
 * rubric was prose and kept grading "mentions in ChatGPT/Perplexity/Gemini
 * responses": one engine nothing measures, and Claude, which everything else
 * measures, missing. The same prompt already carried the contradiction, since
 * `report.ts` appends the measured per-engine rows under `ENGINE_LABELS`.
 *
 * These assertions are keyed to the maps in `src/lib/seo-geo.ts`, not to any
 * engine's spelling, and they are written as EXACT sets rather than as a list of
 * names to avoid — a blocklist only catches the engines whoever typed it
 * remembered.
 */
describe("the Intel rubric grades the engines this platform actually measures", () => {
  /** The one weighted-dimension line; `toHaveLength(1)` is what makes it "the one". */
  const rubricLines = DEFAULT_INTEL_PROMPT.split("\n").filter((l) =>
    l.startsWith("4. **GEO & AI Discoverability**"),
  );

  it("has exactly one GEO dimension line to grade against", () => {
    expect(rubricLines).toHaveLength(1);
  });

  it("names the tracked engine roster there, and nothing else", () => {
    const engines = /mentions in ([^,]+) responses/.exec(rubricLines[0]!)?.[1]?.split("/");
    expect(engines).toEqual(Object.values(ENGINE_LABELS));
  });

  it("sources the visibility index from the providers that answer for those engines", () => {
    // The neighbouring statement of the same fact, one axis over: METRICS_RULES
    // says which VENDOR's API produced the number. It is correct today; this
    // pins it so the roster and the provider list cannot drift apart silently.
    const row = METRICS_RULES.split("\n").find((l) => l.includes("| geo_visibility_index |"));
    expect(row).toBeTruthy();
    const named = /Multi-model capture \(([^)]+)\)/.exec(row!)?.[1]?.split(" / ");
    const wired = Object.values(ENGINE_PROVIDERS).filter((p): p is NonNullable<typeof p> => p !== null);
    expect(named).toEqual(wired);
  });
});
