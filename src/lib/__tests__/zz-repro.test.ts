import { describe, it } from "vitest";
import fs from "node:fs";
const OUT: string[] = [];
const log = (...a: unknown[]) => OUT.push(a.map(String).join(" "));
import { parseDocSections, renderFullDoc, renderSectionBody, stripDocPreamble } from "@/lib/doc-render";

const DOC = [
  "---",
  "module: brand-voice",
  "client: acme",
  "version: 1",
  "---",
  "",
  "<!-- BRAND_SYNC_START -->",
  "## Visual & Tone Reference (auto-synced from guidelines · 2026-07-28)",
  "- **Visual Style:** High-Tech",
  "- **Color 1 (Logo fill):** #e91e8c",
  "- **Tone Keywords:** Disruptive, Precise, Innovative",
  "",
  "_This section is auto-synced when branding guidelines are updated. Edit the guidelines UI to change it._",
  "<!-- BRAND_SYNC_END -->",
  "",
  "# Brand Voice & Copywriting Guide — Acme",
  "",
  "> HOW the brand speaks.",
  "",
  "## Five voice adjectives",
  "- **Precise** — Every sentence carries weight.",
  "- **Warm** — We write like a person, not a policy.",
  "",
  "## Voice dimensions",
  "- Formal ↔ casual: mostly casual",
  "",
].join("\n");

describe("repro", () => {
  it("dumps", () => {
    log("===== stripDocPreamble =====");
    log(JSON.stringify(stripDocPreamble(DOC)));
    log("===== sections =====");
    log(JSON.stringify(parseDocSections(DOC).map((s) => s.heading), null, 2));
    log("===== renderFullDoc =====");
    log(renderFullDoc(DOC));
    log("===== renderSectionBody(adjectives) =====");
    log(renderSectionBody("- **Precise** — Every sentence carries weight.\n- **Warm** — We write like a person."));
    log("===== renderSectionBody(sync end tail) =====");
    log(renderSectionBody("- **Tone Keywords:** a, b\n\n_auto._\n<!-- BRAND_SYNC_END -->"));
    fs.writeFileSync("/tmp/repro-out.txt", OUT.join("\n"));
  });
});
