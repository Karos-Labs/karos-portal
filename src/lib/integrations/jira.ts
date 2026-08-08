import "server-only";

import { getJiraConfig } from "@/lib/data";
import { logger } from "@/services/logger";
import type { ActionItem, JiraConfig } from "@/lib/types";

/**
 * One-way push to Jira Cloud: assigning a meeting action item to a staff
 * member creates (or reassigns) a Jira issue. Nothing is synced back — see
 * the "Jira sync for action-item assignment" plan for the full v1 scope.
 *
 * Jira Cloud's modern REST API (v3) requires an `accountId` for the assignee
 * field, not an email or username, so every write path here resolves email
 * to accountId first via /user/search.
 */

/** What every request needs, regardless of project/issue-type — lets callers that only have credentials (not a full saved config) still test/list projects. */
type JiraCreds = Pick<JiraConfig, "siteUrl" | "email" | "apiToken">;

function authHeader(config: JiraCreds): string {
  return `Basic ${Buffer.from(`${config.email}:${config.apiToken}`).toString("base64")}`;
}

async function jiraFetch(config: JiraCreds, path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${config.siteUrl.replace(/\/$/, "")}${path}`, {
    ...init,
    headers: {
      Authorization: authHeader(config),
      "Content-Type": "application/json",
      Accept: "application/json",
      ...init?.headers,
    },
  });
}

/** Minimal one-paragraph Atlassian Document Format wrapper — v3's `description` field rejects plain strings. */
function toAdf(text: string) {
  return {
    type: "doc",
    version: 1,
    content: [{ type: "paragraph", content: [{ type: "text", text }] }],
  };
}

/** Verify site URL + credentials are usable. Used by the settings page's "Test connection" button. */
export async function testJiraConnection(config: JiraCreds): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await jiraFetch(config, "/rest/api/3/myself");
    if (!res.ok) return { ok: false, error: `Jira returned ${res.status}` };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Connection failed" };
  }
}

/**
 * List projects visible to the connected account — lets the settings form
 * offer a dropdown instead of a free-text key, so a typo or a project the
 * account can't actually create issues in never gets saved silently (that's
 * exactly how the first real assignment failed: "KAR" wasn't a real/reachable
 * project key for this account).
 */
export async function listJiraProjects(config: JiraCreds): Promise<Array<{ key: string; name: string }>> {
  const res = await jiraFetch(config, "/rest/api/3/project/search?maxResults=100");
  if (!res.ok) throw new Error(`Jira project list failed (${res.status}): ${await res.text()}`);
  const body = (await res.json()) as { values: Array<{ key: string; name: string }> };
  return body.values.map((p) => ({ key: p.key, name: p.name }));
}

/** Resolve a staff member's Jira accountId from their email. Returns null if no match. */
export async function resolveJiraAccountId(config: JiraConfig, email: string): Promise<string | null> {
  const res = await jiraFetch(config, `/rest/api/3/user/search?query=${encodeURIComponent(email)}`);
  if (!res.ok) return null;
  const users = (await res.json()) as Array<{ accountId: string; emailAddress?: string }>;
  const exact = users.find((u) => u.emailAddress?.toLowerCase() === email.toLowerCase());
  return (exact ?? users[0])?.accountId ?? null;
}

/** Jira caps issue summaries — truncate rather than let the API reject the create. */
const MAX_SUMMARY_LENGTH = 250;

async function createJiraIssue(
  config: JiraConfig,
  input: { summary: string; descriptionText: string; accountId: string },
): Promise<{ key: string; url: string }> {
  const res = await jiraFetch(config, "/rest/api/3/issue", {
    method: "POST",
    body: JSON.stringify({
      fields: {
        project: { key: config.projectKey },
        summary: input.summary.slice(0, MAX_SUMMARY_LENGTH),
        description: toAdf(input.descriptionText),
        issuetype: { name: config.issueType },
        assignee: { id: input.accountId },
      },
    }),
  });
  if (!res.ok) throw new Error(`Jira create failed (${res.status}): ${await res.text()}`);
  const body = (await res.json()) as { key: string };
  return { key: body.key, url: `${config.siteUrl.replace(/\/$/, "")}/browse/${body.key}` };
}

async function reassignJiraIssue(config: JiraConfig, issueKey: string, accountId: string): Promise<void> {
  const res = await jiraFetch(config, `/rest/api/3/issue/${issueKey}/assignee`, {
    method: "PUT",
    body: JSON.stringify({ accountId }),
  });
  if (!res.ok) throw new Error(`Jira reassign failed (${res.status}): ${await res.text()}`);
}

/**
 * The single entry point both assignment paths (transcript-actions.ts and
 * action-item-actions.ts) call. Never throws — every failure is logged and
 * swallowed, since Jira being unreachable must never block the underlying
 * assignment. Returns the fields to persist onto the ActionItem doc, or null
 * when there's nothing to persist (not configured, unassigning, no Jira
 * account match, or a failed API call).
 */
export async function syncActionItemAssignmentToJira(
  item: ActionItem,
  assignedUserId: string | null,
  assigneeEmail: string,
): Promise<{ jiraIssueKey: string; jiraIssueUrl: string } | null> {
  // Unassigning is out of scope for v1 — the existing Jira issue is left as-is.
  if (!assignedUserId) return null;

  try {
    const config = await getJiraConfig();
    if (!config?.enabled) return null;

    const accountId = await resolveJiraAccountId(config, assigneeEmail);
    if (!accountId) {
      logger.logError({
        clientId: null,
        agentId: null,
        operation: "jira_sync",
        errorMessage: `No Jira account found for ${assigneeEmail}`,
        severity: "WARN",
      });
      return null;
    }

    if (item.jiraIssueKey) {
      await reassignJiraIssue(config, item.jiraIssueKey, accountId);
      return { jiraIssueKey: item.jiraIssueKey, jiraIssueUrl: item.jiraIssueUrl ?? "" };
    }

    const created = await createJiraIssue(config, {
      summary: item.text,
      descriptionText: `From meeting: ${item.transcriptTitle}\n${process.env.NEXT_PUBLIC_APP_URL ?? ""}/transcripts/${item.transcriptId}`,
      accountId,
    });
    return { jiraIssueKey: created.key, jiraIssueUrl: created.url };
  } catch (e) {
    logger.logError({
      clientId: null,
      agentId: null,
      operation: "jira_sync",
      errorMessage: e instanceof Error ? e.message : "Jira sync failed",
      severity: "WARN",
    });
    return null;
  }
}
