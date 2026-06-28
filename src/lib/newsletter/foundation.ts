/**
 * Content-foundation composer — renders the structured `ContentFoundation` fields the
 * questionnaire collects into the §-numbered `CONTENT-FOUNDATION.md` the karos-labs
 * newsletter + blog agents read each run. The structured fields are the single source of
 * truth; this markdown is the engine-facing view.
 *
 * Pure module (no "server-only") — usable from anywhere.
 */

import type { ContentFoundation, NewsletterBrand } from "./types";

/** Drop blank lines (the questionnaire keeps empties while typing in the textarea). */
function cleanLines(lines: string[]): string[] {
  return lines.map((l) => l.trim()).filter(Boolean);
}

function bullets(lines: string[], emptyNote = "_(not provided)_"): string {
  const items = cleanLines(lines);
  return items.length ? items.map((l) => `- ${l}`).join("\n") : emptyNote;
}

function para(text: string, emptyNote = "_(not provided)_"): string {
  return text.trim() || emptyNote;
}

/**
 * Render the editorial brain as `CONTENT-FOUNDATION.md`. Mirrors the karos-labs
 * `CONTENT-FOUNDATION-template.md` section order so the agents find what they expect.
 */
export function composeFoundationMarkdown(f: ContentFoundation, brand?: NewsletterBrand): string {
  const name = brand?._meta?.company_name?.trim() || "Client";
  const register = f.voiceRegister.trim();

  return [
    `# CONTENT FOUNDATION — ${name}`,
    "",
    "## 1. Who the client is",
    para(f.whoTheyAre),
    "",
    "### Audience",
    para(f.audience),
    "",
    "## 2. Voice rules (apply to every issue and post)",
    register ? `Dominant register: ${register}.` : "_(register not set)_",
    bullets(f.voiceHardRules, "_(no extra hard rules)_"),
    "",
    "## 3. Content pillars (4 to 6 themes the client wants to be known for)",
    bullets(f.pillars),
    "",
    "## 4. Seed topic pool",
    bullets(f.seedTopics),
    "",
    "## 5. Keyword & GEO targets (for the blog)",
    para(f.keywordTargets),
    "",
    "## 6. Compliance / hard constraints",
    para(f.complianceConstraints, "_(none provided)_"),
    "",
    "## 7. Cadence",
    para(
      f.cadenceNotes,
      `Newsletter ${brand?.newsletter?.send_day ?? "Tuesday"}, blog the day after.`,
    ),
    "",
  ].join("\n");
}
