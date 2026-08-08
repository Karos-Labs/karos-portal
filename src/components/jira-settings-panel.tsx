"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button, Card, CardTitle, Input, Label, Select } from "@/components/ui";
import {
  saveJiraConfigAction,
  testJiraConnectionAction,
  listJiraProjectsAction,
  deleteJiraConfigAction,
  retryPendingJiraSyncsAction,
} from "@/lib/actions";
import type { JiraConfig } from "@/lib/types";

const ISSUE_TYPES = ["Task", "Bug", "Story"];

type ConfigSummary = (Omit<JiraConfig, "apiToken"> & { hasApiToken: boolean }) | null;
type JiraProject = { key: string; name: string };

export function JiraSettingsPanel({ config }: { config: ConfigSummary }) {
  const router = useRouter();
  const [siteUrl, setSiteUrl] = useState(config?.siteUrl ?? "");
  const [email, setEmail] = useState(config?.email ?? "");
  const [apiToken, setApiToken] = useState("");
  const [projectKey, setProjectKey] = useState(config?.projectKey ?? "");
  // Seeded with the saved key so the dropdown has something to show before
  // "Test connection" is clicked again — otherwise a previously-saved project
  // would render blank until the list loads.
  const [projects, setProjects] = useState<JiraProject[]>(
    config?.projectKey ? [{ key: config.projectKey, name: config.projectKey }] : [],
  );
  const [issueType, setIssueType] = useState(config?.issueType ?? "Task");
  const [enabled, setEnabled] = useState(config?.enabled ?? true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; error?: string } | null>(null);
  const [retrying, setRetrying] = useState(false);
  const [retryResult, setRetryResult] = useState<{ attempted: number; succeeded: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const missing = !siteUrl.trim() || !email.trim() || !projectKey.trim() || (!config?.hasApiToken && !apiToken.trim());
  const credsEntered = siteUrl.trim() && email.trim() && (config?.hasApiToken || apiToken.trim());

  async function handleSave() {
    setSaving(true);
    setError(null);
    try {
      await saveJiraConfigAction({ siteUrl, email, apiToken, projectKey, issueType, enabled });
      setApiToken("");
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't save, try again.");
    } finally {
      setSaving(false);
    }
  }

  // One click validates credentials AND loads the real project list — no
  // point testing a connection you can't yet pick a project through.
  async function handleTest() {
    setTesting(true);
    setTestResult(null);
    try {
      const creds = { siteUrl, email, apiToken };
      const result = await testJiraConnectionAction(creds);
      setTestResult(result);
      if (result.ok) {
        const projectList = await listJiraProjectsAction(creds);
        if (projectList.ok && projectList.projects) {
          setProjects(projectList.projects);
          if (!projectList.projects.some((p) => p.key === projectKey)) {
            setProjectKey(projectList.projects[0]?.key ?? "");
          }
        }
      }
    } catch (e) {
      setTestResult({ ok: false, error: e instanceof Error ? e.message : "Test failed" });
    } finally {
      setTesting(false);
    }
  }

  async function handleDisconnect() {
    setSaving(true);
    setError(null);
    try {
      await deleteJiraConfigAction();
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't disconnect, try again.");
    } finally {
      setSaving(false);
    }
  }

  async function handleRetry() {
    setRetrying(true);
    setRetryResult(null);
    try {
      setRetryResult(await retryPendingJiraSyncsAction());
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't retry, try again.");
    } finally {
      setRetrying(false);
    }
  }

  return (
    <Card className="max-w-xl space-y-4">
      <div className="flex items-center justify-between">
        <CardTitle>Jira</CardTitle>
        {config && (
          <span className={`text-xs ${enabled ? "text-neon" : "text-muted-2"}`}>
            {enabled ? "Connected" : "Connected (disabled)"}
          </span>
        )}
      </div>
      <p className="text-sm text-muted">
        When a staff member is assigned a meeting action item, a Jira issue is
        created (or reassigned) and linked back automatically. Nothing syncs
        back from Jira.
      </p>

      <div className="space-y-3">
        <div>
          <Label htmlFor="jira-site-url">Site URL</Label>
          <Input
            id="jira-site-url"
            value={siteUrl}
            onChange={(e) => setSiteUrl(e.target.value)}
            placeholder="https://karoslabs.atlassian.net"
          />
        </div>
        <div>
          <Label htmlFor="jira-email">Account email</Label>
          <Input
            id="jira-email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="automations@karoslabs.com"
          />
        </div>
        <div>
          <Label htmlFor="jira-api-token">API token</Label>
          <Input
            id="jira-api-token"
            type="password"
            value={apiToken}
            onChange={(e) => setApiToken(e.target.value)}
            placeholder={config?.hasApiToken ? "Leave blank to keep the current token" : "Paste the token from id.atlassian.com"}
          />
        </div>
        <div>
          <Label htmlFor="jira-project-key">Project</Label>
          {projects.length > 0 ? (
            <Select id="jira-project-key" value={projectKey} onChange={(e) => setProjectKey(e.target.value)}>
              {projects.map((p) => (
                <option key={p.key} value={p.key}>{p.name} ({p.key})</option>
              ))}
            </Select>
          ) : (
            <p className="text-xs text-muted-2">
              {credsEntered ? "Test connection to load your Jira projects." : "Enter site URL, email and API token, then test the connection."}
            </p>
          )}
        </div>
        <div>
          <Label htmlFor="jira-issue-type">Issue type</Label>
          <Select id="jira-issue-type" value={issueType} onChange={(e) => setIssueType(e.target.value)}>
            {ISSUE_TYPES.map((t) => (
              <option key={t} value={t}>{t}</option>
            ))}
          </Select>
        </div>
        <label className="flex items-center gap-2 text-sm text-foreground">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          Push new assignments to Jira
        </label>
      </div>

      {testResult && (
        <p className={`text-xs ${testResult.ok ? "text-neon" : "text-red-400"}`}>
          {testResult.ok ? "Connection succeeded." : `Connection failed: ${testResult.error}`}
        </p>
      )}
      {error && <p className="text-xs text-red-400">{error}</p>}

      <div className="flex items-center gap-2">
        <Button variant="outline" size="sm" onClick={handleTest} disabled={testing || !credsEntered}>
          {testing ? "Testing…" : "Test connection"}
        </Button>
        <Button size="sm" onClick={handleSave} disabled={saving || missing}>
          {saving ? "Saving…" : "Save"}
        </Button>
        {config && (
          <Button variant="danger" size="sm" onClick={handleDisconnect} disabled={saving}>
            Disconnect
          </Button>
        )}
      </div>

      {config && (
        <div className="border-t border-border pt-4">
          <p className="text-sm text-muted">
            Action items assigned before Jira was connected, or that failed to
            sync (e.g. a wrong project), don&apos;t get created automatically
            after a fix. Retry them here.
          </p>
          <div className="mt-2 flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={handleRetry} disabled={retrying}>
              {retrying ? "Retrying…" : "Retry pending Jira syncs"}
            </Button>
            {retryResult && (
              <span className="text-xs text-muted-2">
                {retryResult.succeeded}/{retryResult.attempted} synced
                {retryResult.attempted > retryResult.succeeded && " (check errorLogs for the rest)"}
              </span>
            )}
          </div>
        </div>
      )}
    </Card>
  );
}
