/**
 * Maps the karos-labs skill library into karosCMO Agent specs.
 *
 * A karos-labs "skill" is a SKILL.md file (frontmatter + a long runbook body) that, in its
 * home repo, is executed by a Supabase edge function plus a local render/sourcing toolchain.
 * karosCMO has no host for that machinery — an Agent here is a single Claude call whose system
 * prompt is `systemPrompt`. So we import each skill as an Agent whose system prompt is the
 * SKILL.md body (with an operating preamble that tells the model to ignore the parts of the
 * runbook that assume the other environment), and pick the best-fit `outputKind`/capabilities.
 *
 * Source data is the build artifacts copied from karos-labs/karos-ops/src/data:
 *   - labs-skills-catalog.json  — library metadata (clean name/desc), `skills/karos/*` only.
 *   - labs-skills-content.json  — every SKILL.md body keyed by skill id (incl. client skills).
 *
 * Scope (per product decision): the karos library (`skills/karos/*`) + the XO Digital client
 * skills (`skills/clients/xodigital/*`). Everything else is skipped.
 *
 * Pure module: no firebase, no `server-only`. `buildLabsAgentSpecs()` returns plain specs the
 * server action turns into Firestore Agent docs.
 */
import catalogJson from "@/data/labs-skills-catalog.json";
import contentJson from "@/data/labs-skills-content.json";
import type { AgentCapability, AgentField, Agent } from "@/lib/types";

/* ----------------------------- source shapes ----------------------------- */

interface LabsCatalog {
  categories: Array<{
    slug: string;
    label: string;
    path?: string;
    skills: Array<{ id: string; name?: string; desc?: string; trigger?: string; status?: string }>;
  }>;
}
interface LabsContentEntry {
  id: string;
  file_path?: string;
  content?: string;
}
interface LabsContent {
  skills: Record<string, LabsContentEntry>;
}

const catalog = catalogJson as unknown as LabsCatalog;
const content = contentJson as unknown as LabsContent;

/* ------------------------------- output spec ------------------------------ */

export interface LabsAgentSpec {
  /** Stable provenance + idempotency key: the karos-labs skill id. */
  labsSkillId: string;
  name: string;
  description: string;
  icon: string;
  color: string;
  model: string;
  systemPrompt: string;
  outputKind: Agent["outputKind"];
  fields: AgentField[];
  capabilities: AgentCapability[];
  shared: boolean;
}

/** karosCMO's proven default model (see run.ts DEFAULT_MODEL). */
const MODEL = "claude-sonnet-4-6";

/** Keep system prompts bounded — leaf body + at most one inherited parent playbook. */
const OWN_BODY_CAP = 24_000;
const PARENT_BODY_CAP = 12_000;

/**
 * Tells the model how to read a runbook written for a different runtime: follow the
 * strategy/voice/format/quality rules, but produce the deliverable as content here and ignore
 * any step that assumes files, pipelines, ledgers, or database/portal writes it cannot perform.
 */
const OPERATING_PREAMBLE = [
  "You are running as an agent inside karosCMO, a marketing-agency content tool. The playbook",
  "below was authored for a different execution environment. Follow its STRATEGY, VOICE, FORMAT,",
  "and QUALITY rules precisely, but adapt the OUTPUT to this tool: produce the requested content",
  "as text (for Instagram, as structured posts with a caption and an image concept). IGNORE any",
  "instructions about repository paths, folders, rendering or video pipelines (ffmpeg, Playwright,",
  "yt-dlp), ledgers, approval queues, schedules, or database / Supabase / portal writes — those",
  "steps happen outside this tool and you cannot perform them here. Do not output code or shell",
  "commands. Ground everything in the client's brand voice and the request details provided.",
].join(" ");

/* ------------------------------ scope filter ------------------------------ */

const KAROS_PREFIX = "skills/karos/";
const XO_PREFIX = "skills/clients/xodigital/";

function inScope(filePath: string | undefined): boolean {
  if (!filePath) return false;
  return filePath.startsWith(KAROS_PREFIX) || filePath.startsWith(XO_PREFIX);
}

/* --------------------------- frontmatter parsing -------------------------- */

/**
 * Minimal SKILL.md frontmatter reader. Splits the leading `---` block from the body and pulls
 * the top-level scalar keys we need (`name`, `description`, `parent`), handling YAML folded /
 * literal block scalars (`>-`, `|`, …). Not a general YAML parser — just enough for our keys.
 */
export function parseFrontmatter(md: string): { fm: Record<string, string>; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(md);
  if (!m) return { fm: {}, body: md };
  const body = md.slice(m[0].length);
  const lines = m[1].split(/\r?\n/);
  const fm: Record<string, string> = {};

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const keyMatch = /^([A-Za-z_][\w-]*):\s?(.*)$/.exec(line);
    if (!keyMatch) continue; // skip list items / nested / blank lines at top level
    const key = keyMatch[1];
    let value = keyMatch[2];

    if (/^[|>][+-]?\s*$/.test(value.trim())) {
      // Block scalar: gather the indented lines that follow.
      const folded = value.trim().startsWith(">");
      const collected: string[] = [];
      let j = i + 1;
      for (; j < lines.length; j++) {
        const next = lines[j];
        if (next.trim() === "") {
          collected.push("");
          continue;
        }
        if (!/^\s/.test(next)) break; // back to column 0 → next key
        collected.push(next.replace(/^\s+/, ""));
      }
      i = j - 1;
      value = folded ? collected.join(" ").replace(/\s+/g, " ").trim() : collected.join("\n").trim();
    } else {
      value = stripQuotes(value.trim());
    }
    fm[key] = value;
  }
  return { fm, body };
}

function stripQuotes(s: string): string {
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}

/* -------------------------------- helpers --------------------------------- */

const collapse = (s: string) => s.replace(/\s+/g, " ").trim();

/** "karos-did-you-know-xodigital" → "Did You Know". Fallback display name. */
function humanize(slug: string): string {
  return slug
    .replace(/^karos-/, "")
    .replace(/-xodigital$/, "")
    .replace(/[-_]+/g, " ")
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function firstParagraph(body: string): string {
  const para = body.replace(/^#.*$/gm, "").trim().split(/\n\s*\n/).find((p) => collapse(p).length > 0);
  if (!para) return "";
  const text = collapse(para);
  const dot = text.indexOf(". ");
  return dot > 40 ? text.slice(0, dot + 1) : text; // first sentence when it's substantial
}

function truncate(s: string, cap: number): string {
  return s.length <= cap ? s : `${s.slice(0, cap).trimEnd()}\n\n[…truncated for length]`;
}

/* ---------------------------- classification ------------------------------ */

type Style = "ig" | "x" | "email" | "article" | "report";

interface Classification {
  outputKind: Agent["outputKind"];
  capabilities: AgentCapability[];
  icon: string;
  color: string;
}

// NOTE: no style assigns `email_client` — imported agents create assets and stop at "review";
// they never auto-email the client (deliberate: a bulk import shouldn't wire up auto-delivery for
// dozens of agents). Enable email delivery per-agent in the builder if a skill should deliver.
const STYLE: Record<Style, Classification> = {
  ig: { outputKind: "instagram_posts", icon: "Camera", color: "#2dff9e", capabilities: ["generate", "use_brand_voice", "create_assets", "generate_images"] },
  x: { outputKind: "social_posts", icon: "Share2", color: "#ffcf5d", capabilities: ["generate", "use_brand_voice", "create_assets"] },
  email: { outputKind: "email", icon: "Mail", color: "#5db4ff", capabilities: ["generate", "use_brand_voice", "create_assets"] },
  // Reports/strategy benefit from meeting context, so `article` also grounds on transcripts.
  article: { outputKind: "article", icon: "PenLine", color: "#a78bfa", capabilities: ["generate", "use_brand_voice", "create_assets", "use_transcripts"] },
  report: { outputKind: "freeform", icon: "Sparkles", color: "#9aa7b0", capabilities: ["generate", "use_brand_voice", "create_assets", "use_transcripts"] },
};

/** Best-fit output contract from the skill id, file path, and declared parent. */
function classify(id: string, filePath: string, parent: string): Classification {
  const i = id.toLowerCase();
  const p = filePath.toLowerCase();
  // Overseer / roll-up skills produce an ops report, never posts — match the full vocabulary,
  // not just the literal "manager" (e.g. karos-cso, karos-social-orchestrator).
  const isManager = /(manager|orchestrat|\bcso\b|chief|director|officer|overse|roll-?up)/.test(i);

  if (p.includes("/x-content/") || parent === "karos-x-agent" || /(^|-)x-/.test(i)) {
    return isManager ? STYLE.report : STYLE.x;
  }
  if (i.includes("linkedin") || parent === "karos-linkedin-agent") return STYLE.x;
  if (i.includes("newsletter") || i.includes("email") || parent === "karos-email-campaigns") return STYLE.email;
  if (i.includes("blog") || i.includes("seo") || i.includes("geo")) return STYLE.article;
  if (
    p.includes("/content-engine/") ||
    p.includes("/content-social/") ||
    parent === "karos-instagram-tiktok-content-agent" ||
    /(instagram|tiktok|carousel|giro|legend|opportunity|did-you-know|clip)/.test(i)
  ) {
    return isManager ? STYLE.report : STYLE.ig;
  }
  if (/(intel|report|scope|qbr|brand|positioning|strateg|gtm|audit|performance|proposal|channel|community|reputation|review|research|grade)/.test(i)) {
    return STYLE.article;
  }
  return STYLE.report;
}

/* -------------------------------- fields ---------------------------------- */

const TOPIC_FIELD: AgentField = {
  key: "topic",
  label: "Topic / focus",
  type: "text",
  placeholder: "What this run should be about",
  required: true,
};
const NOTES_FIELD: AgentField = {
  key: "notes",
  label: "Notes (optional)",
  type: "textarea",
  placeholder: "Anything specific to include or avoid",
};
function countField(defaultValue: string): AgentField {
  return { key: "count", label: "How many posts", type: "select", options: ["1", "2", "3", "4", "5"], defaultValue };
}

/** `single` → this skill produces one post per run (XO content formats), so default count to 1. */
function fieldsFor(outputKind: Agent["outputKind"], single: boolean): AgentField[] {
  return outputKind === "instagram_posts"
    ? [TOPIC_FIELD, countField(single ? "1" : "3"), NOTES_FIELD]
    : [TOPIC_FIELD, NOTES_FIELD];
}

/* ------------------------------ system prompt ----------------------------- */

function buildSystemPrompt(name: string, ownBody: string, parentName: string, parentBody: string): string {
  const sections = [OPERATING_PREAMBLE];
  if (parentBody) {
    sections.push(
      `===== INHERITED PLAYBOOK: ${parentName} =====\n${truncate(collapseBlank(parentBody), PARENT_BODY_CAP)}`,
    );
  }
  sections.push(`===== SKILL: ${name} =====\n${truncate(collapseBlank(ownBody), OWN_BODY_CAP)}`);
  return sections.join("\n\n");
}

/** Trim leading/trailing blank lines without collapsing internal structure. */
function collapseBlank(s: string): string {
  return s.replace(/^\s*\n/, "").trimEnd();
}

/* -------------------------------- builder --------------------------------- */

/** Catalog metadata (clean name/desc) keyed by skill id, for the library skills that have it. */
function catalogIndex(): Map<string, { name?: string; desc?: string }> {
  const idx = new Map<string, { name?: string; desc?: string }>();
  for (const cat of catalog.categories ?? []) {
    for (const s of cat.skills ?? []) {
      if (s.id) idx.set(s.id, { name: s.name, desc: s.desc });
    }
  }
  return idx;
}

/**
 * Build the in-scope Agent specs. Deterministic and side-effect free.
 * Sorted XO skills first (most actionable), then alphabetically by name.
 */
export function buildLabsAgentSpecs(): LabsAgentSpec[] {
  const cat = catalogIndex();
  const byId = content.skills ?? {};
  const specs: LabsAgentSpec[] = [];

  for (const entry of Object.values(byId)) {
    const filePath = entry.file_path ?? "";
    if (!inScope(filePath)) continue;
    const raw = entry.content ?? "";
    if (!raw.trim()) continue;

    const { fm, body } = parseFrontmatter(raw);
    if (!body.trim()) continue;

    const id = entry.id;
    const isXo = filePath.startsWith(XO_PREFIX);
    const parent = fm.parent ?? "";
    const meta = cat.get(id);

    const baseName = meta?.name?.trim() || humanize(fm.name || id);
    const name = isXo ? `${baseName} — XO Digital` : baseName;

    const description =
      (meta?.desc?.trim() || collapse(fm.description || "") || firstParagraph(body)).slice(0, 280) ||
      "Imported from the Karos skill library.";

    const cls = classify(id, filePath, parent);

    // Inline the parent playbook whenever a skill declares one that's in the bundle — the
    // child's voice/format rules live upstream (true for the XO skills and any library child).
    let parentName = "";
    let parentBody = "";
    if (parent && parent !== id && byId[parent]?.content) {
      parentName = cat.get(parent)?.name?.trim() || humanize(parent);
      parentBody = parseFrontmatter(byId[parent].content ?? "").body;
    }

    specs.push({
      labsSkillId: id,
      name,
      description,
      icon: cls.icon,
      color: cls.color,
      model: MODEL,
      systemPrompt: buildSystemPrompt(name, body, parentName, parentBody),
      outputKind: cls.outputKind,
      fields: fieldsFor(cls.outputKind, isXo),
      capabilities: cls.capabilities,
      shared: true,
    });
  }

  specs.sort((a, b) => {
    const ax = a.labsSkillId.includes("xodigital") ? 0 : 1;
    const bx = b.labsSkillId.includes("xodigital") ? 0 : 1;
    return ax - bx || a.name.localeCompare(b.name);
  });
  return specs;
}
