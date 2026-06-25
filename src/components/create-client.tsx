"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button, Input, Textarea, Label } from "@/components/ui";
import { Modal } from "@/components/modal";
import { Icon } from "@/components/icon";
import { createClientAction } from "@/lib/actions";

export function CreateClientButton() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({
    name: "",
    website: "",
    industry: "",
    contactEmail: "",
    domains: "",
    description: "",
    brandVoice: "",
  });

  function set(k: keyof typeof form, v: string) {
    setForm((s) => ({ ...s, [k]: v }));
  }

  async function submit() {
    setError(null);
    if (!form.name.trim()) return setError("Client name is required.");
    setLoading(true);
    try {
      const { id } = await createClientAction(form);
      setOpen(false);
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
