"use client";

/**
 * Reddit agent (e15) intake surfaces: the account form and free-form feedback.
 * Copy follows the input contract: sentence case, each field says what we do
 * with the answer, optional fields say the product runs without them.
 *
 * What is deliberately NOT asked, because the agent builds it: the subreddit
 * roster, the recurring questions worth answering, the answer formulas, and the
 * voice. The form only collects what research cannot reach - which account we
 * draft as, an honest read of its history, where the client has already been
 * burned, and their disclosure wording.
 *
 * Platform-identity rule: this surface only ever asks for Reddit identity.
 * There are no seats here (Reddit manages accounts, and the portal collects one
 * company account for now) and no news drop - Reddit answers questions, it does
 * not broadcast company news.
 */

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Badge, Button, Card, CardTitle, Input, Label, Select, Textarea } from "@/components/ui";
import { SavedFormCard } from "@/components/saved-form-card";
import { JobStatusBadge } from "@/components/job-status";
import { formatDate, relativeTime } from "@/lib/utils";
import type { JobStatus } from "@/lib/types";
import { IntakeNoRuns } from "@/components/intake-no-runs";
import { clientArchiveLink, intakeAnchorId } from "@/lib/agent-intake-links";
import { intakeSave } from "@/lib/intake-save";
import {
  addRedditDraftFeedbackAction,
  saveRedditCompanyIntakeAction,
} from "@/lib/actions/reddit-agent-actions";

/* ── client-safe props (serialized server-side) ── */

export interface RedditIntakeView {
  handle: string | null;
  accountHistory?: string;
  subreddits?: string[];
  offLimitsSubreddits?: string[];
  disclosurePosture?: string;
  offLimits: string;
  mode?: "warming" | "established";
}

export interface RedditFeedbackRowView {
  id: string;
  account: string;
  action: string;
  /**
   * The lane this row was written against, humanised server-side
   * (agent-intake-views' draftLabelOf). Absent when the stored ref names no
   * lane; the raw ref never crosses — it is the log's join key, not copy.
   */
  draftLabel?: string;
  subreddit?: string;
  reasonCode?: string;
  createdAt: number;
}

export interface RedditRunRowView {
  id: string;
  /** Typed so the row renders through JobStatusBadge, never the raw word. */
  status: JobStatus;
  createdAt: number;
  href?: string;
}

function fieldError(error: string | null) {
  return error ? <p className="mt-2 text-xs text-danger">{error}</p> : null;
}

const MODE_SUMMARY: Record<string, string> = {
  warming: "Value only, no mentions",
  established: "Mentions allowed where the subreddit permits",
};

/* ─────────────────────── the account form ─────────────────────── */

function AccountForm({ clientId, intake }: { clientId: string; intake: RedditIntakeView | null }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(!intake);
  const [username, setUsername] = useState(intake?.handle ?? "");
  const [accountHistory, setAccountHistory] = useState(intake?.accountHistory ?? "");
  const [subreddits, setSubreddits] = useState((intake?.subreddits ?? []).join(", "));
  const [offLimitsSubreddits, setOffLimitsSubreddits] = useState(
    (intake?.offLimitsSubreddits ?? []).join(", "),
  );
  const [disclosurePosture, setDisclosurePosture] = useState(intake?.disclosurePosture ?? "");
  const [offLimits, setOffLimits] = useState(intake?.offLimits ?? "");
  const [mode, setMode] = useState(intake?.mode ?? "");

  function save() {
    setError(null);
    start(async () => {
      const result = await intakeSave(() =>
        saveRedditCompanyIntakeAction({
          clientId,
          username,
          accountHistory,
          subreddits,
          offLimitsSubreddits,
          disclosurePosture,
          offLimits,
          mode,
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
    setUsername(intake?.handle ?? "");
    setAccountHistory(intake?.accountHistory ?? "");
    setSubreddits((intake?.subreddits ?? []).join(", "));
    setOffLimitsSubreddits((intake?.offLimitsSubreddits ?? []).join(", "));
    setDisclosurePosture(intake?.disclosurePosture ?? "");
    setOffLimits(intake?.offLimits ?? "");
    setMode(intake?.mode ?? "");
    setEditing(false);
  }

  return (
    <SavedFormCard
      title="Your Reddit account"
      /* R7 (flow audit 2026-09): "Not set up" is the roster's phrase for an
         agent whose stand-up run has not happened. This badge answers a
         different question — is the form saved — and its five sibling intakes
         now all say so in these words. */
      badge={intake ? <Badge tone="success">On file</Badge> : <Badge tone="warning">Not saved yet</Badge>}
      summary={[
        { label: "Account we draft as", value: intake?.handle ?? "" },
        { label: "Account history", value: accountHistory },
        { label: "Subreddits you are already in", value: subreddits },
        { label: "Off-limits subreddits", value: offLimitsSubreddits },
        { label: "How you want mentions handled", value: MODE_SUMMARY[mode] ?? "" },
      ]}
      open={editing}
      onEdit={() => setEditing(true)}
    >
      <p className="mt-1 text-sm text-muted">
        Reddit rewards a real person being genuinely helpful, so we draft replies for you to post
        yourself. We never post to Reddit. We work out which subreddits your audience is in and
        which questions keep coming up; this form only covers what we cannot research.
      </p>
      <div className="mt-4 space-y-4">
        <div>
          <Label htmlFor="rd-user">Which account should we draft as?</Label>
          <Input
            id="rd-user"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="u/your-account (leave empty if you have not picked one yet)"
          />
          <p className="mt-1 text-xs text-muted">
            A real account with normal history does far better than a brand account, and is far
            safer. We draft either way, but nothing can be posted until you have one.
          </p>
        </div>
        <div>
          <Label htmlFor="rd-history">How much history does that account have? (optional)</Label>
          <Textarea
            id="rd-history"
            rows={2}
            value={accountHistory}
            onChange={(e) => setAccountHistory(e.target.value)}
            placeholder="Roughly how old it is, its karma, and whether it has posted normally before. A rough answer is fine."
          />
          <p className="mt-1 text-xs text-muted">
            This decides whether we can ever mention your product. A new or promotional-looking
            account gets value-only replies until it has earned real history. Some subreddits also
            refuse accounts under a month old, and we check that before drafting for them.
          </p>
        </div>
        <div>
          <Label htmlFor="rd-mode">How should we handle mentioning you?</Label>
          <Select id="rd-mode" value={mode} onChange={(e) => setMode(e.target.value)}>
            <option value="">Decide from the account history above</option>
            <option value="warming">Never mention us for now, pure help only</option>
            <option value="established">Mention us where the subreddit allows it and it truly fits</option>
          </Select>
          <p className="mt-1 text-xs text-muted">
            Every reply has to stand on its own even with any mention removed. When we do mention
            you, we say who we are.
          </p>
        </div>
        <div>
          <Label htmlFor="rd-subs">Subreddits you already take part in (optional)</Label>
          <Textarea
            id="rd-subs"
            rows={2}
            value={subreddits}
            onChange={(e) => setSubreddits(e.target.value)}
            placeholder="r/SaaS, r/marketing. Separated by commas or new lines"
          />
          <p className="mt-1 text-xs text-muted">
            A starting point for our research, not the final list. We build the full set from where
            your audience actually asks questions.
          </p>
        </div>
        <div>
          <Label htmlFor="rd-offsubs">Subreddits to stay out of (optional)</Label>
          <Textarea
            id="rd-offsubs"
            rows={2}
            value={offLimitsSubreddits}
            onChange={(e) => setOffLimitsSubreddits(e.target.value)}
            placeholder="r/SEO, r/marketing. Anywhere you were removed, banned, or would rather not appear"
          />
          <p className="mt-1 text-xs text-muted">
            We never draft for these. Worth filling in if a past post went badly somewhere. Names
            separated by commas or new lines; you can add why after each one.
          </p>
        </div>
        <div>
          <Label htmlFor="rd-disclosure">
            If we mention you, how would you like that worded? (optional)
          </Label>
          <Textarea
            id="rd-disclosure"
            rows={2}
            value={disclosurePosture}
            onChange={(e) => setDisclosurePosture(e.target.value)}
            placeholder="For example: I work at Acme, so take this as an interested view."
          />
          <p className="mt-1 text-xs text-muted">
            We use your wording as the disclosure line. Leave it empty and we write a plain one for
            you to approve.
          </p>
        </div>
        <div>
          <Label htmlFor="rd-offlimits">Anything we must never say (optional)</Label>
          <Textarea
            id="rd-offlimits"
            rows={2}
            value={offLimits}
            onChange={(e) => setOffLimits(e.target.value)}
            placeholder="Topics, client names, specific numbers. Leave it empty and our house rules still apply."
          />
        </div>
        {fieldError(error)}
        <div className="flex items-center gap-3">
          <Button onClick={save} disabled={pending}>
            {pending ? "Saving…" : "Save account"}
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
  too_promotional: "too promotional",
  wrong_subreddit: "wrong subreddit",
  thread_died: "thread went quiet",
  rules: "against the rules",
  removed: "removed or downvoted",
  other: "other",
};

function FeedbackBox({
  clientId,
  runs,
  recent,
  isStaff,
}: {
  clientId: string;
  runs: RedditRunRowView[];
  recent: RedditFeedbackRowView[];
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
        addRedditDraftFeedbackAction({
          clientId,
          account: "program",
          action: "note",
          reason: note,
        }),
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
      {/* F28: the archive holds APPROVED work (F149 filters it to approved,
          non-future items), so a fresh batch is not there yet and a client sent
          looking for one finds an empty page. Name the approval step, and link
          the archive rather than describing where it might be. */}
      <p className="mt-1 text-sm text-muted">
        Tell us what is working and what is not, in your own words. It goes straight into the
        agent&apos;s next run. Once your Karos team has approved the replies, saying whether you posted a
        reply happens on the reply itself, in{" "}
        <a href={archive.href} className="underline hover:text-foreground">
          {archive.label}
        </a>
        , and that is the signal that sharpens the voice fastest.
      </p>
      {runs.length > 0 ? (
        /* The run's state through the app's own mapper, and its date through
           the app's own formatter. This printed the raw database word
           ("review", "queued", "failed") beside an ISO machine date, in
           client-facing copy - the same rows the X and LinkedIn intakes render
           properly. */
        <ul className="mt-3 space-y-1.5">
          {runs.slice(0, 4).map((r) => {
            /* C2 (parity pass 2026-09). The CLIENT'S sentence is the primary
               text for BOTH roles. Staff used to read `Run <date>` in its
               place, so one row said two different things and a staff preview
               of this page could not be compared with what the client gets.
               They lose nothing: the exact generation instant they debug with
               is appended as a muted secondary suffix, and the /jobs link -
               staff-only, staff-guarded, and outside the client workspace -
               rides on that suffix behind an Internal marker. The per-day
               collapse for clients still happens server-side (toRunRowViews). */
            const label = `Worked on your content · ${relativeTime(r.createdAt)}`;
            const stamp = `Run ${formatDate(r.createdAt)}`;
            return (
              <li key={r.id} className="flex flex-wrap items-center gap-2 text-xs text-muted">
                <span>{label}</span>
                {isStaff &&
                  (r.href ? (
                    <a href={r.href} className="text-muted-2 underline hover:text-foreground">
                      {stamp}
                    </a>
                  ) : (
                    <span className="text-muted-2">{stamp}</span>
                  ))}
                {isStaff && r.href && <Badge tone="neutral">Internal</Badge>}
                <JobStatusBadge status={r.status} />
              </li>
            );
          })}
        </ul>
      ) : (
        <IntakeNoRuns clientId={clientId} noun="replies" />
      )}
      <div className="mt-4 space-y-3">
        <Textarea
          rows={5}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Explain the problem or the win. Replies too long? Wrong subreddits? A tone that landed well? Write it like you would to a teammate."
        />
        {fieldError(error)}
        <div className="flex items-center gap-3">
          <Button onClick={submit} disabled={pending || !note.trim()}>
            {pending ? "Sending…" : "Send feedback"}
          </Button>
          {sent ? <span className="text-xs text-muted">Sent. It feeds the next run.</span> : null}
        </div>
      </div>
      {recent.length > 0 ? (
        <ul className="mt-4 space-y-2 border-t border-border pt-4">
          {recent.slice(0, 6).map((f) => (
            <li key={f.id} className="text-xs text-muted">
              <span className="text-foreground">
                {f.action === "note" ? "Feedback" : f.action.replace(/_/g, " ")}
              </span>
              {f.reasonCode ? ` · ${REASON_LABEL[f.reasonCode] ?? f.reasonCode}` : ""}
              {f.subreddit ? ` · ${f.subreddit}` : ""}
              {f.draftLabel ? ` · ${f.draftLabel}` : ""} · {relativeTime(f.createdAt)}
            </li>
          ))}
        </ul>
      ) : null}
    </Card>
  );
}

/* ────────────────────────── the page body ───────────────────────── */

export function RedditAgentIntake({
  clientId,
  company,
  feedback,
  runs,
  isStaff,
}: {
  clientId: string;
  company: RedditIntakeView | null;
  feedback: RedditFeedbackRowView[];
  runs: RedditRunRowView[];
  /** Whose vocabulary the run rows are written in - see FeedbackBox. */
  isStaff: boolean;
}) {
  return (
    <div className="space-y-6">
      {/* The anchor the agent page's inputs band links its one row to (#85).
          Reddit has no seats and no news drop, so "company" is the whole set —
          and it is derived from the same row id the band mints, not spelled
          twice. */}
      <div id={intakeAnchorId("company")} className="scroll-mt-24">
        <AccountForm clientId={clientId} intake={company} />
      </div>
      <FeedbackBox clientId={clientId} runs={runs} recent={feedback} isStaff={isStaff} />
    </div>
  );
}
