import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { listClients } from "@/lib/data";
import { isLabOutputsConfigured, labRepoName } from "@/lib/lab-outputs";
import { isOpsInboxConfigured, listInboxBundles, opsInboxDir } from "@/lib/ops-inbox";
import { findPriorImports } from "@/lib/ops-import-history";
import { Badge, Card, CardTitle, EmptyState, PageHeader } from "@/components/ui";
import { Icon } from "@/components/icon";
import { LabImportButton } from "@/components/lab-import";
import { OpsImport } from "@/components/ops-import";

/**
 * Ops Import (admin only) - land work produced locally into the live portal.
 *
 * Two discovery sources for proposals, one write path:
 *   · the karos-agents lab repo (clients/<slug>/refresh/*.json), scanned by
 *     "Check for updates";
 *   · the server's ops inbox (OPS_IMPORT_DIR), read at page load.
 * Both render identical plan cards through src/lib/refresh-apply-core.ts, the
 * same validator scripts/refresh-apply.ts uses.
 *
 * POSTS reuse the EXISTING lab-outputs importer rather than a second
 * implementation. That flow already reads the committed karos-agents run
 * outputs and creates draft assets through the same createAsset path the
 * agent-service webhook uses, with per-item idempotency and the one-post/day
 * chain reflow. Reimplementing it here would have forked the asset writer -
 * the one thing this page must not do.
 *
 * Runbook: docs/qa-sweep-2026-07/refresh/OPS-IMPORT.md
 */
export default async function OpsImportPage() {
  const user = await requireUser();
  if (user.role !== "KAROS_ADMIN") redirect("/dashboard");

  const inboxReady = isOpsInboxConfigured();
  const [rawBundles, clients] = await Promise.all([
    inboxReady ? listInboxBundles() : Promise.resolve([]),
    listClients(),
  ]);

  // Which of these have been imported before, read back from the activity log.
  // Without this an imported bundle is indistinguishable from a never-imported
  // one, which is what made Albert ask why Karos Labs was not listed.
  const history = await findPriorImports(
    rawBundles
      .filter((b) => b.clientId && b.fingerprint)
      .map((b) => ({ clientId: b.clientId!, origin: "inbox", ref: b.file, fingerprint: b.fingerprint! })),
  );
  const bundles = rawBundles.map((b) => ({ ...b, priorImport: history.get(`inbox:${b.file}`) ?? null }));

  const labReady = isLabOutputsConfigured();
  const labClients = clients
    .filter((c) => typeof c.agentsRepoSlug === "string" && c.agentsRepoSlug.trim() !== "")
    .sort((a, b) => a.name.localeCompare(b.name));

  return (
    <div>
      <PageHeader
        title="Ops Import"
        description="Find locally-produced updates and land them in the live portal. Every bundle is reviewed as a diff before anything is written."
      />

      <ConfigStrip
        labReady={labReady}
        repo={labRepoName()}
        inboxDir={inboxReady ? opsInboxDir() : null}
        wiredClients={labClients.length}
      />

      <section className="mb-8">
        <h2 className="mb-3 text-sm font-medium">Docs, competitors, profile &amp; SEO/GEO</h2>
        <OpsImport bundles={bundles} />
      </section>

      <section>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-medium">Posts &amp; assets from locally-run agents</h2>
          {labReady && <Badge tone="neutral">{labClients.length} clients wired</Badge>}
        </div>
        <p className="mb-3 text-xs text-muted">
          Imports the committed <code className="font-mono">client/</code> deliverables from a lab run. Everything lands
          as a <strong>draft</strong> for staff review - a client never sees an imported post until it is approved.
          &ldquo;Check for updates&rdquo; above tells you which clients have runs you have not imported yet.
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

/**
 * What this page can and cannot reach, named by env var.
 *
 * Written because the AI Agents tab simply HIDES its "Import lab outputs"
 * button when AGENTS_REPO_GITHUB_TOKEN is missing - a missing feature looks
 * identical to a feature that was never built, and Albert lost time to exactly
 * that. A missing capability should say its own name.
 */
function ConfigStrip({
  labReady,
  repo,
  inboxDir,
  wiredClients,
}: {
  labReady: boolean;
  repo: string | null;
  inboxDir: string | null;
  wiredClients: number;
}) {
  return (
    <div className="mb-6 grid gap-2 @2xl:grid-cols-2">
      <ConfigRow
        ok={labReady}
        env="AGENTS_REPO_GITHUB_TOKEN"
        label="Lab repo"
        detail={
          labReady
            ? `${repo} · ${wiredClients} client${wiredClients === 1 ? "" : "s"} with a lab slug`
            : "Unset - Check for updates cannot scan, and the per-client “Import lab outputs” button is hidden everywhere in the app."
        }
      />
      <ConfigRow
        ok={inboxDir !== null}
        env="OPS_IMPORT_DIR"
        label="Ops inbox"
        detail={
          inboxDir ??
          "Unset - proposals dropped on the server are not read, and SEO/GEO snapshots cannot be imported. The lab-repo source still works."
        }
      />
    </div>
  );
}

function ConfigRow({
  ok,
  env,
  label,
  detail,
}: {
  ok: boolean;
  env: string;
  label: string;
  detail: string;
}) {
  return (
    <div className="flex items-start gap-2.5 rounded-lg border border-border bg-surface-2 px-3.5 py-2.5">
      <Icon
        name={ok ? "CircleCheck" : "CircleAlert"}
        className={ok ? "mt-0.5 h-4 w-4 shrink-0 text-success" : "mt-0.5 h-4 w-4 shrink-0 text-warning"}
      />
      <div className="min-w-0">
        <p className="text-xs font-medium">
          {label} <code className="ml-1 font-mono text-[10px] text-muted-2">{env}</code>
        </p>
        <p className="mt-0.5 break-words text-[11px] text-muted">{detail}</p>
      </div>
    </div>
  );
}
