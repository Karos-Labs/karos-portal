"use client";

/**
 * The shared "what happened this week" company news drop (SCRUM-51): ONE
 * input per client, stored once (the xNewsUpdates collection keeps its
 * historical name) and fanned out at run time to every agent that consumes
 * news — X gets whats-new.json, the LinkedIn company page gets
 * company-updates.md Section A. Mounted on both agent data pages; do not
 * build a per-platform copy of this box.
 */

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button, Card, CardTitle, Input, Select, Textarea } from "@/components/ui";
import { addXNewsUpdateAction } from "@/lib/actions/x-agent-actions";

export interface CompanyNewsRowView {
  id: string;
  title: string;
  date: string;
  type?: string;
}

const NEWS_TYPES = ["launch", "milestone", "customer win", "hire", "partnership", "event", "other"];

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export function CompanyNewsBox({ clientId, rows }: { clientId: string; rows: CompanyNewsRowView[] }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [date, setDate] = useState(today());
  const [type, setType] = useState("");
  const [url, setUrl] = useState("");
  const [detail, setDetail] = useState("");

  function add() {
    setError(null);
    start(async () => {
      const result = await addXNewsUpdateAction({ clientId, title, date, type, url, detail });
      if (result.error) {
        setError(result.error);
        return;
      }
      setTitle("");
      setDetail("");
      setUrl("");
      setType("");
      setDate(today());
      router.refresh();
    });
  }

  return (
    <Card className="p-5">
      <CardTitle>What happened this week</CardTitle>
      <p className="mt-1 text-sm text-muted">
        One or two lines on what is new. We turn it into the post, you do not write it. You type it
        once and every agent that posts news picks it up. Empty weeks are fine; the agents keep
        running on their always-on lanes.
      </p>
      <div className="mt-4 space-y-3">
        <Textarea
          rows={2}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="What happened?"
        />
        <Textarea
          rows={2}
          value={detail}
          onChange={(e) => setDetail(e.target.value)}
          placeholder="Detail (optional): what shipped and why it matters. If it contains a number, add the source link below or we post it without the number."
        />
        <div className="grid gap-3 sm:grid-cols-3">
          <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          <Select value={type} onChange={(e) => setType(e.target.value)}>
            <option value="">Type (optional)</option>
            {NEWS_TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </Select>
          <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="Public link (optional)" />
        </div>
        {error ? <p className="mt-2 text-xs text-red-400">{error}</p> : null}
        <Button onClick={add} disabled={pending} variant="subtle">
          {pending ? "Adding…" : "Drop the update"}
        </Button>
      </div>
      {rows.length > 0 ? (
        <ul className="mt-4 space-y-2 border-t border-border pt-4">
          {rows.slice(0, 6).map((r) => (
            <li key={r.id} className="text-xs text-muted">
              <span className="text-foreground">{r.date}</span>
              {r.type ? ` · ${r.type}` : ""} - {r.title}
            </li>
          ))}
        </ul>
      ) : null}
    </Card>
  );
}
