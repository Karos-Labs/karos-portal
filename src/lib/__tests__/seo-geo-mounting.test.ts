import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * QA F152 — the PREVENTION half. (Restoration was F1.)
 *
 * On 22 Jul, db573d0 shipped the plain-English action plan with its working
 * Approve button. Hours later, de0d414 ("resolve SEO dashboard merge boundary")
 * resolved a merge against the five-day-older SCRUM-52 redesign and kept the old
 * panel. SeoGeoActionPlan became an orphan: a complete, wired, client-facing
 * component imported by zero files. Both trees still compiled, every test still
 * passed, and nobody noticed for five weeks — the plain-English copy kept being
 * generated and persisted on every run, then thrown away at render.
 *
 * The failure mode is specifically invisible to type-checking and to unit tests
 * that exercise components directly, because nothing about an unmounted component
 * is a type error. These checks close that hole: a merge that drops the render, or
 * that orphans anything else in the SEO/GEO family, fails here.
 */

const SRC = path.resolve(process.cwd(), "src");

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

const ALL_FILES = walk(SRC);
const read = (file: string) => readFileSync(file, "utf8");

/** Files whose whole point is to be rendered by someone else. */
function seoGeoModules(): string[] {
  return ALL_FILES.filter((f) => {
    const rel = path.relative(SRC, f);
    return (
      (rel.startsWith(path.join("components", "seo-geo")) ||
        rel.startsWith(path.join("components", "seo-geo-"))) &&
      !rel.includes("__tests__")
    );
  });
}

/** Any file that imports `target` by its module specifier's last segment. */
function importersOf(target: string): string[] {
  const base = path.basename(target).replace(/\.tsx?$/, "");
  const spec = new RegExp(`from\\s+["'][^"']*/${base}["']`);
  return ALL_FILES.filter((f) => f !== target && spec.test(read(f)));
}

describe("SEO/GEO surfaces stay mounted (QA F152)", () => {
  it("has no orphaned component in the SEO/GEO family", () => {
    const orphans = seoGeoModules()
      .filter((f) => importersOf(f).length === 0)
      .map((f) => path.relative(SRC, f));
    // A zero-importer component here means a merge dropped a render — exactly the
    // regression that hid SeoGeoActionPlan for five weeks. Delete it or mount it.
    expect(orphans).toEqual([]);
  }, 15_000); // Full-repo file scan — the default 5s budget is already gone as the codebase grows, not a slow assertion.

  it("keeps the client-facing action plan mounted in the panel", () => {
    const panel = read(path.join(SRC, "components", "seo-geo-panel.tsx"));
    expect(panel).toMatch(/import\s*\{[^}]*\bSeoGeoActionPlan\b[^}]*\}\s*from/);
    expect(panel).toContain("<SeoGeoActionPlan");
    // Not just imported — actually fed the persisted plan and the approval state.
    expect(panel).toMatch(/recommendations=\{/);
    expect(panel).toMatch(/approvedRecIds=\{/);
    expect(panel).toContain("insights.recommendations");
  });

  it("keeps the internal gap list behind the staff gate, below the plan", () => {
    const panel = read(path.join(SRC, "components", "seo-geo-panel.tsx"));
    // `gaps` is documented INTERNAL — never rendered raw to a client (dev-handoff §4).
    expect(panel).toMatch(/!isClientViewer\s*&&/);
    // The plan is the primary view; GapList is the technical disclosure under it.
    expect(panel.indexOf("<SeoGeoActionPlan")).toBeLessThan(panel.indexOf("<GapList"));
  });

  it("still builds and persists the plan on every capture run", () => {
    // If the pipeline stops writing `recommendations`, the mounted component
    // silently renders its empty state — the same invisible failure, one layer down.
    //
    // SCRUM-274 (T-B19): this used to read `src/lib/intel/seo-geo.ts`, the old
    // in-process SEO/GEO capture `runSeoGeoResearch` ran, called exclusively
    // from the now-deleted `src/lib/intel/pipeline.ts` — deleted along with it
    // (see this ticket's report). The capture run this test's own name refers
    // to is not gone: it is now the real `seo-geo-agent`, dispatched through
    // agent-engine, whose deliverable `src/lib/agent-engine/
    // seo-geo-insights-mapping.ts` maps into the SAME `SeoGeoInsights` shape
    // (`recommendations: buildRecommendations(gaps)`, using the identical
    // `src/lib/seo-geo.ts` helper the old path used) before
    // `persist-seo-geo-insights.ts` writes it through the same
    // `upsertClientSeoGeo` this test used to indirectly guard.
    const pipeline = read(path.join(SRC, "lib", "agent-engine", "seo-geo-insights-mapping.ts"));
    expect(pipeline).toContain("buildRecommendations(");
    expect(pipeline).toMatch(/recommendations:\s*(dedupe|buildRecommendations)/);
  });
});
