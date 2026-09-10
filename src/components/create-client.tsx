"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Button, Input, Textarea, Label } from "@/components/ui";
import { Modal } from "@/components/modal";
import { Icon } from "@/components/icon";
import { createClientAction } from "@/lib/actions";
import { CLIENT_CATEGORY_MAX_LENGTH } from "@/lib/utils";

const LOGO_ACCEPT = "image/png,image/jpeg,image/svg+xml,.svg";
const MAX_LOGO_BYTES = 4 * 1024 * 1024;

export function CreateClientButton() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({
    name: "",
    website: "",
    category: "",
    contactEmail: "",
    domains: "",
    description: "",
    brandVoice: "",
  });

  const [logoFile, setLogoFile] = useState<File | null>(null);
  const [logoPreview, setLogoPreview] = useState<string | null>(null);
  const [logoError, setLogoError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  function set(k: keyof typeof form, v: string) {
    setForm((s) => ({ ...s, [k]: v }));
  }

  function pickLogo(file: File) {
    if (file.size > MAX_LOGO_BYTES) {
      setLogoError("Logo exceeds 4 MB.");
      return;
    }
    setLogoError(null);
    setLogoFile(file);
    setLogoPreview((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return URL.createObjectURL(file);
    });
  }

  function clearLogo() {
    setLogoPreview((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return null;
    });
    setLogoFile(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  function reset() {
    setForm({ name: "", website: "", category: "", contactEmail: "", domains: "", description: "", brandVoice: "" });
    clearLogo();
    setError(null);
    setLogoError(null);
  }

  async function submit() {
    setError(null);
    if (!form.name.trim()) return setError("Client name is required.");
    setLoading(true);
    try {
      const { id } = await createClientAction(form);
      if (logoFile) {
        // Best-effort: the client record exists either way - a failed logo
        // upload shouldn't block creation, it can be added from Settings later.
        const body = new FormData();
        body.append("file", logoFile);
        await fetch(`/api/clients/${id}/logo`, { method: "POST", body }).catch(() => {});
      }
      setOpen(false);
      reset();
      router.push(`/clients/${id}`);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not create client");
      setLoading(false);
    }
  }

  return (
    <>
      <Button onClick={() => setOpen(true)}>
        <Icon name="Plus" className="h-4 w-4" />
        New client
      </Button>
      <Modal open={open} onClose={() => setOpen(false)} title="New client" description="Add a brand to your roster.">
        <div className="space-y-3">
          <div>
            <Label>Brand logo</Label>
            {logoPreview ? (
              <div className="flex items-center gap-3 rounded-[10px] border border-border bg-surface-2 p-3">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-[6px] border border-border bg-white p-1">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={logoPreview} alt="" className="h-full w-full object-contain" />
                </div>
                <p className="min-w-0 flex-1 truncate text-xs font-medium">{logoFile?.name}</p>
                <div className="flex shrink-0 gap-1.5">
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    className="rounded-[6px] border border-border px-2.5 py-1.5 text-xs font-medium transition-colors hover:border-neon/50 hover:text-neon"
                  >
                    Change
                  </button>
                  <button
                    type="button"
                    onClick={clearLogo}
                    className="flex items-center justify-center rounded-[6px] border border-border p-1.5 text-muted-2 transition-colors hover:border-danger/50 hover:text-danger"
                    aria-label="Remove logo"
                  >
                    <Icon name="Trash2" className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
            ) : (
              <div
                onClick={() => fileInputRef.current?.click()}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => e.key === "Enter" && fileInputRef.current?.click()}
                className="flex cursor-pointer flex-col items-center gap-1.5 rounded-[10px] border-2 border-dashed border-border py-4 text-center transition-colors hover:border-neon/40"
              >
                <Icon name="Upload" className="h-4 w-4 text-muted-2" />
                <p className="text-xs text-muted-2">Click to upload · PNG, JPG, or SVG · max 4 MB</p>
              </div>
            )}
            <input
              ref={fileInputRef}
              type="file"
              accept={LOGO_ACCEPT}
              className="sr-only"
              onChange={(e) => { if (e.target.files?.[0]) pickLogo(e.target.files[0]); }}
            />
            {logoError && <p className="mt-1 text-xs text-danger">{logoError}</p>}
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <Label>Name *</Label>
              <Input value={form.name} onChange={(e) => set("name", e.target.value)} placeholder="Acme Co" />
            </div>
            {/* The chip's field from the very first save, capped where the chip
                is measured — a new client is not created into the legacy name. */}
            <div>
              <Label>Category</Label>
              <Input
                value={form.category}
                onChange={(e) => set("category", e.target.value)}
                placeholder="SaaS, retail…"
                maxLength={CLIENT_CATEGORY_MAX_LENGTH}
              />
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
            <Label>About</Label>
            <Textarea value={form.description} onChange={(e) => set("description", e.target.value)} className="min-h-[60px]" placeholder="What does this client do?" />
          </div>
          <div>
            <Label>Brand voice</Label>
            <Textarea value={form.brandVoice} onChange={(e) => set("brandVoice", e.target.value)} placeholder="Tone, vocabulary, do's and don'ts. Agents use this to stay on-brand." />
          </div>
          {error && <p className="text-xs text-danger">{error}</p>}
          <Button className="w-full" loading={loading} onClick={submit}>
            Create client
          </Button>
        </div>
      </Modal>
    </>
  );
}
