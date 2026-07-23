/**
 * Read a CLIENT's own GitHub repo activity — distinct from
 * `AGENTS_REPO_GITHUB_TOKEN` (src/lib/lab-outputs.ts), which reads Karos's
 * private karos-agents lab repo for staff tooling. This is the "optional
 * lane" the X/newsletter agents want: turning a client's shipped commits/
 * releases into post material. Server-only.
 *
 * No OAuth app needed for PUBLIC repos: an optional `GITHUB_READ_TOKEN`
 * (any classic PAT with public_repo scope, or none at all) just raises the
 * GitHub API rate limit from 60/hr to 5000/hr. Private client repos would
 * need a per-client token or GitHub App install, not built here — flag that
 * decision if a client's repo isn't public.
 */

import "server-only";

const API = "https://api.github.com";

function headers(): Record<string, string> {
  const token = process.env.GITHUB_READ_TOKEN;
  return {
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
}

export interface ClientRepoCommit {
  sha: string;
  message: string;
  authorLogin: string | null;
  date: string;
}

export interface ClientRepoRelease {
  tagName: string;
  name: string | null;
  body: string | null;
  publishedAt: string | null;
  url: string;
}

/** Recent commits on a public client repo's default branch. */
export async function fetchClientRepoCommits(
  owner: string,
  repo: string,
  perPage = 20,
): Promise<ClientRepoCommit[]> {
  const res = await fetch(
    `${API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits?per_page=${perPage}`,
    { headers: headers(), signal: AbortSignal.timeout(15_000) },
  );
  if (res.status === 404) throw new Error(`Repo not found or private: ${owner}/${repo}`);
  if (res.status === 403) throw new Error("GitHub rate limit hit — set GITHUB_READ_TOKEN to raise it.");
  if (!res.ok) throw new Error(`GitHub commits fetch failed: ${res.status}`);
  const body = (await res.json()) as Array<{
    sha?: string;
    commit?: { message?: string; author?: { date?: string } };
    author?: { login?: string } | null;
  }>;
  return body.map((c) => ({
    sha: c.sha ?? "",
    message: c.commit?.message ?? "",
    authorLogin: c.author?.login ?? null,
    date: c.commit?.author?.date ?? "",
  }));
}

/** Recent releases — usually the stronger "shipped work" signal than raw commits. */
export async function fetchClientRepoReleases(
  owner: string,
  repo: string,
  perPage = 10,
): Promise<ClientRepoRelease[]> {
  const res = await fetch(
    `${API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/releases?per_page=${perPage}`,
    { headers: headers(), signal: AbortSignal.timeout(15_000) },
  );
  if (res.status === 404) throw new Error(`Repo not found or private: ${owner}/${repo}`);
  if (res.status === 403) throw new Error("GitHub rate limit hit — set GITHUB_READ_TOKEN to raise it.");
  if (!res.ok) throw new Error(`GitHub releases fetch failed: ${res.status}`);
  const body = (await res.json()) as Array<{
    tag_name?: string;
    name?: string | null;
    body?: string | null;
    published_at?: string | null;
    html_url?: string;
  }>;
  return body.map((r) => ({
    tagName: r.tag_name ?? "",
    name: r.name ?? null,
    body: r.body ?? null,
    publishedAt: r.published_at ?? null,
    url: r.html_url ?? "",
  }));
}
