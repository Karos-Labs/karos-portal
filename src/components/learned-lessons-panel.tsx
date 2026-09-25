"use client";

import { useState, useTransition } from "react";
import { Badge, Button, Spinner } from "@/components/ui";
import { setVoiceLessonRetiredAction } from "@/lib/actions/learning-lessons-actions";
import type { LearnedLessons, LessonSource, VoiceLesson } from "@/lib/agent-engine/learning-lessons";

/**
 * WHAT THE AGENTS LEARNED ABOUT THIS CLIENT (SCRUM-508), STAFF ONLY.
 *
 * Every draft on every platform reads the newest eight of these lessons. Since
 * SCRUM-508 a revision note and a change request each become one, including a
 * note that was only true of one post, so a person has to be able to see the
 * list and take a wrong lesson out. "Retire" keeps it out of every later
 * derivation; it moves to the retired list, where "Restore" puts it back.
 *
 * The order is the middleware's (weakest evidence first, strongest last),
 * shown newest-strongest at the top, and the eight a draft actually reads are
 * marked so nobody has to know about `.slice(-8)`.
 */

/** How many lessons a draft reads (`preferencesForDrafting`, `.slice(-8)`). */
const LESSONS_A_DRAFT_READS = 8;

const SOURCE_LABEL: Record<LessonSource, string> = {
  review: "reviewer's note at the gate",
  note: "client's note",
  change_request: "change request",
  edits: "counted from the client's edits",
  skips: "counted from skipped drafts",
};

function evidenceLine(lesson: VoiceLesson): string {
  const source = lesson.source ? SOURCE_LABEL[lesson.source] : "stated";
  return lesson.evidence !== undefined && lesson.evidence > 1 ? `${source} · ${lesson.evidence} times` : source;
}

export function LearnedLessonsPanel({ clientId, initial }: { clientId: string; initial: LearnedLessons | null | undefined }) {
  const [lessons, setLessons] = useState(initial);
  const [pendingLesson, setPendingLesson] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  if (lessons === undefined) {
    return <p className="text-xs text-muted-2">Could not read what the agents have learned: the control plane did not answer.</p>;
  }
  if (lessons === null || (lessons.voiceLessons.length === 0 && lessons.likes.length === 0 && lessons.retired.length === 0)) {
    return <p className="text-xs text-muted-2">Nothing learned yet. Lessons appear after the client edits, skips or sends back a draft, or a reviewer asks for a change.</p>;
  }

  const change = (lesson: string, retired: boolean) => {
    setError(null);
    setPendingLesson(lesson);
    startTransition(async () => {
      const result = await setVoiceLessonRetiredAction({ clientId, lesson, retired });
      if (result.error) setError(result.error);
      else if (result.lessons) setLessons(result.lessons);
      setPendingLesson(null);
    });
  };

  // Strongest last in the stored order; shown strongest first.
  const shown = [...lessons.voiceLessons].reverse();
  const readCount = Math.min(LESSONS_A_DRAFT_READS, shown.length);

  return (
    <div className="space-y-5">
      {error && <p className="text-xs text-danger">{error}</p>}

      <section className="space-y-2">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <h4 className="font-label text-[11px] uppercase tracking-[0.08em] text-muted">Voice lessons</h4>
          <p className="text-xs text-muted-2">
            {shown.length} held · the top {readCount} reach every draft
          </p>
        </div>
        {shown.length === 0 ? (
          <p className="text-xs text-muted-2">None held.</p>
        ) : (
          <ul className="space-y-2">
            {shown.map((lesson, i) => (
              <li key={lesson.lesson} className="flex items-start justify-between gap-3 text-sm">
                <div className="min-w-0 space-y-0.5">
                  <p className="text-foreground">{lesson.lesson}</p>
                  <p className="flex flex-wrap items-center gap-2 text-xs text-muted-2">
                    {i < readCount && <Badge tone="info">read by drafts</Badge>}
                    <span>{evidenceLine(lesson)}</span>
                  </p>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={pendingLesson !== null}
                  onClick={() => change(lesson.lesson, true)}
                  aria-label={`Retire the lesson: ${lesson.lesson}`}
                >
                  {pendingLesson === lesson.lesson ? <Spinner className="h-3.5 w-3.5" /> : "Retire"}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {lessons.likes.length > 0 && (
        <section className="space-y-2">
          <h4 className="font-label text-[11px] uppercase tracking-[0.08em] text-muted">Posted without an edit</h4>
          <ul className="space-y-1 text-sm">
            {[...lessons.likes].reverse().map((like, i) => (
              <li key={`${like.runId ?? ""}-${i}`} className="text-foreground">
                {like.subject ?? like.runId}
              </li>
            ))}
          </ul>
        </section>
      )}

      {lessons.retired.length > 0 && (
        <section className="space-y-2">
          <h4 className="font-label text-[11px] uppercase tracking-[0.08em] text-muted">Retired</h4>
          <ul className="space-y-2">
            {lessons.retired.map((lesson) => (
              <li key={lesson} className="flex items-start justify-between gap-3 text-sm">
                <p className="min-w-0 text-muted-2 line-through">{lesson}</p>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={pendingLesson !== null}
                  onClick={() => change(lesson, false)}
                  aria-label={`Restore the lesson: ${lesson}`}
                >
                  {pendingLesson === lesson ? <Spinner className="h-3.5 w-3.5" /> : "Restore"}
                </Button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
