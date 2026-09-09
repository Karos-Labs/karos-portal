"use client";

import { useState, useTransition } from "react";
import { Button, Textarea } from "@/components/ui";
import { Icon } from "@/components/icon";
import { generateDynamicAgentDraftAction } from "@/lib/actions";
import type { DynamicAgentInputDef, DynamicAgentStepDef } from "@/lib/types";

const MAX_DESCRIPTION_CHARS = 5_000;

/**
 * Agent Studio's free-text → draft generator (Feature 2 of the 2026-08
 * dynamic-agent-v2 work). An admin describes the agent in plain English;
 * `generateDynamicAgentDraftAction` turns that into a validated
 * input-schema + AI-only step pipeline. Nothing here ever touches
 * Firestore or charges credits — this is a pure authoring aid that hands
 * its result to `onApply`, which is `AgentStudioEditor`'s
 * `applyGeneratedDraft` (overwrites the LOCAL working copy only; the admin
 * still has to hit "Save" on the Inputs/Pipeline tabs to persist it).
 *
 * Replacing existing, non-empty inputs/steps is destructive to unsaved
 * editor state (though never to what is already persisted, since nothing
 * here saves) — so when the spec already has content, generating asks for
 * an explicit confirmation before applying the draft over it.
 */
export function GenerateFromTextPanel({
  hasExistingContent,
  onApply,
}: {
  hasExistingContent: boolean;
  onApply: (draft: { inputSchema: DynamicAgentInputDef[]; steps: DynamicAgentStepDef[] }) => void;
}) {
  const [description, setDescription] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notes, setNotes] = useState<string[]>([]);
  const [pendingDraft, setPendingDraft] = useState<{
    inputSchema: DynamicAgentInputDef[];
    steps: DynamicAgentStepDef[];
    notes: string[];
  } | null>(null);
  const [pending, startTransition] = useTransition();

  function runGeneration() {
    setError(null);
    setNotes([]);
    setPendingDraft(null);
    startTransition(async () => {
      const result = await generateDynamicAgentDraftAction({ description });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      if (hasExistingContent) {
        // Ask before clobbering unsaved inputs/steps already in the editor.
        setPendingDraft({ inputSchema: result.inputSchema, steps: result.steps, notes: result.notes });
        return;
      }
      setNotes(result.notes);
      onApply({ inputSchema: result.inputSchema, steps: result.steps });
    });
  }

  function confirmApply() {
    if (!pendingDraft) return;
    setNotes(pendingDraft.notes);
    onApply({ inputSchema: pendingDraft.inputSchema, steps: pendingDraft.steps });
    setPendingDraft(null);
  }

  function cancelApply() {
    setPendingDraft(null);
  }

  return (
    <div className="space-y-4">
      <p className="text-xs leading-relaxed text-muted-2">
        Describe the agent you want in plain English — what it produces, what it needs from the client, and any
        tone or structure it should follow. This generates a draft input schema and AI step pipeline into the
        Inputs and Pipeline tabs; nothing is saved until you review it there and click Save.
      </p>

      <Textarea
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        placeholder="e.g. An agent that writes a weekly LinkedIn post recapping the client's latest blog article. Ask for the article URL and a desired tone."
        className="min-h-[140px]"
        maxLength={MAX_DESCRIPTION_CHARS}
        disabled={pending}
      />
      <p className="text-right text-[11px] text-muted-2">
        {description.length.toLocaleString()} / {MAX_DESCRIPTION_CHARS.toLocaleString()}
      </p>

      {error ? (
        <p className="text-xs text-danger" role="alert">
          {error}
        </p>
      ) : null}

      {pendingDraft ? (
        <div className="rounded-md border border-warning/30 bg-warning/10 p-3">
          <p className="mb-2 flex items-start gap-1.5 text-xs text-warning" role="alert">
            <Icon name="CircleAlert" className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            This agent already has inputs or pipeline steps. Applying this draft will replace them in this editor
            (nothing persisted is lost until you click Save).
          </p>
          <div className="flex items-center gap-2">
            <Button type="button" size="sm" onClick={confirmApply}>
              Replace with generated draft
            </Button>
            <Button type="button" size="sm" variant="outline" onClick={cancelApply}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <Button type="button" disabled={pending || !description.trim()} loading={pending} onClick={runGeneration}>
          <Icon name="WandSparkles" className="h-3.5 w-3.5" />
          Generate
        </Button>
      )}

      {notes.length > 0 ? (
        <div className="rounded-md border border-border bg-surface-2 p-3">
          <p className="mb-1.5 text-[10px] uppercase tracking-[0.08em] text-muted-2">Assumptions made</p>
          <ul className="list-inside list-disc space-y-1 text-xs text-muted">
            {notes.map((note, i) => (
              <li key={i}>{note}</li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
