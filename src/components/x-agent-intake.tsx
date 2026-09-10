"use client";

/**
 * X agent (e13) intake surfaces: the company-page form, per-person seat forms
 * ("add a seat", repeatable), the two ongoing drop boxes, and per-draft
 * feedback. One canonical set of X surfaces - copy follows the input
 * contract: sentence case, each field says what we do with the answer,
 * optional fields say the product runs without them.
 */

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Badge, Button, Card, CardTitle, Input, Label, Select, Textarea } from "@/components/ui";
import { Icon } from "@/components/icon";
import { CompanyNewsBox, type CompanyNewsRowView } from "@/components/company-news-box";
import { SavedFormCard } from "@/components/saved-form-card";
import { ClientSeatRemove } from "@/components/client-seat-remove";
import { RequiredMark, fieldError } from "@/components/intake-field";
import {
  IntakeFeedbackBox,
  type IntakeFeedbackRowView,
  type IntakeRunRowView,
} from "@/components/intake-feedback-box";
import { intakeAnchorId, intakeSeatAnchorId } from "@/lib/agent-intake-links";
import { intakeSave } from "@/lib/intake-save";
import { CreditPriceNote } from "@/components/credit-price-note";
import { xRosterProposalPrice } from "@/lib/credits";
import {
  addXDraftFeedbackAction,
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
  /** true/false = client-confirmed; undefined = auto-detect. */
  premium?: boolean;
}

export interface XSeatView {
  id: string;
  name: string;
  slug: string;
  intake: XIntakeView | null;
  takes: Array<{ id: string; take: string; date: string; topic?: string }>;
}

/** The shared company news row (SCRUM-51) - see company-news-box.tsx. */
export type XNewsRowView = CompanyNewsRowView;

/**
 * The feedback and run row shapes are the SHARED ones (SCRUM-412) - see
 * intake-feedback-box.tsx. They were declared here and in
 * linkedin-agent-intake.tsx, byte for byte identical, which is what let one
 * 135-line component be written out twice. These aliases keep the `X…` names
 * their readers already import (agent-intake-views.ts) while there is exactly
 * one definition.
 */
export type XFeedbackRowView = IntakeFeedbackRowView;
export type XRunRowView = IntakeRunRowView;

const TAKE_PROMPTS = [
  "What do most people in your space get wrong?",
  "What did you change your mind about recently?",
  "What lesson cost you the most to learn?",
  "What decision did you make this week, and why?",
  "What number from your work would surprise people?",
];

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

const premiumValue = (p?: boolean) => (p === true ? "yes" : p === false ? "no" : "auto");

const premiumSummary = (v: string) => (v === "yes" ? "Yes" : v === "no" ? "No" : "Auto-detect");

/** The roster lives in state as the comma list the field shows. */
function rosterSummary(roster: string): string {
  const count = roster.split(",").filter((h) => h.trim()).length;
  return count === 0 ? "" : `${count} account${count === 1 ? "" : "s"}`;
}

/**
 * Reads the take drop back in the collapsed seat summary. Takes arrive newest
 * first, and each carries the date it was dropped. No takes stays empty for the
 * summary card's own empty-value treatment.
 */
function takesSummary(takes: XSeatView["takes"]): string {
  const latest = takes[0];
  if (!latest) return "";
  return `${takes.length} take${takes.length === 1 ? "" : "s"} · latest ${latest.date}`;
}

/** X Premium tri-state: auto-detect by default, pin it when the client knows. */
function PremiumField({
  idPrefix,
  value,
  onChange,
}: {
  idPrefix: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="max-w-xs">
      <Label htmlFor={`${idPrefix}-premium`}>X Premium</Label>
      <Select id={`${idPrefix}-premium`} value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="auto">Auto-detect</option>
        <option value="yes">Yes, has Premium</option>
        <option value="no">No, standard account</option>
      </Select>
      <p className="mt-1 text-xs text-muted">
        Premium accounts can post past 280 characters, so long-form posts become an option where
        the account&apos;s style fits. Auto-detect reads the account live.
      </p>
    </div>
  );
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
  viewerIsBilled,
}: {
  clientId: string;
  seatName?: string;
  value: string;
  onChange: (v: string) => void;
  idPrefix: string;
  helper: string;
  /** `isBillableClientActor()` — decides whose money the quote names, not the figure. */
  viewerIsBilled: boolean;
}) {
  const [proposing, startProposing] = useTransition();
  const [why, setWhy] = useState<Array<{ handle: string; why: string }> | null>(null);
  const [error, setError] = useState<string | null>(null);

  function propose() {
    setError(null);
    startProposing(async () => {
      const result = await intakeSave(
        () => proposeXRosterAction({ clientId, ...(seatName ? { seatName } : {}) }),
        // Not a save: this builds a proposal. The funnel's save sentence would
        // also have WON over this call site's own "Could not build a proposal."
        // below, because `result.error ?? …` prefers whatever the funnel put there.
        "We couldn't build a proposal. Refresh the page to check you're still signed in, then try again.",
      );
      // `handles` exists only on the action's own result, never on the funnel's
      // failure — so it is read through the narrowing rather than asserted.
      const handles = "handles" in result ? result.handles : undefined;
      if (result.error || !handles) {
        setError(result.error ?? "Could not build a proposal.");
        return;
      }
      onChange(handles.map((h) => h.handle).join(", "));
      setWhy(handles);
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
        placeholder="@handle, @handle. Or let us propose a list"
      />
      <p className="mt-1 text-xs text-muted">{helper}</p>
      {/* R3: the press charges a credit the moment it is made — there is no
          confirm step and re-pressing to refresh charges again — and it used to
          quote nothing. Quoted from the same constant the action charges from. */}
      <CreditPriceNote
        price={xRosterProposalPrice(true)}
        viewerIsBilled={viewerIsBilled}
        className="mt-1"
      />
      {fieldError(error)}
      {why && why.length > 0 ? (
        <ul className="mt-2 space-y-1 rounded-md border border-border bg-surface-2 p-3">
          {why.map((h) => (
            <li key={h.handle} className="text-xs text-muted">
              <span className="text-foreground">{h.handle}</span> · {h.why}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/* ─────────────────────── company page form ─────────────────────── */

function CompanyForm({
  clientId,
  intake,
  viewerIsBilled,
}: {
  clientId: string;
  intake: XIntakeView | null;
  /** Threaded to RosterInput, whose "Propose accounts" press charges. */
  viewerIsBilled: boolean;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(!intake);
  const [handle, setHandle] = useState(intake?.handle ?? "");
  const [comeAcross, setComeAcross] = useState(intake?.comeAcross ?? "");
  const [offLimits, setOffLimits] = useState(intake?.offLimits ?? "");
  const [roster, setRoster] = useState(intake?.roster.join(", ") ?? "");
  const [premium, setPremium] = useState(premiumValue(intake?.premium));
  const [announcements, setAnnouncements] = useState("");

  function save() {
    setError(null);
    start(async () => {
      const result = await intakeSave(() =>
        saveXCompanyIntakeAction({ clientId, handle, comeAcross, offLimits, roster, premium, announcements }),
      );
      if (result.error) {
        setError(result.error);
        return;
      }
      // One-shot drop: clearing it keeps a second save from posting it twice.
      setAnnouncements("");
      setEditing(false);
      router.refresh();
    });
  }

  function cancel() {
    setError(null);
    setHandle(intake?.handle ?? "");
    setComeAcross(intake?.comeAcross ?? "");
    setOffLimits(intake?.offLimits ?? "");
    setRoster(intake?.roster.join(", ") ?? "");
    setPremium(premiumValue(intake?.premium));
    setAnnouncements("");
    setEditing(false);
  }

  return (
    <SavedFormCard
      title="Company page"
      /* R7: "Not set up" is the roster's phrase for an agent whose stand-up has
         not run. This badge answers a different question — is the form saved —
         and one vocabulary must not carry two states. */
      badge={intake ? <Badge tone="success">On file</Badge> : <Badge tone="warning">Not saved yet</Badge>}
      summary={[
        { label: "Company X handle", value: handle },
        { label: "How you come across on X", value: comeAcross },
        { label: "Anything we must never post", value: offLimits },
        { label: "Accounts to engage", value: rosterSummary(roster) },
        { label: "X Premium", value: premiumSummary(premium) },
      ]}
      open={editing}
      onEdit={() => setEditing(true)}
    >
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
          <Label htmlFor="xc-voice">
            How do you want to come across on X?
            <RequiredMark />
          </Label>
          <Textarea
            id="xc-voice"
            rows={2}
            value={comeAcross}
            onChange={(e) => setComeAcross(e.target.value)}
            placeholder="One or two lines. This is the only voice question we ask."
          />
        </div>
        <div>
          <Label htmlFor="xc-offlimits">
            Anything we must never post
            <RequiredMark />
          </Label>
          <Textarea
            id="xc-offlimits"
            rows={2}
            value={offLimits}
            onChange={(e) => setOffLimits(e.target.value)}
            placeholder='Topics, client names, specific numbers. Write "nothing" if everything is fair game.'
          />
        </div>
        <PremiumField idPrefix="xc" value={premium} onChange={setPremium} />
        <RosterInput
          clientId={clientId}
          value={roster}
          onChange={setRoster}
          idPrefix="xc"
          viewerIsBilled={viewerIsBilled}
          helper="Optional; this turns on the engagement lane. We propose from what we already know about your business. You approve or edit. Every handle is verified live before any engagement."
        />
        {!intake ? (
          <div>
            <Label htmlFor="xc-announce">Anything worth announcing right now? (optional)</Label>
            <Textarea
              id="xc-announce"
              rows={3}
              value={announcements}
              onChange={(e) => setAnnouncements(e.target.value)}
              placeholder="One per line. A launch, a milestone, a hire. A line each is enough; we turn them into posts."
            />
          </div>
        ) : null}
        {fieldError(error)}
        <div className="flex items-center gap-3">
          <Button onClick={save} disabled={pending}>
            {pending ? "Saving…" : "Save company page"}
          </Button>
          {intake ? (
            <Button variant="ghost" onClick={cancel} disabled={pending}>
              Cancel
            </Button>
          ) : null}
        </div>
      </div>
    </SavedFormCard>
  );
}

/* ────────────────────────── seat cards ─────────────────────────── */

/**
 * The take drop is an ongoing input, not setup, so it sits outside the seat
 * form's collapse and stays usable whatever state the form is in.
 */
function SeatTakes({ clientId, seat }: { clientId: string; seat: XSeatView }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [take, setTake] = useState("");
  const [topic, setTopic] = useState("");
  const [takeUrl, setTakeUrl] = useState("");
  const [takeError, setTakeError] = useState<string | null>(null);
  const promptIndex = seat.takes.length % TAKE_PROMPTS.length;

  function submitTake() {
    setTakeError(null);
    start(async () => {
      const result = await intakeSave(() =>
        addXTakeAction({
          clientId,
          seatId: seat.id,
          take,
          date: today(),
          topic,
          url: takeUrl,
        }),
      );
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
    <div className="mt-4 border-t border-border pt-4">
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
            placeholder="Source link. Only if your take contains a number"
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
  );
}

function SeatCard({
  clientId,
  seat,
  runInFlight,
  viewerIsBilled,
}: {
  clientId: string;
  seat: XSeatView;
  /** Passed through to the remove confirm — see ClientSeatRemove. */
  runInFlight: boolean;
  /** Threaded to RosterInput, whose "Propose accounts" press charges. */
  viewerIsBilled: boolean;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(!seat.intake);
  const [handle, setHandle] = useState(seat.intake?.handle ?? "");
  const [offLimits, setOffLimits] = useState(seat.intake?.offLimits ?? "");
  const [roster, setRoster] = useState(seat.intake?.roster.join(", ") ?? "");
  const [premium, setPremium] = useState(premiumValue(seat.intake?.premium));

  function saveSeat() {
    setError(null);
    start(async () => {
      const result = await intakeSave(() =>
        saveXSeatIntakeAction({ clientId, seatId: seat.id, handle, offLimits, roster, premium }),
      );
      if (result.error) {
        setError(result.error);
        return;
      }
      setEditing(false);
      router.refresh();
    });
  }

  function cancelSeat() {
    setError(null);
    setHandle(seat.intake?.handle ?? "");
    setOffLimits(seat.intake?.offLimits ?? "");
    setRoster(seat.intake?.roster.join(", ") ?? "");
    setPremium(premiumValue(seat.intake?.premium));
    setEditing(false);
  }

  return (
    <SavedFormCard
      title={seat.name}
      badge={
        seat.intake?.handle ? (
          <Badge tone="success">{seat.intake.handle}</Badge>
        ) : (
          <Badge tone="warning">Handle pending, drafts only</Badge>
        )
      }
      summary={[
        { label: "Your X handle", value: handle },
        { label: "Anything we must never post", value: offLimits },
        { label: "Accounts you want to be near", value: rosterSummary(roster) },
        { label: "X Premium", value: premiumSummary(premium) },
        { label: "Your takes and topics", value: takesSummary(seat.takes) },
      ]}
      open={editing}
      onEdit={() => setEditing(true)}
      footer={
        <>
          <SeatTakes clientId={clientId} seat={seat} />
          {/* In the footer so it renders in BOTH states: a seat added by
              mistake is one nobody has opened, and hiding the way back behind
              "Edit" is how it became permanent. */}
          <ClientSeatRemove
            clientId={clientId}
            seatId={seat.id}
            seatName={seat.name}
            runInFlight={runInFlight}
          />
        </>
      }
    >
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
            viewerIsBilled={viewerIsBilled}
            helper="Optional; this turns on your engagement lane. We propose people worth being near. You approve or edit."
          />
        </div>
        <div>
          <Label htmlFor={`xs-offlimits-${seat.id}`}>
            Anything we must never post
            <RequiredMark />
          </Label>
          <Textarea
            id={`xs-offlimits-${seat.id}`}
            rows={2}
            value={offLimits}
            onChange={(e) => setOffLimits(e.target.value)}
            placeholder='Topics, names, numbers. Write "nothing" if everything is fair game.'
          />
        </div>
        <PremiumField idPrefix={`xs-${seat.id}`} value={premium} onChange={setPremium} />
        <p className="text-xs text-muted">
          No voice questions here on purpose: if we already run your LinkedIn we reuse that voice, and
          otherwise we build it from your profile and sharpen it from your real posts and edits.
        </p>
        {fieldError(error)}
        <div className="flex items-center gap-3">
          <Button onClick={saveSeat} disabled={pending} variant="subtle">
            {pending ? "Saving…" : "Save seat"}
          </Button>
          {seat.intake ? (
            <Button variant="ghost" onClick={cancelSeat} disabled={pending}>
              Cancel
            </Button>
          ) : null}
        </div>

      </div>
    </SavedFormCard>
  );
}

function AddSeatForm({
  clientId,
  viewerIsBilled,
}: {
  clientId: string;
  /** Threaded to RosterInput, whose "Propose accounts" press charges. */
  viewerIsBilled: boolean;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [handle, setHandle] = useState("");
  const [offLimits, setOffLimits] = useState("");
  const [roster, setRoster] = useState("");
  const [premium, setPremium] = useState("auto");
  const [firstTakes, setFirstTakes] = useState("");

  function add() {
    setError(null);
    start(async () => {
      const result = await intakeSave(() =>
        addXSeatAction({ clientId, name, handle, offLimits, roster, premium, firstTakes }),
      );
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
          <Label htmlFor="xa-offlimits">
            Anything we must never post
            <RequiredMark />
          </Label>
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
          viewerIsBilled={viewerIsBilled}
          helper="Optional; this turns on your engagement lane. We propose people worth being near. You approve or edit."
        />
        <PremiumField idPrefix="xa" value={premium} onChange={setPremium} />
        <div>
          <Label htmlFor="xa-takes">Your first takes</Label>
          <Textarea
            id="xa-takes"
            rows={4}
            value={firstTakes}
            onChange={(e) => setFirstTakes(e.target.value)}
            placeholder={"3 to 5 rough one-liners of what you actually think. One per line.\nGTM, hiring, AI, the grind. We turn each into a post in your voice."}
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

/* ────────────────────────── the page body ───────────────────────── */

export function XAgentIntake({
  clientId,
  company,
  seats,
  news,
  feedback,
  runs,
  runInFlight,
  viewerIsBilled = true,
  isStaff,
}: {
  clientId: string;
  company: XIntakeView | null;
  seats: XSeatView[];
  news: XNewsRowView[];
  feedback: XFeedbackRowView[];
  runs: XRunRowView[];
  /**
   * A run this agent has in flight already holds its payload, so the remove
   * confirm says a removed seat may still come back with drafts (#84).
   *
   * A PROP, not `runs.some(…)`. `runs` is the DISPLAY list, and for a client it
   * is collapsed to one row per calendar day — so a run queued at 09:00 is not
   * in it once a later run the same day lands, and the warning went to staff
   * and not to the client who pressed Remove. The server answers this from the
   * unfiltered scan (see `anyRunInFlight` in lib/agent-intake-views.ts).
   */
  runInFlight: boolean;
  /**
   * `isBillableClientActor()` for this session. Decides whose money the
   * "Propose accounts" quote names — never whether a figure appears at all,
   * which is the parity rule refresh-task-map-button.tsx set.
   */
  viewerIsBilled?: boolean;
  /** Whose vocabulary the run rows are written in - see IntakeFeedbackBox. */
  isStaff: boolean;
}) {
  return (
    <div className="space-y-6">
      {/* The anchors the agent page's inputs band links each of its rows to
          (#85). Both sides derive them from the SAME row id through
          intakeAnchorId, so a row cannot end up pointing at a hash that
          matches nothing — which scrolls nowhere and raises nothing. */}
      <div id={intakeAnchorId("company")} className="scroll-mt-24">
        <CompanyForm clientId={clientId} intake={company} viewerIsBilled={viewerIsBilled} />
      </div>
      {/* The takes row is client-wide (its count is every seat's takes) and the
          take boxes live one per seat card, so the seat LIST is where that row
          lands — there is no single takes surface to point at. */}
      <div id={intakeAnchorId("takes")} className="space-y-4 scroll-mt-24">
        {seats.map((seat) => (
          <div key={seat.id} id={intakeSeatAnchorId(seat.id)} className="scroll-mt-24">
            <SeatCard
              clientId={clientId}
              seat={seat}
              runInFlight={runInFlight}
              viewerIsBilled={viewerIsBilled}
            />
          </div>
        ))}
        <AddSeatForm clientId={clientId} viewerIsBilled={viewerIsBilled} />
      </div>
      <div id={intakeAnchorId("news")} className="scroll-mt-24">
        <CompanyNewsBox clientId={clientId} rows={news} />
      </div>
      <IntakeFeedbackBox
        clientId={clientId}
        family="x"
        seats={seats}
        runs={runs}
        recent={feedback}
        isStaff={isStaff}
        sendNote={addXDraftFeedbackAction}
      />
    </div>
  );
}
