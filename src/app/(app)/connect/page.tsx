import { headers } from "next/headers";
import { requireUser } from "@/lib/auth";
import { listAccessTokens } from "@/lib/data";
import { PageHeader, Card, CardTitle } from "@/components/ui";
import { Icon } from "@/components/icon";
import { TokenManager } from "@/components/token-manager";

export default async function ConnectPage() {
  const user = await requireUser(["KAROS_ADMIN", "KAROS_EMPLOYEE"]);
  const [tokens, h] = await Promise.all([listAccessTokens(user.uid), headers()]);

  const host = h.get("host") ?? "localhost:3000";
  const proto = h.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  const mcpUrl = `${proto}://${host}/api/mcp`;

  return (
    <>
      <PageHeader
        title="Connect Claude Code"
        description="Drive Karos from your own terminal. Karos exposes an MCP server your Claude Code can use to read client data, browse jobs & assets, run repo agents, and upload files."
      />

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
        <div className="space-y-6">
          <Card className="space-y-4">
            <CardTitle>1. Create a personal access token</CardTitle>
            <p className="text-sm text-muted">
              Claude Code authenticates with a bearer token tied to your account. It acts as you,
              with the same permissions you have in the app. Keep it secret; revoke it anytime.
            </p>
            <TokenManager tokens={tokens} mcpUrl={mcpUrl} />
          </Card>

          <Card className="space-y-4">
            <CardTitle>2. Add the server to Claude Code</CardTitle>
            <p className="text-sm text-muted">
              Run this in any project (replace <code className="text-neon">YOUR_TOKEN</code> with the token above):
            </p>
            <pre className="overflow-auto rounded-md border border-border bg-surface-2 p-3 text-[12.5px] leading-relaxed">
{`claude mcp add --transport http karos \\
  ${mcpUrl} \\
  --header "Authorization: Bearer YOUR_TOKEN"`}
            </pre>
            <p className="text-sm text-muted">Or add it by hand to your Claude Code config:</p>
            <pre className="overflow-auto rounded-md border border-border bg-surface-2 p-3 text-[12.5px] leading-relaxed">
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
            <CardTitle>3. Work by chatting</CardTitle>
            <p className="text-sm text-muted">Once connected, just talk to Claude Code. For example:</p>
            <blockquote className="rounded-md border-l-2 border-neon bg-neon-soft/40 px-4 py-3 text-sm">
              “Pull <em>Acme Co</em>&apos;s brand voice and recent assets, then run their content agent
              with a prompt for three Instagram posts about the summer launch, and tell me the job id.”
            </blockquote>
            <p className="text-sm text-muted">
              Claude Code will read the client&apos;s context, start the repo agent through the agent
              service, and you can poll it; results land in Jobs and Assets for review as usual.
              Running an agent is the only thing the server starts — the catalog products run from
              the client&apos;s own task board, not over MCP.
            </p>
          </Card>
        </div>

        <div className="space-y-6">
          <Card className="space-y-3">
            <CardTitle>Available tools</CardTitle>
            {[
              ["list_clients", "Clients you can access"],
              ["get_client", "Full profile & brand voice"],
              ["list_client_context", "Files & images attached to a client"],
              ["get_client_context_docs", "Brand/strategy/audience docs"],
              ["list_assets / get_asset", "Generated content, with bodies"],
              ["list_jobs / get_job", "Agent runs & their status"],
              ["list_agents", "Repo agents you can run"],
              ["run_agent", "Run a repo agent for a client with a prompt"],
              ["upload_context_file", "Attach a reference file/image"],
              ["upload_asset", "Save a generated asset (draft)"],
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
