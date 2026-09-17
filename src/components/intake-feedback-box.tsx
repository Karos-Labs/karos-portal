"use client";

/**
 * The intake feedback box: run history, a free-text note, and what has been
 * sent lately. One component, read by the LinkedIn and X intake surfaces.
 *
 * WHY IT MOVED HERE (SCRUM-412). It was declared twice, 135 lines each, in
 * `linkedin-agent-intake.tsx` and `x-agent-intake.tsx`. The two copies differed
 * in exactly four places and in nothing else:
 *
 *   1. the view types — `LiFeedbackRowView`/`LiRunRowView` and the X pair were
 *      BYTE IDENTICAL, so this was a difference in name only;
 *   2. the server action the note posts to;
 *   3. the DOM id prefix, hand-spelled `lf-` and `xf-`;
 *   4. one placeholder sentence.
 *
 * Everything else — the archive link, the run rows and their C2 staff/client
 * parity treatment, the empty state, the recent-feedback list, the "Sent. It
 * feeds the next run." confirmation — was the same code written out twice. Which
 * is how the rest of the two files drifted: `SetupBand`, `IdentityPicker` and
 * `DirectionRequestsBox` exist only on LinkedIn, `SeatTakes`, `RosterInput` and
 * `PremiumField` only on X, and each of those started as "just this one edit".
 *
 * WHAT STAYED BEHIND, and why this is not the whole ticket. `CompanyForm`,
 * `SeatCard` and `AddSeatForm` are named the same in both files and are NOT the
 * same component. LinkedIn's `CompanyForm` fires the one-time stand-up run on
 * first save and takes a URL suggestion off the client profile; X's holds the
 * engagement roster, the Premium tri-state and a one-shot announcements drop.
 * Those are different features that happen to share a title. Merging them behind
 * a flag would produce one component with two disjoint halves, which is worse
 * than two components — so the finding is recorded rather than forced, and only
 * what is genuinely one thing is one thing.
 *
 * THE ACTION IS A PROP, not an import. Both `addLiDraftFeedbackAction` and
 * `addXDraftFeedbackAction` already satisfy `SendIntakeNote` structurally, so
 * the call sites pass the action itself with no wrapper. A `server-only` module
 * could not be imported from here anyway (this is a "use client" file), and
 * server ACTIONS are the one thing a client component is meant to be handed.
 */

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { fieldError } from "@/components/intake-field";
import { IntakeRunRows, type IntakeRunRowView } from "@/components/intake-run-rows";
import { Button, Card, CardTitle, Label, Select, Textarea } from "@/components/ui";
import { clientArchiveLink } from "@/lib/agent-intake-links";
import { intakeSave } from "@/lib/intake-save";
import {
  intakeFeedbackFieldId,
  intakeFeedbackPlaceholder,
  type IntakeFeedbackFamily,
} from "@/lib/intake-feedback-copy";
import { relativeTime } from "@/lib/utils";

export type { IntakeRunRowView };

/** One row of the "what you have told us lately" list. */
export interface IntakeFeedbackRowView {
  id: string;
  account: string;
  action: string;
  /**
   * The lane this row was written against, humanised server-side
   * (agent-intake-views' draftLabelOf). Absent when the stored ref names no
   * lane; the raw ref never crosses - it is the log's join key, not copy.
   */
  draftLabel?: string;
  createdAt: number;
}

/**
 * What the box needs off a seat: an id to file the note against and a name to
 * offer in the picker. Deliberately the narrowest read of `LiSeatView` and
 * `XSeatView` that works, so neither platform's seat can grow a field this box
 * then quietly depends on.
 */
export interface IntakeFeedbackSeat {
  id: string;
  name: string;
}

/**
 * The note-posting action. Both platforms' `add…DraftFeedbackAction` match this
 * without adaptation; a third platform's would have to, which is the point.
 */
export type SendIntakeNote = (input: {
  clientId: string;
  account: string;
  action: "note";
  reason: string;
}) => Promise<{ error?: string }>;

export function IntakeFeedbackBox({
  clientId,
  family,
  seats,
  runs,
  recent,
  isStaff,
  sendNote,
}: {
  clientId: string;
  /** Which platform's page this is - picks the placeholder and the field ids. */
  family: IntakeFeedbackFamily;
  seats: IntakeFeedbackSeat[];
  runs: IntakeRunRowView[];
  recent: IntakeFeedbackRowView[];
  isStaff: boolean;
  sendNote: SendIntakeNote;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const [account, setAccount] = useState("program");
  const [note, setNote] = useState("");

  const accountName = (id: string) =>
    id === "company"
      ? "Company page"
      : id === "program"
        ? "Everything"
        : (seats.find((s) => s.id === id)?.name ?? "Seat");
  // #90: `?tab=archive` is read only by ProgressView, and a staff viewer at the
  // flat /tasks never gets one. The destination and its label move together.
  const archive = clientArchiveLink({ clientId, isStaff });
  const accountFieldId = intakeFeedbackFieldId(family, "account");

  function submit() {
    setError(null);
    setSent(false);
    start(async () => {
      const result = await intakeSave(() =>
        sendNote({ clientId, account, action: "note", reason: note }),
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
      <p className="mt-1 text-sm text-muted">
        Tell us what is working and what is not. In your own words, as much detail as you like.
        It goes straight into the agent&apos;s next run. Picking, editing and skipping happens on the
        drafts themselves once they are in{" "}
        <a href={archive.href} className="underline hover:text-foreground">
          {archive.label}
        </a>
        , and each of those choices reaches the agent too.
      </p>
      <IntakeRunRows clientId={clientId} family={family} runs={runs} isStaff={isStaff} />
      <div className="mt-4 space-y-3">
        <div className="max-w-xs">
          <Label htmlFor={accountFieldId}>This is about</Label>
          <Select
            id={accountFieldId}
            value={account}
            onChange={(e) => setAccount(e.target.value)}
          >
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
          placeholder={intakeFeedbackPlaceholder(family)}
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
              <span className="text-foreground">{accountName(f.account)}</span> ·{" "}
              {f.action === "note" ? "feedback" : f.action.replace(/_/g, " ")}
              {f.draftLabel ? ` · ${f.draftLabel}` : ""} · {relativeTime(f.createdAt)}
            </li>
          ))}
        </ul>
      ) : null}
    </Card>
  );
}
