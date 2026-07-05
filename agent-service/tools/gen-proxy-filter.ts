import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * Generates config/proxy-filter.txt (tinyproxy FilterList, anchored-regex
 * per domain) from config/egress-allowlist.json. Commit the result; the
 * proxy container mounts it read-only.
 */
async function main(): Promise<void> {
  const configDir = path.join(import.meta.dirname, "..", "config");
  const allowlist = JSON.parse(await readFile(path.join(configDir, "egress-allowlist.json"), "utf8")) as {
    groups: Record<string, string[]>;
  };
  const domains = [...new Set(Object.values(allowlist.groups).flat())].sort();
  const lines = domains.map((d) => `^${d.replaceAll(".", "\\.")}$`);
  const header = "# GENERATED from egress-allowlist.json — run `npm run gen:proxy-filter` to update\n";
  await writeFile(path.join(configDir, "proxy-filter.txt"), header + lines.join("\n") + "\n");
  console.log(`wrote ${domains.length} domains to config/proxy-filter.txt`);
}

void main();
