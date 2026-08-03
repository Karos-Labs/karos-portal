"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Card, CardTitle, Button, Input, Textarea, Label } from "@/components/ui";
import { Icon } from "@/components/icon";
import { CLIENT_CATEGORY_MAX_LENGTH, clientCategoryValue, cn } from "@/lib/utils";
import { updateClientAction } from "@/lib/actions";
import type { Client } from "@/lib/types";

export function ClientEditor({ client }: { client: Client }) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({
    name: client.name ?? "",
    contactEmail: client.contactEmail ?? "",
    website: client.website ?? "",
    // Same field, same prefill and same cap as the Clients-page dialog: this
    // card writes through the same staff action, and the action stopped taking
    // the legacy name.
    category: clientCategoryValue(client) ?? "",
    domainsCsv: (client.domains ?? []).join(", "),
    description: client.description ?? "",
    brandVoice: client.brandVoice ?? "",
  });

  // Logo state - managed independently (API route writes directly to DB)
  const [logoUrl, setLogoUrl] = useState(client.logoUrl ?? "");
  const [logoFileName, setLogoFileName] = useState<string | null>(null);
  const [logoUploading, setLogoUploading] = useState(false);
  const [logoRemoving, setLogoRemoving] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [logoError, setLogoError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  function set(k: keyof typeof form, v: string) {
    setForm((s) => ({ ...s, [k]: v }));
  }

  async function handleFileUpload(file: File) {
    if (logoUploading) return;
    setLogoUploading(true);
    setLogoError(null);
    try {
      const body = new FormData();
      body.append("file", file);
      const res = await fetch(`/api/clients/${client.id}/logo`, { method: "POST", body });
      if (!res.ok) {
        const j = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(j.error ?? "Upload failed");
      }
      const { url } = await res.json() as { url: string };
      setLogoUrl(url);
      setLogoFileName(file.name);
    } catch (e) {
      setLogoError(e instanceof Error ? e.message : "Logo upload failed");
    } finally {
      setLogoUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    setIsDragging(false);
    const file = e.dataTransfer.files[0];
    if (file) handleFileUpload(file);
  }

  async function removeLogo() {
    if (logoRemoving) return;
    setLogoRemoving(true);
    setLogoError(null);
    try {
      const res = await fetch(`/api/clients/${client.id}/logo`, { method: "DELETE" });
      if (!res.ok) {
        const j = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(j.error ?? "Could not remove logo");
      }
      setLogoUrl("");
      setLogoFileName(null);
    } catch (e) {
      setLogoError(e instanceof Error ? e.message : "Could not remove logo");
    } finally {
      setLogoRemoving(false);
    }
  }

  async function save() {
    setSaving(true);
    try {
      await updateClientAction(client.id, form);
      setEditing(false);
      router.refresh();
    } finally {
      setSaving(false);
    }
  }

  /* ── View mode ───────────────────────────────────────────────────────── */
  if (!editing) {
    return (
      <Card className="space-y-4">
        <div className="flex items-center justify-between">
          <CardTitle>Brand profile</CardTitle>
          <Button size="sm" variant="outline" onClick={() => setEditing(true)}>
            <Icon name="Pencil" className="h-3.5 w-3.5" />
            Edit
          </Button>
        </div>

        {/* Logo preview */}
        {logoUrl && (
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-[6px] border border-border bg-white p-1">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={logoUrl}
                alt="Brand logo"
                className="h-full w-full object-contain"
                onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
              />
            </div>
            <p className="text-xs text-muted-2">Brand logo</p>
          </div>
        )}

        <Field label="Company name" value={client.name} />
        <Field label="Brand voice" value={client.brandVoice} multiline />
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Contact email" value={client.contactEmail} />
          <Field label="Website" value={client.website} />
          <Field label="Category" value={clientCategoryValue(client) ?? undefined} />
          <Field label="Meeting domains" value={(client.domains ?? []).join(", ")} />
        </div>
        <Field label="About" value={client.description} multiline />
      </Card>
    );
  }

  /* ── Edit mode ───────────────────────────────────────────────────────── */
  return (
    <Card className="space-y-4">
      <CardTitle>Edit brand profile</CardTitle>

      {/* Logo upload */}
      <div>
        <Label>Brand logo</Label>
        <p className="mb-2 text-[10px] text-muted-2">
          PNG, JPG, or SVG · max 4 MB. AI uses the logo pixels to extract authentic brand colors.
        </p>

        {logoUrl ? (
          /* Preview */
          <div className="flex items-center gap-3 rounded-[10px] border border-border bg-surface-2 p-3">
            <div className="flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-[6px] border border-border bg-white p-1">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={logoUrl}
                alt="Brand logo"
                className="h-full w-full object-contain"
                onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
              />
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-xs font-medium">{logoFileName ?? "Logo uploaded"}</p>
              <p className="text-[10px] text-muted-2">Used for AI color extraction</p>
            </div>
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
          /* Drop zone */
          <div
            className={cn(
              "flex cursor-pointer flex-col items-center gap-2 rounded-[10px] border-2 border-dashed py-6 text-center transition-colors",
              isDragging ? "border-neon bg-neon/5" : "border-border hover:border-neon/40",
              logoUploading && "pointer-events-none opacity-60",
            )}
            onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
            onDragLeave={() => setIsDragging(false)}
            onDrop={handleDrop}
            onClick={() => fileInputRef.current?.click()}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => e.key === "Enter" && fileInputRef.current?.click()}
          >
            {logoUploading ? (
              <>
                <div className="h-5 w-5 animate-spin rounded-full border-2 border-neon border-t-transparent" />
                <span className="text-xs text-muted-2">Uploading…</span>
              </>
            ) : (
              <>
                <Icon name="Upload" className="h-5 w-5 text-muted-2" />
                <div>
                  <p className="text-sm font-medium">Click or drag to upload</p>
                  <p className="text-xs text-muted-2">PNG, JPG, or SVG · max 4 MB</p>
                </div>
              </>
            )}
          </div>
        )}

        <input
          ref={fileInputRef}
          type="file"
          accept="image/png,image/jpeg,image/svg+xml,.svg"
          className="sr-only"
          onChange={(e) => { if (e.target.files?.[0]) handleFileUpload(e.target.files[0]); }}
        />
        {logoError && <p className="mt-1 text-xs text-danger">{logoError}</p>}
      </div>

      <div>
        <Label>Company name</Label>
        <Input value={form.name} onChange={(e) => set("name", e.target.value)} />
      </div>
      <div>
        <Label>Brand voice</Label>
        <Textarea value={form.brandVoice} onChange={(e) => set("brandVoice", e.target.value)} className="min-h-[120px]" placeholder="Tone, vocabulary, rules…" />
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <Label>Contact email</Label>
          <Input value={form.contactEmail} onChange={(e) => set("contactEmail", e.target.value)} />
        </div>
        <div>
          <Label>Website</Label>
          <Input value={form.website} onChange={(e) => set("website", e.target.value)} />
        </div>
        <div>
          <Label>Category</Label>
          <Input
            value={form.category}
            onChange={(e) => set("category", e.target.value)}
            maxLength={CLIENT_CATEGORY_MAX_LENGTH}
          />
        </div>
        <div>
          <Label>Meeting domains (csv)</Label>
          <Input value={form.domainsCsv} onChange={(e) => set("domainsCsv", e.target.value)} />
        </div>
      </div>
      <div>
        <Label>About</Label>
        <Textarea value={form.description} onChange={(e) => set("description", e.target.value)} className="min-h-[60px]" />
      </div>
      <div className="flex gap-2">
        <Button onClick={save} loading={saving}>Save</Button>
        <Button variant="ghost" onClick={() => setEditing(false)}>Cancel</Button>
      </div>
    </Card>
  );
}

function Field({ label, value, multiline }: { label: string; value?: string; multiline?: boolean }) {
  return (
    <div>
      <p className="text-xs text-muted">{label}</p>
      <p className={`mt-0.5 text-sm ${multiline ? "whitespace-pre-wrap" : ""} ${value ? "text-foreground" : "text-muted-2"}`}>
        {value || "-"}
      </p>
    </div>
  );
}
