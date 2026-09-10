/**
 * SCRUM-332 (AU49) — config inventory: the load-bearing logic behind
 * `scripts/env-inventory.ts`, split out so it can be unit-tested without
 * shelling out to a CLI.
 *
 * Emits three sets and the three deltas between them, per the ticket:
 *
 *   A — read by code        every variable name the source actually reads
 *   B — wired at deploy     every name in --set-env-vars / --set-secrets,
 *                           across cloudbuild.yaml and cloudbuild.promote.yaml
 *   C — documented          every name in .env.example
 *
 *   read-but-undocumented   = A - C   (CI-failing)
 *   wired-but-never-read    = B - A   (CI-warning only)
 *   documented-but-nonexistent = C - A
 *
 * THE HARD PART. Unlike agent-engine's `*FromEnv` factory-indirection
 * pattern (this repo has NO equivalent factory — confirmed: there is no
 * `create-*-from-env.ts` file, and no config object that is built ONCE from
 * `process.env` and threaded through the app), this repo reads env vars two
 * other indirect ways that a plain `process.env.NAME` / `process.env["NAME"]`
 * grep misses entirely:
 *
 *   1. A dependency-injection default parameter. ~8 functions across the repo
 *      (src/lib/firebase/admin.ts, src/lib/ai/provider.ts,
 *      src/lib/agent-engine/{client,pubsub-client,middleware-http,
 *      middleware-client,product-mapping}.ts, scripts/lib/firestore-db.ts)
 *      take `env: Record<string, string | undefined> = process.env` and read
 *      `env.NAME` inside. Same variable name as a direct read, just one hop
 *      away from the literal string `process.env.NAME` a naive grep expects.
 *
 *   2. A dynamic bracket access whose key is a config-object FIELD, not a
 *      string literal: `process.env[cfg.envClientId]`,
 *      `process.env[opts.envVar]`, `process.env[envFlag]`. The env var NAME
 *      never appears next to the word "env" at the read site at all — it
 *      lives in a separate object literal (src/lib/integrations/oauth.ts's
 *      per-provider PROVIDERS table, src/lib/cron-auth.ts's
 *      `checkWebhookSecret({ envVar: "..." })` callers) that is constructed
 *      far from where `process.env[...]` is actually evaluated. This is this
 *      repo's equivalent of the "false positive" trap the agent-engine half
 *      guards against with its eleven-name regression list: a crude grep
 *      would report LINKEDIN_CLIENT_ID, TWITTER_CLIENT_ID, GOOGLE_CLIENT_ID,
 *      FACEBOOK_APP_ID, TIKTOK_CLIENT_KEY, REDDIT_CLIENT_ID, and their
 *      *_SECRET partners, plus META_ADVANCED_ACCESS_APPROVED,
 *      TIKTOK_RESEARCH_API_APPROVED, GOOGLE_BUSINESS_PROFILE_APPROVED, and
 *      FIREFLIES_WEBHOOK_SECRET, as "wired but never read" — every one a false
 *      positive. See `scripts/lib/__tests__/env-inventory-core.test.ts` for
 *      the regression assertion.
 *
 * Both indirections are resolved with plain regex passes over source text
 * (no TypeScript type-checker, no AST) — this is a config-hygiene lint, not a
 * compiler, and the two patterns above are the only two currently in use.
 * `dynamicUnresolved` surfaces anything a future third pattern introduces
 * instead of silently dropping it.
 */
import { readFileSync, readdirSync, statSync } from "fs";
import { join, relative, extname } from "path";

// ── Set A: read by code ──────────────────────────────────────────────────

export type ReadKind = "direct" | "di-default-param" | "indirect-config-field";

export interface ReadSite {
  name: string;
  file: string; // repo-relative, forward slashes
  line: number;
  kind: ReadKind;
}

export interface DynamicUnresolved {
  file: string;
  line: number;
  expr: string;
}

export interface ScanResult {
  /** name -> every site that reads it */
  reads: Map<string, ReadSite[]>;
  /** process.env[<non-literal, unresolved>] sites — should stay empty */
  dynamicUnresolved: DynamicUnresolved[];
}

const SCAN_EXTENSIONS = new Set([".ts", ".tsx"]);
const SCAN_EXCLUDE_DIRS = new Set([
  "node_modules",
  ".next",
  ".git",
  "dist",
  "build",
  "coverage",
  "_backup",
]);

function isTestFile(relPath: string): boolean {
  return (
    relPath.includes("__tests__/") ||
    /\.(test|spec)\.tsx?$/.test(relPath) ||
    relPath.endsWith(".d.ts")
  );
}

/**
 * This tool's own two source files talk ABOUT `process.env.NAME` and
 * `process.env[expr]` in prose comments and in the literal report strings
 * it prints (e.g. `` `process.env[${d.expr}]` ``) — text that is not itself
 * a config read. Excluded from self-scanning rather than relying on comment
 * stripping alone, since the printed-report strings are code, not comments.
 */
const SELF_EXCLUDE = new Set(["scripts/env-inventory.ts", "scripts/lib/env-inventory-core.ts"]);

/**
 * Blank out `//line` and `/* block *\/` comments, preserving every character
 * position and newline so line numbers computed on the result still match
 * the original file. String and template literals are tracked so a `//`
 * inside a URL (`"http://..."`) is not mistaken for a comment start.
 * Deliberately does not parse `${...}` interpolations inside template
 * literals as code — no `process.env` read in this codebase sits inside one
 * (checked: see env-inventory-core.test.ts).
 */
export function stripComments(src: string): string {
  const out: string[] = new Array(src.length);
  type State = "code" | "line-comment" | "block-comment" | "sq" | "dq" | "tpl";
  let state: State = "code";
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    const next = src[i + 1];
    switch (state) {
      case "code":
        if (c === "/" && next === "/") {
          out[i] = " ";
          state = "line-comment";
        } else if (c === "/" && next === "*") {
          out[i] = " ";
          state = "block-comment";
        } else if (c === "'") {
          out[i] = c;
          state = "sq";
        } else if (c === '"') {
          out[i] = c;
          state = "dq";
        } else if (c === "`") {
          out[i] = c;
          state = "tpl";
        } else {
          out[i] = c;
        }
        break;
      case "line-comment":
        out[i] = c === "\n" ? "\n" : " ";
        if (c === "\n") state = "code";
        break;
      case "block-comment":
        if (c === "*" && next === "/") {
          out[i] = " ";
          out[i + 1] = " ";
          i++;
          state = "code";
        } else {
          out[i] = c === "\n" ? "\n" : " ";
        }
        break;
      case "sq":
      case "dq":
      case "tpl": {
        out[i] = c;
        const quote = state === "sq" ? "'" : state === "dq" ? '"' : "`";
        if (c === "\\") {
          // Escaped char — copy it verbatim too and skip past it so an
          // escaped quote (`\"`) doesn't end the string early.
          if (next !== undefined) {
            out[i + 1] = next;
            i++;
          }
        } else if (c === quote) {
          state = "code";
        }
        break;
      }
    }
  }
  return out.join("");
}

/** Recursively list source files under `dir`, repo-relative, forward-slashed. */
export function listSourceFiles(repoRoot: string, dir: string): string[] {
  const out: string[] = [];
  const absDir = join(repoRoot, dir);
  let entries: string[];
  try {
    entries = readdirSync(absDir);
  } catch {
    return out; // dir doesn't exist in this checkout — not an error
  }
  for (const entry of entries) {
    if (SCAN_EXCLUDE_DIRS.has(entry)) continue;
    const abs = join(absDir, entry);
    const rel = relative(repoRoot, abs).split("\\").join("/");
    const st = statSync(abs);
    if (st.isDirectory()) {
      out.push(...listSourceFiles(repoRoot, rel));
    } else if (SCAN_EXTENSIONS.has(extname(entry))) {
      out.push(rel);
    }
  }
  return out;
}

function lineOf(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

function addRead(
  reads: Map<string, ReadSite[]>,
  name: string,
  file: string,
  line: number,
  kind: ReadKind,
) {
  const list = reads.get(name) ?? [];
  list.push({ name, file, line, kind });
  reads.set(name, list);
}

const ENV_NAME = /^[A-Z][A-Z0-9_]*$/;

/**
 * Scan one file's text for direct `process.env.NAME` / `process.env["NAME"]`
 * reads, the DI-default-param `env.NAME` pattern, and dynamic
 * `process.env[<expr>]` accesses (collected for the second, cross-file
 * resolution pass rather than resolved here).
 */
function scanFileText(
  relFile: string,
  text: string,
  reads: Map<string, ReadSite[]>,
  dynamicExprs: { file: string; line: number; expr: string }[],
) {
  // 1. process.env.NAME
  for (const m of text.matchAll(/process\.env\.([A-Za-z_][A-Za-z0-9_]*)/g)) {
    const name = m[1];
    if (!ENV_NAME.test(name)) continue; // e.g. process.env.hasOwnProperty
    addRead(reads, name, relFile, lineOf(text, m.index ?? 0), "direct");
  }

  // 2. process.env["NAME"] / process.env['NAME'] (literal) — and collect the
  //    dynamic (non-literal) form for resolution below.
  const bracketRe = /process\.env\[\s*([^\]]+?)\s*\]/g;
  for (const m of text.matchAll(bracketRe)) {
    const inner = m[1];
    const litMatch = /^(["'])([A-Za-z_][A-Za-z0-9_]*)\1$/.exec(inner);
    const idx = m.index ?? 0;
    if (litMatch) {
      addRead(reads, litMatch[2], relFile, lineOf(text, idx), "direct");
      continue;
    }
    // Distinguish a read (`process.env[x]`) from the dotenv-style local-load
    // write pattern `process.env[key] = val` that ~30 scripts use to hydrate
    // process.env from a hand-parsed .env file — that's not a read of a
    // *named* variable at all, it's the mechanism the operator's own env
    // vars arrive through, so it must not show up as either a read or an
    // unresolved dynamic access.
    const after = text.slice(idx + m[0].length).match(/^\s*(=[^=]|$)/);
    if (after) continue; // assignment target, not a read
    dynamicExprs.push({ file: relFile, line: lineOf(text, idx), expr: inner });
  }

  // 3. DI-default-param pattern: `env.NAME` where this file defines a
  //    parameter `env: Record<string, string | undefined> = process.env`.
  //    File-level guard (not per-function-scope) — deliberate and cheap:
  //    every current use of an `env` identifier in this shape is exactly
  //    that parameter (verified by hand across all matches at the time this
  //    was written), and gating on the phrase keeps a file with an unrelated
  //    local named `env` (there are none today) from being swept in.
  if (/=\s*process\.env\b/.test(text)) {
    for (const m of text.matchAll(/\benv\.([A-Z][A-Z0-9_]*)\b/g)) {
      addRead(reads, m[1], relFile, lineOf(text, m.index ?? 0), "di-default-param");
    }
  }
}

/** Split a parameter- or argument-list string on top-level commas only —
 * depth-tracks `(){}[]` so a nested call or object literal isn't split
 * apart. Does NOT track `<>` (generics/comparisons are ambiguous without a
 * real parser); the one caller of this that matters for env-name extraction
 * has no generics in its signature (checked by hand — see the module doc
 * comment and env-inventory-core.test.ts's coverage of it).
 */
function splitTopLevelCommas(s: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  let quote: string | null = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      current += c;
      if (c === "\\") {
        current += s[++i] ?? "";
      } else if (c === quote) {
        quote = null;
      }
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      quote = c;
      current += c;
    } else if ("([{".includes(c)) {
      depth++;
      current += c;
    } else if (")]}".includes(c)) {
      depth--;
      current += c;
    } else if (c === "," && depth === 0) {
      parts.push(current);
      current = "";
    } else {
      current += c;
    }
  }
  if (current.trim() !== "") parts.push(current);
  return parts.map((p) => p.trim());
}

const ENV_FIELD_NAME = /^env[A-Za-z0-9_]*$/;

/**
 * Positional-parameter resolution. Handles the one shape the object-literal
 * / default-param field resolver above cannot: a function whose parameter is
 * named like an env field (`envFlag`, matching {@link ENV_FIELD_NAME}) but
 * has no default and is called positionally with a plain string literal —
 * `assertExtendedAccessApproved("facebook", "META_ADVANCED_ACCESS_APPROVED")`
 * for `function assertExtendedAccessApproved(platform: string, envFlag: string)`.
 * Finds every `function NAME(...)` declaration, notes the index of any
 * env-shaped parameter, then finds call sites of NAME and reads the literal
 * at that argument position.
 */
function resolvePositionalEnvFields(
  files: { relFile: string; text: string }[],
): Map<string, { name: string; file: string; line: number }[]> {
  const results = new Map<string, { name: string; file: string; line: number }[]>();

  const targets: { fnName: string; paramIndex: number; fieldName: string }[] = [];
  const declRe = /function\s+([A-Za-z_$][\w$]*)\s*\(([^)]*)\)/g;
  for (const f of files) {
    for (const m of f.text.matchAll(declRe)) {
      const params = splitTopLevelCommas(m[2]).map((p) => p.split(/[:=]/)[0].trim());
      params.forEach((p, idx) => {
        if (ENV_FIELD_NAME.test(p)) targets.push({ fnName: m[1], paramIndex: idx, fieldName: p });
      });
    }
  }

  for (const t of targets) {
    const callRe = new RegExp(`\\b${t.fnName}\\s*\\(([^)]*)\\)`, "g");
    for (const f of files) {
      for (const m of f.text.matchAll(callRe)) {
        const idx = m.index ?? 0;
        // Skip the declaration itself re-matching as a "call".
        if (/function\s*$/.test(f.text.slice(Math.max(0, idx - 12), idx))) continue;
        const args = splitTopLevelCommas(m[1]);
        const arg = args[t.paramIndex];
        if (!arg) continue;
        const lit = /^(["'])([A-Z][A-Z0-9_]*)\1$/.exec(arg);
        if (!lit) continue;
        const list = results.get(t.fieldName) ?? [];
        list.push({ name: lit[2], file: f.relFile, line: lineOf(f.text, idx) });
        results.set(t.fieldName, list);
      }
    }
  }

  return results;
}

/**
 * Second pass: resolve `process.env[<expr>]` dynamic accesses whose trailing
 * property name (e.g. `envClientId` out of `cfg.envClientId`) is defined
 * somewhere in the tree as:
 *   (a) an object-literal field or parameter default holding a string
 *       literal — `envClientId: "LINKEDIN_CLIENT_ID"`, `envVar = "CRON_SECRET"`, or
 *   (b) a plain (non-default) function parameter called positionally with a
 *       string literal — see {@link resolvePositionalEnvFields}.
 * Every literal value found for a property/parameter name that is actually
 * used as a dynamic env key is an indirected read.
 */
function resolveIndirectConfigFields(
  files: { relFile: string; text: string }[],
  dynamicExprs: { file: string; line: number; expr: string }[],
  reads: Map<string, ReadSite[]>,
): DynamicUnresolved[] {
  const positional = resolvePositionalEnvFields(files);
  const unresolved: DynamicUnresolved[] = [];
  for (const d of dynamicExprs) {
    // Only handle `identifier` or `identifier.property` / `identifier?.property`
    // shapes — anything else (computed index, function call, template
    // literal) is left as genuinely unresolved rather than guessed at.
    const propMatch = /^[A-Za-z_$][\w$]*(?:\?\.|\.)([A-Za-z_$][\w$]*)$/.exec(d.expr);
    const bareMatch = /^[A-Za-z_$][\w$]*$/.exec(d.expr);
    const fieldName = propMatch ? propMatch[1] : bareMatch ? bareMatch[0] : null;
    if (!fieldName) {
      unresolved.push(d);
      continue;
    }
    const fieldPattern = new RegExp(
      `\\b${fieldName}\\s*[:=]\\s*(["'])([A-Z][A-Z0-9_]*)\\1`,
      "g",
    );
    let foundAny = false;
    for (const f of files) {
      for (const m of f.text.matchAll(fieldPattern)) {
        foundAny = true;
        addRead(
          reads,
          m[2],
          f.relFile,
          lineOf(f.text, m.index ?? 0),
          "indirect-config-field",
        );
      }
    }
    for (const hit of positional.get(fieldName) ?? []) {
      foundAny = true;
      addRead(reads, hit.name, hit.file, hit.line, "indirect-config-field");
    }
    if (!foundAny) unresolved.push(d);
  }
  return unresolved;
}

/**
 * Scan `src/` and `scripts/` (production + operational code; test files are
 * excluded — a test mocking/setting `process.env.X` is exercising a read
 * elsewhere, not itself a real read the deployed app depends on) for every
 * environment variable name the code reads, direct or indirect.
 */
export function scanReadByCode(repoRoot: string): ScanResult {
  const relFiles = [
    ...listSourceFiles(repoRoot, "src"),
    ...listSourceFiles(repoRoot, "scripts"),
  ].filter((f) => !isTestFile(f) && !SELF_EXCLUDE.has(f));

  const files = relFiles.map((relFile) => ({
    relFile,
    text: stripComments(readFileSync(join(repoRoot, relFile), "utf8")),
  }));

  const reads = new Map<string, ReadSite[]>();
  const dynamicExprs: { file: string; line: number; expr: string }[] = [];

  for (const f of files) scanFileText(f.relFile, f.text, reads, dynamicExprs);

  const dynamicUnresolved = resolveIndirectConfigFields(files, dynamicExprs, reads);

  return { reads, dynamicUnresolved };
}

// ── Set B: wired at deploy ───────────────────────────────────────────────

export interface WiredVar {
  name: string;
  service: string;
  wiring: "env-var" | "secret";
  file: string;
  line: number;
}

/**
 * Extract every name passed to `--set-env-vars=` / `--set-env-vars="...`
 * and `--set-secrets=` in one cloudbuild file, and the Cloud Run `_SERVICE`
 * substitution it deploys under.
 *
 * karosCMO has exactly one Cloud Run service (`_SERVICE: karos-cmo`) and one
 * `gcloud run deploy` step per file today — unlike agent-engine's
 * deploy-http/deploy-worker split, there is no second surface to report
 * separately here. `service` is still threaded through per finding so a
 * second surface added later shows up distinctly rather than needing a
 * schema change.
 */
export function parseCloudbuildWiring(repoRoot: string, relFile: string): WiredVar[] {
  const abs = join(repoRoot, relFile);
  const text = readFileSync(abs, "utf8");

  const serviceMatch = /_SERVICE:\s*([^\s#]+)/.exec(text);
  const service = serviceMatch ? serviceMatch[1].replace(/^["']|["']$/g, "") : "unknown";

  const out: WiredVar[] = [];

  const collect = (flag: "set-env-vars" | "set-secrets", wiring: "env-var" | "secret") => {
    // Matches --set-env-vars=... / --set-env-vars="..." / --set-secrets=...
    // up to the end of that value: a closing quote if quoted, else the next
    // whitespace/backslash-newline/end of the args array entry.
    const re = new RegExp(`--${flag}=("([^"]*)"|'([^']*)'|(\\S+))`, "g");
    for (const m of text.matchAll(re)) {
      const value = m[2] ?? m[3] ?? m[4] ?? "";
      const line = lineOf(text, m.index ?? 0);
      for (const entry of value.split(",")) {
        const name = entry.split("=")[0]?.trim();
        if (name && ENV_NAME.test(name)) {
          out.push({ name, service, wiring, file: relFile, line });
        }
      }
    }
  };

  collect("set-env-vars", "env-var");
  collect("set-secrets", "secret");

  return out;
}

// ── Set C: documented in .env.example ────────────────────────────────────

export interface DocumentedVar {
  name: string;
  line: number;
  commentedOut: boolean;
}

/**
 * Every variable name assigned in `.env.example`, live or commented-out.
 * A commented `# FOO=` line is still documentation (this file uses that
 * shape deliberately for optional alternates — e.g. the three discrete
 * `FIREBASE_*` vars offered as an alternative to `FIREBASE_SERVICE_ACCOUNT_KEY`,
 * or `# BQ_DATASET_ID=bi_telemetry` noting a default) — excluding it would
 * make the delta report vars as "undocumented" that the file plainly explains.
 */
export function parseEnvExample(repoRoot: string, relFile = ".env.example"): DocumentedVar[] {
  const text = readFileSync(join(repoRoot, relFile), "utf8");
  const out: DocumentedVar[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const m = /^(\s*#\s*)?([A-Z][A-Z0-9_]*)=/.exec(raw);
    if (!m) continue;
    out.push({ name: m[2], line: i + 1, commentedOut: !!m[1] });
  }
  return out;
}

// ── Assembled inventory ──────────────────────────────────────────────────

export interface Inventory {
  readByCode: Map<string, ReadSite[]>;
  dynamicUnresolved: DynamicUnresolved[];
  wiredAtDeploy: WiredVar[];
  documented: DocumentedVar[];
  readByCodeNames: Set<string>;
  wiredNames: Set<string>;
  documentedNames: Set<string>;
  readButUndocumented: string[];
  wiredButNeverRead: string[];
  documentedButNonexistent: string[];
}

export function buildInventory(repoRoot: string): Inventory {
  const { reads, dynamicUnresolved } = scanReadByCode(repoRoot);
  const wiredAtDeploy = [
    ...parseCloudbuildWiring(repoRoot, "cloudbuild.yaml"),
    ...parseCloudbuildWiring(repoRoot, "cloudbuild.promote.yaml"),
  ];
  const documented = parseEnvExample(repoRoot);

  const readByCodeNames = new Set(reads.keys());
  const wiredNames = new Set(wiredAtDeploy.map((w) => w.name));
  const documentedNames = new Set(documented.map((d) => d.name));

  const readButUndocumented = [...readByCodeNames]
    .filter((n) => !documentedNames.has(n))
    .sort();
  const wiredButNeverRead = [...wiredNames].filter((n) => !readByCodeNames.has(n)).sort();
  const documentedButNonexistent = [...documentedNames]
    .filter((n) => !readByCodeNames.has(n))
    .sort();

  return {
    readByCode: reads,
    dynamicUnresolved,
    wiredAtDeploy,
    documented,
    readByCodeNames,
    wiredNames,
    documentedNames,
    readButUndocumented,
    wiredButNeverRead,
    documentedButNonexistent,
  };
}
