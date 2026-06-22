"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Card, Button, Badge, Label, Input, Textarea, Select } from "@/components/ui";
import { Modal } from "@/components/modal";
import { Icon } from "@/components/icon";
import { runAgentAction } from "@/lib/actions";
import { relativeTime } from "@/lib/utils";
import type { Agent, Client } from "@/lib/types";

/** A card for an in-development draft agent — links into the builder; no real runs. */
export function DraftAgentCard({ agent }: { agent: Agent }) {
  return (
    <Card className="flex flex-col hover:border-border-strong">
      <div className="flex items-start gap-3">
        <div
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-[12px] bg-neon-soft text-neon"
          style={agent.color ? { color: agent.color, background: agent.color + "1f" } : undefined}
        >
          <Icon name={agent.icon} className="h-5 w-5" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h3 className="truncate text-base font-semibold">{agent.name || "Untitled agent"}</h3>
            <Badge tone="warning">Draft</Badge>
          </div>
          <p className="mt-1 line-clamp-2 text-sm text-muted">{agent.description || "No description yet."}</p>
        </div>
      </div>

      <div className="mt-4 flex items-center justify-between gap-2 border-t border-border pt-4">
        <span className="text-xs text-muted-2">Edited {relativeTime(agent.updatedAt)}</span>
        <Link href={`/agents/${agent.id}`}>
          <Button size="sm" variant="outline">
            <Icon name="PencilRuler" className="h-4 w-4" />
            Continue editing
          </Button>
        </Link>
      </div>
    </Card>
  );
}

const CAP_LABEL: Record<string, string> = {
  generate: "Generates content",
  email_client: "Emails client",
  create_assets: "Saves assets",
  use_transcripts: "Uses meetings",
  use_brand_voice: "On-brand",
};

export function AgentCard({ agent, clients, canEdit }: { agent: Agent; clients: Client[]; canEdit: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <Card className="flex flex-col hover:border-border-strong">
      <div className="flex items-start gap-3">
        <div
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-[12px] bg-neon-soft text-neon"
          style={agent.color ? { color: agent.color, background: agent.color + "1f" } : undefined}
        >
          <Icon name={agent.icon} className="h-5 w-5" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h3 className="truncate text-base font-semibold">{agent.name}</h3>
            {!agent.isActive && <Badge tone="neutral">Paused</Badge>}
          </div>
          <p className="mt-1 line-clamp-2 text-sm text-muted">{agent.description}</p>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap gap-1.5">
        {agent.capabilities.map((c) => (
          <Badge key={c} tone="neutral">
            {CAP_LABEL[c] ?? c}
          </Badge>
        ))}
      </div>

      <div className="mt-4 flex items-center gap-2 border-t border-border pt-4">
        <Button size="sm" className="flex-1" onClick={() => setOpen(true)} disabled={!agent.isActive}>
          <Icon name="Play" className="h-4 w-4" />
          Run
        </Button>
        {canEdit && (
          <Link href={`/agents/${agent.id}`}>
            <Button size="sm" variant="outline">
              <Icon name="Settings2" className="h-4 w-4" />
            </Button>
          </Link>
        )}
      </div>

      <RunModal agent={agent} clients={clients} open={open} onClose={() => setOpen(false)} />
    </Card>
  );
}

export function RunModal({
  agent,
  clients,
  open,
  onClose,
}: {
  agent: Agent;
  clients: Client[];
  open: boolean;
  onClose: () => void;
}) {
  const router = useRouter();
  const [clientId, setClientId] = useState(clients[0]?.id ?? "");
  const [values, setValues] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ jobId: string; status: string } | null>(null);

  function set(key: string, v: string) {
    setValues((s) => ({ ...s, [key]: v }));
  }

  async function run() {
    setError(null);
    if (!clientId) {
      setError("Pick a client first.");
      return;
    }
    setLoading(true);
    try {
      const res = await runAgentAction({ agentId: agent.id, clientId, input: values });
      setDone(res);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Run failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title={`Run ${agent.name}`} description={agent.description}>
      {done ? (
        <div className="text-center">
          <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-neon-soft">
            <Icon name={done.status === "failed" ? "TriangleAlert" : "Rocket"} className={done.status === "failed" ? "h-6 w-6 text-danger" : "h-6 w-6 text-neon"} />
          </div>
          <p className="text-sm font-medium">
            {done.status === "failed" ? "Couldn’t start the run" : "Agent is running in the background"}
          </p>
          <p className="mt-1 text-sm text-muted">
            {done.status === "failed"
              ? "The job log has the details."
              : "Feel free to keep working — the job page updates as it goes, and emails the client when done."}
          </p>
          <div className="mt-4 flex justify-center gap-2">
            <Link href={`/jobs/${done.jobId}`}>
              <Button size="sm">{done.status === "failed" ? "View log" : "View progress"}</Button>
            </Link>
            <Button size="sm" variant="outline" onClick={() => { setDone(null); setValues({}); }}>
              Run another
            </Button>
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          <div>
            <Label>Client</Label>
            <Select value={clientId} onChange={(e) => setClientId(e.target.value)}>
              {clients.length === 0 && <option value="">No clients yet</option>}
              {clients.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          </div>

          {agent.fields.map((f) => (
            <div key={f.key}>
              <Label>
                {f.label}
                {f.required && <span className="text-danger"> *</span>}
              </Label>
              {f.type === "textarea" ? (
                <Textarea
                  placeholder={f.placeholder}
                  value={values[f.key] ?? f.defaultValue ?? ""}
                  onChange={(e) => set(f.key, e.target.value)}
                />
              ) : f.type === "select" ? (
                <Select value={values[f.key] ?? f.defaultValue ?? ""} onChange={(e) => set(f.key, e.target.value)}>
                  {(f.options ?? []).map((o) => (
                    <option key={o} value={o}>
                      {o}
                    </option>
                  ))}
                </Select>
              ) : (
                <Input
                  type={f.type === "number" ? "number" : "text"}
                  placeholder={f.placeholder}
                  value={values[f.key] ?? f.defaultValue ?? ""}
                  onChange={(e) => set(f.key, e.target.value)}
                />
              )}
            </div>
          ))}

          {agent.capabilities.includes("email_client") && (
            <p className="flex items-center gap-1.5 text-xs text-muted">
              <Icon name="Mail" className="h-3.5 w-3.5 text-neon" />
              Output will be emailed to the client&apos;s contact address.
            </p>
          )}

          {error && <p className="text-xs text-danger">{error}</p>}

          <Button className="w-full" loading={loading} onClick={run}>
            {loading ? "Starting…" : "Run agent"}
          </Button>
        </div>
      )}
    </Modal>
  );
}
