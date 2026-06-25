"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Card, CardTitle, Button, Input, Textarea, Label } from "@/components/ui";
import { Icon } from "@/components/icon";
import { updateClientAction } from "@/lib/actions";
import type { Client } from "@/lib/types";

export function ClientEditor({ client }: { client: Client }) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({
    contactEmail: client.contactEmail ?? "",
    website: client.website ?? "",
    industry: client.industry ?? "",
    domainsCsv: (client.domains ?? []).join(", "),
    description: client.description ?? "",
    brandVoice: client.brandVoice ?? "",
  });

  function set(k: keyof typeof form, v: string) {
    setForm((s) => ({ ...s, [k]: v }));
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
        <Field label="Brand voice" value={client.brandVoice} multiline />
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Contact email" value={client.contactEmail} />
          <Field label="Website" value={client.website} />
          <Field label="Industry" value={client.industry} />
          <Field label="Meeting domains" value={(client.domains ?? []).join(", ")} />
        </div>
        <Field label="About" value={client.description} multiline />
      </Card>
    );
  }

  return (
    <Card className="space-y-4">
      <CardTitle>Edit brand profile</CardTitle>
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
          <Label>Industry</Label>
          <Input value={form.industry} onChange={(e) => set("industry", e.target.value)} />
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
        {value || "—"}
      </p>
    </div>
  );
}
