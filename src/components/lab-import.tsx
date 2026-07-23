"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Badge, Button, EmptyState, Spinner } from "@/components/ui";
import { Icon } from "@/components/icon";
import { AgentMark } from "@/components/agent-identity";
import { Modal } from "@/components/modal";
import { importLabRunAction, listLabOutputRunsAction } from "@/lib/actions";
import { cn } from "@/lib/utils";

interface RunRow {
  agentFolder: string;
  runName: string;
  hasClientFolder: boolean;
}

/** Fallback lucide icon per lab agent folder — AgentMark resolves the real platform logos first. */
function runVisual(agentFolder: string): { icon: string } {
  const f = agentFolder.toLowerCase();
  if (f.includes("instagram") || f.includes("tiktok")) return { icon: "Camera" };
  if (f.includes("newsletter") || f.includes("email")) return { icon: "Mail" };
  if (f.includes("blog") || f.includes("seo")) return { icon: "PenLine" };
  if (f.includes("landing")) return { icon: "LayoutTemplate" };
  return { icon: "FolderDown" };
}

/**
 * Staff-only: import a lab run's committed client/ deliverables
 * (karos-agents → clients/<slug>/outputs/<agent>/<run>/client) into the
 * platform as draft assets for review.
 */
export function LabImportButton({ clientId }: { clientId: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [runs, setRuns] = useState<RunRow[] | null>(null);
  const [importedKeys, setImportedKeys] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [importing, setImporting] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string, string>>({});
  const [, startTransition] = useTransition();

  function openModal() {
    setOpen(true);
    setError(null);
    if (runs === null && !loading) {
      setLoading(true);
      startTransition(async () => {
        const res = await listLabOutputRunsAction(clientId);
        if (res.error) setError(res.error);
        setRuns(res.runs ?? []);
        setImportedKeys(new Set(res.importedRunKeys ?? []));
        setLoading(false);
      });
    }
  }

  function importRun(run: RunRow) {
    const key = `${run.agentFolder}/${run.runName}`;
    setImporting(key);
    setError(null);
    startTransition(async () => {
      const res = await importLabRunAction({ clientId, agentFolder: run.agentFolder, runName: run.runName });
      if (res.error) {
        setResults((r) => ({ ...r, [key]: `✕ ${res.error}` }));
      } else {
        setResults((r) => ({
          ...r,
          [key]: `${res.created} imported${res.skipped ? `, ${res.skipped} already present` : ""}`,
        }));
        setImportedKeys((s) => new Set(s).add(key));
        router.refresh();
      }
      setImporting(null);
    });
  }

  return (
    <>
      <Button size="sm" variant="subtle" onClick={openModal}>
        <Icon name="FolderDown" className="h-3.5 w-3.5" /> Import lab outputs
      </Button>

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Import lab outputs"
        description="Deliverables produced in the karos-agents lab. Importing creates draft assets for review."
        className="max-w-xl"
      >
        <div className="mt-4">
          {loading && (
            <div className="flex items-center gap-2 py-8 text-sm text-muted">
              <Spinner className="h-4 w-4" /> Reading the lab repo…
            </div>
          )}
          {error && !loading && <p className="mb-3 text-xs text-danger">{error}</p>}
          {!loading && runs !== null && runs.length === 0 && !error && (
            <EmptyState
              icon={<Icon name="FolderOpen" className="h-6 w-6" />}
              title="No lab runs found"
              description="This client has no committed runs under its outputs folder in karos-agents."
            />
          )}
          {!loading && runs !== null && runs.length > 0 && (
            <div className="max-h-[420px] space-y-1 overflow-y-auto">
              {runs.map((run) => {
                const key = `${run.agentFolder}/${run.runName}`;
                const visual = runVisual(run.agentFolder);
                const imported = importedKeys.has(key);
                const result = results[key];
                return (
                  <div
                    key={key}
                    className={cn(
                      "flex items-center gap-3 rounded-md border border-border px-3 py-2.5",
                      !run.hasClientFolder && "opacity-60",
                    )}
                  >
                    <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-foreground/10 bg-foreground/[0.04] text-foreground/80">
                      <AgentMark identity={run.agentFolder} icon={visual.icon} className="h-4 w-4" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm">{run.runName}</p>
                      <p className="truncate text-xs text-muted-2">
                        {run.agentFolder}
                        {result && <span className="ml-1.5 text-muted">· {result}</span>}
                      </p>
                    </div>
                    {imported && <Badge tone="success">imported</Badge>}
                    {!run.hasClientFolder ? (
                      <Badge tone="neutral">no client files</Badge>
                    ) : (
                      <Button
                        size="sm"
                        variant={imported ? "ghost" : "subtle"}
                        disabled={importing !== null}
                        onClick={() => importRun(run)}
                      >
                        {importing === key ? (
                          <Spinner className="h-3.5 w-3.5" />
                        ) : (
                          <Icon name="Download" className="h-3.5 w-3.5" />
                        )}
                        {imported ? "Re-check" : "Import"}
                      </Button>
                    )}
                  </div>
                );
              })}
            </div>
          )}
          <p className="mt-3 text-xs text-muted-2">
            Files are copied into the platform&apos;s own storage; the lab repo is never modified.
          </p>
        </div>
      </Modal>
    </>
  );
}
