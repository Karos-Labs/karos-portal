import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { listClients } from "@/lib/data";
import { isLabOutputsConfigured } from "@/lib/lab-outputs";
import { isOpsInboxConfigured, listInboxBundles, opsInboxDir } from "@/lib/ops-inbox";
import { Badge, Card, CardTitle, EmptyState, PageHeader } from "@/components/ui";
import { Icon } from "@/components/icon";
import { LabImportButton } from "@/components/lab-import";
import { OpsImport } from "@/components/ops-import";

/**
 * Ops Import (admin only) — land work produced locally into the live portal.
 *
 * Two halves, deliberately different mechanisms:
 *
 *   · Docs / competitors / profile / palette / SEO-GEO come from the ops inbox
 *     (OPS_IMPORT_DIR), through the same validation core the CLI uses.
 *   · POSTS reuse the EXISTING lab-outputs importer rather than a second
 *     implementation. That flow already reads the committed karos-agents run
 *     outputs and creates draft assets through the same createAsset path the
 *     agent-service webhook uses, with per-item idempotency and the one-post/day
 *     chain reflow. Reimplementing it against the inbox would have forked the
 *     asset writer — the one thing this page must not do.
 *
 * Runbook: docs/qa-sweep-2026-07/refresh/OPS-IMPORT.md
 */
export default async function OpsImportPage() {
  const user = await requireUser();
  if (user.role !== "KAROS_ADMIN") redirect("/dashboard");

  const inboxReady = isOpsInboxConfigured();
  const [bundles, clients] = await Promise.all([
    inboxReady ? listInboxBundles() : Promise.resolve([]),
    listClients(),
  ]);

  const labReady = isLabOutputsConfigured();
  const labClients = clients
    .filter((c) => typeof c.agentsRepoSlug === "string" && c.agentsRepoSlug.trim() !== "")
    .sort((a, b) => a.name.localeCompare(b.name));

  return (
    <div>
      <PageHeader
        title="Ops Import"
        description="Land locally-produced updates in the live portal. Every bundle is reviewed as a diff before anything is written."
      />

      <section className="mb-8">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-medium">Docs, competitors, profile &amp; SEO/GEO</h2>
          {inboxReady && <Badge tone="neutral">{bundles.length} in inbox</Badge>}
        </div>

        {!inboxReady ? (
          <Card className="p-5">
            <CardTitle>The ops inbox is not configured</CardTitle>
            <p className="mt-2 text-sm text-muted">
              Set <code className="font-mono text-xs text-foreground">OPS_IMPORT_DIR</code> to an absolute path on the
              server and restart. The importer only reads from it — it never writes to or empties the folder.
            </p>
            <div className="mt-3 rounded-md border border-border bg-surface-2 px-3.5 py-3 font-mono text-[11px] leading-relaxed text-muted">
              <div>&lt;inbox&gt;/&lt;anything&gt;.json — one refresh proposal per client</div>
              <div>&lt;inbox&gt;/seo-geo/&lt;clientId&gt;.json — one SEO/GEO capture per client</div>
            </div>
            <p className="mt-3 text-xs text-muted-2">
              Posts are not read from the inbox — they come from the lab repo, below.
            </p>
          </Card>
        ) : (
          <>
            <p className="mb-3 font-mono text-[11px] text-muted-2">{opsInboxDir()}</p>
            <OpsImport bundles={bundles} />
          </>
        )}
      </section>

      <section>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-medium">Posts &amp; assets from locally-run agents</h2>
          {labReady && <Badge tone="neutral">{labClients.length} clients wired</Badge>}
        </div>
        <p className="mb-3 text-xs text-muted">
          Imports the committed <code className="font-mono">client/</code> deliverables from a lab run. Everything lands
          as a <strong>draft</strong> for staff review — a client never sees an imported post until it is approved.
        </p>

        {!labReady ? (
          <Card className="p-5">
            <CardTitle>Lab imports are not configured</CardTitle>
            <p className="mt-2 text-sm text-muted">
              Set <code className="font-mono text-xs text-foreground">AGENTS_REPO_GITHUB_TOKEN</code> to a token with
              read access to the agents repo.
            </p>
          </Card>
        ) : labClients.length === 0 ? (
          <EmptyState
            icon={<Icon name="FolderOpen" className="h-6 w-6" />}
            title="No client has a lab repo slug"
            description="Set a client's Lab repo slug in its Edit dialog to import that client's runs here."
          />
        ) : (
          <div className="space-y-1">
            {labClients.map((c) => (
              <div
                key={c.id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border px-3.5 py-2.5"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm">{c.name}</p>
                  <p className="truncate font-mono text-[11px] text-muted-2">{c.agentsRepoSlug}</p>
                </div>
                <LabImportButton clientId={c.id} />
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
