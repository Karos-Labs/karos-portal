import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

import {
  CLIENT_SAFE_ACTOR,
  INTERNAL_ACTOR_NAMES,
  clientSafeActor,
  isInternalActor,
} from "@/lib/activity-actors";

/**
 * The registry is only as good as the writers that use it.
 *
 * `INTERNAL_ACTORS` redacts by NAME, matched against a hand-kept list. Nothing
 * stopped a new cron from storing `actor: "Content pipeline"` — a name the list
 * has never heard of, redacted nowhere, printed on the client's timeline as the
 * signature of their work. The list cannot be derived (an actor name is a
 * runtime string on a Firestore document), so the closure is enforced here: no
 * file may write a bare actor-name literal. Every internal name comes from the
 * registry, so adding one to the codebase means adding it to the list.
 *
 * The two literals that stay are the timeline's own DISPLAY labels, which are
 * not writers at all: nothing stores them.
 */
const ALLOWED_LITERALS = new Set([CLIENT_SAFE_ACTOR, "Staff"]);

const SRC = join(process.cwd(), "src");

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(full)) out.push(full);
  }
  return out;
}

const FILES = walk(SRC).filter(
  (f) => !f.includes("__tests__") && !f.endsWith("activity-actors.ts"),
);

/**
 * Source with comments removed. The docstrings that explain this rule name the
 * very strings it forbids — run against raw text, the honest way to keep this
 * green would be deleting the explanations.
 */
function code(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

describe("the internal-actor registry", () => {
  it("is closed: no writer types an actor name it does not know", () => {
    const offenders: string[] = [];
    for (const file of FILES) {
      const src = code(readFileSync(file, "utf8"));
      for (const m of src.matchAll(/\bactor:\s*"([^"]+)"/g)) {
        if (!ALLOWED_LITERALS.has(m[1])) offenders.push(`${relative(SRC, file)} → "${m[1]}"`);
      }
      // The synthetic users the crons dispatch as carry the name on `name:`
      // instead — that is how "Runway autopilot" reached a client's timeline in
      // the first place (submitManagedJob logs `actor: user.name`).
      for (const name of INTERNAL_ACTOR_NAMES) {
        if (src.includes(`"${name}"`)) offenders.push(`${relative(SRC, file)} → "${name}"`);
      }
    }
    expect(offenders, "these bypass activity-actors.ts").toEqual([]);
  });

  it("redacts every name it lists, for client viewers only", () => {
    for (const name of INTERNAL_ACTOR_NAMES) {
      expect(isInternalActor(name), `${name} is not matched`).toBe(true);
      expect(clientSafeActor(name, "staff", true)).toEqual({
        actor: CLIENT_SAFE_ACTOR,
        actorRole: "system",
      });
      expect(clientSafeActor(name, "staff", false).actor, `${name} is redacted for staff`).toBe(
        name,
      );
    }
  });

  it("does not redact the label it redacts TO", () => {
    // "Karos" reaching isInternalActor would be a loop with no exit and, worse,
    // would tell a client their own agency is an internal system.
    expect(isInternalActor(CLIENT_SAFE_ACTOR)).toBe(false);
  });
});
