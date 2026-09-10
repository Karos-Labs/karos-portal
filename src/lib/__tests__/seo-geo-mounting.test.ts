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

/**
 * MEMOIZED (2026-09), and the reason is the shape of `importersOf` below: it
 * scans every file in `src/` looking for one module's importers, and it is
 * called once per SEO/GEO module. Uncached that is `modules × files` synchronous
 * reads — around 4,000 — and this test's 15s budget was being exceeded under a
 * full-suite run, so the guard failed with a timeout rather than a finding. The
 * cost also grew with the tree, which makes a timeout tuned on an unloaded run a
 * tripwire on every future file added to src/.
 *
 * Nothing mutates a file during the run, so one read per path is the same text.
 */
const READ_CACHE = new Map<string, string>();
const read = (file: string): string => {
  let cached = READ_CACHE.get(file);
  if (cached === undefined) {
    cached = readFileSync(file, "utf8");
    READ_CACHE.set(file, cached);
  }
  return cached;
};

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

  /**
   * THE CONTRACT CHANGED (portal feedback round 4, 2026-09), and it did not
   * weaken: it inverted. F152 pinned that the Karos-owned action plan must stay
   * MOUNTED, because a merge had silently orphaned it. The product owner then
   * ruled the section itself untrue — "all these 'what we're fixing' items are
   * not true… make the system not generate this anymore" — so the plan must now
   * stay OFF the client-facing report, and the thing that may not be silently
   * dropped is its replacement.
   *
   * Both halves are pinned, because the failure mode F152 describes is unchanged
   * in shape: nothing about an unrendered component is a type error.
   */
  it("keeps the plan wired to the persisted snapshot, for the cross-repo contract", () => {
    // buildRecommendations is still produced and persisted on every capture for
    // docs/routable-recommendation-contract.md, and this render path is kept so
    // re-enabling it is a decision, not a rebuild. It must therefore stay whole.
    const panel = read(path.join(SRC, "components", "seo-geo-panel.tsx"));
    expect(panel).toMatch(/import\s*\{[^}]*\bSeoGeoActionPlan\b[^}]*\}\s*from/);
    expect(panel).toContain("<SeoGeoActionPlan");
    expect(panel).toMatch(/recommendations=\{/);
    expect(panel).toMatch(/approvedRecIds=\{/);
    expect(panel).toContain("insights.recommendations");
    // ...and stay off unless a caller asks for it by name.
    expect(panel).toMatch(/hidePlan = true/);
  });

  it("renders no Karos-owned plan on the client-facing report", () => {
    const page = read(path.join(SRC, "app", "(app)", "clients", "[id]", "settings", "page.tsx"));
    // The Reporting tab is the ONLY surface that mounts the report. Neither the
    // plan nor the internal gap list may be mounted from it, under any prop.
    expect(page).not.toMatch(/<SeoGeoPlan/);
    expect(page).not.toMatch(/<GapList/);
    expect(page).not.toMatch(/\bSeoGeoPlan\b.*from "@\/components\/seo-geo-panel"/);
    expect(page).not.toMatch(/from "@\/components\/seo-geo\/gap-list"/);
    // And it says so at the panel it does mount, rather than inheriting the default.
    expect(page).toMatch(/hidePlan\b/);
  });

  it("mounts the client-owned suggestions in its place", () => {
    const page = read(path.join(SRC, "app", "(app)", "clients", "[id]", "settings", "page.tsx"));
    expect(page).toMatch(/import\s*\{[^}]*\bClientSuggestions\b[^}]*\}\s*from/);
    expect(page).toContain("<ClientSuggestions");
    // Fed from the same snapshot the scores read, through the pure builder whose
    // rules are the product (see seo-geo-client-suggestions.test.ts).
    expect(page).toContain("buildClientSuggestions(");
    expect(page).toMatch(/suggestions=\{/);
  });

  /**
   * round 6: THE TAB'S ORDER IS A RULING, so it is pinned by source index the
   * same way the mounts themselves are.
   *
   * Albert: "Move 'Things only you can do' to the very bottom of Reporting" and
   * "ADD above it a section [that lists] every relevant Karos agent with what it
   * does for visibility". Reading order is the whole point of both asks — the
   * scores answer the question the tab is named after, the agent rows say what
   * is moving them, the panel is the comparison and the working, and the one
   * section that asks the READER for anything closes the tab. Nothing about an
   * order is a type error, which is this file's entire premise.
   */
  it("reads scores, then what we are doing, then the report, then the client's own list", () => {
    const page = read(path.join(SRC, "app", "(app)", "clients", "[id]", "settings", "page.tsx"));
    expect(page).toMatch(/import\s*\{[^}]*\bVisibilityWork\b[^}]*\}\s*from/);
    // The section is built once and mounted through a const, because the
    // no-snapshot branch shows it too (what we are doing does not depend on
    // having measured it yet).
    expect(page).toContain("<VisibilityWork");
    // Read off the JSX that renders the tab, not off the whole file: the notes
    // above the panel name `<ClientSuggestions/>` in prose, and a comment is
    // not a mount.
    const section = page.slice(page.indexOf("const reportingSection = seoGeo ?"));
    const order = ["<SeoGeoScores", "{visibilityWork}", "{visibilityPanel}", "<ClientSuggestions"].map(
      (needle) => section.indexOf(needle),
    );
    expect(order.every((i) => i > -1), section).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it("keeps the hand-built Reputation card off the tab", () => {
    // round 6: it was the only "what Karos does" pointer on a tab full of
    // scores — one agent, a label invented on this page, and a green "Beta"
    // badge. The Reputation agent is a row in <VisibilityWork/> now, with the
    // roster's own status word, so a second surface cannot describe it
    // differently.
    const page = read(path.join(SRC, "app", "(app)", "clients", "[id]", "settings", "page.tsx"));
    // Anchored on the mount, so the note explaining the removal (which quotes
    // the badge it took with it) is not itself a hit.
    expect(page).not.toMatch(/^\s*\{reputationBubble\}/m);
    expect(page).not.toMatch(/<Badge tone="neon">/);
    expect(page).not.toMatch(/^\s*const reputationBubble/m);
  });

  it("keeps Performance and Connected channels off the Reporting tab", () => {
    // "Connected channels and Performance have nothing to do in the Reporting
    // tab." Staff Home keeps its own <ClientAnalytics/>; this page has none.
    const page = read(path.join(SRC, "app", "(app)", "clients", "[id]", "settings", "page.tsx"));
    // Anchored, so the note explaining the removal is not itself a hit.
    expect(page).not.toMatch(/^\s*<ClientAnalytics/m);
    expect(page).not.toMatch(/from "@\/components\/client-analytics"/);
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
