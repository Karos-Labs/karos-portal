"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button, Input, Textarea, Label, Select } from "@/components/ui";
import { Modal } from "@/components/modal";
import { Icon } from "@/components/icon";
import { ingestManualTranscriptAction, assignTranscriptAction } from "@/lib/actions";
import type { Client } from "@/lib/types";

export function ManualIngestButton() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [form, setForm] = useState({ title: "", participants: "", rawText: "" });
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setError(null);
    if (!form.rawText.trim()) return setError("Paste the transcript text.");
    setLoading(true);
    try {
      const res = await ingestManualTranscriptAction(form);
      setOpen(false);
      setForm({ title: "", participants: "", rawText: "" });
      router.refresh();
      if (res.id) router.push(`/transcripts/${res.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Ingest failed");
      setLoading(false);
    }
  }

  return (
    <>
      <Button variant="outline" onClick={() => setOpen(true)}>
        <Icon name="Upload" className="h-4 w-4" />
        Paste transcript
      </Button>
      <Modal open={open} onClose={() => setOpen(false)} title="Ingest a transcript" description="Paste a meeting transcript. Karos will summarise it and auto-route it to the matching client.">
        <div className="space-y-3">
          <div>
            <Label>Meeting title</Label>
            <Input value={form.title} onChange={(e) => setForm((s) => ({ ...s, title: e.target.value }))} placeholder="Acme — kickoff call" />
          </div>
          <div>
            <Label>Participant emails (for auto-routing)</Label>
            <Input value={form.participants} onChange={(e) => setForm((s) => ({ ...s, participants: e.target.value }))} placeholder="jane@acme.com, you@agency.com" />
          </div>
          <div>
            <Label>Transcript</Label>
            <Textarea value={form.rawText} onChange={(e) => setForm((s) => ({ ...s, rawText: e.target.value }))} className="min-h-[160px]" placeholder="Paste the full transcript…" />
          </div>
          {error && <p className="text-xs text-danger">{error}</p>}
          <Button className="w-full" loading={loading} onClick={submit}>
            {loading ? "Analysing…" : "Ingest & analyse"}
          </Button>
        </div>
      </Modal>
    </>
  );
}

export function TranscriptAssign({ transcriptId, clients, current }: { transcriptId: string; clients: Client[]; current?: string | null }) {
  const router = useRouter();
  const [value, setValue] = useState(current ?? "");
  const [saving, setSaving] = useState(false);

  async function change(v: string) {
    setValue(v);
    setSaving(true);
    try {
      await assignTranscriptAction(transcriptId, v || null);
      router.refresh();
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex items-center gap-2">
      <Select value={value} onChange={(e) => change(e.target.value)} className="h-9 w-44 text-xs" disabled={saving}>
        <option value="">Unassigned</option>
        {clients.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
      </Select>
      {saving && <Icon name="LoaderCircle" className="h-4 w-4 animate-spin-slow text-muted" />}
    </div>
  );
}
