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
import {
  addRedditDraftFeedbackAction,
  lookUpRedditAccountAction,
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
  draftRef?: string;
  subreddit?: string;
  reasonCode?: string;
  createdAt: number;
}

export interface RedditRunRowView {
  id: string;
  status: string;
  createdAt: number;
  href?: string;
}

function fieldError(error: string | null) {
  return error ? <p className="mt-2 text-xs text-red-400">{error}</p> : null;
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
  const [lookingUp, setLookingUp] = useState(false);
  const [lookupNote, setLookupNote] = useState<string | null>(null);

  /**
   * Reads the account's own public activity and fills the rest of the form in,
   * so the client does not have to describe their own Reddit history. Nothing is
   * saved until they press save, so this can never overwrite an answer they
   * corrected by hand — and they see everything before it is stored.
   */
  async function lookUp() {
    setError(null);
    setLookupNote(null);
    setLookingUp(true);
    try {
      const result = await lookUpRedditAccountAction({ clientId, username });
      if (result.error) {
        setError(result.error);
        return;
      }
      if (result.handle) setUsername(result.handle);
      if (result.history) setAccountHistory(result.history);
      if (result.subreddits?.length) setSubreddits(result.subreddits.join(", "));
      setLookupNote(
        result.notice ??
          "Filled in from this account's public activity. Check it and change anything that looks wrong - Reddit does not let us see karma or account age, so add those if you know them.",
      );
    } finally {
      setLookingUp(false);
    }
  }

  function save() {
    setError(null);
    start(async () => {
      const result = await saveRedditCompanyIntakeAction({
        clientId,
        username,
        accountHistory,
        subreddits,
        offLimitsSubreddits,
        disclosurePosture,
        offLimits,
        mode,
      });
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
      badge={intake ? <Badge tone="success">On file</Badge> : <Badge tone="warning">Not set up</Badge>}
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
          <div className="mt-2 flex flex-wrap items-center gap-3">
            <Button size="sm" variant="subtle" onClick={lookUp} disabled={lookingUp || !username.trim()}>
              {lookingUp ? "Reading the account…" : "Look it up and fill this in"}
            </Button>
            <p className="text-xs text-muted">
              We read its public activity and answer the rest for you.
            </p>
          </div>
          {lookupNote ? <p className="mt-2 text-xs text-muted">{lookupNote}</p> : null}
          <p className="mt-2 text-xs text-muted">
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
            placeholder="r/SaaS, r/marketing - separated by commas or new lines"
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
            placeholder="r/SEO, r/marketing - anywhere you were removed, banned, or would rather not appear"
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
}: {
  clientId: string;
  runs: RedditRunRowView[];
  recent: RedditFeedbackRowView[];
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const [note, setNote] = useState("");

  function submit() {
    setError(null);
    setSent(false);
    start(async () => {
      const result = await addRedditDraftFeedbackAction({
        clientId,
        account: "program",
        action: "note",
        reason: note,
      });
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
        Tell us what is working and what is not, in your own words. It goes straight into the next
        run. Saying whether you posted an individual reply happens on the reply itself, in your
        Workspace archive, and that is the signal that sharpens the voice fastest.
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
          {sent ? <span className="text-xs text-muted">Sent - it feeds the next run.</span> : null}
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

export function RedditAgentIntake({
  clientId,
  company,
  feedback,
  runs,
}: {
  clientId: string;
  company: RedditIntakeView | null;
  feedback: RedditFeedbackRowView[];
  runs: RedditRunRowView[];
}) {
  return (
    <div className="space-y-6">
      <AccountForm clientId={clientId} intake={company} />
      <FeedbackBox clientId={clientId} runs={runs} recent={feedback} />
    </div>
  );
}
