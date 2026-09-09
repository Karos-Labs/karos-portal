/**
 * SCRUM-332 (AU49) — exercises the actual CLI entry point (not just the
 * core module) so the CI-facing contract — exit 0 when clean, exit 1 when
 * read-but-undocumented is non-empty — is itself under test, not just
 * asserted about the library function it's built on.
 */
import { describe, expect, it } from "vitest";
import { execFileSync } from "child_process";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, cpSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const REPO_ROOT = join(__dirname, "..", "..");
// Absolute path to this repo's own installed tsx binary — a plain `npx tsx`
// run with `cwd` pointed at a throwaway fixture directory (no node_modules
// of its own) would try to fetch tsx from the network instead of finding it.
// Invoked through tsx's own JS entrypoint under the current `node`, not through
// `node_modules/.bin/tsx`. That shim is a POSIX shell script, which
// execFileSync cannot run on Windows, and the `.cmd` beside it cannot be
// execFile'd either without a shell — both fail the spawn outright and hand
// back `status: null` instead of an exit code, so these assertions read as
// failures even when the script exits 0. Going through `process.execPath`
// needs no shim and behaves the same on every platform.
const TSX_CLI = join(REPO_ROOT, "node_modules", "tsx", "dist", "cli.mjs");
const SCRIPT = join(REPO_ROOT, "scripts", "env-inventory.ts");

function runInventory(cwd: string, args: string[] = []): { status: number; output: string } {
  try {
    const stdout = execFileSync(process.execPath, [TSX_CLI, SCRIPT, ...args], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: 0, output: stdout };
  } catch (err) {
    const e = err as { status: number; stdout: string; stderr: string };
    return { status: e.status, output: `${e.stdout}\n${e.stderr}` };
  }
}

describe("scripts/env-inventory.ts CLI", () => {
  it("exits 0 on this repo's actual tree (read-but-undocumented is empty)", () => {
    const result = runInventory(REPO_ROOT);
    expect(result.status).toBe(0);
    expect(result.output).toContain("OK: every variable read by code is documented");
  }, 30_000);

  it("exits 1 on a fixture with a read-but-undocumented variable", () => {
    const dir = mkdtempSync(join(tmpdir(), "env-inventory-cli-fail-"));
    try {
      mkdirSync(join(dir, "src"), { recursive: true });
      mkdirSync(join(dir, "scripts", "lib"), { recursive: true });
      writeFileSync(join(dir, "src", "app.ts"), "const a = process.env.UNDOCUMENTED_VAR;\n");
      writeFileSync(join(dir, "cloudbuild.yaml"), "substitutions:\n  _SERVICE: x\nsteps: []\n");
      writeFileSync(
        join(dir, "cloudbuild.promote.yaml"),
        "substitutions:\n  _SERVICE: x\nsteps: []\n",
      );
      writeFileSync(join(dir, ".env.example"), "SOMETHING_ELSE=\n");
      cpSync(
        join(REPO_ROOT, "scripts", "lib", "env-inventory-core.ts"),
        join(dir, "scripts", "lib", "env-inventory-core.ts"),
      );
      cpSync(join(REPO_ROOT, "scripts", "env-inventory.ts"), join(dir, "scripts", "env-inventory.ts"));

      const result = runInventory(dir);
      expect(result.status).toBe(1);
      expect(result.output).toContain("UNDOCUMENTED_VAR");
      expect(result.output).toContain("FAIL:");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
