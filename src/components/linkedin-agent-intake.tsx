"use client";

/**
 * LinkedIn agent (e10) intake surfaces: the company-page form, per-person
 * seat forms (the lab seat form's 6 fields, incl. the private CV upload and
 * the inactive-on-LinkedIn fallback), the shared company news drop, and
 * per-draft feedback. Copy follows the input contract: sentence case, each
 * field says what we do with the answer, optional fields say the product runs
 * without them. Platform-identity rule: this page only ever asks for
 * LinkedIn identity - never an X handle.
 */

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Badge, Button, Card, CardTitle, Input, Label, Select, Textarea } from "@/components/ui";
import { Icon } from "@/components/icon";
import { CompanyNewsBox, type CompanyNewsRowView } from "@/components/company-news-box";
import {
  addLiDraftFeedbackAction,
  addLinkedInSeatAction,
  saveLinkedInCompanyIntakeAction,
  saveLinkedInSeatIntakeAction,
  uploadLinkedInSeatCvAction,
} from "@/lib/actions/linkedin-agent-actions";

/* ── client-safe props (serialized server-side) ── */

export interface LiIntakeView {
  handle: string | null;
  comeAcross?: string;
  offLimits: string;
  role?: string;
  focus?: string;
  fallbackKind?: "writing" | "about";
  fallbackText?: string;
  cvName?: string;
}

export interface LiSeatView {
  id: string;
  name: string;
  slug: string;
  intake: LiIntakeView | null;
}

export interface LiFeedbackRowView {
  id: string;
  account: string;
  action: string;
  draftRef?: string;
  createdAt: number;
}

export interface LiRunRowView {
  id: string;
  status: string;
  createdAt: number;
  href?: string;
}

function fieldError(error: string | null) {
  return error ? <p className="mt-2 text-xs text-red-400">{error}</p> : null;
}

/* ─────────────────────── company page form ─────────────────────── */

function CompanyForm({ clientId, intake }: { clientId: string; intake: LiIntakeView | null }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [pageUrl, setPageUrl] = useState(intake?.handle ?? "");
  const [comeAcross, setComeAcross] = useState(intake?.comeAcross ?? "");
  const [offLimits, setOffLimits] = useState(intake?.offLimits ?? "");

  function save() {
    setError(null);
    setSaved(false);
    start(async () => {
      const result = await saveLinkedInCompanyIntakeAction({ clientId, pageUrl, comeAcross, offLimits });
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
        One per business. The page runs on your brand voice and your own first-party material; we
        only ask what we cannot find ourselves. Drafts only - a person always posts.
      </p>
      <div className="mt-4 space-y-4">
        <div>
          <Label htmlFor="lc-url">Company page URL</Label>
          <Input
            id="lc-url"
            value={pageUrl}
            onChange={(e) => setPageUrl(e.target.value)}
            placeholder="linkedin.com/company/yourcompany (leave empty if there is none yet)"
          />
          <p className="mt-1 text-xs text-muted">
            Where the drafts route. We draft either way, but nothing can be posted until the page
            exists.
          </p>
        </div>
        <div>
          <Label htmlFor="lc-voice">How should the company come across on LinkedIn?</Label>
          <Textarea
            id="lc-voice"
            rows={2}
            value={comeAcross}
            onChange={(e) => setComeAcross(e.target.value)}
            placeholder="One or two lines. This is the only voice question we ask."
          />
        </div>
        <div>
          <Label htmlFor="lc-offlimits">Anything we must never post</Label>
          <Textarea
            id="lc-offlimits"
            rows={2}
            value={offLimits}
            onChange={(e) => setOffLimits(e.target.value)}
            placeholder="Topics, client names, specific numbers."
          />
        </div>
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

/* ──────────────── the inactive-on-LinkedIn fallback field ─────────────── */

/**
 * The lab seat form's field 6: for people with little or no post history we
 * capture ONE genuine voice source - their own writing, or who-they-are notes
 * (a transcribed voice note is the best source; it cannot be AI-polished).
 */
function FallbackField({
  idPrefix,
  kind,
  text,
  onKind,
  onText,
}: {
  idPrefix: string;
  kind: string;
  text: string;
  onKind: (v: string) => void;
  onText: (v: string) => void;
}) {
  return (
    <div>
      <Label htmlFor={`${idPrefix}-fallback`}>If this person is not very active on LinkedIn (optional)</Label>
      <Select id={`${idPrefix}-fallback`} value={kind} onChange={(e) => onKind(e.target.value)}>
        <option value="">They post regularly - we learn the voice from their real posts</option>
        <option value="writing">Drop a long piece of their own genuine writing</option>
        <option value="about">Tell us who they are (typed, or a transcribed voice note)</option>
      </Select>
      <p className="mt-1 text-xs text-muted">
        Being inactive on LinkedIn is a first-class case, not a problem. This is how we learn a real
        voice for someone who does not post - a spoken sample is the best source.
      </p>
      {kind ? (
        <Textarea
          className="mt-2"
          rows={5}
          value={text}
          onChange={(e) => onText(e.target.value)}
          placeholder={
            kind === "writing"
              ? "Paste the piece here - an essay, a long email, anything they genuinely wrote themselves."
              : "Who are they, what have they actually done, how do they talk? Paste a voice-note transcript if you have one."
          }
        />
      ) : null}
    </div>
  );
}

/* ──────────────────── the private CV upload ─────────────────── */

function CvUpload({ clientId, seat }: { clientId: string; seat: LiSeatView }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  function upload(file: File) {
    setError(null);
    start(async () => {
      const body = new FormData();
      body.append("clientId", clientId);
      body.append("seatId", seat.id);
      body.append("file", file);
      const result = await uploadLinkedInSeatCvAction(body);
      if (result.error) {
        setError(result.error);
        return;
      }
      if (inputRef.current) inputRef.current.value = "";
      router.refresh();
    });
  }

  return (
    <div>
      <Label htmlFor={`ls-cv-${seat.id}`}>Resume / CV (pdf, docx, or txt)</Label>
      <div className="mt-1 flex items-center gap-3">
        <input
          ref={inputRef}
          id={`ls-cv-${seat.id}`}
          type="file"
          accept=".pdf,.docx,.txt"
          className="block w-full max-w-sm text-xs text-muted file:mr-3 file:rounded-md file:border file:border-border file:bg-surface-2 file:px-3 file:py-1.5 file:text-xs file:text-foreground"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) upload(file);
          }}
          disabled={pending}
        />
        {pending ? <span className="text-xs text-muted">Uploading…</span> : null}
        {seat.intake?.cvName && !pending ? (
          <Badge tone="success">{seat.intake.cvName}</Badge>
        ) : null}
      </div>
      <p className="mt-1 text-xs text-muted">
        Private - never client-visible, never posted. The CV is for substance (their real
        experience), not voice. Not strictly required: real posts or the voice sample below also
        work, but it is the strongest single source.
      </p>
      {fieldError(error)}
    </div>
  );
}

/* ────────────────────────── seat cards ─────────────────────────── */

function SeatCard({ clientId, seat }: { clientId: string; seat: LiSeatView }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [profileUrl, setProfileUrl] = useState(seat.intake?.handle ?? "");
  const [role, setRole] = useState(seat.intake?.role ?? "");
  const [focus, setFocus] = useState(seat.intake?.focus ?? "");
  const [offLimits, setOffLimits] = useState(seat.intake?.offLimits ?? "");
  const [fallbackKind, setFallbackKind] = useState<string>(seat.intake?.fallbackKind ?? "");
  const [fallbackText, setFallbackText] = useState(seat.intake?.fallbackText ?? "");

  function saveSeat() {
    setError(null);
    start(async () => {
      const result = await saveLinkedInSeatIntakeAction({
        clientId,
        seatId: seat.id,
        role,
        profileUrl,
        focus,
        offLimits,
        fallbackKind,
        fallbackText,
      });
      if (result.error) {
        setError(result.error);
        return;
      }
      router.refresh();
    });
  }

  return (
    <Card className="p-5">
      <div className="flex items-center justify-between">
        <CardTitle>{seat.name}</CardTitle>
        {seat.intake?.handle ? (
          <Badge tone="success">Profile linked</Badge>
        ) : (
          <Badge tone="warning">Profile pending, drafts only</Badge>
        )}
      </div>
      <div className="mt-4 space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <Label htmlFor={`ls-url-${seat.id}`}>LinkedIn profile URL</Label>
            <Input
              id={`ls-url-${seat.id}`}
              value={profileUrl}
              onChange={(e) => setProfileUrl(e.target.value)}
              placeholder="linkedin.com/in/their-name"
            />
            <p className="mt-1 text-xs text-muted">
              Routes their drafts, and is where we read their real posts to learn their voice. We
              never ask anyone to paste their own posts.
            </p>
          </div>
          <div>
            <Label htmlFor={`ls-role-${seat.id}`}>Company role</Label>
            <Input
              id={`ls-role-${seat.id}`}
              value={role}
              onChange={(e) => setRole(e.target.value)}
              placeholder="In their own words"
            />
          </div>
        </div>
        <div>
          <Label htmlFor={`ls-focus-${seat.id}`}>What should their profile focus on? (optional)</Label>
          <Textarea
            id={`ls-focus-${seat.id}`}
            rows={2}
            value={focus}
            onChange={(e) => setFocus(e.target.value)}
            placeholder="The 2 to 4 topics they want to be known for. Seeds their content pillars."
          />
        </div>
        <div>
          <Label htmlFor={`ls-offlimits-${seat.id}`}>Anything we must never post</Label>
          <Textarea
            id={`ls-offlimits-${seat.id}`}
            rows={2}
            value={offLimits}
            onChange={(e) => setOffLimits(e.target.value)}
            placeholder='Topics, names, numbers. Write "nothing" if everything is fair game.'
          />
        </div>
        <CvUpload clientId={clientId} seat={seat} />
        <FallbackField
          idPrefix={`ls-${seat.id}`}
          kind={fallbackKind}
          text={fallbackText}
          onKind={setFallbackKind}
          onText={setFallbackText}
        />
        <p className="text-xs text-muted">
          No voice questions here on purpose: we build the voice from their real posts, CV and
          edits, and if we already run their X seat we reuse what we know.
        </p>
        {fieldError(error)}
        <Button onClick={saveSeat} disabled={pending} variant="subtle">
          {pending ? "Saving…" : "Save seat"}
        </Button>
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
  const [role, setRole] = useState("");
  const [profileUrl, setProfileUrl] = useState("");
  const [focus, setFocus] = useState("");
  const [offLimits, setOffLimits] = useState("");
  const [fallbackKind, setFallbackKind] = useState("");
  const [fallbackText, setFallbackText] = useState("");

  function add() {
    setError(null);
    start(async () => {
      const result = await addLinkedInSeatAction({
        clientId,
        name,
        role,
        profileUrl,
        focus,
        offLimits,
        fallbackKind,
        fallbackText,
      });
      if (result.error) {
        setError(result.error);
        return;
      }
      setName("");
      setRole("");
      setProfileUrl("");
      setFocus("");
      setOffLimits("");
      setFallbackKind("");
      setFallbackText("");
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
        A seat is one person on your team whose LinkedIn we draft for. If they already have a seat
        for another agent, this adds LinkedIn to the same seat. Attach the CV on the seat&apos;s
        card after adding.
      </p>
      <div className="mt-4 space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <Label htmlFor="la-name">Name</Label>
            <Input id="la-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Full name" />
          </div>
          <div>
            <Label htmlFor="la-role">Company role</Label>
            <Input id="la-role" value={role} onChange={(e) => setRole(e.target.value)} placeholder="In their own words" />
          </div>
        </div>
        <div>
          <Label htmlFor="la-url">LinkedIn profile URL</Label>
          <Input
            id="la-url"
            value={profileUrl}
            onChange={(e) => setProfileUrl(e.target.value)}
            placeholder="linkedin.com/in/their-name (leave empty while they open one)"
          />
        </div>
        <div>
          <Label htmlFor="la-focus">What should their profile focus on? (optional)</Label>
          <Textarea
            id="la-focus"
            rows={2}
            value={focus}
            onChange={(e) => setFocus(e.target.value)}
            placeholder="The 2 to 4 topics they want to be known for."
          />
        </div>
        <div>
          <Label htmlFor="la-offlimits">Anything we must never post</Label>
          <Textarea
            id="la-offlimits"
            rows={2}
            value={offLimits}
            onChange={(e) => setOffLimits(e.target.value)}
            placeholder='Write "nothing" if everything is fair game.'
          />
        </div>
        <FallbackField
          idPrefix="la"
          kind={fallbackKind}
          text={fallbackText}
          onKind={setFallbackKind}
          onText={setFallbackText}
        />
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

/* ──────────────── feedback box (free-form, per account) ─────────────── */

function FeedbackBox({
  clientId,
  seats,
  runs,
  recent,
}: {
  clientId: string;
  seats: LiSeatView[];
  runs: LiRunRowView[];
  recent: LiFeedbackRowView[];
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
      const result = await addLiDraftFeedbackAction({ clientId, account, action: "note", reason: note });
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
          <Label htmlFor="lf-account">This is about</Label>
          <Select id="lf-account" value={account} onChange={(e) => setAccount(e.target.value)}>
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
          placeholder="Explain the problem or the win. Too corporate? Wrong topics? A draft style you want more of? Write it like you would to a teammate."
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

export function LinkedInAgentIntake({
  clientId,
  company,
  seats,
  news,
  feedback,
  runs,
}: {
  clientId: string;
  company: LiIntakeView | null;
  seats: LiSeatView[];
  news: CompanyNewsRowView[];
  feedback: LiFeedbackRowView[];
  runs: LiRunRowView[];
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
      <CompanyNewsBox clientId={clientId} rows={news} />
      <FeedbackBox clientId={clientId} seats={seats} runs={runs} recent={feedback} />
    </div>
  );
}
