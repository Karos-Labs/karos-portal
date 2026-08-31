#!/usr/bin/env -S npx tsx
/**
 * SCRUM-332 (AU49) — config inventory.
 *
 * Emits set A (read by code), set B (wired at deploy, per Cloud Run service),
 * set C (documented in .env.example), and the three deltas between them —
 * see scripts/lib/env-inventory-core.ts for what "read" means here and why a
 * plain `process.env.NAME` grep is not enough in this repo.
 *
 *   npx tsx scripts/env-inventory.ts            human-readable report
 *   npx tsx scripts/env-inventory.ts --json     machine-readable report
 *
 * Exit code: non-zero when read-but-undocumented is non-empty. This is
 * Deliverable 3 — the CI check that keeps .env.example true — and
 * `.github/workflows/quality.yml` runs this on every PR (see the "Env
 * inventory" step added there). wired-but-never-read only WARNS (printed,
 * does not affect exit code): the indirection-resolution in
 * env-inventory-core.ts is a new instrument and the ticket calls for it to
 * prove itself over a few releases before it can fail a build.
 */
import { buildInventory, type Inventory } from "./lib/env-inventory-core";

function printSection(title: string, lines: string[]) {
  console.log(`\n${title}`);
  console.log("─".repeat(title.length));
  if (lines.length === 0) {
    console.log("  (none)");
  } else {
    for (const l of lines) console.log(`  ${l}`);
  }
}

function humanReport(inv: Inventory): void {
  console.log("SCRUM-332 (AU49) — karosCMO environment variable inventory");
  console.log(`  A. read by code:        ${inv.readByCodeNames.size}`);
  console.log(`  B. wired at deploy:     ${inv.wiredNames.size}`);
  console.log(`  C. documented:          ${inv.documentedNames.size}`);

  printSection(
    `read-but-undocumented (${inv.readButUndocumented.length}) — FAILS CI`,
    inv.readButUndocumented.map((name) => {
      const sites = inv.readByCode.get(name) ?? [];
      const loc = sites[0] ? `${sites[0].file}:${sites[0].line} [${sites[0].kind}]` : "?";
      const extra = sites.length > 1 ? ` (+${sites.length - 1} more site${sites.length > 2 ? "s" : ""})` : "";
      return `${name}  —  ${loc}${extra}`;
    }),
  );

  printSection(
    `wired-but-never-read (${inv.wiredButNeverRead.length}) — warns only`,
    inv.wiredButNeverRead.map((name) => {
      const w = inv.wiredAtDeploy.filter((x) => x.name === name);
      const services = [...new Set(w.map((x) => `${x.service}/${x.wiring}`))].join(", ");
      return `${name}  —  ${services}`;
    }),
  );

  printSection(
    `documented-but-nonexistent (${inv.documentedButNonexistent.length})`,
    inv.documentedButNonexistent,
  );

  if (inv.dynamicUnresolved.length > 0) {
    console.log(
      `\nUNRESOLVED dynamic process.env[...] accesses (${inv.dynamicUnresolved.length})`,
    );
    console.log("─".repeat(60));
    console.log(
      "  Expected, not a defect: every one of these is scripts/**'s local\n" +
        "  `.env`/.env.local bootstrap loader (`if (!process.env[key]) process.env[key] = val`),\n" +
        "  which by design copies WHATEVER names a developer's own .env file happens to\n" +
        "  define — it never names a specific variable in source, so nothing here belongs\n" +
        "  in set A. Kept visible (not silently dropped) so a future dynamic-access shape\n" +
        "  that ISN'T this pattern doesn't get missed the same way.",
    );
    for (const d of inv.dynamicUnresolved) {
      console.log(`    ${d.file}:${d.line}  process.env[${d.expr}]`);
    }
  }
}

function jsonReport(inv: Inventory) {
  return {
    setA_readByCode: [...inv.readByCodeNames].sort(),
    setB_wiredAtDeploy: [...inv.wiredNames].sort(),
    setC_documented: [...inv.documentedNames].sort(),
    readButUndocumented: inv.readButUndocumented,
    wiredButNeverRead: inv.wiredButNeverRead,
    documentedButNonexistent: inv.documentedButNonexistent,
    dynamicUnresolved: inv.dynamicUnresolved,
  };
}

function main() {
  const repoRoot = process.cwd();
  const inv = buildInventory(repoRoot);
  const asJson = process.argv.includes("--json");

  if (asJson) {
    console.log(JSON.stringify(jsonReport(inv), null, 2));
  } else {
    humanReport(inv);
  }

  if (inv.readButUndocumented.length > 0) {
    console.error(
      `\nFAIL: ${inv.readButUndocumented.length} variable(s) are read by code and absent from .env.example.`,
    );
    process.exit(1);
  }

  console.log("\nOK: every variable read by code is documented in .env.example.");
}

main();
