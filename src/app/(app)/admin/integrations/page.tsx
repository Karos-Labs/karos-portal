import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { getJiraConfig } from "@/lib/data";
import { PageHeader } from "@/components/ui";
import { JiraSettingsPanel } from "@/components/jira-settings-panel";

/**
 * Admin-only agency-wide integrations (currently: Jira). Distinct from
 * /clients/[id]/settings' per-client integrations tab — this connection isn't
 * scoped to a client, it's the one board every staff member's action-item
 * assignments push to. See the "Jira sync for action-item assignment" plan.
 */
export default async function AdminIntegrationsPage() {
  const user = await requireUser();
  if (user.role !== "KAROS_ADMIN") redirect("/dashboard");

  const config = await getJiraConfig();
  // apiToken is decrypted server-side for the API client's own use only — it
  // must never reach the browser. The panel only needs to know one exists.
  const summary = config
    ? {
        id: config.id,
        siteUrl: config.siteUrl,
        email: config.email,
        projectKey: config.projectKey,
        issueType: config.issueType,
        enabled: config.enabled,
        connectedBy: config.connectedBy,
        connectedAt: config.connectedAt,
        updatedAt: config.updatedAt,
        hasApiToken: !!config.apiToken,
      }
    : null;

  return (
    <>
      <PageHeader
        title="Integrations"
        description="Agency-wide connections shared across all clients."
      />
      <JiraSettingsPanel config={summary} />
    </>
  );
}
