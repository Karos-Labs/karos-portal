"use server";

import { revalidatePath } from "next/cache";
import {
  getJiraConfig,
  upsertJiraConfig,
  deleteJiraConfig,
  getUser,
  updateActionItem,
  listActionItemsPendingJiraSync,
} from "@/lib/data";
import { historyEntry } from "@/lib/action-items";
import { testJiraConnection, listJiraProjects, syncActionItemAssignmentToJira } from "@/lib/integrations/jira";
import { requireAdmin } from "./_shared";

/**
 * Save (create or overwrite) the agency-wide Jira connection. Admin-only —
 * this is the one board every staff member's action items push to, not a
 * per-client credential.
 *
 * A blank apiToken means "keep the stored secret", same convention as
 * `saveIntegrationAction` — secrets never reach the browser, so the form
 * cannot send back what it was never given.
 */
export async function saveJiraConfigAction(input: {
  siteUrl: string;
  email: string;
  apiToken: string;
  projectKey: string;
  issueType: string;
  enabled: boolean;
}): Promise<void> {
  const user = await requireAdmin();

  const existing = await getJiraConfig();
  const apiToken = input.apiToken.trim() || existing?.apiToken;
  if (!apiToken) throw new Error("API token is required");

  await upsertJiraConfig({
    siteUrl: input.siteUrl.trim().replace(/\/$/, ""),
    email: input.email.trim(),
    apiToken,
    projectKey: input.projectKey.trim(),
    issueType: input.issueType.trim() || "Task",
    enabled: input.enabled,
    connectedBy: user.uid,
    connectedAt: existing?.connectedAt ?? Date.now(),
    updatedAt: Date.now(),
  });

  revalidatePath("/admin/integrations");
}

/** Resolve the credentials to test/list-projects with: what was typed, falling back to what's stored. */
async function resolveCreds(input: { siteUrl: string; email: string; apiToken: string }) {
  const existing = await getJiraConfig();
  const apiToken = input.apiToken.trim() || existing?.apiToken;
  if (!apiToken) return null;
  return { siteUrl: input.siteUrl.trim().replace(/\/$/, ""), email: input.email.trim(), apiToken };
}

/** Verify the given (or, if apiToken is blank, currently stored) credentials work. */
export async function testJiraConnectionAction(input: {
  siteUrl: string;
  email: string;
  apiToken: string;
}): Promise<{ ok: boolean; error?: string }> {
  await requireAdmin();
  const creds = await resolveCreds(input);
  if (!creds) return { ok: false, error: "API token is required" };
  return testJiraConnection(creds);
}

/** Projects the connected account can see — powers the settings form's project-key dropdown. */
export async function listJiraProjectsAction(input: {
  siteUrl: string;
  email: string;
  apiToken: string;
}): Promise<{ ok: boolean; projects?: Array<{ key: string; name: string }>; error?: string }> {
  await requireAdmin();
  const creds = await resolveCreds(input);
  if (!creds) return { ok: false, error: "API token is required" };
  try {
    return { ok: true, projects: await listJiraProjects(creds) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Couldn't list projects" };
  }
}

/** Disconnect Jira entirely — new assignments stop pushing issues. */
export async function deleteJiraConfigAction(): Promise<void> {
  await requireAdmin();
  await deleteJiraConfig();
  revalidatePath("/admin/integrations");
}

/**
 * Catch up any action item that has an assignee but never got a Jira issue —
 * created before Jira was configured, or that failed (e.g. the project key
 * was wrong). One click instead of re-opening and reassigning each one.
 */
export async function retryPendingJiraSyncsAction(): Promise<{ attempted: number; succeeded: number }> {
  await requireAdmin();

  const pending = await listActionItemsPendingJiraSync();
  let succeeded = 0;
  for (const item of pending) {
    if (!item.assigneeUserId) continue;
    const user = await getUser(item.assigneeUserId);
    if (!user) continue;

    const jira = await syncActionItemAssignmentToJira(item, item.assigneeUserId, user.email);
    if (!jira) continue;
    succeeded++;
    await updateActionItem(item.id, {
      ...jira,
      history: [
        ...item.history,
        historyEntry("jira_linked", `Linked to Jira issue ${jira.jiraIssueKey}`, { id: "system", name: "Jira sync" }),
      ],
    });
  }

  revalidatePath("/dashboard");
  return { attempted: pending.length, succeeded };
}
