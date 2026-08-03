"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button, Textarea } from "@/components/ui";
import { Modal } from "@/components/modal";
import { relativeTime } from "@/lib/utils";
import { MAX_SLOT_NOTE_CHARS, slotNoteEcho } from "@/lib/slot-notes";
import { setAgentSlotNoteAction } from "@/lib/actions/slot-note-actions";
import type { ClientAgentCardRow } from "./types";

const WEEKDAY_LONG = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

/**
 * A note about ONE day (§4.3, CD-A3).
 *
 * The copy is the load-bearing part. A note is not feedback - feedback shapes
 * everything the agent writes from here on, a note is about Thursday - and the
 * dialog says so, because a client who leaves "make this one about the launch"
 * expecting it to become a standing rule has been misled by the surface.
 *
 * What it promises is what actually happens: a human reads it and folds it into
 * that day's post. The design has two higher-fidelity paths (day-of generation
 * consuming the note as a context file, and a revision pass over an existing
 * draft) and NEITHER is wired, so neither is described. Promising the agent has
 * already read it would be the same class of lie as D6's picker.
 */
export function SlotNoteModal({
  clientId,
  day,
  onClose,
}: {
  clientId: string;
  day: ClientAgentCardRow["week"][number];
  onClose: () => void;
}) {
  const router = useRouter();
  const [text, setText] = useState(day.note?.text ?? "");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const [y, mo, d] = day.dateKey.split("-").map(Number);
  const at = new Date(Date.UTC(y, mo - 1, d));
  const dayName = `${WEEKDAY_LONG[at.getUTCDay()]} ${at.getUTCDate()}`;

  function save() {
    setError(null);
    startTransition(async () => {
      const result = await setAgentSlotNoteAction({ clientId, slotId: day.slotId, text });
      if (result.error) {
        setError(result.error);
        return;
      }
      router.refresh();
      onClose();
    });
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={`Note for ${dayName}`}
      // The label is already a noun for the post ("Daily post", "By The Numbers"),
      // so appending "post" produced "About this one Daily post post".
      description={`About this one. The ${day.label} going out that day, not a standing rule. To change what this agent always does, use Give feedback instead.`}
      footer={
        <div className="flex items-center justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button variant="accent" onClick={save} loading={pending} disabled={pending}>
            {text.trim() ? "Save note" : day.note ? "Remove note" : "Save note"}
          </Button>
        </div>
      }
    >
      <div className="space-y-2">
        <Textarea
          value={text}
          onChange={(e) => setText(e.target.value.slice(0, MAX_SLOT_NOTE_CHARS))}
          rows={3}
          placeholder="e.g. Tie this one to the Thursday launch."
          aria-label={`Note for ${dayName}`}
        />
        <div className="flex items-center justify-between gap-2">
          <p className="text-[11px] text-muted-2">
            {text.length}/{MAX_SLOT_NOTE_CHARS}
          </p>
          {day.note && (
            <p className="text-[11px] text-muted-2">
              {day.note.authorName} · {relativeTime(day.note.createdAt)}
            </p>
          )}
        </div>
        {day.note && (
          <p className="rounded-md border border-border bg-surface-2/70 px-3 py-2 text-[11px] text-muted-2">
            {slotNoteEcho({ consumedAt: day.note.applied ? day.note.createdAt : null })}
          </p>
        )}
        {error && <p className="text-[11px] text-warning">{error}</p>}
      </div>
    </Modal>
  );
}
