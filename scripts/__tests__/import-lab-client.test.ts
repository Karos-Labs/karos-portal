/**
 * import-lab-client.ts opened Firestore with a bare getFirestore(), which is
 * "(default)" — production — whatever FIRESTORE_DATABASE_ID says: firebase-admin
 * never reads that variable, so `FIRESTORE_DATABASE_ID=prep ... --apply` wrote
 * to production. It now opens Firestore through scripts/lib/firestore-db.ts
 * (SCRUM-374).
 *
 * The CLI cases drive the real script in a child process whose environment is
 * an allowlist (no Firebase credentials, whatever the parent shell holds) and
 * whose cwd has no .env.local, against a throwaway lab checkout. Every case is
 * a dry run: nothing here can open a database, let alone write to one.
 */
import { execFileSync } from "child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const REPO_ROOT = join(__dirname, "..", "..");
// tsx's JS entrypoint under the current node, as env-inventory.cli.test.ts
// does (see there for why not the .bin shim). --tsconfig because the child's
// cwd is the sandbox, where tsx would not find the repo's "@/" alias itself.
const TSX_CLI = join(REPO_ROOT, "node_modules", "tsx", "dist", "cli.mjs");
const TSCONFIG = join(REPO_ROOT, "tsconfig.json");
const SCRIPT = join(REPO_ROOT, "scripts", "import-lab-client.ts");

let sandbox = "";
let labRoot = "";

beforeAll(() => {
  sandbox = mkdtempSync(join(tmpdir(), "import-lab-client-"));
  labRoot = join(sandbox, "karos-agents");
  mkdirSync(join(labRoot, "clients", "fixture"), { recursive: true });
  writeFileSync(
    join(labRoot, "clients", "fixture", "config.json"),
    JSON.stringify({ name: "Fixture Co", website: "https://fixture.example" }),
  );
});

afterAll(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

/** Dry run of the fixture client. `databaseId` undefined = the variable is absent. */
function dryRun(databaseId: string | undefined): { status: number; output: string } {
  const env: NodeJS.ProcessEnv = { NODE_ENV: "test", NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET: "fixture-bucket.example" };
  for (const key of ["PATH", "HOME", "TMPDIR", "TMP", "TEMP", "SystemRoot"]) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  if (databaseId !== undefined) env.FIRESTORE_DATABASE_ID = databaseId;
  try {
    const stdout = execFileSync(
      process.execPath,
      [TSX_CLI, "--tsconfig", TSCONFIG, SCRIPT, "fixture", `--lab-root=${labRoot}`],
      { cwd: sandbox, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    return { status: 0, output: stdout };
  } catch (err) {
    const e = err as { status: number; stdout: string; stderr: string };
    return { status: e.status, output: `${e.stdout}\n${e.stderr}` };
  }
}

describe("scripts/import-lab-client.ts names its database or refuses", () => {
  it("refuses to run — dry run included — when FIRESTORE_DATABASE_ID is unset", () => {
    const result = dryRun(undefined);
    expect(result.status).toBe(1);
    expect(result.output).toContain("FIRESTORE_DATABASE_ID is not set");
    // Refused before the banner, and before the lab checkout was even read.
    expect(result.output).not.toContain("DRY RUN");
    expect(result.output).not.toContain("Lab client:");
  }, 30_000);

  it("refuses an unrecognised database id rather than falling through to production", () => {
    const result = dryRun("prpe");
    expect(result.status).toBe(1);
    expect(result.output).toContain('unrecognised FIRESTORE_DATABASE_ID "prpe"');
    expect(result.output).not.toContain("Lab client:");
  }, 30_000);

  it("opens with the database, then the bucket both databases share", () => {
    const result = dryRun("prep");
    expect(result.status).toBe(0);
    const [mode, database, storage] = result.output.split("\n");
    expect(mode).toBe("DRY RUN — nothing is written. Pass --apply to write.");
    expect(database).toMatch(/^ {2}database: prep /);
    expect(storage).toMatch(/^ {2}storage: {2}fixture-bucket\.example — one bucket shared by prep and production/);
    expect(result.output).toContain("Dry run complete for Fixture Co.");
  }, 30_000);

  it('calls "(default)" production by name', () => {
    const result = dryRun("(default)");
    expect(result.status).toBe(0);
    expect(result.output).toContain("  database: (default) — PRODUCTION");
  }, 30_000);
});

describe("scripts/import-lab-client.ts takes its Firestore from the shared helper only", () => {
  const src = readFileSync(SCRIPT, "utf-8");

  it("constructs Firestore through getScriptFirestore", () => {
    expect(src).toMatch(/getScriptFirestore\(app\)/);
  });

  it("imports no firebase-admin constructor that opens (default) on its own", () => {
    expect(src).not.toMatch(
      /import\s*\{[^}]*\b(getFirestore|initializeFirestore)\b[^}]*\}\s*from\s*"firebase-admin\/firestore"/,
    );
  });

  it("does not take production as the unset default", () => {
    // That opt-in is for scripts that are production-only by design. An
    // importer is not: production has to be named, the same as prep.
    expect(src).not.toMatch(/allowDefaultProduction:\s*true/);
  });
});
