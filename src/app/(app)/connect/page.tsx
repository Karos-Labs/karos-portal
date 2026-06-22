import { headers } from "next/headers";
import { requireUser } from "@/lib/auth";
import { listAccessTokens } from "@/lib/data";
import { PageHeader, Card, CardTitle } from "@/components/ui";
import { Icon } from "@/components/icon";
import { TokenManager } from "@/components/token-manager";

export default async function ConnectPage() {
  const user = await requireUser(["admin", "employee"]);
  const [tokens, h] = await Promise.all([listAccessTokens(user.uid), headers()]);

  const host = h.get("host") ?? "localhost:3000";
  const proto = h.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  const mcpUrl = `${proto}://${host}/api/mcp`;

  return (
    <>
      <PageHeader
        title="Connect Claude Code"
        description="Build and test agents from your own terminal. Karos exposes an MCP server your Claude Code can drive."
      />

      <div className="grid gap-6 lg:grid-cols-[1fr_360px]">
        <div className="space-y-6">
          <Card className="space-y-4">
            <CardTitle>1. Create a personal access token</CardTitle>
            <p className="text-sm text-muted">
              Claude Code authenticates with a bearer token tied to your account. It acts as you —
              with the same permissions you have in the app. Keep it secret; revoke it anytime.
            </p>
            <TokenManager tokens={tokens} mcpUrl={mcpUrl} />
          </Card>

          <Card className="space-y-4">
            <CardTitle>2. Add the server to Claude Code</CardTitle>
            <p className="text-sm text-muted">
              Run this in any project (replace <code className="text-neon">YOUR_TOKEN</code> with the token above):
            </p>
            <pre className="overflow-auto rounded-[10px] border border-border bg-surface-2 p-3 text-[12.5px] leading-relaxed">
{`claude mcp add --transport http karos \\
  ${mcpUrl} \\
  --header "Authorization: Bearer YOUR_TOKEN"`}
            </pre>
            <p className="text-sm text-muted">Or add it by hand to your Claude Code config:</p>
            <pre className="overflow-auto rounded-[10px] border border-border bg-surface-2 p-3 text-[12.5px] leading-relaxed">
{`{
  "mcpServers": {
    "karos": {
      "type": "http",
      "url": "${mcpUrl}",
      "headers": { "Authorization": "Bearer YOUR_TOKEN" }
    }
  }
}`}
            </pre>
          </Card>

          <Card className="space-y-3">
            <CardTitle>3. Build agents by chatting</CardTitle>
            <p className="text-sm text-muted">Once connected, just talk to Claude Code. For example:</p>
            <blockquote className="rounded-[10px] border-l-2 border-neon bg-neon-soft/40 px-4 py-3 text-sm">
              “Draft an Instagram agent for <em>Acme Co</em> focused on their summer launch. Test-run it,
              read the captions, tighten the system prompt until the hooks are punchy, then publish it.”
            </blockquote>
            <p className="text-sm text-muted">
              Claude Code will list your clients, create a draft, run sandboxed tests (nothing is emailed
              or saved), iterate on the prompt, and publish when you&apos;re happy.
            </p>
          </Card>
        </div>

        <div className="space-y-6">
          <Card className="space-y-3">
            <CardTitle>Available tools</CardTitle>
            {[
              ["list_clients", "Your clients (id, name, brand voice)"],
              ["list_agents", "Existing agents — drafts and live"],
              ["get_agent", "Full config of one agent"],
              ["create_agent", "Create a new draft agent"],
              ["update_agent", "Edit a draft's prompt / fields / capabilities"],
              ["test_run_agent", "Sandboxed run — no email, no saved assets"],
              ["publish_agent", "Make a draft live & runnable"],
            ].map(([name, hint]) => (
              <div key={name} className="flex items-start gap-2">
                <Icon name="Wrench" className="mt-0.5 h-3.5 w-3.5 shrink-0 text-neon" />
                <div>
                  <code className="text-xs text-foreground">{name}</code>
                  <p className="text-xs text-muted-2">{hint}</p>
                </div>
              </div>
            ))}
          </Card>
        </div>
      </div>
    </>
  );
}
