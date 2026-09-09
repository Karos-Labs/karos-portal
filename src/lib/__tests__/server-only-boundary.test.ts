import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve as resolvePath, dirname } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * No `"use client"` module may reach a `server-only` module through a value
 * import.
 *
 * `next build` is the only thing that catches this today, and it catches it as
 * "This module cannot be imported from a Client Component module" pointing at
 * `node_modules/server-only`, several hops from the import that did it. Two
 * file-specific spot checks exist (`asset-media-download.test.ts` asserts two
 * particular modules stay free of the marker); nothing states the rule.
 *
 * It is worth stating because the pull is real: a `server-only` module is often
 * exactly where a rule has been written down, and the honest fix is to move the
 * shared part somewhere client-safe rather than to copy it. `deliverableStamp`
 * is the worked example — it sat in `agent-detail-archetypes` behind
 * `import "server-only"`, so three client components re-derived it by hand and
 * one of them got it wrong.
 *
 * THE TRAVERSAL STOPS AT `"use server"`, which is the whole reason this can be
 * green. A server-action module is MEANT to be imported from a client
 * component: that import compiles to a call across the RSC boundary, and the
 * server-only modules behind it never enter the client bundle. Following
 * through one produces 314 findings, every one of them correct architecture —
 * so a sweep that does not model the boundary is a sweep nobody can act on.
 *
 * TYPE IMPORTS DO NOT COUNT. `import type { … }`, and a named clause whose every
 * specifier is `type`-prefixed, are erased before the bundler sees them; that is
 * how `daily-finder-panel` legitimately imports four types from the same
 * `server-only` module this test would otherwise fail it for.
 */

const SRC = join(process.cwd(), "src");

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(full)) out.push(full);
  }
  return out;
}

const FILES = walk(SRC).filter((f) => !f.includes("__tests__"));
const SOURCE = new Map(FILES.map((f) => [f, readFileSync(f, "utf8")]));

const directive = (file: string, name: "use client" | "use server") => {
  const head = (SOURCE.get(file) ?? "").trimStart().slice(0, 200);
  return head.startsWith(`"${name}"`) || head.startsWith(`'${name}'`);
};
const isServerOnly = (file: string) => /^import\s+"server-only";/m.test(SOURCE.get(file) ?? "");

/** Resolve an import specifier to a file in this tree, or null if it leaves it. */
function resolveSpecifier(specifier: string, from: string): string | null {
  let base: string;
  if (specifier.startsWith("@/")) base = join(SRC, specifier.slice(2));
  else if (specifier.startsWith(".")) base = resolvePath(dirname(from), specifier);
  else return null; // a package, not our source

  for (const candidate of [`${base}.ts`, `${base}.tsx`, join(base, "index.ts"), join(base, "index.tsx")]) {
    if (SOURCE.has(candidate)) return candidate;
  }
  return null;
}

const IMPORT = /^\s*import\s+(?!type\s)([\s\S]*?)from\s+"([^"]+)";/gm;
const BARE_IMPORT = /^\s*import\s+"([^"]+)";/gm;

/** Specifiers this file imports for their VALUES. */
function valueImports(file: string): string[] {
  const src = SOURCE.get(file) ?? "";
  const out: string[] = [];
  for (const match of src.matchAll(IMPORT)) {
    const clause = match[1]!.trim();
    if (clause.startsWith("{") && clause.endsWith("}")) {
      const specifiers = clause
        .slice(1, -1)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      if (specifiers.length > 0 && specifiers.every((s) => s.startsWith("type "))) continue;
    }
    out.push(match[2]!);
  }
  for (const match of src.matchAll(BARE_IMPORT)) out.push(match[1]!);
  return out;
}

describe("the client/server module boundary", () => {
  const clients = FILES.filter((f) => directive(f, "use client"));
  const serverOnly = FILES.filter(isServerOnly);

  it("found both sides to check", () => {
    // Non-vacuity: a directive rename or a walk that stopped finding files
    // would empty one of these and make the rule below hold over nothing.
    expect(clients.length).toBeGreaterThan(100);
    expect(serverOnly.length).toBeGreaterThan(50);
  });

  it("no client module reaches a server-only module", () => {
    const found: string[] = [];

    for (const entry of clients) {
      const seen = new Set<string>();
      const stack: { file: string; chain: string[] }[] = [{ file: entry, chain: [entry] }];

      while (stack.length > 0) {
        const { file, chain } = stack.pop()!;
        for (const specifier of valueImports(file)) {
          const target = resolveSpecifier(specifier, file);
          if (target === null || seen.has(target)) continue;
          seen.add(target);
          // The RSC boundary: everything behind a server action stays on the server.
          if (directive(target, "use server")) continue;
          if (isServerOnly(target)) {
            found.push([...chain, target].map((f) => relative(SRC, f)).join(" -> "));
            continue;
          }
          stack.push({ file: target, chain: [...chain, target] });
        }
      }
    }

    expect(
      [...new Set(found)].sort(),
      "move the shared part into a client-safe module instead of importing this one",
    ).toEqual([]);
  });
});
