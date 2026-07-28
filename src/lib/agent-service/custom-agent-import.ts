import "server-only";

/**
 * Import source for custom agents: scans the karos-agents repo's own catalog
 * (catalog/agent-runtime-manifest.json — the per-skill service contract) via
 * the GitHub contents API and turns products/ entry agents into importable
 * candidates. Same auth as lab-outputs.ts: AGENTS_REPO_GITHUB_TOKEN +
 * AGENTS_REPO (defaults to karoslabs/karos-agents), read-only.
 */

const API = "https://api.github.com";

function config(): { repo: string; token: string } | null {
  const token = process.env.AGENTS_REPO_GITHUB_TOKEN;
  if (!token) return null;
  return { repo: process.env.AGENTS_REPO ?? "karoslabs/karos-agents", token };
}

export function isCustomAgentImportConfigured(): boolean {
  return config() !== null;
}

async function ghRaw(path: string): Promise<string> {
  const cfg = config();
  if (!cfg) throw new Error("AGENTS_REPO_GITHUB_TOKEN is not configured.");
  const res = await fetch(`${API}/repos/${cfg.repo}/contents/${encodeURI(path)}`, {
    headers: {
      authorization: `Bearer ${cfg.token}`,
      accept: "application/vnd.github.raw",
      "x-github-api-version": "2022-11-28",
    },
    signal: AbortSignal.timeout(30_000),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`GitHub fetch of ${path} failed (${res.status})`);
  return res.text();
}

async function headSha(): Promise<string | undefined> {
  const cfg = config();
  if (!cfg) return undefined;
  try {
    const res = await fetch(`${API}/repos/${cfg.repo}/commits?per_page=1`, {
      headers: {
        authorization: `Bearer ${cfg.token}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
      },
      signal: AbortSignal.timeout(15_000),
      cache: "no-store",
    });
    if (!res.ok) return undefined;
    const commits = (await res.json()) as Array<{ sha?: string }>;
    return commits[0]?.sha;
  } catch {
    return undefined; // provenance only — never block an import on it
  }
}

/* ── Repo catalog shapes (hand-maintained JSON in karos-agents) ──── */

interface ManifestSkill {
  skill_name?: string;
  /** SKILL.md path, e.g. "products/live/instagram-agent/SKILL.md". */
  path?: string;
  /** "entry-agent" = directly invokable; "composed-only" = never run alone. */
  kind?: string;
  status?: string;
  blocked_reason?: string;
  outputs?: string;
}

interface SkillsCatalog {
  categories?: Array<{
    skills?: Array<{ id?: string; name?: string; desc?: string }>;
  }>;
}

export interface CustomAgentImportCandidate {
  /** Stable key = the repo skill_name (unique in the manifest). */
  key: string;
  name: string;
  description: string;
  /** Repo-relative entry skill directory. */
  entrySkillDir: string;
  /** Picker group derived from the path, e.g. "Live", "Amazon", "Internal". */
  group: string;
  /** Runtime-manifest readiness: ready / blocked / unreviewed. */
  status: string;
  blockedReason?: string;
}

function groupForPath(dir: string): string {
  if (dir.startsWith("products/live/amazon")) return "Amazon";
  if (dir.startsWith("products/live/")) return "Live";
  if (dir.startsWith("products/building/")) return "Building";
  if (dir.startsWith("products/internal/")) return "Internal";
  if (dir.startsWith("products/onboarding/")) return "Onboarding";
  return "Other";
}

function titleCase(slug: string): string {
  return slug
    .replace(/^karos-/, "")
    .split(/[-_]/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(" ");
}

/**
 * All importable products/ entry agents, grouped and sorted for the picker.
 * Names/descriptions prefer the hand-maintained skills catalog; agents the
 * catalog doesn't cover (e.g. Amazon phase sub-skills) fall back to a
 * title-cased skill name.
 */
export async function listCustomAgentImportCandidates(): Promise<{
  repoSha?: string;
  candidates: CustomAgentImportCandidate[];
}> {
  const [manifestRaw, catalogRaw, repoSha] = await Promise.all([
    ghRaw("catalog/agent-runtime-manifest.json"),
    ghRaw("catalog/skills-catalog.json").catch(() => null),
    headSha(),
  ]);

  const manifest = JSON.parse(manifestRaw) as { skills?: ManifestSkill[] };
  const names = new Map<string, { name?: string; desc?: string }>();
  if (catalogRaw) {
    try {
      const catalog = JSON.parse(catalogRaw) as SkillsCatalog;
      for (const category of catalog.categories ?? []) {
        for (const skill of category.skills ?? []) {
          if (skill.id) names.set(skill.id, { name: skill.name, desc: skill.desc });
        }
      }
    } catch {
      // catalog is a nicety — the manifest alone is enough to import
    }
  }

  const candidates: CustomAgentImportCandidate[] = [];
  const seen = new Set<string>();
  for (const skill of manifest.skills ?? []) {
    if (!skill.skill_name || !skill.path) continue;
    if (skill.kind !== "entry-agent") continue;
    if (!skill.path.startsWith("products/")) continue; // per the import-scope decision
    if (seen.has(skill.skill_name)) continue;
    seen.add(skill.skill_name);

    const entrySkillDir = skill.path.replace(/\/SKILL\.md$/, "");
    const catalogEntry = names.get(skill.skill_name);
    candidates.push({
      key: skill.skill_name,
      name: catalogEntry?.name ?? titleCase(skill.skill_name),
      description: catalogEntry?.desc ?? skill.outputs ?? "",
      entrySkillDir,
      group: groupForPath(entrySkillDir),
      status: skill.status ?? "unreviewed",
      ...(skill.blocked_reason ? { blockedReason: skill.blocked_reason } : {}),
    });
  }

  const groupOrder = ["Live", "Building", "Onboarding", "Internal", "Amazon", "Other"];
  candidates.sort(
    (a, b) =>
      groupOrder.indexOf(a.group) - groupOrder.indexOf(b.group) || a.name.localeCompare(b.name),
  );
  return { ...(repoSha ? { repoSha } : {}), candidates };
}

/**
 * One top-level frontmatter value, line-based so YAML block scalars
 * (`description: >-` / `|` followed by indented lines) and multi-line strings
 * fold correctly — a regex lookahead to the "next key" truncates those.
 */
function frontmatterValue(body: string, key: string): string | undefined {
  const lines = body.split("\n");
  const start = lines.findIndex((l) => l.startsWith(`${key}:`));
  if (start === -1) return undefined;
  const first = lines[start].slice(key.length + 1).trim();
  const parts: string[] = /^[>|][+-]?$/.test(first) ? [] : [first];
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\S/.test(lines[i])) break; // next top-level key
    parts.push(lines[i].trim());
  }
  const value = parts.filter(Boolean).join(" ").trim().replace(/^["']|["']$/g, "");
  return value || undefined;
}

/** name + description from a SKILL.md's YAML frontmatter (best effort). */
export async function fetchSkillFrontmatter(
  entrySkillDir: string,
): Promise<{ name?: string; description?: string }> {
  try {
    const raw = await ghRaw(`${entrySkillDir}/SKILL.md`);
    const match = raw.match(/^---\n([\s\S]*?)\n---/);
    if (!match) return {};
    const name = frontmatterValue(match[1], "name");
    const description = frontmatterValue(match[1], "description");
    return { ...(name ? { name } : {}), ...(description ? { description } : {}) };
  } catch {
    return {};
  }
}

/**
 * Lab-repo shorthand that must never reach a client surface: product codes
 * ("(e13)"), pipeline vocabulary ("sub-skill", "tonemap"), internal gate names
 * ("FORGE"), and route labels ("Path A"). The import path tests every manifest
 * blurb against this before it may become a client-facing `clientBlurb`, and
 * the admin editor refuses a blurb that matches — so the next import cannot
 * quietly reintroduce engineering notes into the client's agent cards.
 */
export const LAB_JARGON_RE = /\be\d{1,2}\)|sub-skill|tonemap|FORGE|Path [A-Z]\b/i;

export function containsLabJargon(text: string): boolean {
  return LAB_JARGON_RE.test(text);
}

/** Default editable instructions seeded into an imported agent. */
export function defaultInstructionsFor(candidate: CustomAgentImportCandidate, skillDescription?: string): string {
  const about = skillDescription || candidate.description;
  return [
    `Run the "${candidate.key}" skill (${candidate.entrySkillDir}/SKILL.md) end to end.`,
    about ? `\nWhat this agent does: ${about}` : "",
    `\nFollow the client's brand voice and profile docs. Prefer the client's emitted sub-skills when they exist. Deliver production-ready output — no placeholders, no unfinished drafts.`,
  ]
    .filter(Boolean)
    .join("\n")
    .slice(0, 11_000);
}
