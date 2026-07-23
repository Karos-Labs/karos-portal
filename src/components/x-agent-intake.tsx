"use client";

/**
 * X agent (e13) intake surfaces: the company-page form, per-person seat forms
 * ("add a seat", repeatable), the two ongoing drop boxes, and per-draft
 * feedback. One canonical set of X surfaces — copy follows the input
 * contract: sentence case, each field says what we do with the answer,
 * optional fields say the product runs without them.
 */

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Badge, Button, Card, CardTitle, Input, Label, Select, Textarea } from "@/components/ui";
import { Icon } from "@/components/icon";
import {
  addXDraftFeedbackAction,
  addXNewsUpdateAction,
  addXSeatAction,
  addXTakeAction,
  proposeXRosterAction,
  saveXCompanyIntakeAction,
  saveXSeatIntakeAction,
} from "@/lib/actions/x-agent-actions";

/* ── client-safe props (serialized server-side) ── */

export interface XIntakeView {
  handle: string | null;
  comeAcross?: string;
  offLimits: string;
  roster: string[];
}

export interface XSeatView {
  id: string;
  name: string;
  slug: string;
  intake: XIntakeView | null;
  takes: Array<{ id: string; take: string; date: string; topic?: string }>;
}

export interface XNewsRowView {
  id: string;
  title: string;
  date: string;
  type?: string;
}

export interface XFeedbackRowView {
  id: string;
  account: string;
  action: string;
  draftRef?: string;
  createdAt: number;
}

export interface XRunRowView {
  id: string;
  status: string;
  createdAt: number;
  href?: string;
}

const TAKE_PROMPTS = [
  "What do most people in your space get wrong?",
  "What did you change your mind about recently?",
  "What lesson cost you the most to learn?",
  "What decision did you make this week, and why?",
  "What number from your work would surprise people?",
];

const NEWS_TYPES = ["launch", "milestone", "customer win", "hire", "partnership", "event", "other"];

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function fieldError(error: string | null) {
  return error ? <p className="mt-2 text-xs text-red-400">{error}</p> : null;
}

/**
 * Roster field with propose-and-approve: we suggest accounts from what we
 * already know about the business (and the person, for seats); the client
 * edits and approves. Re-clicking refreshes the proposal.
 */
function RosterInput({
  clientId,
  seatName,
  value,
  onChange,
  idPrefix,
  helper,
}: {
  clientId: string;
  seatName?: string;
  value: string;
  onChange: (v: string) => void;
  idPrefix: string;
  helper: string;
}) {
  const [proposing, startProposing] = useTransition();
  const [why, setWhy] = useState<Array<{ handle: string; why: string }> | null>(null);
  const [error, setError] = useState<string | null>(null);

  function propose() {
    setError(null);
    startProposing(async () => {
      const result = await proposeXRosterAction({ clientId, ...(seatName ? { seatName } : {}) });
      if (result.error || !result.handles) {
        setError(result.error ?? "Could not build a proposal.");
        return;
      }
      onChange(result.handles.map((h) => h.handle).join(", "));
      setWhy(result.handles);
    });
  }

  return (
    <div>
      <div className="flex items-center justify-between">
        <Label htmlFor={`${idPrefix}-roster`}>
          {seatName ? "Accounts you want to be near on X (optional)" : "Accounts or communities to engage (optional)"}
        </Label>
        <Button variant="ghost" size="sm" onClick={propose} disabled={proposing} type="button">
          {proposing ? "Proposing…" : value.trim() ? "Refresh proposal" : "Propose accounts"}
        </Button>
      </div>
      <Input
        id={`${idPrefix}-roster`}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="@handle, @handle - or let us propose a list"
      />
      <p className="mt-1 text-xs text-muted">{helper}</p>
      {fieldError(error)}
      {why && why.length > 0 ? (
        <ul className="mt-2 space-y-1 rounded-md border border-border bg-surface-2 p-3">
          {why.map((h) => (
            <li key={h.handle} className="text-xs text-muted">
              <span className="text-foreground">{h.handle}</span> - {h.why}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/* ─────────────────────── company page form ─────────────────────── */

function CompanyForm({ clientId, intake }: { clientId: string; intake: XIntakeView | null }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [handle, setHandle] = useState(intake?.handle ?? "");
  const [comeAcross, setComeAcross] = useState(intake?.comeAcross ?? "");
  const [offLimits, setOffLimits] = useState(intake?.offLimits ?? "");
  const [roster, setRoster] = useState(intake?.roster.join(", ") ?? "");
  const [announcements, setAnnouncements] = useState("");

  function save() {
    setError(null);
    setSaved(false);
    start(async () => {
      const result = await saveXCompanyIntakeAction({ clientId, handle, comeAcross, offLimits, roster, announcements });
      if (result.error) {
        setError(result.error);
        return;
      }
      setSaved(true);
      router.refresh();
    });
  }

  return (
    <Card className="p-5">
      <div className="flex items-center justify-between">
        <CardTitle>Company page</CardTitle>
        {intake ? <Badge tone="success">On file</Badge> : <Badge tone="warning">Not set up</Badge>}
      </div>
      <p className="mt-1 text-sm text-muted">
        One per business. Voice, pillars and cadence are built from your profile and your posts; we
        only ask what we cannot find ourselves.
      </p>
      <div className="mt-4 space-y-4">
        <div>
          <Label htmlFor="xc-handle">Company X handle</Label>
          <Input
            id="xc-handle"
            value={handle}
            onChange={(e) => setHandle(e.target.value)}
            placeholder="@yourcompany (leave empty if there is none yet)"
          />
        </div>
        <div>
          <Label htmlFor="xc-voice">How do you want to come across on X?</Label>
          <Textarea
            id="xc-voice"
            rows={2}
            value={comeAcross}
            onChange={(e) => setComeAcross(e.target.value)}
            placeholder="One or two lines. This is the only voice question we ask."
          />
        </div>
        <div>
          <Label htmlFor="xc-offlimits">Anything we must never post</Label>
          <Textarea
            id="xc-offlimits"
            rows={2}
            value={offLimits}
            onChange={(e) => setOffLimits(e.target.value)}
            placeholder="Topics, client names, specific numbers."
          />
        </div>
        <RosterInput
          clientId={clientId}
          value={roster}
          onChange={setRoster}
          idPrefix="xc"
          helper="Optional; this turns on the engagement lane. We propose from what we already know about your business - you approve or edit. Every handle is verified live before any engagement."
        />
        {!intake ? (
          <div>
            <Label htmlFor="xc-announce">Anything worth announcing right now? (optional)</Label>
            <Textarea
              id="xc-announce"
              rows={3}
              value={announcements}
              onChange={(e) => setAnnouncements(e.target.value)}
              placeholder="One per line. A launch, a milestone, a hire - a line each is enough; we turn them into posts."
            />
          </div>
        ) : null}
        {fieldError(error)}
        <div className="flex items-center gap-3">
          <Button onClick={save} disabled={pending}>
            {pending ? "Saving…" : "Save company page"}
          </Button>
          {saved ? <span className="text-xs text-muted">Saved.</span> : null}
        </div>
      </div>
    </Card>
  );
}

/* ────────────────────────── seat cards ─────────────────────────── */

function SeatCard({ clientId, seat }: { clientId: string; seat: XSeatView }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [handle, setHandle] = useState(seat.intake?.handle ?? "");
  const [offLimits, setOffLimits] = useState(seat.intake?.offLimits ?? "");
  const [roster, setRoster] = useState(seat.intake?.roster.join(", ") ?? "");
  const [take, setTake] = useState("");
  const [topic, setTopic] = useState("");
  const [takeUrl, setTakeUrl] = useState("");
  const [takeError, setTakeError] = useState<string | null>(null);
  const promptIndex = seat.takes.length % TAKE_PROMPTS.length;

  function saveSeat() {
    setError(null);
    start(async () => {
      const result = await saveXSeatIntakeAction({ clientId, seatId: seat.id, handle, offLimits, roster });
      if (result.error) {
        setError(result.error);
        return;
      }
      router.refresh();
    });
  }

  function submitTake() {
    setTakeError(null);
    start(async () => {
      const result = await addXTakeAction({
        clientId,
        seatId: seat.id,
        take,
        date: today(),
        topic,
        url: takeUrl,
      });
      if (result.error) {
        setTakeError(result.error);
        return;
      }
      setTake("");
      setTopic("");
      setTakeUrl("");
      router.refresh();
    });
  }

  return (
    <Card className="p-5">
      <div className="flex items-center justify-between">
        <CardTitle>{seat.name}</CardTitle>
        {seat.intake?.handle ? (
          <Badge tone="success">{seat.intake.handle}</Badge>
        ) : (
          <Badge tone="warning">Handle pending, drafts only</Badge>
        )}
      </div>
      <div className="mt-4 space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <Label htmlFor={`xs-handle-${seat.id}`}>Your X handle</Label>
            <Input
              id={`xs-handle-${seat.id}`}
              value={handle}
              onChange={(e) => setHandle(e.target.value)}
              placeholder="@you (leave empty while you open one)"
            />
            <p className="mt-1 text-xs text-muted">
              A seat runs a real account; we do not create accounts. We draft either way, but nothing
              can post until the handle exists.
            </p>
          </div>
          <RosterInput
            clientId={clientId}
            seatName={seat.name}
            value={roster}
            onChange={setRoster}
            idPrefix={`xs-${seat.id}`}
            helper="Optional; this turns on your engagement lane. We propose people worth being near - you approve or edit."
          />
        </div>
        <div>
          <Label htmlFor={`xs-offlimits-${seat.id}`}>Anything we must never post</Label>
          <Textarea
            id={`xs-offlimits-${seat.id}`}
            rows={2}
            value={offLimits}
            onChange={(e) => setOffLimits(e.target.value)}
            placeholder='Topics, names, numbers. Write "nothing" if everything is fair game.'
          />
        </div>
        <p className="text-xs text-muted">
          No voice questions here on purpose: if we already run your LinkedIn we reuse that voice, and
          otherwise we build it from your profile and sharpen it from your real posts and edits.
        </p>
        {fieldError(error)}
        <Button onClick={saveSeat} disabled={pending} variant="subtle">
          {pending ? "Saving…" : "Save seat"}
        </Button>

        <div className="border-t border-border pt-4">
          <p className="text-sm font-medium">Your takes and topics</p>
          <p className="mt-1 text-xs text-muted">
            One honest sentence on something in your space. We turn it into a post in your voice.
          </p>
          <div className="mt-3 space-y-3">
            <Textarea
              rows={2}
              value={take}
              onChange={(e) => setTake(e.target.value)}
              placeholder={TAKE_PROMPTS[promptIndex]}
            />
            <div className="grid gap-3 sm:grid-cols-2">
              <Input
                value={topic}
                onChange={(e) => setTopic(e.target.value)}
                placeholder="Topic (optional): GTM, hiring, AI…"
              />
              <Input
                value={takeUrl}
                onChange={(e) => setTakeUrl(e.target.value)}
                placeholder="Source link - only if your take contains a number"
              />
            </div>
            {fieldError(takeError)}
            <Button onClick={submitTake} disabled={pending} variant="subtle">
              Drop the take
            </Button>
          </div>
          {seat.takes.length > 0 ? (
            <ul className="mt-4 space-y-2">
              {seat.takes.slice(0, 5).map((t) => (
                <li key={t.id} className="text-xs text-muted">
                  <span className="text-foreground">{t.date}</span>
                  {t.topic ? ` · ${t.topic}` : ""} - {t.take}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      </div>
    </Card>
  );
}

function AddSeatForm({ clientId }: { clientId: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [handle, setHandle] = useState("");
  const [offLimits, setOffLimits] = useState("");
  const [roster, setRoster] = useState("");
  const [firstTakes, setFirstTakes] = useState("");

  function add() {
    setError(null);
    start(async () => {
      const result = await addXSeatAction({ clientId, name, handle, offLimits, roster, firstTakes });
      if (result.error) {
        setError(result.error);
        return;
      }
      setName("");
      setHandle("");
      setOffLimits("");
      setRoster("");
      setFirstTakes("");
      setOpen(false);
      router.refresh();
    });
  }

  if (!open) {
    return (
      <Button variant="subtle" onClick={() => setOpen(true)}>
        <Icon name="Plus" className="mr-1.5 h-4 w-4" />
        Add a seat
      </Button>
    );
  }
  return (
    <Card className="p-5">
      <CardTitle>Add a seat</CardTitle>
      <p className="mt-1 text-sm text-muted">
        A seat is one person on your team whose X account we draft for. Anyone on the team can have
        one.
      </p>
      <div className="mt-4 space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <Label htmlFor="xa-name">Name</Label>
            <Input id="xa-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Full name" />
          </div>
          <div>
            <Label htmlFor="xa-handle">X handle</Label>
            <Input
              id="xa-handle"
              value={handle}
              onChange={(e) => setHandle(e.target.value)}
              placeholder="@you (leave empty while you open one)"
            />
          </div>
        </div>
        <div>
          <Label htmlFor="xa-offlimits">Anything we must never post</Label>
          <Textarea
            id="xa-offlimits"
            rows={2}
            value={offLimits}
            onChange={(e) => setOffLimits(e.target.value)}
            placeholder='Write "nothing" if everything is fair game.'
          />
        </div>
        <RosterInput
          clientId={clientId}
          seatName={name || undefined}
          value={roster}
          onChange={setRoster}
          idPrefix="xa"
          helper="Optional; this turns on your engagement lane. We propose people worth being near - you approve or edit."
        />
        <div>
          <Label htmlFor="xa-takes">Your first takes</Label>
          <Textarea
            id="xa-takes"
            rows={4}
            value={firstTakes}
            onChange={(e) => setFirstTakes(e.target.value)}
            placeholder={"3 to 5 rough one-liners of what you actually think - one per line.\nGTM, hiring, AI, the grind. We turn each into a post in your voice."}
          />
          <p className="mt-1 text-xs text-muted">
            The single highest-leverage input for your seat. Rough is perfect; we do the wordsmithing.
          </p>
        </div>
        {fieldError(error)}
        <div className="flex gap-3">
          <Button onClick={add} disabled={pending}>
            {pending ? "Adding…" : "Add seat"}
          </Button>
          <Button variant="ghost" onClick={() => setOpen(false)}>
            Cancel
          </Button>
        </div>
      </div>
    </Card>
  );
}

/* ─────────────────────── what's new box ────────────────────────── */

function NewsBox({ clientId, rows }: { clientId: string; rows: XNewsRowView[] }) {
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
        One or two lines on what is new. We turn it into the post, you do not write it. Empty weeks
        are fine; the agent keeps running on its always-on lanes.
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
          <Select
            value={type}
            onChange={(e) => setType(e.target.value)}
            >
            <option value="">Type (optional)</option>
            {NEWS_TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </Select>
          <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="Public link (optional)" />
        </div>
        {fieldError(error)}
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

/* ──────────────── feedback box (free-form, per account) ─────────────── */

function FeedbackBox({
  clientId,
  seats,
  runs,
  recent,
}: {
  clientId: string;
  seats: XSeatView[];
  runs: XRunRowView[];
  recent: XFeedbackRowView[];
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const [account, setAccount] = useState("program");
  const [note, setNote] = useState("");

  const accountName = (id: string) =>
    id === "company" ? "Company page" : id === "program" ? "Everything" : (seats.find((s) => s.id === id)?.name ?? "Seat");

  function submit() {
    setError(null);
    setSent(false);
    start(async () => {
      const result = await addXDraftFeedbackAction({ clientId, account, action: "note", reason: note });
      if (result.error) {
        setError(result.error);
        return;
      }
      setNote("");
      setSent(true);
      router.refresh();
    });
  }

  return (
    <Card className="p-5">
      <CardTitle>Feedback</CardTitle>
      <p className="mt-1 text-sm text-muted">
        Tell us what is working and what is not - in your own words, as much detail as you like.
        It goes straight into the agent&apos;s next run. Picking, editing, or skipping individual
        drafts happens on the drafts themselves, in your Workspace archive.
      </p>
      {runs.length > 0 ? (
        <ul className="mt-3 space-y-1">
          {runs.slice(0, 4).map((r) => (
            <li key={r.id} className="text-xs text-muted">
              {r.href ? (
                <a href={r.href} className="underline hover:text-foreground">
                  Run {new Date(r.createdAt).toISOString().slice(0, 10)}
                </a>
              ) : (
                <span>Run {new Date(r.createdAt).toISOString().slice(0, 10)}</span>
              )}{" "}
              · {r.status}
            </li>
          ))}
        </ul>
      ) : null}
      <div className="mt-4 space-y-3">
        <div className="max-w-xs">
          <Label htmlFor="xf-account">This is about</Label>
          <Select id="xf-account" value={account} onChange={(e) => setAccount(e.target.value)}>
            <option value="program">Everything</option>
            <option value="company">Company page</option>
            {seats.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </Select>
        </div>
        <Textarea
          rows={5}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Explain the problem or the win. Too salesy? Wrong topics? A draft style you want more of? Write it like you would to a teammate."
        />
        {fieldError(error)}
        <div className="flex items-center gap-3">
          <Button onClick={submit} disabled={pending || !note.trim()}>
            {pending ? "Sending…" : "Send feedback"}
          </Button>
          {sent ? <span className="text-xs text-muted">Sent - it feeds the next run.</span> : null}
        </div>
      </div>
      {recent.length > 0 ? (
        <ul className="mt-4 space-y-2 border-t border-border pt-4">
          {recent.slice(0, 6).map((f) => (
            <li key={f.id} className="text-xs text-muted">
              <span className="text-foreground">{accountName(f.account)}</span> ·{" "}
              {f.action === "note" ? "feedback" : f.action.replace(/_/g, " ")}
              {f.draftRef ? ` · ${f.draftRef}` : ""} ·{" "}
              {new Date(f.createdAt).toISOString().slice(0, 10)}
            </li>
          ))}
        </ul>
      ) : null}
    </Card>
  );
}

/* ────────────────────────── the page body ───────────────────────── */

export function XAgentIntake({
  clientId,
  company,
  seats,
  news,
  feedback,
  runs,
}: {
  clientId: string;
  company: XIntakeView | null;
  seats: XSeatView[];
  news: XNewsRowView[];
  feedback: XFeedbackRowView[];
  runs: XRunRowView[];
}) {
  return (
    <div className="space-y-6">
      <CompanyForm clientId={clientId} intake={company} />
      <div className="space-y-4">
        {seats.map((seat) => (
          <SeatCard key={seat.id} clientId={clientId} seat={seat} />
        ))}
        <AddSeatForm clientId={clientId} />
      </div>
      <NewsBox clientId={clientId} rows={news} />
      <FeedbackBox clientId={clientId} seats={seats} runs={runs} recent={feedback} />
    </div>
  );
}
