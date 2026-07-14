import { execFile } from "node:child_process";
import { mkdir, readdir, rm, writeFile, appendFile, access } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface Workspace {
  /** the copied agents repo — the SDK cwd */
  repoDir: string;
  agentsRepoSha: string;
  clientSlug: string;
  clientScaffolded: boolean;
}

export function deriveSlug(clientId: string, clientSlug?: string): string {
  if (clientSlug) return clientSlug;
  const slug = clientId
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return slug || "client";
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], { maxBuffer: 10 * 1024 * 1024 });
  return stdout.trim();
}

export async function prepareWorkspace(params: {
  bakedRepoDir: string;
  workDir: string;
  clientId: string;
  clientSlug?: string;
  agentVersion?: string;
}): Promise<Workspace> {
  const repoDir = path.join(params.workDir, "repo");
  await mkdir(params.workDir, { recursive: true });
  await execFileAsync("git", ["clone", "--no-hardlinks", params.bakedRepoDir, repoDir], {
    maxBuffer: 10 * 1024 * 1024,
  });

  if (params.agentVersion) {
    try {
      await git(repoDir, "checkout", "--detach", params.agentVersion);
    } catch {
      throw new Error(
        `agent_version "${params.agentVersion}" is not present in the baked agents repo; ` +
          `rebuild the runner image with AGENTS_REPO_REF=${params.agentVersion}`,
      );
    }
  }
  const agentsRepoSha = await git(repoDir, "rev-parse", "HEAD");

  await git(repoDir, "config", "user.email", "agent-runner@karoslabs.internal");
  await git(repoDir, "config", "user.name", "Karos Agent Runner");
  await appendFile(path.join(repoDir, ".git", "info", "exclude"), "\nclient_context/\n.claude/\noutputs/\n");

  const slug = deriveSlug(params.clientId, params.clientSlug);
  const clientsDir = path.join(repoDir, "clients");
  let clientScaffolded = false;
  const entries = await readdir(clientsDir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory() && entry.name !== slug) {
      await rm(path.join(clientsDir, entry.name), { recursive: true, force: true });
    }
  }
  try {
    await access(path.join(clientsDir, slug));
  } catch {
    clientScaffolded = true;
    await scaffoldClient(clientsDir, slug);
  }
  return { repoDir, agentsRepoSha, clientSlug: slug, clientScaffolded };
}

async function scaffoldClient(clientsDir: string, slug: string): Promise<void> {
  const clientDir = path.join(clientsDir, slug);
  for (const sub of ["profile", "brand/logos", "skills", "outputs/_ledger", "internal"]) {
    await mkdir(path.join(clientDir, sub), { recursive: true });
  }
  await writeFile(
    path.join(clientDir, "README.md"),
    `# ${slug}\n\nScaffolded for a platform job run. This client has no lab profile yet.\n` +
      `The authoritative context for this run lives in \`client_context/\` at the repo root ` +
      `(brief.md plus any input files). Treat missing profile docs as "data unavailable" — never invent client facts.\n`,
  );
  await writeFile(
    path.join(clientDir, "config.json"),
    JSON.stringify({ slug, status: "active", scaffolded_by: "agent-service" }, null, 2) + "\n",
  );
}

export async function writeClientContext(params: {
  repoDir: string;
  brief: Record<string, unknown>;
  briefMarkdown?: string;
}): Promise<void> {
  const contextDir = path.join(params.repoDir, "client_context");
  await mkdir(path.join(contextDir, "files"), { recursive: true });
  const briefLines = [
    "# Job brief",
    "",
    ...Object.entries(params.brief)
      .filter(([, v]) => v !== undefined && v !== null && v !== "")
      .map(([k, v]) => `- **${k}**: ${Array.isArray(v) ? v.join("; ") : String(v)}`),
  ];
  await writeFile(path.join(contextDir, "brief.md"), `${briefLines.join("\n")}\n`);
}
