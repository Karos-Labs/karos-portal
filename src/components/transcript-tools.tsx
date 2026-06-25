"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button, Input, Textarea, Label, Select } from "@/components/ui";
import { Modal } from "@/components/modal";
import { Icon } from "@/components/icon";
import {
  ingestManualTranscriptAction,
  assignTranscriptAction,
  updateTranscriptContextSignalAction,
} from "@/lib/actions";
import type { Client } from "@/lib/types";

/* ── Fireflies JSON detection ────────────────────────────────────── */

interface FirefliesJsonExport {
  id?: string;
  title?: string;
  participants?: string[];
  meeting_attendees?: Array<{ email?: string; displayName?: string }>;
  sentences?: Array<{ speaker_name?: string; text?: string }>;
  summary?: { overview?: string; action_items?: string[] | string };
}

function parseFirefliesJson(raw: string): { title: string; participants: string; rawText: string } | null {
  try {
    const data = JSON.parse(raw) as FirefliesJsonExport;
    if (!data || typeof data !== "object") return null;
    if (!data.sentences && !data.meeting_attendees) return null;

    const title = data.title ?? "";
    const emails: string[] = [
      ...(data.participants ?? []),
      ...(data.meeting_attendees ?? []).map((a) => a.email ?? "").filter(Boolean),
    ];
    const participants = Array.from(new Set(emails)).join(", ");
    const rawText = Array.isArray(data.sentences)
      ? data.sentences.map((s) => `${s.speaker_name ?? "Speaker"}: ${s.text ?? ""}`).join("\n")
      : "";

    if (!rawText) return null;
    return { title, participants, rawText };
  } catch {
    return null;
  }
}

/* ── ManualIngestButton ──────────────────────────────────────────── */

export function ManualIngestButton() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [mode, setMode] = useState<"text" | "json">("text");
  const [form, setForm] = useState({ title: "", participants: "", rawText: "" });
  const [jsonRaw, setJsonRaw] = useState("");
  const [jsonError, setJsonError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  function handleJsonChange(raw: string) {
    setJsonRaw(raw);
    setJsonError(null);
    const parsed = parseFirefliesJson(raw);
    if (parsed) {
      setForm(parsed);
      setJsonError(null);
    } else if (raw.trim().startsWith("{")) {
      setJsonError("Could not parse as Fireflies JSON. Make sure it includes 'sentences'.");
    }
  }

  function reset() {
    setForm({ title: "", participants: "", rawText: "" });
    setJsonRaw("");
    setJsonError(null);
    setError(null);
    setMode("text");
  }

  async function submit() {
    setError(null);
    if (!form.rawText.trim()) return setError("Paste the transcript text.");
    setLoading(true);
    try {
      const res = await ingestManualTranscriptAction(form);
      setOpen(false);
      reset();
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
      <Modal
        open={open}
        onClose={() => { setOpen(false); reset(); }}
        title="Ingest a transcript"
        description="Paste a meeting transcript or import a Fireflies JSON export. Karos will summarise it and auto-route it to the matching client."
      >
        <div className="space-y-3">
          {/* Mode toggle */}
          <div className="flex rounded-[8px] border border-border bg-surface-2 p-0.5">
            {(["text", "json"] as const).map((m) => (
              <button
                key={m}
                onClick={() => setMode(m)}
                className={`flex-1 rounded-[6px] py-1.5 text-xs font-medium transition-colors ${
                  mode === m ? "bg-surface text-foreground shadow-sm" : "text-muted hover:text-foreground"
                }`}
              >
                {m === "text" ? "Paste text" : "Import JSON"}
              </button>
            ))}
          </div>

          {mode === "text" ? (
            <>
              <div>
                <Label>Meeting title</Label>
                <Input
                  value={form.title}
                  onChange={(e) => setForm((s) => ({ ...s, title: e.target.value }))}
                  placeholder="Acme — kickoff call"
                />
              </div>
              <div>
                <Label>Participant emails (for auto-routing)</Label>
                <Input
                  value={form.participants}
                  onChange={(e) => setForm((s) => ({ ...s, participants: e.target.value }))}
                  placeholder="jane@acme.com, you@agency.com"
                />
              </div>
              <div>
                <Label>Transcript</Label>
                <Textarea
                  value={form.rawText}
                  onChange={(e) => setForm((s) => ({ ...s, rawText: e.target.value }))}
                  className="min-h-[160px]"
                  placeholder="Paste the full transcript…"
                />
              </div>
            </>
          ) : (
            <>
              <div>
                <Label>Fireflies JSON export</Label>
                <Textarea
                  value={jsonRaw}
                  onChange={(e) => handleJsonChange(e.target.value)}
                  className="min-h-[160px] font-mono text-xs"
                  placeholder='Paste the JSON export from Fireflies (contains "sentences", "meeting_attendees", etc.)…'
                />
                {jsonError && <p className="mt-1 text-xs text-danger">{jsonError}</p>}
              </div>
              {form.rawText && (
                <div className="rounded-[8px] border border-neon/20 bg-neon-soft/20 p-3 text-xs text-muted">
                  <p className="font-medium text-neon">Parsed successfully</p>
                  {form.title && <p>Title: {form.title}</p>}
                  {form.participants && <p>Participants: {form.participants}</p>}
                  <p>{form.rawText.split("\n").length} lines of transcript</p>
                </div>
              )}
            </>
          )}

          {error && <p className="text-xs text-danger">{error}</p>}
          <Button className="w-full" loading={loading} onClick={submit}>
            {loading ? "Analysing…" : "Ingest & analyse"}
          </Button>
        </div>
      </Modal>
    </>
  );
}

/* ── TranscriptAssign ────────────────────────────────────────────── */

export function TranscriptAssign({
  transcriptId,
  clients,
  current,
}: {
  transcriptId: string;
  clients: Client[];
  current?: string | null;
}) {
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
      <Select
        value={value}
        onChange={(e) => change(e.target.value)}
        className="h-9 w-44 text-xs"
        disabled={saving}
      >
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

/* ── TranscriptSignalButton ──────────────────────────────────────── */

export function TranscriptSignalButton({
  transcriptId,
  clientId,
}: {
  transcriptId: string;
  clientId: string;
}) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function push() {
    setLoading(true);
    setError(null);
    try {
      await updateTranscriptContextSignalAction(transcriptId, clientId);
      setDone(true);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to send signal");
    } finally {
      setLoading(false);
    }
  }

  if (done) {
    return (
      <div className="flex items-center gap-1.5 text-xs text-neon">
        <Icon name="CheckCircle" className="h-3.5 w-3.5" />
        Sent to Intel
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1">
      <Button variant="outline" size="sm" onClick={push} loading={loading}>
        <Icon name="BrainCircuit" className="h-4 w-4" />
        {loading ? "Sending…" : "Send to Intel"}
      </Button>
      {error && <p className="text-xs text-danger">{error}</p>}
    </div>
  );
}
