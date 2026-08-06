"use client";

/**
 * Newsletter agent (v2) intake surfaces: the setup band, the client's own
 * configuration, and free-form feedback. Copy follows the input contract:
 * sentence case, each field says what we do with the answer, optional fields say
 * the product runs without them.
 *
 * What is deliberately NOT asked, because setup builds it from the material the
 * client already gave us: the content pillars, the voice card, the topic pool,
 * the niche watch-list, the compliance block, the keyword targets. Asking for
 * any of them would put a second author on files whose framework names setup as
 * their single writer of record.
 *
 * NO SEATS AND NO NEWS DROP. An issue goes out from the business, never from a
 * person, so there is one company form and nothing else; and the seven-day scan
 * FINDS what happened in the client's niche rather than being told.
 */

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Badge, Button, Card, CardTitle, Input, Label, Select, Textarea } from "@/components/ui";
import { SavedFormCard } from "@/components/saved-form-card";
import { JobStatusBadge } from "@/components/job-status";
import { formatDate, relativeTime } from "@/lib/utils";
import type { JobStatus } from "@/lib/types";
import { clientArchiveLink, intakeAnchorId } from "@/lib/agent-intake-links";
import { intakeSave } from "@/lib/intake-save";
import {
  addNewsletterDraftFeedbackAction,
  runNewsletterSetupAction,
  saveNewsletterCompanyIntakeAction,
} from "@/lib/actions/newsletter-agent-actions";

/* ── client-safe props (serialized server-side) ── */

export interface NewsletterIntakeView {
  /**
   * 0=Sun..6=Sat, or null for "no day chosen yet".
   *
   * NULL AND UNDEFINED MEAN THE SAME THING HERE and both must render as "not
   * chosen". The framework is explicit that the weekday belongs to the client
   * and that several existing files wrongly assert Tuesday, so this surface
   * never shows a day nobody picked.
   */
  preferredWeekday?: number | null;
  espName?: string;
  audienceNote?: string;
  bannedPhrases?: string[];
  openComplianceNote?: string;
}

export interface NewsletterFeedbackRowView {
  id: string;
  action: string;
  /** The issue the row is about, as the run numbered it. */
  issueNumber?: string;
  reasonCode?: string;
  createdAt: number;
}

export interface NewsletterRunRowView {
  id: string;
  /** Typed so the row renders through JobStatusBadge, never the raw word. */
  status: JobStatus;
  createdAt: number;
  href?: string;
}

function fieldError(error: string | null) {
  return error ? <p className="mt-2 text-xs text-red-400">{error}</p> : null;
}

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** The chosen day as a person reads it — never a default, see `preferredWeekday`. */
function weekdayLabel(day: number | null | undefined): string {
  return day === null || day === undefined ? "" : (WEEKDAYS[day] ?? "");
}

/* ─────────────────────── the setup band ─────────────────────── */

/**
 * The one-time stand-up, as a button and a status rather than a form.
 *
 * Setup is a separate skill from the writer and it is what produces the issue
 * index, the voice card, the topic pool and the watch-list. Until it has run
 * there is nothing to write from: the writer claims an issue number in that
 * index at its very first step, so a run started before this would be charged
 * for and die immediately. Both submit cores refuse it, and this is where the
 * press that unblocks them lives.
 */
function SetupBand({
  clientId,
  isSetUp,
  detailsOnFile,
}: {
  clientId: string;
  isSetUp: boolean;
  detailsOnFile: boolean;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [fired, setFired] = useState(false);

  function run() {
    setError(null);
    start(async () => {
      const result = await intakeSave(() => runNewsletterSetupAction({ clientId }));
      if (result.error) {
        setError(result.error);
        return;
      }
      setFired(true);
      router.refresh();
    });
  }

  if (isSetUp) {
    return (
      <Card className="p-5">
        <div className="flex items-center justify-between gap-3">
          <CardTitle>Your newsletter is set up</CardTitle>
          <Badge tone="success">Ready</Badge>
        </div>
        <p className="mt-1 text-sm text-muted">
          The topics, the voice and the issue numbering are all in place. Every weekly run reads
          them, and your answers below keep steering them.
        </p>
      </Card>
    );
  }

  return (
    <Card className="p-5">
      <div className="flex items-center justify-between gap-3">
        <CardTitle>We need to set this up first</CardTitle>
        <Badge tone="warning">Not set up</Badge>
      </div>
      <p className="mt-1 text-sm text-muted">
        One run works out what your newsletter is: the subjects you write about, how it sounds,
        a runway of topics to draw from, and the numbering every future issue follows. It is all
        built from the material you already gave us, and nothing is sent. After this, every run
        prepares one issue for you to send.
      </p>
      {fired ? (
        <p className="mt-3 text-sm text-muted">
          Setup is running. This page updates itself when it finishes.
        </p>
      ) : (
        <>
          {!detailsOnFile ? (
            <p className="mt-3 text-xs text-muted-2">
              Save your details below first, so setup knows your rules.
            </p>
          ) : null}
          {fieldError(error)}
          <Button onClick={run} disabled={pending || !detailsOnFile} className="mt-3">
            {pending ? "Starting…" : "Set it up"}
          </Button>
        </>
      )}
    </Card>
  );
}

/* ─────────────────────── the details form ─────────────────────── */

function DetailsForm({
  clientId,
  intake,
}: {
  clientId: string;
  intake: NewsletterIntakeView | null;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(!intake);
  const [preferredWeekday, setPreferredWeekday] = useState(
    intake?.preferredWeekday === null || intake?.preferredWeekday === undefined
      ? ""
      : String(intake.preferredWeekday),
  );
  const [espName, setEspName] = useState(intake?.espName ?? "");
  const [audienceNote, setAudienceNote] = useState(intake?.audienceNote ?? "");
  const [bannedPhrases, setBannedPhrases] = useState((intake?.bannedPhrases ?? []).join("\n"));
  const [openComplianceNote, setOpenComplianceNote] = useState(intake?.openComplianceNote ?? "");

  function save() {
    setError(null);
    start(async () => {
      const result = await intakeSave(() =>
        saveNewsletterCompanyIntakeAction({
          clientId,
          preferredWeekday,
          espName,
          audienceNote,
          bannedPhrases,
          openComplianceNote,
        }),
      );
      if (result.error) {
        setError(result.error);
        return;
      }
      setEditing(false);
      router.refresh();
    });
  }

  function cancel() {
    setError(null);
    setPreferredWeekday(
      intake?.preferredWeekday === null || intake?.preferredWeekday === undefined
        ? ""
        : String(intake.preferredWeekday),
    );
    setEspName(intake?.espName ?? "");
    setAudienceNote(intake?.audienceNote ?? "");
    setBannedPhrases((intake?.bannedPhrases ?? []).join("\n"));
    setOpenComplianceNote(intake?.openComplianceNote ?? "");
    setEditing(false);
  }

  return (
    <SavedFormCard
      title="Your newsletter details"
      badge={
        intake ? <Badge tone="success">On file</Badge> : <Badge tone="warning">Not set up</Badge>
      }
      summary={[
        // Read off the SAVED view, not the live field, so the collapsed card
        // shows what the agent will actually run on rather than unsaved typing.
        { label: "Day you want it", value: weekdayLabel(intake?.preferredWeekday) },
        { label: "Where you send from", value: intake?.espName ?? "" },
        { label: "Who it is for", value: intake?.audienceNote ?? "" },
        { label: "Phrases we may never print", value: (intake?.bannedPhrases ?? []).join(", ") },
      ]}
      open={editing}
      onEdit={() => setEditing(true)}
    >
      <p className="mt-1 text-sm text-muted">
        We prepare a complete issue each week and you send it from your own platform. What your
        newsletter is about, how it sounds and what it covers next are all worked out from the
        material you already gave us; this form only covers what we cannot work out.
      </p>
      <div className="mt-4 space-y-4">
        <div>
          <Label htmlFor="nl-day">Which day would you like your issue ready?</Label>
          <Select
            id="nl-day"
            value={preferredWeekday}
            onChange={(e) => setPreferredWeekday(e.target.value)}
          >
            {/* The empty option is a real answer, not a placeholder. Nothing in
                this product may assume a day the client has not picked. */}
            <option value="">No day chosen yet</option>
            {WEEKDAYS.map((day, index) => (
              <option key={day} value={String(index)}>
                {day}
              </option>
            ))}
          </Select>
          <p className="mt-1 text-xs text-muted">
            We prepare it ahead of the day you pick, so it is waiting when you want to send. Leave
            it unchosen and we will not assume one.
          </p>
        </div>
        <div>
          <Label htmlFor="nl-esp">Where do you send your newsletter from? (optional)</Label>
          <Input
            id="nl-esp"
            value={espName}
            onChange={(e) => setEspName(e.target.value)}
            placeholder="Mailchimp, Beehiiv, Klaviyo, your own tool…"
          />
          <p className="mt-1 text-xs text-muted">
            Only so we know what to hand you. We prepare the issue; you send it from your own
            platform, and we never need access to it.
          </p>
        </div>
        <div>
          <Label htmlFor="nl-audience">Who is this newsletter for? (optional)</Label>
          <Textarea
            id="nl-audience"
            rows={2}
            value={audienceNote}
            onChange={(e) => setAudienceNote(e.target.value)}
            placeholder="For example: founders at seed-stage B2B companies who are doing their own marketing."
          />
          <p className="mt-1 text-xs text-muted">
            We work your audience out from your onboarding material. This is your chance to correct
            us if the person you picture is not the one we would have guessed.
          </p>
        </div>
        <div>
          <Label htmlFor="nl-banned">Anything we must never print? (optional)</Label>
          <Textarea
            id="nl-banned"
            rows={3}
            value={bannedPhrases}
            onChange={(e) => setBannedPhrases(e.target.value)}
            placeholder={"One per line, or separated by commas.\nguaranteed returns\nrisk-free"}
          />
          <p className="mt-1 text-xs text-muted">
            Exact phrases, claims your regulator forbids, competitor names. We check every issue
            against this list and hold the whole issue rather than quietly rewriting it. Our own
            house rules apply either way.
          </p>
        </div>
        <div>
          <Label htmlFor="nl-compliance">
            Anything still unresolved with your legal or compliance team? (optional)
          </Label>
          <Textarea
            id="nl-compliance"
            rows={2}
            value={openComplianceNote}
            onChange={(e) => setOpenComplianceNote(e.target.value)}
            placeholder="For example: we are still waiting on wording for the disclaimer in the footer."
          />
          <p className="mt-1 text-xs text-muted">
            We will flag this at the top of every issue until you tell us it is settled, so whoever
            presses send reads it first.
          </p>
        </div>
        {fieldError(error)}
        <div className="flex items-center gap-3">
          <Button onClick={save} disabled={pending}>
            {pending ? "Saving…" : "Save details"}
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

/* ─────────────────────────── feedback ─────────────────────────── */

const REASON_LABEL: Record<string, string> = {
  off_topic: "wrong subject",
  wrong_voice: "did not sound like us",
  compliance: "compliance problem",
  too_long: "too long",
  timing: "wrong timing",
  other: "other",
};

const ACTION_LABEL: Record<string, string> = {
  sent: "Sent",
  sent_with_edits: "Sent with edits",
  not_sent: "Not sent",
  note: "Feedback",
  edit_request: "Change requested",
};

function FeedbackBox({
  clientId,
  runs,
  recent,
  isStaff,
}: {
  clientId: string;
  runs: NewsletterRunRowView[];
  recent: NewsletterFeedbackRowView[];
  isStaff: boolean;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const [note, setNote] = useState("");
  // #90: `?tab=archive` is read only by ProgressView, and a staff viewer at the
  // flat /tasks never gets one. The destination and its label move together.
  const archive = clientArchiveLink({ clientId, isStaff });

  function submit() {
    setError(null);
    setSent(false);
    start(async () => {
      const result = await intakeSave(() =>
        addNewsletterDraftFeedbackAction({ clientId, action: "note", reason: note }),
      );
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
      {/* F28: the archive holds APPROVED work, so a fresh issue is not there
          yet and a client sent looking for one finds an empty page. Name the
          approval step, and link the archive rather than describing it. */}
      <p className="mt-1 text-sm text-muted">
        Tell us what is working and what is not, in your own words. It goes straight into the next
        issue. Once your Karos team has approved an issue, telling us whether you sent it happens on
        the issue itself, in{" "}
        <a href={archive.href} className="underline hover:text-foreground">
          {archive.label}
        </a>
        , and that is the signal that sharpens the writing fastest.
      </p>
      {runs.length > 0 ? (
        <ul className="mt-3 space-y-1.5">
          {runs.slice(0, 4).map((r) => {
            // A3/A4: staff keep the machinery noun and the exact instant, which
            // is what they debug with; a client gets the relative language every
            // other client-facing stamp uses.
            const label = isStaff
              ? `Run ${formatDate(r.createdAt)}`
              : `Worked on your content · ${relativeTime(r.createdAt)}`;
            return (
              <li key={r.id} className="flex items-center gap-2 text-xs text-muted">
                {r.href ? (
                  <a href={r.href} className="underline hover:text-foreground">
                    {label}
                  </a>
                ) : (
                  <span>{label}</span>
                )}
                <JobStatusBadge status={r.status} />
              </li>
            );
          })}
        </ul>
      ) : null}
      <div className="mt-4 space-y-3">
        <Textarea
          rows={5}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Explain the problem or the win. Subject lines not landing? Too long? A section your readers replied to? Write it like you would to a teammate."
        />
        {fieldError(error)}
        <div className="flex items-center gap-3">
          <Button onClick={submit} disabled={pending || !note.trim()}>
            {pending ? "Sending…" : "Send feedback"}
          </Button>
          {sent ? <span className="text-xs text-muted">Sent. It feeds the next issue.</span> : null}
        </div>
      </div>
      {recent.length > 0 ? (
        <ul className="mt-4 space-y-2 border-t border-border pt-4">
          {recent.slice(0, 6).map((f) => (
            <li key={f.id} className="text-xs text-muted">
              <span className="text-foreground">
                {ACTION_LABEL[f.action] ?? f.action.replace(/_/g, " ")}
              </span>
              {f.reasonCode ? ` · ${REASON_LABEL[f.reasonCode] ?? f.reasonCode}` : ""}
              {f.issueNumber ? ` · issue ${f.issueNumber}` : ""} · {relativeTime(f.createdAt)}
            </li>
          ))}
        </ul>
      ) : null}
    </Card>
  );
}

/* ────────────────────────── the page body ───────────────────────── */

export function NewsletterAgentIntake({
  clientId,
  company,
  isSetUp,
  feedback,
  runs,
  isStaff,
}: {
  clientId: string;
  company: NewsletterIntakeView | null;
  /**
   * Has v2 setup produced an issue index for this client? Answered from the same
   * row the submit core gates on, so the band and the server agree about what
   * "set up" means. Absent on props built before setup existed — treated as set
   * up, so an older caller never shows a client a step that is not theirs.
   */
  isSetUp?: boolean;
  feedback: NewsletterFeedbackRowView[];
  runs: NewsletterRunRowView[];
  /** Whose vocabulary the run rows are written in — see FeedbackBox. */
  isStaff: boolean;
}) {
  return (
    <div className="space-y-6">
      <SetupBand clientId={clientId} isSetUp={isSetUp ?? true} detailsOnFile={company !== null} />
      {/* The same anchor the other three surfaces carry for the agent page's
          inputs band (#85), minted from the shared helper rather than spelled
          by hand. Newsletter has no seats and no news drop, so "company" would
          be the whole set.

          NOTHING LINKS TO IT YET, and that is worth stating rather than
          implying: `intakeFamilyFor` in agent-detail-sections.ts answers null
          for this family, so the band does not render on a newsletter agent's
          page at all. Wiring it needs `toAgentInputRows` to stop keying its
          seat and news-drop guards on `agent !== "reddit"` — newsletter has
          neither either — which is a change to shared projection logic and its
          tests, not to this file. The anchor is here so that when the band does
          arrive it lands somewhere, and because a stable deep link costs
          nothing. */}
      <div id={intakeAnchorId("company")} className="scroll-mt-24">
        <DetailsForm clientId={clientId} intake={company} />
      </div>
      <FeedbackBox clientId={clientId} runs={runs} recent={feedback} isStaff={isStaff} />
    </div>
  );
}
