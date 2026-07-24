"use client";

import { useRef, useState, useMemo, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Card, Badge, Button, Input, Textarea, Label } from "@/components/ui";
import { Modal } from "@/components/modal";
import { Icon } from "@/components/icon";
import { updateClientAction, deleteClientAction } from "@/lib/actions";
import { cn } from "@/lib/utils";
import { BrandFavicon } from "@/components/brand-favicon";
import type { Asset, Client, Job } from "@/lib/types";

/* ── Client avatar: logo or initials fallback ────────────────────────── */

function ClientAvatar({ client }: { client: Client }) {
  return (
    <BrandFavicon
      src={client.logoUrl || client.brandingGuidelines?.logoUrl}
      website={client.website}
      name={client.name}
      accentColor={client.accentColor ?? "#FF6B2C"}
      faviconSize={128}
      className="h-11 w-11 rounded-md text-sm"
      imgClassName="border border-border bg-surface-2 object-contain p-1"
    />
  );
}

/* ── Edit client modal ───────────────────────────────────────────────── */

function EditClientModal({
  client,
  open,
  onClose,
}: {
  client: Client;
  open: boolean;
  onClose: () => void;
}) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({
    name: client.name ?? "",
    website: client.website ?? "",
    industry: client.industry ?? "",
    contactEmail: client.contactEmail ?? "",
    domains: (client.domains ?? []).join(", "),
    description: client.description ?? "",
    brandVoice: client.brandVoice ?? "",
    agentsRepoSlug: client.agentsRepoSlug ?? "",
  });

  // Logo — uploaded/removed immediately via the logo API route (client already exists).
  const [logoUrl, setLogoUrl] = useState(client.logoUrl ?? "");
  const [logoFileName, setLogoFileName] = useState<string | null>(null);
  const [logoUploading, setLogoUploading] = useState(false);
  const [logoRemoving, setLogoRemoving] = useState(false);
  const [logoError, setLogoError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  function set(k: keyof typeof form, v: string) {
    setForm((s) => ({ ...s, [k]: v }));
  }

  async function handleLogoUpload(file: File) {
    if (logoUploading) return;
    setLogoUploading(true);
    setLogoError(null);
    try {
      const body = new FormData();
      body.append("file", file);
      const res = await fetch(`/api/clients/${client.id}/logo`, { method: "POST", body });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error ?? "Upload failed");
      }
      const { url } = (await res.json()) as { url: string };
      setLogoUrl(url);
      setLogoFileName(file.name);
      router.refresh();
    } catch (e) {
      setLogoError(e instanceof Error ? e.message : "Logo upload failed");
    } finally {
      setLogoUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  async function removeLogo() {
    if (logoRemoving) return;
    setLogoRemoving(true);
    setLogoError(null);
    try {
      const res = await fetch(`/api/clients/${client.id}/logo`, { method: "DELETE" });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error ?? "Could not remove logo");
      }
      setLogoUrl("");
      setLogoFileName(null);
      router.refresh();
    } catch (e) {
      setLogoError(e instanceof Error ? e.message : "Could not remove logo");
    } finally {
      setLogoRemoving(false);
    }
  }

  async function submit() {
    setError(null);
    if (!form.name.trim()) return setError("Client name is required.");
    setLoading(true);
    try {
      await updateClientAction(client.id, {
        name: form.name.trim(),
        website: form.website.trim(),
        industry: form.industry.trim(),
        contactEmail: form.contactEmail.trim().toLowerCase(),
        domainsCsv: form.domains,
        description: form.description.trim(),
        brandVoice: form.brandVoice.trim(),
        agentsRepoSlug: form.agentsRepoSlug.trim().toLowerCase(),
      });
      onClose();
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save changes");
      setLoading(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Edit client"
      description="Update this client's details."
    >
      <div className="space-y-3">
        <div>
          <Label>Brand logo</Label>
          {logoUrl ? (
            <div className="flex items-center gap-3 rounded-[10px] border border-border bg-surface-2 p-3">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-[6px] border border-border bg-white p-1">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={logoUrl}
                  alt="Brand logo"
                  className="h-full w-full object-contain"
                  onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
                />
              </div>
              <p className="min-w-0 flex-1 truncate text-xs font-medium">{logoFileName ?? "Logo uploaded"}</p>
              <div className="flex shrink-0 gap-1.5">
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={logoUploading || logoRemoving}
                  className="rounded-[6px] border border-border px-2.5 py-1.5 text-xs font-medium transition-colors hover:border-neon/50 hover:text-neon disabled:pointer-events-none disabled:opacity-50"
                >
                  Change
                </button>
                <button
                  type="button"
                  onClick={removeLogo}
                  disabled={logoUploading || logoRemoving}
                  className="flex items-center justify-center rounded-[6px] border border-border p-1.5 text-muted-2 transition-colors hover:border-danger/50 hover:text-danger disabled:pointer-events-none disabled:opacity-50"
                  aria-label="Remove logo"
                >
                  {logoRemoving ? (
                    <div className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />
                  ) : (
                    <Icon name="Trash2" className="h-3.5 w-3.5" />
                  )}
                </button>
              </div>
            </div>
          ) : (
            <div
              onClick={() => fileInputRef.current?.click()}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => e.key === "Enter" && fileInputRef.current?.click()}
              className={cn(
                "flex cursor-pointer flex-col items-center gap-1.5 rounded-[10px] border-2 border-dashed border-border py-4 text-center transition-colors hover:border-neon/40",
                logoUploading && "pointer-events-none opacity-60",
              )}
            >
              {logoUploading ? (
                <>
                  <div className="h-4 w-4 animate-spin rounded-full border-2 border-neon border-t-transparent" />
                  <span className="text-xs text-muted-2">Uploading…</span>
                </>
              ) : (
                <>
                  <Icon name="Upload" className="h-4 w-4 text-muted-2" />
                  <p className="text-xs text-muted-2">Click to upload · PNG, JPG, or SVG · max 4 MB</p>
                </>
              )}
            </div>
          )}
          <input
            ref={fileInputRef}
            type="file"
            accept="image/png,image/jpeg,image/svg+xml,.svg"
            className="sr-only"
            onChange={(e) => { if (e.target.files?.[0]) handleLogoUpload(e.target.files[0]); }}
          />
          {logoError && <p className="mt-1 text-xs text-danger">{logoError}</p>}
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <Label>Name *</Label>
            <Input value={form.name} onChange={(e) => set("name", e.target.value)} placeholder="Acme Co" />
          </div>
          <div>
            <Label>Industry</Label>
            <Input value={form.industry} onChange={(e) => set("industry", e.target.value)} placeholder="SaaS, retail…" />
          </div>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <Label>Website</Label>
            <Input value={form.website} onChange={(e) => set("website", e.target.value)} placeholder="acme.com" />
          </div>
          <div>
            <Label>Contact email</Label>
            <Input value={form.contactEmail} onChange={(e) => set("contactEmail", e.target.value)} placeholder="marketing@acme.com" />
          </div>
        </div>
        <div>
          <Label>Email domains (for auto-routing meetings)</Label>
          <Input value={form.domains} onChange={(e) => set("domains", e.target.value)} placeholder="acme.com, acmecorp.com" />
        </div>
        <div>
          <Label>Lab repo slug (karos-agents clients/ folder)</Label>
          <Input
            value={form.agentsRepoSlug}
            onChange={(e) => set("agentsRepoSlug", e.target.value)}
            placeholder="e.g. xodigital: links managed runs + lab imports to the client's lab folder"
          />
        </div>
        <div>
          <Label>About</Label>
          <Textarea
            value={form.description}
            onChange={(e) => set("description", e.target.value)}
            className="min-h-[60px]"
            placeholder="What does this client do?"
          />
        </div>
        <div>
          <Label>Brand voice</Label>
          <Textarea
            value={form.brandVoice}
            onChange={(e) => set("brandVoice", e.target.value)}
            placeholder="Tone, vocabulary, do's and don'ts. Agents use this to stay on-brand."
          />
        </div>
        {error && <p className="text-xs text-danger">{error}</p>}
        <Button className="w-full" loading={loading} onClick={submit}>
          Save changes
        </Button>
      </div>
    </Modal>
  );
}

/* ── Delete confirmation dialog ──────────────────────────────────────── */

function DeleteConfirmModal({
  client,
  open,
  onClose,
  onDeleted,
}: {
  client: Client;
  open: boolean;
  onClose: () => void;
  onDeleted: (clientId: string) => void;
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function confirm() {
    setError(null);
    startTransition(async () => {
      try {
        await deleteClientAction(client.id);
        onDeleted(client.id);
        onClose();
      } catch (e) {
        setError(e instanceof Error ? e.message : "Could not delete client");
      }
    });
  }

  return (
    <Modal open={open} onClose={onClose} title="Delete client">
      <div className="space-y-4">
        <div className="flex items-start gap-3 rounded-lg border border-danger/25 bg-danger/5 p-3.5">
          <Icon name="TriangleAlert" className="mt-0.5 h-4 w-4 shrink-0 text-danger" />
          <div className="text-sm text-foreground">
            <p className="font-medium">This action is irreversible.</p>
            <p className="mt-1 text-muted">
              Deleting <span className="font-semibold text-foreground">{client.name}</span> will
              permanently remove the client record. All associated jobs, assets, and context
              documents will become inaccessible.
            </p>
          </div>
        </div>
        {error && <p className="text-xs text-danger">{error}</p>}
        <div className="flex gap-2">
          <Button variant="outline" className="flex-1" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button
            variant="danger"
            className="flex-1"
            loading={pending}
            onClick={confirm}
          >
            Delete client
          </Button>
        </div>
      </div>
    </Modal>
  );
}

/* ── Clients grid ────────────────────────────────────────────────────── */

export function ClientsGrid({
  clients: initialClients,
  assets,
  jobs,
}: {
  clients: Client[];
  assets: Asset[];
  jobs: Job[];
}) {
  const [clients, setClients] = useState(initialClients);
  const [editTarget, setEditTarget] = useState<Client | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Client | null>(null);

  const assetCountByClient = useMemo(() => {
    const m = new Map<string, number>();
    for (const a of assets) m.set(a.clientId, (m.get(a.clientId) ?? 0) + 1);
    return m;
  }, [assets]);

  const jobCountByClient = useMemo(() => {
    const m = new Map<string, number>();
    for (const j of jobs) m.set(j.clientId, (m.get(j.clientId) ?? 0) + 1);
    return m;
  }, [jobs]);

  function handleDeleted(clientId: string) {
    setClients((prev) => prev.filter((c) => c.id !== clientId));
  }

  return (
    <>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {clients.map((c) => {
          const assetCount = assetCountByClient.get(c.id) ?? 0;
          const jobCount = jobCountByClient.get(c.id) ?? 0;
          return (
            <div key={c.id} className="group relative">
              <Link href={`/clients/${c.id}`}>
                <Card className="h-full hover:border-border-strong">
                  <div className="flex items-start justify-between">
                    <div className="flex items-center gap-3">
                      <ClientAvatar client={c} />
                      <div>
                        <p className="font-semibold">{c.name}</p>
                        <p className="text-xs text-muted-2">{c.industry || c.website || "-"}</p>
                      </div>
                    </div>
                    <Badge tone={c.status === "active" ? "neon" : "neutral"}>{c.status}</Badge>
                  </div>
                  <div className="mt-4 flex gap-4 text-xs text-muted">
                    <span className="flex items-center gap-1">
                      <Icon name="FolderOpen" className="h-3.5 w-3.5" /> {assetCount} assets
                    </span>
                    <span className="flex items-center gap-1">
                      <Icon name="ListChecks" className="h-3.5 w-3.5" /> {jobCount} jobs
                    </span>
                  </div>
                </Card>
              </Link>

              {/* Action buttons — revealed on card hover */}
              <div className="absolute right-2 top-2 flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                <button
                  onClick={() => setEditTarget(c)}
                  className="flex h-7 w-7 items-center justify-center rounded-md border border-border bg-surface text-muted-2 shadow-sm transition-colors hover:border-foreground/30 hover:text-foreground"
                  aria-label="Edit client"
                  title="Edit client"
                >
                  <Icon name="Pencil" className="h-3.5 w-3.5" />
                </button>
                <button
                  onClick={() => setDeleteTarget(c)}
                  className="flex h-7 w-7 items-center justify-center rounded-md border border-border bg-surface text-muted-2 shadow-sm transition-colors hover:border-danger/40 hover:text-danger"
                  aria-label="Delete client"
                  title="Delete client"
                >
                  <Icon name="Trash2" className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {editTarget && (
        <EditClientModal
          key={editTarget.id}
          client={editTarget}
          open={true}
          onClose={() => setEditTarget(null)}
        />
      )}

      {deleteTarget && (
        <DeleteConfirmModal
          key={deleteTarget.id}
          client={deleteTarget}
          open={true}
          onClose={() => setDeleteTarget(null)}
          onDeleted={handleDeleted}
        />
      )}
    </>
  );
}
