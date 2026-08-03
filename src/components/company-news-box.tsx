"use client";

/**
 * The shared "what happened this week" company news drop (SCRUM-51): ONE
 * input per client, stored once (the xNewsUpdates collection keeps its
 * historical name) and fanned out at run time to every agent that consumes
 * news - X gets whats-new.json, the LinkedIn company page gets
 * company-updates.md Section A. Mounted inside both agent intake surfaces; do
 * not build a per-platform copy of this box.
 */

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button, Card, CardTitle, Input, Select, Textarea } from "@/components/ui";
import { intakeSave } from "@/lib/intake-save";
import { addXNewsUpdateAction } from "@/lib/actions/x-agent-actions";

export interface CompanyNewsRowView {
  id: string;
  title: string;
  date: string;
  type?: string;
}

/** The Section A pick-list from the lab template - the skill routes by these terms. */
const NEWS_TYPES = [
  "win/milestone",
  "launch",
  "customer story",
  "culture",
  "event",
  "hire",
  "partnership",
  "other",
];

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
  const [sourceUrl, setSourceUrl] = useState("");
  const [consent, setConsent] = useState("");

  const hasNumber = /\d/.test(`${title} ${detail}`);
  const featuresPerson = type === "customer story" || type === "hire";

  function add() {
    setError(null);
    start(async () => {
      // Through the intake funnel like every other write on these two pages:
      // this box is mounted INSIDE the X and LinkedIn intake surfaces, so a
      // lapsed session drops a click here exactly as it did there (#86).
      const result = await intakeSave(() =>
        addXNewsUpdateAction({ clientId, title, date, type, url, detail, sourceUrl, consent }),
      );
      if (result.error) {
        setError(result.error);
        return;
      }
      setTitle("");
      setDetail("");
      setUrl("");
      setType("");
      setSourceUrl("");
      setConsent("");
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
        posting their regular content either way.
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
          placeholder="Detail (optional): what shipped and why it matters."
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
        {hasNumber ? (
          <div>
            <Input
              value={sourceUrl}
              onChange={(e) => setSourceUrl(e.target.value)}
              placeholder="Source for the number"
            />
            <p className="mt-1 text-xs text-muted">
              If your update contains a number, add where it comes from. No source means we post it
              without the number.
            </p>
          </div>
        ) : null}
        {featuresPerson ? (
          <div>
            <Input
              value={consent}
              onChange={(e) => setConsent(e.target.value)}
              placeholder="Who is featured + their ok"
            />
            <p className="mt-1 text-xs text-muted">
              If this features a person (a hire, a customer quote), confirm they are ok with it. We
              hold the draft until then.
            </p>
          </div>
        ) : null}
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
              {r.type ? ` · ${r.type}` : ""} · {r.title}
            </li>
          ))}
        </ul>
      ) : null}
    </Card>
  );
}
