"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Badge, Button, Select, Textarea } from "@/components/ui";
import { Modal } from "@/components/modal";
import { relativeTime } from "@/lib/utils";
import { FEEDBACK_CATEGORIES, FEEDBACK_CATEGORY_LABEL, MAX_FEEDBACK_CHARS } from "@/lib/client-agent-feedback";
import type { FeedbackCategory } from "@/lib/types";
import {
  addClientAgentFeedbackAction,
  setClientAgentFeedbackStatusAction,
  updateClientAgentFeedbackAction,
  withdrawClientAgentFeedbackAction,
} from "@/lib/actions/client-agent-feedback-actions";
import type { ClientAgentFeedbackRow } from "./types";

/**
 * The two-level feedback surface (Phase 3 §5).
 *
 * ONE component, two scopes. The scope is fixed by where it was opened from —
 * the agent footer or a template row — and stated in the copy rather than
 * offered as a dropdown: "which of my formats does this apply to" is a question
 * the client already answered by clicking the row they were looking at, and a
 * mis-set dropdown silently teaches the wrong stream.
 *
 * The copy makes the reach explicit in both directions, because the whole
 * difference between the levels is invisible otherwise: global feedback changes
 * every post this agent will ever make, and a client who thought they were
 * commenting on one format would have no way to tell.
 */
export function ClientAgentFeedbackModal({
  clientId,
  clientAgentId,
  agentName,
  scope,
  templateKey,
  templateName,
  rows,
  viewerIsClient,
  onClose,
}: {
  clientId: string;
  clientAgentId: string;
  agentName: string;
  scope: "agent" | "template";
  templateKey?: string | null;
  templateName?: string | null;
  /** Every row on this umbrella — filtered to the open scope below. */
  rows: ClientAgentFeedbackRow[];
  viewerIsClient: boolean;
  onClose: () => void;
}) {
  const router = useRouter();
  const [text, setText] = useState("");
  const [category, setCategory] = useState<FeedbackCategory | "">("");
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const scoped = rows
    .filter((row) =>
      scope === "agent" ? row.scope === "agent" : row.scope === "template" && row.templateKey === templateKey,
    )
    .sort((a, b) => b.createdAt - a.createdAt);

  const reach =
    scope === "agent"
      ? `Shapes everything ${agentName} makes. Every format, every post from here on.`
      : `Shapes only "${templateName ?? templateKey}" posts. Nothing else this agent makes changes.`;

  function submit() {
    setError(null);
    startTransition(async () => {
      const result = await addClientAgentFeedbackAction({
        clientId,
        clientAgentId,
        scope,
        ...(scope === "template" ? { templateKey } : {}),
        text,
        ...(category ? { category } : {}),
      });
      if (result.error) setError(result.error);
      else {
        setText("");
        setCategory("");
        router.refresh();
      }
    });
  }

  function saveEdit() {
    if (!editing) return;
    setError(null);
    startTransition(async () => {
      const result = await updateClientAgentFeedbackAction({
        clientId,
        feedbackId: editing.id,
        text: editing.text,
      });
      if (result.error) setError(result.error);
      else {
        setEditing(null);
        router.refresh();
      }
    });
  }

  function withdraw(id: string) {
    setError(null);
    startTransition(async () => {
      const result = await withdrawClientAgentFeedbackAction({ clientId, feedbackId: id });
      if (result.error) setError(result.error);
      else router.refresh();
    });
  }

  function setStatus(id: string, status: "active" | "resolved") {
    setError(null);
    startTransition(async () => {
      const result = await setClientAgentFeedbackStatusAction({ feedbackId: id, status });
      if (result.error) setError(result.error);
      else router.refresh();
    });
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={scope === "agent" ? `Feedback on ${agentName}` : `Feedback on "${templateName ?? templateKey}"`}
      description={reach}
    >
      <div className="space-y-5">
        <div className="space-y-1.5">
          <Textarea
            value={text}
            onChange={(e) => setText(e.target.value.slice(0, MAX_FEEDBACK_CHARS))}
            rows={3}
            placeholder={
              scope === "agent"
                ? "e.g. Keep it plain. No exclamation marks, no emoji."
                : "e.g. Lead with the number, not the setup."
            }
            aria-label="Your feedback"
          />
          {/* Cosmetic only — filters the analytics history table, changes
              nothing about scope or injection. Optional, so skipping it costs
              nothing. */}
          <Select
            value={category}
            onChange={(e) => setCategory(e.target.value as FeedbackCategory | "")}
            aria-label="Category (optional)"
            className="h-8 text-xs"
          >
            <option value="">No category</option>
            {FEEDBACK_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {FEEDBACK_CATEGORY_LABEL[c]}
              </option>
            ))}
          </Select>
          <div className="flex items-center justify-between gap-2">
            <p className="text-[11px] text-muted-2">
              {text.length}/{MAX_FEEDBACK_CHARS} · applied to every future run
            </p>
            <Button
              size="sm"
              variant="accent"
              onClick={submit}
              disabled={!text.trim() || pending}
              loading={pending}
            >
              Save feedback
            </Button>
          </div>
          {error && <p className="text-[11px] text-warning">{error}</p>}
        </div>

        <div>
          <p className="mb-2 font-mono text-[10px] uppercase tracking-[0.08em] text-muted">
            {scope === "agent" ? "On this agent" : "On this format"}
          </p>
          {scoped.length === 0 ? (
            <p className="text-xs text-muted-2">Nothing yet.</p>
          ) : (
            <ul className="space-y-2">
              {scoped.map((row) => (
                <li
                  key={row.id}
                  className="rounded-[var(--radius)] border border-border bg-surface-2/50 p-2.5"
                >
                  {editing?.id === row.id ? (
                    <div className="space-y-1.5">
                      <Textarea
                        value={editing.text}
                        onChange={(e) =>
                          setEditing({ id: row.id, text: e.target.value.slice(0, MAX_FEEDBACK_CHARS) })
                        }
                        rows={3}
                        aria-label="Edit feedback"
                      />
                      <div className="flex gap-1.5">
                        <Button size="sm" variant="subtle" onClick={saveEdit} disabled={pending}>
                          Save
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>
                          Cancel
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <>
                      <p className="whitespace-pre-wrap text-xs text-foreground">{row.text}</p>
                      <div className="mt-1.5 flex flex-wrap items-center gap-2">
                        <span className="text-[11px] text-muted-2">
                          {row.authorName} · {relativeTime(row.createdAt)}
                        </span>
                        {row.category && <Badge tone="neutral">{FEEDBACK_CATEGORY_LABEL[row.category]}</Badge>}
                        {/* Two closed states, two labels (D7). "Resolved" is a
                            claim that Karos acted on the note; a client's own
                            withdrawal is not that, and saying so told them their
                            note had been handled when nobody had read it. */}
                        {row.status === "resolved" && <Badge tone="neutral">Resolved</Badge>}
                        {row.status === "withdrawn" && <Badge tone="neutral">Withdrawn</Badge>}
                        {row.editable && (
                          <>
                            <button
                              type="button"
                              className="text-[11px] text-muted hover:text-foreground"
                              onClick={() => setEditing({ id: row.id, text: row.text })}
                            >
                              Edit
                            </button>
                            {row.status === "active" && (
                              <button
                                type="button"
                                className="text-[11px] text-muted hover:text-foreground"
                                onClick={() =>
                                  viewerIsClient ? withdraw(row.id) : setStatus(row.id, "resolved")
                                }
                                disabled={pending}
                              >
                                {viewerIsClient ? "Withdraw" : "Mark resolved"}
                              </button>
                            )}
                            {!viewerIsClient && row.status === "resolved" && (
                              <button
                                type="button"
                                className="text-[11px] text-muted hover:text-foreground"
                                onClick={() => setStatus(row.id, "active")}
                                disabled={pending}
                              >
                                Re-open
                              </button>
                            )}
                          </>
                        )}
                      </div>
                    </>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>

        <p className="border-t border-border/60 pt-3 text-[11px] text-muted-2">
          Your Karos team reads this too. The newest note wins where two conflict.
        </p>
      </div>
    </Modal>
  );
}
