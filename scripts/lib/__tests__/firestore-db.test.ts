import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { resolveScriptDatabaseId } from "../firestore-db";

/**
 * SCRUM-374 — maintenance scripts default to PRODUCTION Firestore.
 *
 * `scripts/` is a second Firestore-construction surface with the opposite
 * default from `src/` (bound in AU60 / SCRUM-359, PR #54): a bare
 * `getFirestore()` there resolves to `(default)`, which is production, and
 * nothing errors — `(default)` is a real database that accepts the write.
 *
 * The cases that matter are the throwing ones. A guard that only ever sees
 * its happy path is the defect family this codebase keeps finding.
 */

describe("resolveScriptDatabaseId — the pairings that are correct today", () => {
  it("honours an explicit prep", () => {
    expect(resolveScriptDatabaseId({}, { FIRESTORE_DATABASE_ID: "prep" })).toBe("prep");
  });

  it("honours an explicit (default)", () => {
    expect(resolveScriptDatabaseId({}, { FIRESTORE_DATABASE_ID: "(default)" })).toBe("(default)");
  });
});

describe("resolveScriptDatabaseId — it fails closed, not open", () => {
  it("REFUSES when FIRESTORE_DATABASE_ID is unset and there is no opt-in", () => {
    // This is the exact defect SCRUM-374 filed: unset silently became
    // production for ~30 scripts because getFirestore() resolves that way on
    // its own. Nothing here resolves silently.
    expect(() => resolveScriptDatabaseId({}, {})).toThrow(/is not set/);
  });

  it("names the direction of the damage — unset means production", () => {
    let msg = "";
    try {
      resolveScriptDatabaseId({}, {});
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toContain("Unset means production");
  });

  it("REFUSES an unrecognised database id rather than falling through", () => {
    // Falling through would open "(default)" — production — for a value
    // nobody has vetted, e.g. a typo of "prep".
    expect(() => resolveScriptDatabaseId({}, { FIRESTORE_DATABASE_ID: "prpe" })).toThrow(
      /unrecognised FIRESTORE_DATABASE_ID/,
    );
  });

  it("does not let allowDefaultProduction rescue an unrecognised explicit value", () => {
    // The opt-in only fills the gap when the variable is UNSET. A typo that
    // was actually meant to say "prep" must still fail loud, not be waved
    // through as "production is fine here".
    expect(() =>
      resolveScriptDatabaseId({ allowDefaultProduction: true }, { FIRESTORE_DATABASE_ID: "prpe" }),
    ).toThrow(/unrecognised FIRESTORE_DATABASE_ID/);
  });
});

describe("resolveScriptDatabaseId — the one explicit opt-in", () => {
  it("resolves unset to (default) ONLY when the script opts in", () => {
    expect(resolveScriptDatabaseId({ allowDefaultProduction: true }, {})).toBe("(default)");
  });

  it("an explicit prep still wins over the opt-in default", () => {
    expect(
      resolveScriptDatabaseId({ allowDefaultProduction: true }, { FIRESTORE_DATABASE_ID: "prep" }),
    ).toBe("prep");
  });
});

describe("getScriptFirestore is ON THE PATH, not merely present", () => {
  /**
   * Drives the real construction wrapper and asserts it refuses BEFORE any
   * Firestore instance is handed out — the same shape as the adminDb() test
   * added for AU60 / SCRUM-359 (PR #54).
   */
  it("refuses before calling firebase-admin's getFirestore when unset and no opt-in", async () => {
    vi.resetModules();
    const getFirestoreSpy = vi.fn();
    vi.doMock("firebase-admin/firestore", () => ({ getFirestore: getFirestoreSpy }));

    const mod = await import("../firestore-db");
    expect(() => mod.getScriptFirestore({} as never, {}, {})).toThrow(/is not set/);
    expect(getFirestoreSpy).not.toHaveBeenCalled();

    vi.doUnmock("firebase-admin/firestore");
    vi.resetModules();
  });

  it("passes the resolved database id through to firebase-admin's getFirestore", async () => {
    vi.resetModules();
    const getFirestoreSpy = vi.fn(() => "the-firestore-instance");
    vi.doMock("firebase-admin/firestore", () => ({ getFirestore: getFirestoreSpy }));

    const mod = await import("../firestore-db");
    const app = { name: "[DEFAULT]" } as never;
    const result = mod.getScriptFirestore(app, {}, { FIRESTORE_DATABASE_ID: "prep" });

    expect(getFirestoreSpy).toHaveBeenCalledWith(app, "prep");
    expect(result).toBe("the-firestore-instance");

    vi.doUnmock("firebase-admin/firestore");
    vi.resetModules();
  });
});

/**
 * SCRUM-374's in-scope migration: the two scripts it names as deliberately
 * production-only by design must opt in to that EXPLICITLY through the
 * shared helper, not by omission (a bare getFirestore()). The ~30-35 other
 * bare call sites are a documented, separately-filed sweep (see the ticket's
 * "Not fixed here") and are deliberately NOT asserted against here — turning
 * this into a full-tree sweep would fail on files this ticket explicitly
 * declines to touch.
 */
describe("the named production scripts opt in explicitly", () => {
  const SCRIPTS_DIR = join(__dirname, "..", "..");
  const PRODUCTION_BY_DESIGN = ["cleanup-production-trash.ts", "audit-production-trash.ts"];

  it.each(PRODUCTION_BY_DESIGN)("%s constructs Firestore through the shared helper", (file) => {
    const src = readFileSync(join(SCRIPTS_DIR, file), "utf-8");
    expect(src).toMatch(/getScriptFirestore\(/);
    expect(src).toMatch(/allowDefaultProduction:\s*true/);
    // No bare firebase-admin getFirestore() left in these two files — that's
    // exactly the omission the helper replaces. (A type-only import of
    // something else from "firebase-admin/firestore", e.g. DocumentReference,
    // is fine and untouched by this assertion.)
    expect(src).not.toMatch(/\bgetFirestore\(\)/);
    expect(src).not.toMatch(/import\s*\{[^}]*\bgetFirestore\b[^}]*\}\s*from\s*"firebase-admin\/firestore"/);
  });
});
