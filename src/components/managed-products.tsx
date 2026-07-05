"use client";

import { useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Badge, Button, Input, Label, Select, Textarea } from "@/components/ui";
import { Icon } from "@/components/icon";
import { Modal } from "@/components/modal";
import { JobStatusBadge } from "@/components/job-status";
import { submitManagedJobAction } from "@/lib/actions";
import {
  AGENT_SERVICE_AGENT_ID,
  MANAGED_PRODUCTS,
  getManagedProduct,
  type ManagedProduct,
} from "@/lib/agent-service/products";
import type { ContextItem, Job } from "@/lib/types";
import { cn, relativeTime } from "@/lib/utils";

/**
 * The "Managed products" section on a client's Agents page: one card per
 * lab product, a guided run dialog, and the client's managed-run history.
 */
export function ManagedProducts({
  clientId,
  contextItems,
  jobs,
}: {
  clientId: string;
  contextItems: ContextItem[];
  jobs: Job[];
}) {
  const [activeProduct, setActiveProduct] = useState<ManagedProduct | null>(null);

  const managedJobs = useMemo(
    () =>
      jobs
        .filter((j) => j.agentId === AGENT_SERVICE_AGENT_ID)
        .sort((a, b) => b.createdAt - a.createdAt),
    [jobs],
  );

  return (
    <section className="mt-10">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-xl text-foreground">Managed products</h2>
          <p className="mt-0.5 text-sm text-muted">
            Karos lab agents that research, produce, and deliver drafts for review.
          </p>
        </div>
        <Badge tone="neutral">{managedJobs.length} run{managedJobs.length !== 1 ? "s" : ""}</Badge>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        {MANAGED_PRODUCTS.map((product) => {
          const productJobs = managedJobs.filter((j) => j.external?.taskType === product.taskType);
          const lastRun = productJobs[0];
          return (
            <div
              key={product.taskType}
              className="card-grad flex flex-col rounded-[var(--radius)] border border-border p-4 transition-colors hover:border-border-strong"
            >
              <div className="flex items-start gap-3">
                <div
                  className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md"
                  style={{ background: product.color + "1f", color: product.color }}
                >
                  <Icon name={product.icon} className="h-5 w-5" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="font-medium">{product.name}</p>
                  <p className="mt-0.5 text-xs text-muted">{product.tagline}</p>
                </div>
              </div>

              <p className="mt-3 line-clamp-2 text-xs text-muted-2">
                Delivers: {product.deliverables.filter((d) => !d.includes("internal")).join(" · ")}
              </p>

              <div className="mt-auto flex items-center justify-between gap-2 pt-4">
                <p className="text-xs text-muted-2">
                  {product.estimate}
                  {productJobs.length > 0 && (
                    <span className="ml-1.5">
                      · {productJobs.length} run{productJobs.length !== 1 ? "s" : ""}
                      {lastRun && ` · last ${relativeTime(lastRun.createdAt)}`}
                    </span>
                  )}
                </p>
                <Button size="sm" variant="subtle" onClick={() => setActiveProduct(product)}>
                  <Icon name="Play" className="h-3.5 w-3.5" /> Run
                </Button>
              </div>
            </div>
          );
        })}
      </div>

      {managedJobs.length > 0 && (
        <div className="mt-6">
          <p className="mb-2 font-mono text-[10px] uppercase tracking-[0.08em] text-muted">
            Recent runs
          </p>
          <div className="overflow-hidden rounded-[var(--radius)] border border-border">
            {managedJobs.slice(0, 8).map((job, i) => {
              const product = job.external ? getManagedProduct(job.external.taskType) : null;
              return (
                <Link
                  key={job.id}
                  href={`/jobs/${job.id}`}
                  className={cn(
                    "flex items-center gap-3 px-4 py-2.5 transition-colors hover:bg-surface-2",
                    i > 0 && "border-t border-border",
                  )}
                >
                  <div
                    className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md"
                    style={
                      product
                        ? { background: product.color + "1f", color: product.color }
                        : { background: "var(--surface-3)" }
                    }
                  >
                    <Icon name={product?.icon ?? "Bot"} className="h-3.5 w-3.5" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm">{product?.name ?? job.agentName}</p>
                    <p className="text-xs text-muted-2">{relativeTime(job.createdAt)}</p>
                  </div>
                  {job.external?.totalCostUsd !== undefined && (
                    <span className="font-mono text-xs text-muted">
                      ${job.external.totalCostUsd.toFixed(2)}
                    </span>
                  )}
                  <JobStatusBadge status={job.status} />
                  <Icon name="ChevronRight" className="h-4 w-4 shrink-0 text-muted-2" />
                </Link>
              );
            })}
          </div>
        </div>
      )}

      {activeProduct && (
        <RunProductModal
          product={activeProduct}
          clientId={clientId}
          contextItems={contextItems}
          onClose={() => setActiveProduct(null)}
        />
      )}
    </section>
  );
}

/* ── Run dialog ──────────────────────────────────────────────────────── */

function RunProductModal({
  product,
  clientId,
  contextItems,
  onClose,
}: {
  product: ManagedProduct;
  clientId: string;
  contextItems: ContextItem[];
  onClose: () => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [fields, setFields] = useState<Record<string, string>>({});
  const [notes, setNotes] = useState("");
  const [selectedFiles, setSelectedFiles] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  const set = (key: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) =>
    setFields((f) => ({ ...f, [key]: e.target.value }));

  function buildBrief(): Record<string, unknown> {
    const brief: Record<string, unknown> = {};
    for (const field of product.briefFields) {
      const raw = fields[field.key]?.trim();
      if (!raw) continue;
      if (field.type === "number") brief[field.key] = Number(raw);
      else if (field.key === "must_include") brief[field.key] = raw.split("\n").map((l) => l.trim()).filter(Boolean);
      else brief[field.key] = raw;
    }
    if (notes.trim()) brief.notes = notes.trim();
    return brief;
  }

  function submit() {
    setError(null);
    const missing = product.briefFields.find((f) => f.required && !fields[f.key]?.trim());
    if (missing) {
      setError(`${missing.label} is required.`);
      return;
    }
    startTransition(async () => {
      const result = await submitManagedJobAction({
        clientId,
        taskType: product.taskType,
        brief: buildBrief(),
        contextItemIds: selectedFiles,
      });
      if (result.error) {
        setError(result.error);
        return;
      }
      if (result.jobId) router.push(`/jobs/${result.jobId}`);
    });
  }

  return (
    <Modal open onClose={onClose} title={product.name} description={product.description}>
      <div className="mt-4 space-y-4">
        <div className="rounded-md border border-border bg-surface-2 px-3 py-2.5">
          <p className="font-mono text-[10px] uppercase tracking-[0.08em] text-muted">You get</p>
          <ul className="mt-1 space-y-0.5">
            {product.deliverables.map((d) => (
              <li key={d} className="flex items-center gap-1.5 text-xs text-foreground">
                <Icon name="Check" className="h-3 w-3 shrink-0 text-success" /> {d}
              </li>
            ))}
          </ul>
        </div>

        {product.briefFields.map((field) => (
          <div key={field.key}>
            <Label htmlFor={`mp-${field.key}`}>
              {field.label}
              {field.required && <span className="ml-1 text-danger">*</span>}
            </Label>
            {field.type === "select" ? (
              <Select id={`mp-${field.key}`} value={fields[field.key] ?? field.options?.[0]?.value} onChange={set(field.key)}>
                {field.options?.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </Select>
            ) : field.type === "textarea" ? (
              <Textarea
                id={`mp-${field.key}`}
                rows={3}
                placeholder={field.placeholder}
                value={fields[field.key] ?? ""}
                onChange={set(field.key)}
              />
            ) : (
              <Input
                id={`mp-${field.key}`}
                type={field.type === "number" ? "number" : "text"}
                min={field.min}
                max={field.max}
                placeholder={field.placeholder}
                value={fields[field.key] ?? ""}
                onChange={set(field.key)}
              />
            )}
            {field.helper && <p className="mt-1 text-xs text-muted-2">{field.helper}</p>}
          </div>
        ))}

        <div>
          <Label htmlFor="mp-notes">Notes for the agent</Label>
          <Textarea
            id="mp-notes"
            rows={2}
            placeholder="Anything else the agent should know — optional"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
        </div>

        {contextItems.length > 0 && (
          <div>
            <Label>Attach input files</Label>
            <div className="max-h-36 space-y-1 overflow-y-auto rounded-md border border-border p-2">
              {contextItems.map((item) => (
                <label
                  key={item.id}
                  className="flex cursor-pointer items-center gap-2 rounded px-1 py-0.5 text-xs hover:bg-surface-2"
                >
                  <input
                    type="checkbox"
                    checked={selectedFiles.includes(item.id)}
                    onChange={() =>
                      setSelectedFiles((ids) =>
                        ids.includes(item.id) ? ids.filter((x) => x !== item.id) : [...ids, item.id],
                      )
                    }
                    className="accent-neon"
                  />
                  <Icon name={item.kind === "image" ? "Image" : "FileText"} className="h-3.5 w-3.5 text-muted-2" />
                  <span className="truncate">{item.name}</span>
                  {item.note && <span className="truncate text-muted-2">— {item.note}</span>}
                </label>
              ))}
            </div>
            <p className="mt-1 text-xs text-muted-2">The agent reads these as inputs (photos, briefs, docs).</p>
          </div>
        )}

        {error && <p className="text-xs text-danger">{error}</p>}

        <div className="flex items-center justify-between gap-3 pt-1">
          <p className="text-xs text-muted-2">
            <Icon name="Clock" className="mr-1 inline h-3 w-3" />
            {product.estimate} — you can leave this page; the run continues.
          </p>
          <Button variant="accent" onClick={submit} loading={pending}>
            {pending ? "Starting…" : "Start run"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
