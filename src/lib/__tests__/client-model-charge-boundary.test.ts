import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { readSource } from "./source-scan";

/**
 * NO CLIENT-REACHABLE MODEL CALL WITHOUT A DECISION ABOUT WHO PAYS.
 *
 * Five separate surfaces let a client spend Karos money on a model with no
 * charge attached — "Propose accounts", the copilot's Refresh Task Map chip,
 * Audience Simulation, and two more this scan found on its own. They were not a
 * list of oversights so much as one missing rule, so the rule is asked here of
 * a DERIVED set rather than of a list somebody has to remember to extend.
 *
 * ── WHAT THE SCAN COMPUTES ───────────────────────────────────────────────────
 *
 * 1. A CALL GRAPH over every top-level function in `src`, at EXPORT
 *    granularity. Module granularity was tried first and was useless: it makes
 *    `inferOwnerEngine` — a pure switch — "model-reaching" because it happens to
 *    live in execution-engine.ts next to something that does call a model, which
 *    buried the four real findings under a dozen false ones. The graph resolves
 *    each callee through the file's own imports (static, `await import()`
 *    destructures, and `export … from` re-export chains, which is what makes the
 *    `lib/actions/index.ts` barrel transparent).
 *
 * 2. MODEL-REACHING nodes: the closure of anything that calls `generateText`,
 *    `generateObject` or `streamText` — i.e. IN-PROCESS model calls only. The
 *    agent service is a different animal entirely and is NOT in this set (see
 *    the limits section at the bottom); nothing here should be read as a claim
 *    about it.
 *
 * 3. CHARGING nodes: the closure of anything that calls `chargeClientModelCall`
 *    or `withClientModelCharge` — the one home in lib/client-model-charge.ts.
 *    Deliberately NOT `chargeClientCredits`: that is the data-layer primitive,
 *    and accepting it here would re-bless exactly the five hand-rolled spellings
 *    this cluster consolidated.
 *
 * 4. ENTRY POINTS: exported handlers in `src/app/api/**​/route.ts` and exported
 *    actions in `src/lib/actions/*.ts`. Both are network-reachable surfaces; a
 *    server action is reachable whether or not any component calls it today,
 *    which is why the scan reads exports rather than UI call sites.
 *
 * ── HOW A NON-CHARGING ENTRY IS EXCUSED ──────────────────────────────────────
 *
 * By CHARACTERISING ITS BOUNDARY, and — for the one open product decision —
 * by naming it in a register that fails when it goes stale. Four gates count,
 * each read off a named CALL in the entry's own body, and each covering only the
 * model calls that come after it:
 *
 *   - `requireStaff()` / `requireAdmin()` — agency overhead, never billed.
 *   - `requireCronSecret()` / `checkWebhookSecret()` (`lib/cron-auth`) — no
 *     client actor exists.
 *   - `requireFirstOnboarding()` — may run once per account, so it cannot be
 *     replayed for free compute. Onboarding provisioning is deliberately free;
 *     that is affordable *because* of this gate, which is why the gate is what
 *     the scan reads rather than the intent.
 *
 * Plus one region form: a model call sitting inside an `if (isStaff…)` /
 * `if (user.role === "KAROS_…")` block of an otherwise client-reachable action.
 * `addCompetitorByNameAction` is the live case — a client may add a competitor,
 * only staff trigger the analysis.
 *
 * EVERY ONE OF THESE IS KEYED TO A POSITION, not to the enclosing export. That
 * is the whole point of the rewrite this file has had: as a per-export boolean,
 * a gate anywhere greened every path through the function, and the cron gate was
 * worse still — it was `/cron-auth/.test(theWholeFileText)`, so one comment
 * mentioning it marked every exported handler in the file gated.
 *
 * ── WHAT THIS DOES NOT SEE, stated rather than implied ───────────────────────
 *
 * 1. THE AGENT SERVICE IS NOT IN SCOPE. Custom-agent and managed-product runs
 *    are the most expensive thing a client can trigger, and they never call
 *    `generateText` in this process — they POST to the service and land on a
 *    webhook. Their charge/refund contract lives in submit-custom.ts and
 *    credit-reconcile.ts and is guarded by other tests. Nothing this file says
 *    green covers them.
 * 2. THE GRAPH FOLLOWS NAMED CALLS AND NAMED REFERENCES. A model call reached
 *    only through a value this scan cannot name — a function on an object
 *    literal, a callback selected at runtime, a dynamic `import(variable)` — is
 *    invisible to it.
 * 3. LEXICAL ORDER IS NOT CONTROL FLOW. "A charge appears before this model
 *    call" is the strongest ordering fact an AST scan gets for free. Two shapes
 *    slip through it: a charge taken inside a conditional (`if (force) charge()`
 *    — real, in the insights route, where the unforced rerun is deliberately
 *    free), and a pure charge WRAPPER called before an unrelated model call in
 *    the same function. A charged, model-reaching sibling does NOT green a later
 *    call — that one is closed, and planted below.
 *
 * It is not a proof; it is a tripwire over the shapes this codebase actually
 * writes. Both of its directions are exercised below by planting into the real
 * source text, because a scan that cannot fail is worse than no scan.
 */

const SRC = resolve(__dirname, "..", "..");
const MODEL_FNS = new Set(["generateText", "generateObject", "streamText"]);
const CHARGE_FNS = new Set(["chargeClientModelCall", "withClientModelCharge"]);
const ENTRY_GATES = new Set(["requireStaff", "requireAdmin", "requireFirstOnboarding"]);
/**
 * lib/cron-auth.ts — the two functions that actually refuse an unsigned
 * caller — plus lib/agent-service/verify.ts's HMAC check, the same gate class
 * for the agent-service webhook: the handler 401s before any work when the
 * signature is invalid, so no client credential can ever reach a model call
 * behind it (the webhook's own titling call, asset-titles.ts, is
 * platform-absorbed by that gate's design).
 */
const CRON_GATES = new Set(["requireCronSecret", "checkWebhookSecret", "verifyAgentServiceSignature"]);
const ALL_GATES = new Set([...ENTRY_GATES, ...CRON_GATES]);

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) {
      if (entry === "__tests__" || entry === "node_modules") continue;
      walk(p, out);
    } else if (/\.(ts|tsx)$/.test(entry)) out.push(p);
  }
  return out;
}

const FILES = walk(SRC);

function resolveSpec(from: string, spec: string): string | null {
  let base: string;
  if (spec.startsWith("@/")) base = join(SRC, spec.slice(2));
  else if (spec.startsWith(".")) base = resolve(dirname(from), spec);
  else return null;
  for (const c of [base + ".ts", base + ".tsx", join(base, "index.ts"), join(base, "index.tsx")]) {
    if (existsSync(c)) return c;
  }
  return null;
}

const isEntryFile = (f: string) =>
  /[\\/]app[\\/]api[\\/].*[\\/]route\.ts$/.test(f) || /[\\/]lib[\\/]actions[\\/][^\\/]+\.ts$/.test(f);

interface Verdict {
  file: string;
  fn: string;
  /** Which callee carries the model call out of this entry, ungated. */
  via: string;
  kind: "gated" | "charged" | "unmetered";
}

/**
 * The real, on-disk parse of every file in `FILES`, computed exactly once.
 *
 * `analyze()` runs once at module load and again inside each of the ~9
 * planted-negative tests below, each time with only ONE file's text swapped
 * for a mutated copy. Re-parsing all ~500 source files with the TypeScript
 * compiler on every one of those calls (instead of just the single overridden
 * file) doesn't just waste CPU — it starves every other vitest worker running
 * concurrently, which is what turned unrelated suites into 5000ms timeouts.
 * `ts.SourceFile` nodes are read-only from this scan's perspective (nothing
 * here mutates the AST), so sharing the cached parse across calls is safe.
 */
const BASE_SOURCE_FILES = new Map<string, ts.SourceFile>(
  FILES.map((f) => [
    f,
    ts.createSourceFile(
      f,
      readSource(f),
      ts.ScriptTarget.Latest,
      true,
      f.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    ),
  ]),
);

/**
 * Run the whole analysis. `overrides` replaces a file's SOURCE TEXT — the hook
 * the planted-negative tests use to prove this scan can go red without editing
 * anything on disk.
 */
function analyze(overrides: Map<string, string> = new Map()): Verdict[] {
  const sf = new Map<string, ts.SourceFile>(
    FILES.map((f) => {
      if (!overrides.has(f)) return [f, BASE_SOURCE_FILES.get(f)!];
      return [
        f,
        ts.createSourceFile(
          f,
          overrides.get(f)!,
          ts.ScriptTarget.Latest,
          true,
          f.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
        ),
      ];
    }),
  );
  const each = (n: ts.Node, fn: (n: ts.Node) => void): void => {
    fn(n);
    n.forEachChild((c) => each(c, fn));
  };

  type Ref = { file: string; exp: string };
  const importsOf = new Map<string, Map<string, Ref>>();
  const reExportsOf = new Map<string, { named: Map<string, Ref>; stars: string[] }>();
  const fnsOf = new Map<string, Map<string, { body: ts.Node; exported: boolean }>>();

  for (const f of FILES) {
    const named = new Map<string, Ref>();
    const rxNamed = new Map<string, Ref>();
    const stars: string[] = [];
    each(sf.get(f)!, (n) => {
      if (ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier)) {
        const t = resolveSpec(f, n.moduleSpecifier.text);
        const b = n.importClause?.namedBindings;
        if (t && b && ts.isNamedImports(b)) {
          for (const el of b.elements) named.set(el.name.text, { file: t, exp: (el.propertyName ?? el.name).text });
        }
        return;
      }
      if (ts.isExportDeclaration(n) && n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier)) {
        const t = resolveSpec(f, n.moduleSpecifier.text);
        if (!t) return;
        if (n.exportClause && ts.isNamedExports(n.exportClause)) {
          for (const el of n.exportClause.elements) {
            rxNamed.set(el.name.text, { file: t, exp: (el.propertyName ?? el.name).text });
          }
        } else stars.push(t);
        return;
      }
      // const { x } = await import("…")
      if (ts.isVariableDeclaration(n) && n.initializer && ts.isAwaitExpression(n.initializer)) {
        const call = n.initializer.expression;
        if (
          ts.isCallExpression(call) &&
          call.expression.kind === ts.SyntaxKind.ImportKeyword &&
          call.arguments[0] &&
          ts.isStringLiteral(call.arguments[0])
        ) {
          const t = resolveSpec(f, call.arguments[0].text);
          if (t && ts.isObjectBindingPattern(n.name)) {
            for (const el of n.name.elements) {
              named.set(el.name.getText(), { file: t, exp: (el.propertyName ?? el.name).getText() });
            }
          }
        }
      }
    });
    importsOf.set(f, named);
    reExportsOf.set(f, { named: rxNamed, stars });

    const fns = new Map<string, { body: ts.Node; exported: boolean }>();
    for (const st of sf.get(f)!.statements) {
      const exported = !!(ts.canHaveModifiers(st) ? ts.getModifiers(st) : undefined)?.some(
        (m) => m.kind === ts.SyntaxKind.ExportKeyword,
      );
      if (ts.isFunctionDeclaration(st) && st.name && st.body) fns.set(st.name.text, { body: st.body, exported });
      if (ts.isVariableStatement(st)) {
        for (const d of st.declarationList.declarations) {
          if (d.initializer && (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer)) && ts.isIdentifier(d.name)) {
            fns.set(d.name.text, { body: d.initializer.body, exported });
          }
        }
      }
    }
    fnsOf.set(f, fns);
  }

  const nodeKey = (f: string, n: string) => `${f}#${n}`;
  function resolveIn(file: string, exp: string, seen: Set<string>): string | null {
    const g = `${file}|${exp}`;
    if (seen.has(g)) return null;
    seen.add(g);
    if (fnsOf.get(file)?.has(exp)) return nodeKey(file, exp);
    const rx = reExportsOf.get(file);
    if (!rx) return null;
    const nm = rx.named.get(exp);
    if (nm) return resolveIn(nm.file, nm.exp, seen);
    for (const s of rx.stars) {
      const r = resolveIn(s, exp, seen);
      if (r) return r;
    }
    return null;
  }
  function resolveName(f: string, name: string): string | null {
    if (fnsOf.get(f)?.has(name)) return nodeKey(f, name);
    const im = importsOf.get(f)?.get(name);
    return im ? resolveIn(im.file, im.exp, new Set()) : null;
  }

  const edges = new Map<string, Set<string>>();
  const modelSeeds = new Set<string>();
  const chargeSeeds = new Set<string>();
  for (const f of FILES) {
    for (const [name, fn] of fnsOf.get(f)!) {
      const self = nodeKey(f, name);
      const outs = new Set<string>();
      // Every identifier, not only callees: a function handed off as a callback
      // still runs, and `after(() => runTaskExecution(...))` is the house idiom.
      each(fn.body, (n) => {
        if (!ts.isIdentifier(n)) return;
        const nm = n.text;
        if (MODEL_FNS.has(nm)) modelSeeds.add(self);
        if (CHARGE_FNS.has(nm)) chargeSeeds.add(self);
        const r = resolveName(f, nm);
        if (r && r !== self) outs.add(r);
      });
      edges.set(self, outs);
    }
  }
  const close = (seeds: Set<string>): Set<string> => {
    const out = new Set(seeds);
    for (let changed = true; changed; ) {
      changed = false;
      for (const [k, outs] of edges) {
        if (out.has(k)) continue;
        for (const o of outs) {
          if (out.has(o)) {
            out.add(k);
            changed = true;
            break;
          }
        }
      }
    }
    return out;
  };
  const modelReaching = close(modelSeeds);
  const charging = close(chargeSeeds);

  const verdicts: Verdict[] = [];
  for (const f of FILES.filter(isEntryFile).sort()) {
    for (const [name, fn] of fnsOf.get(f)!) {
      if (!fn.exported || !modelReaching.has(nodeKey(f, name))) continue;
      const self = nodeKey(f, name);

      // ── Where the model is reached, as POSITIONS in this handler's body ──
      // Every identifier, on the same rule the call graph itself is built with,
      // so "this entry reaches a model" and "here is where" can never disagree.
      // The call-expression-only version of this loop could not see the
      // callback-handoff shape (`after(runTaskExecution)`) and reported `via:
      // null` for it — which the verdict below then read as GATED. A model call
      // the scan cannot locate is the one thing it must not call safe.
      const sites: Array<{ at: number; name: string; target: string | null }> = [];
      each(fn.body, (n) => {
        if (!ts.isIdentifier(n)) return;
        const nm = n.text;
        if (MODEL_FNS.has(nm)) {
          sites.push({ at: n.getStart(), name: nm, target: "MODEL" });
          return;
        }
        const t = resolveName(f, nm);
        if (t && t !== self && modelReaching.has(t)) sites.push({ at: n.getStart(), name: nm, target: t });
      });

      // ── Gates, as positions rather than as a boolean for the whole export ──
      // A gate can only protect what runs AFTER it, so each gate covers the
      // sites downstream of its own position and nothing else. The cron gate is
      // read here with the others: it used to be `/cron-auth/.test(fileText)`,
      // which marked every exported handler in a file gated on the strength of
      // any prose mention — a bare comment was enough, verified by planting one.
      const gatePoints: number[] = [];
      each(fn.body, (n) => {
        if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && ALL_GATES.has(n.expression.text)) {
          gatePoints.push(n.getStart());
        }
      });

      // Staff-gated REGIONS inside an otherwise client-reachable action.
      const staffSpans: Array<[number, number]> = [];
      each(fn.body, (n) => {
        if (!ts.isIfStatement(n)) return;
        const cond = n.expression.getText();
        if (/\bisStaff\b/.test(cond) || /role\s*===\s*"KAROS_/.test(cond)) {
          staffSpans.push([n.thenStatement.getStart(), n.thenStatement.getEnd()]);
        }
      });

      // ── Charges, also as positions ──
      // A charge SPAN is `withClientModelCharge(call, run)`: the model call sits
      // lexically inside it. A charge POINT is a charge taken before the model
      // call — either the helper itself, or a local wrapper around it
      // (chargeTaskExecution). A wrapper that is ITSELF model-reaching does not
      // count: `await chargedRun(); await somethingElseThatModels();` is two
      // different pieces of work, and letting the first pay for the second is
      // the per-export hole this replaces.
      const chargeSpans: Array<[number, number]> = [];
      const chargePoints: number[] = [];
      each(fn.body, (n) => {
        if (!ts.isCallExpression(n)) return;
        const e = n.expression;
        const nm = ts.isIdentifier(e) ? e.text : ts.isPropertyAccessExpression(e) ? e.name.text : null;
        if (!nm) return;
        if (CHARGE_FNS.has(nm)) {
          chargeSpans.push([n.getStart(), n.getEnd()]);
          chargePoints.push(n.getStart());
          return;
        }
        const t = resolveName(f, nm);
        if (t && charging.has(t) && !modelReaching.has(t)) chargePoints.push(n.getStart());
      });

      const live = sites.filter(
        (s) =>
          !staffSpans.some(([a, b]) => s.at >= a && s.at <= b) && !gatePoints.some((g) => g < s.at),
      );
      const unpaid = live.filter((s) => {
        if (chargeSpans.some(([a, b]) => s.at >= a && s.at <= b)) return false;
        if (chargePoints.some((p) => p < s.at)) return false;
        // The charge lives downstream of the very callee that carries the model
        // call out of here (runTaskExecution → chargeTaskExecution).
        return !(s.target && s.target !== "MODEL" && charging.has(s.target));
      });

      const rel = f.slice(SRC.length + 1).split(sep).join("/");
      const via = (list: typeof sites) => list[0]?.name ?? "-";
      if (live.length === 0) verdicts.push({ file: rel, fn: name, via: via(sites), kind: "gated" });
      else if (unpaid.length === 0) verdicts.push({ file: rel, fn: name, via: via(live), kind: "charged" });
      else verdicts.push({ file: rel, fn: name, via: via(unpaid), kind: "unmetered" });
    }
  }
  return verdicts;
}

const BASELINE = analyze();
const show = (v: Verdict[]) => v.map((x) => `${x.file} :: ${x.fn} (reaches a model via ${x.via})`).join("\n");
const key = (v: Verdict) => `${v.file}::${v.fn}`;

/**
 * FREE ON PURPOSE, PENDING A RULING — the one thing in this file that is named
 * rather than characterised, and the reason it is named is that "free until
 * Daniel decides" is a fact about a decision, not about the code.
 *
 * This is an allowlist, which this file otherwise refuses to have, so it is
 * built to rot loudly instead of quietly:
 *   - a row that no longer matches an unmetered entry FAILS (the test below),
 *     so the moment the decision lands and the code changes, the row must go;
 *   - the value is the finding id, not a hand-wave, so the row is traceable to
 *     the open question rather than to whoever added it.
 * Adding a row is a product decision being recorded, never a way to land code.
 */
const OPEN_PRICING_DECISIONS: Record<string, string> = {
  "lib/actions/intel-actions.ts::generateDocSummaryAction":
    "#168 — one credit per generated summary, or free and documented. Free is the " +
    "recommendation and the current state: nobody presses this (it runs on drawer " +
    "open), and the cache key is the doc version, so a staff or cron refresh would " +
    "make a client pay for a change they did not ask for. See the call site.",
};

describe("every client-reachable model call is charged or refused", () => {
  it("finds no entry point that spends on an in-process model call without going through the one charge home", () => {
    const offenders = BASELINE.filter((v) => v.kind === "unmetered" && !(key(v) in OPEN_PRICING_DECISIONS));
    expect(
      offenders,
      "These are network-reachable by a CLIENT_USER, reach an in-process model call\n" +
        "(generateText / generateObject / streamText), and never charge.\n" +
        "Route it through withClientModelCharge / chargeClientModelCall in lib/client-model-charge.ts,\n" +
        "or give it a real gate (requireStaff / requireAdmin / requireFirstOnboarding / cron auth).\n" +
        "Do NOT add a row to OPEN_PRICING_DECISIONS to land code — that register records\n" +
        "a pricing question someone has actually decided to leave open.\n\n" +
        show(offenders),
    ).toEqual([]);
  });

  it("keeps the open-decision register from rotting into an allowlist", () => {
    const unmetered = new Set(BASELINE.filter((v) => v.kind === "unmetered").map(key));
    const stale = Object.keys(OPEN_PRICING_DECISIONS).filter((k) => !unmetered.has(k));
    expect(
      stale,
      "These rows no longer name an unmetered entry — the code moved on (it was priced,\n" +
        "gated, renamed or deleted) and the register did not. Delete them.\n\n" +
        stale.join("\n"),
    ).toEqual([]);
  });

  /**
   * NON-VACUITY, the half that matters most. Everything above passes trivially
   * if the scan resolves nothing, so the shape of the real answer is pinned:
   * the sweep has to be finding entries, and finding them in all three states.
   */
  it("is actually resolving the graph, not silently finding nothing", () => {
    expect(BASELINE.length, "the scan found no model-reaching entry points at all").toBeGreaterThan(15);
    expect(BASELINE.filter((v) => v.kind === "charged").length).toBeGreaterThan(8);
    expect(BASELINE.filter((v) => v.kind === "gated").length).toBeGreaterThan(5);
  });

  it("sees through the actions barrel and the await-import indirection", () => {
    // proposeXRosterAction calls generateText directly; applyGlobalDocCorrection
    // reaches its model only through `const { applyDocCorrections } = await
    // import("@/lib/intel")`. Both must be classified, or the sweep is blind to
    // the two indirections this codebase uses most.
    // runPendingTasksBatchAction (settings-actions.ts) used to be pinned here
    // too — a third reachability shape, `chargeClientModelCall` called directly
    // in a loop rather than through either indirection above. It was the
    // Workspace board's own "run all pending" batch action and had no caller
    // left once the board was removed entirely (2026-08), so it was deleted
    // along with the board rather than kept as an unreachable charge point.
    const named = (fn: string) => BASELINE.find((v) => v.fn === fn);
    expect(named("proposeXRosterAction")?.kind).toBe("charged");
    expect(named("applyGlobalDocCorrectionAction")?.kind).toBe("charged");
  });
});

/**
 * BOTH DIRECTIONS, planted into the REAL source text of the REAL files (in
 * memory — nothing is written to disk, so there is no restore to get wrong).
 * Each plant is the exact loosening the rule forbids, and each is asserted to
 * turn this suite red.
 */
describe("the sweep under the loosenings it forbids", () => {
  const file = (rel: string) => join(SRC, rel);

  it("goes red when a charged entry stops charging", () => {
    const target = file("lib/actions/x-agent-actions.ts");
    const original = readSource(target);
    // Strip the charge wrapper's identifier only — the model call stays.
    const planted = original.replace(/withClientModelCharge/g, "runUncharged");
    expect(planted, "the plant did not change anything — has the helper been renamed?").not.toBe(original);

    const offenders = analyze(new Map([[target, planted]])).filter((v) => v.kind === "unmetered");
    expect(offenders.map((v) => v.fn)).toContain("proposeXRosterAction");
  });

  it("goes red when a model call leaves its staff-only block", () => {
    // addCompetitorByNameAction is client-reachable and passes ONLY because the
    // analysis call sits inside `if (isStaff) {`. Rename the condition so the
    // region is no longer recognisable as a staff gate: the same code, now
    // indistinguishable from an ungated client-triggered model call.
    const target = file("lib/actions/competitor-actions.ts");
    const original = readSource(target);
    const planted = original.replace(/\bconst isStaff =/, "const wantsAnalysis =").replace(/\bif \(isStaff\) \{/, "if (wantsAnalysis) {");
    expect(planted).not.toBe(original);

    const offenders = analyze(new Map([[target, planted]])).filter((v) => v.kind === "unmetered");
    expect(offenders.map((v) => v.fn)).toContain("addCompetitorByNameAction");
  });

  it("goes red when a once-per-account gate is dropped", () => {
    // Onboarding's AI provisioning is free BECAUSE it cannot be replayed.
    // Remove the gate and it becomes an unlimited free model call again.
    const target = file("lib/actions/onboarding-actions.ts");
    const original = readSource(target);
    const planted = original.replace(/await requireFirstOnboarding\(user\);/, "");
    expect(planted).not.toBe(original);

    const offenders = analyze(new Map([[target, planted]])).filter((v) => v.kind === "unmetered");
    expect(offenders.map((v) => v.fn)).toContain("completeOnboardingAction");
  });

  /**
   * THE CRON EXEMPTION, ASKED OF THE HANDLER. It used to be a regex over the
   * whole file's TEXT, so a single line of PROSE mentioning cron auth marked
   * every exported handler in that file gated — which is how an offender hides.
   * The plant is the cheapest possible version of that: one comment, no code.
   */
  it("does not accept a comment mentioning cron auth as a gate", () => {
    const target = file("lib/actions/intel-actions.ts");
    const original = readSource(target);
    const planted = "// Scheduled refreshes come in via lib/cron-auth (requireCronAuth).\n" + original;

    const verdicts = analyze(new Map([[target, planted]]));
    // The file's own known-free entry must still read as unmetered, not laundered
    // into "gated" by a comment somebody wrote three hundred lines away.
    expect(verdicts.find((v) => v.fn === "generateDocSummaryAction")?.kind).toBe("unmetered");
    // …and the charged entries in the same file must not read as gated either:
    // "gated" and "charged" are different claims and the comment proves neither.
    expect(verdicts.find((v) => v.fn === "applyGlobalDocCorrectionAction")?.kind).toBe("charged");
  });

  it("goes red when a cron route drops its secret check", () => {
    // The other direction for the same gate: it has to be load-bearing. This
    // pipeline is free because only Cloud Scheduler can fire it; unsigned, it is
    // an anonymous Sonnet pipeline over every scheduled client.
    const target = file("app/api/intel-report-schedule/route.ts");
    const original = readSource(target);
    const planted = original.replace(
      /const unauthorized = requireCronSecret\(req\);\s*\n\s*if \(unauthorized\) return unauthorized;/,
      "",
    );
    expect(planted, "the cron gate's shape changed — re-aim this plant").not.toBe(original);

    const offenders = analyze(new Map([[target, planted]])).filter((v) => v.kind === "unmetered");
    expect(offenders.map((v) => v.fn)).toContain("GET");
  });

  /**
   * PER-BRANCH, NOT PER-EXPORT — the two shapes the old verdict could not tell
   * apart, because it asked "does this function charge anywhere?".
   */
  it("goes red when a new branch reaches a model before the charge", () => {
    // An early return added ABOVE the charge in an already-charged handler: the
    // handler still charges, on a path this request never takes.
    const target = file("app/api/clients/[id]/simulate/route.ts");
    const original = readSource(target);
    const planted = original.replace(
      "  // ── Charge ──",
      '  if (asset.status === "draft") return Response.json(await generateText({}));\n\n  // ── Charge ──',
    );
    expect(planted, "the charge banner moved — re-aim this plant").not.toBe(original);

    const offenders = analyze(new Map([[target, planted]])).filter((v) => v.kind === "unmetered");
    expect(offenders.map((v) => v.fn)).toContain("POST");
  });

  it("goes red when a charged sibling call is used to cover a second, uncharged one", () => {
    // applyGlobalDocCorrectionAction's charge lives downstream of
    // applyGlobalDocCorrection. Add a SECOND model call next to it: the export
    // still "charges", and the new call is still free.
    const target = file("lib/actions/intel-actions.ts");
    const original = readSource(target);
    const planted = original.replace(
      "    await applyGlobalDocCorrection(clientId, corrections);\n    return { ok: true };",
      "    await applyGlobalDocCorrection(clientId, corrections);\n    await generateText({});\n    return { ok: true };",
    );
    expect(planted, "applyGlobalDocCorrectionAction's body changed — re-aim this plant").not.toBe(original);

    const offenders = analyze(new Map([[target, planted]])).filter((v) => v.kind === "unmetered");
    expect(offenders.map((v) => v.fn)).toContain("applyGlobalDocCorrectionAction");
  });

  it("stays green when the same file is edited harmlessly", () => {
    // The mirror of the plants above: a change that does NOT loosen the rule
    // must not turn the sweep red, or the guard is just noise.
    const target = file("lib/actions/x-agent-actions.ts");
    const original = readSource(target);
    const planted = original.replace("const MAX_TEXT = 2_000;", "const MAX_TEXT = 2_048;");
    expect(planted).not.toBe(original);

    const offenders = analyze(new Map([[target, planted]])).filter(
      (v) => v.kind === "unmetered" && !(key(v) in OPEN_PRICING_DECISIONS),
    );
    expect(offenders).toEqual([]);
  });

  it("stays green when a charge is added AFTER an already-covered model call", () => {
    // The tightening added a position rule, so it needs its own green mirror:
    // an extra charge later in an already-charged handler is not a loosening and
    // must not be read as one. `withClientModelCharge` still wraps the model
    // call; this is just another statement after it.
    const target = file("lib/actions/x-agent-actions.ts");
    const original = readSource(target);
    const planted = original.replace(
      "  const outcome = await withClientModelCharge(",
      "  void chargeClientModelCall;\n  const outcome = await withClientModelCharge(",
    );
    expect(planted).not.toBe(original);

    const offenders = analyze(new Map([[target, planted]])).filter(
      (v) => v.kind === "unmetered" && !(key(v) in OPEN_PRICING_DECISIONS),
    );
    expect(offenders).toEqual([]);
  });
});

/**
 * THE ONE HOME, asked as a property rather than as a count.
 *
 * `chargeClientCredits` / `creditClientCredits` are the data-layer primitives.
 * Before this cluster, five surfaces reached past the helper straight for them,
 * and the five copies had quietly drifted — two threw on denial and two returned
 * the message, none refunded a crash. Any entry that reaches a model must get
 * its charge from the helper, so that the next behaviour change lands once.
 *
 * Deliberately scoped to model-reaching entries: seat purchases and admin credit
 * grants are legitimate direct callers and are not client-triggered model calls.
 */
describe("the charge helper is the only door for a model call", () => {
  it("no model-reaching entry module calls the credit primitives directly", () => {
    // Asked of CALL EXPRESSIONS via the AST, not of the file's text. A text
    // match reported execution-actions.ts, whose only mention of
    // `chargeClientCredits` is the docstring explaining why it no longer calls
    // it — a guard that fires on prose describing the fix is a guard people
    // learn to weaken.
    const PRIMITIVES = new Set(["chargeClientCredits", "creditClientCredits"]);
    const callsPrimitive = (abs: string): boolean => {
      const tree = ts.createSourceFile(abs, readFileSync(abs, "utf8"), ts.ScriptTarget.Latest, true);
      let found = false;
      const visit = (n: ts.Node): void => {
        if (ts.isCallExpression(n)) {
          const e = n.expression;
          const nm = ts.isIdentifier(e) ? e.text : ts.isPropertyAccessExpression(e) ? e.name.text : null;
          if (nm && PRIMITIVES.has(nm)) found = true;
        }
        n.forEachChild(visit);
      };
      visit(tree);
      return found;
    };
    const modelReachingEntries = [...new Set(BASELINE.map((v) => v.file))];
    const direct = modelReachingEntries.filter((rel) => callsPrimitive(join(SRC, rel)));
    expect(
      direct,
      "These reach a model AND call the credit primitives themselves. Use\n" +
        "chargeClientModelCall / withClientModelCharge instead — the point of the\n" +
        "helper is that 'who pays, and what happens when it fails' has one answer.\n\n" +
        direct.join("\n"),
    ).toEqual([]);
  });
});
