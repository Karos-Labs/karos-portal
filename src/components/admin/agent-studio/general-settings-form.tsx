"use client";

import { useState } from "react";
import { Button, Input, Label, Textarea } from "@/components/ui";

export interface GeneralSettingsDraft {
  name: string;
  /** One-line pitch for list surfaces. Optional; readers fall back to description. */
  summary: string;
  description: string;
  category: string;
  icon: string;
  creditsCost: number;
  active: boolean;
  allowedClientIds: string[];
  /** Opt-in output de-duplication. See docs/dynamic-agent-guardrails.md. */
  dedupeAgainstHistory: boolean;
}

/**
 * General Settings section of the Agent Studio (Phase 2): name, a one-line
 * summary, the full description, category, icon, creditsCost, active toggle,
 * and a per-client allowlist.
 * Used both in the "New agent" dialog (agent-studio-list.tsx) and as a tab of
 * the full editor (agent-studio-editor.tsx) — the same fields either way, so
 * validation can never drift between create and edit.
 */
export function GeneralSettingsForm({
  initial,
  clients,
  submitLabel,
  pending,
  error,
  onSubmit,
}: {
  initial: GeneralSettingsDraft;
  clients: { id: string; name: string }[];
  submitLabel: string;
  pending: boolean;
  error: string | null;
  onSubmit: (draft: GeneralSettingsDraft) => void;
}) {
  const [draft, setDraft] = useState(initial);

  function set<K extends keyof GeneralSettingsDraft>(key: K, value: GeneralSettingsDraft[K]) {
    setDraft((current) => ({ ...current, [key]: value }));
  }

  function toggleClient(id: string) {
    set(
      "allowedClientIds",
      draft.allowedClientIds.includes(id)
        ? draft.allowedClientIds.filter((c) => c !== id)
        : [...draft.allowedClientIds, id],
    );
  }

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit(draft);
      }}
    >
      <div>
        <Label htmlFor="das-name">Name</Label>
        <Input
          id="das-name"
          value={draft.name}
          onChange={(e) => set("name", e.target.value)}
          placeholder="e.g. Weekly Case Study Drafter"
          maxLength={200}
        />
      </div>

      <div>
        <Label htmlFor="das-summary">Summary</Label>
        <p className="mb-1.5 text-xs text-muted-2">
          One line, shown wherever agents are listed side by side. Leave it blank to use the description.
        </p>
        <Input
          id="das-summary"
          value={draft.summary}
          onChange={(e) => set("summary", e.target.value)}
          placeholder="e.g. Turns a client brief into a publishable case study."
          maxLength={160}
        />
      </div>

      <div>
        <Label htmlFor="das-description">Description</Label>
        <Textarea
          id="das-description"
          value={draft.description}
          onChange={(e) => set("description", e.target.value)}
          placeholder="What this agent does and when to use it."
          maxLength={2000}
        />
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <Label htmlFor="das-category">Category</Label>
          <Input
            id="das-category"
            value={draft.category}
            onChange={(e) => set("category", e.target.value)}
            placeholder="e.g. Content"
            maxLength={60}
          />
        </div>
        <div>
          <Label htmlFor="das-icon">Icon (lucide name)</Label>
          <Input
            id="das-icon"
            value={draft.icon}
            onChange={(e) => set("icon", e.target.value)}
            placeholder="Sparkles"
            maxLength={60}
          />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <Label htmlFor="das-credits">Credits per run</Label>
          <Input
            id="das-credits"
            type="number"
            min={0}
            step={1}
            value={draft.creditsCost}
            onChange={(e) => set("creditsCost", Math.max(0, Math.round(Number(e.target.value) || 0)))}
          />
        </div>
        <div className="flex items-end pb-1">
          <label className="flex items-center gap-2 text-sm text-foreground">
            <input
              type="checkbox"
              className="accent-neon"
              checked={draft.active}
              onChange={(e) => set("active", e.target.checked)}
            />
            Active (visible to clients)
          </label>
        </div>
      </div>

      <div className="rounded-md border border-border bg-surface-2 p-3">
        <label className="flex cursor-pointer items-start gap-2 text-sm text-foreground">
          <input
            type="checkbox"
            className="mt-0.5 accent-neon"
            checked={draft.dedupeAgainstHistory}
            onChange={(e) => set("dedupeAgainstHistory", e.target.checked)}
          />
          <span>Avoid repeating previous outputs</span>
        </label>
        <p className="mt-1.5 text-[11px] leading-snug text-muted-2">
          Shows this agent the last few drafts it produced for the same client and tells it not to repeat
          them, then scores the new draft against them and flags a near-duplicate for your team. Off by
          default — turn it on for an agent that produces on a recurring cadence.
        </p>
      </div>

      <div>
        <Label>Allowed clients</Label>
        <p className="mb-1.5 text-xs text-muted-2">Leave every client unchecked to allow all clients.</p>
        {clients.length === 0 ? (
          <p className="text-xs text-muted-2">No clients yet.</p>
        ) : (
          <div className="max-h-40 space-y-1 overflow-y-auto rounded-md border border-border bg-foreground/[0.02] p-2">
            {clients.map((client) => (
              <label
                key={client.id}
                className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-xs text-foreground hover:bg-surface-2"
              >
                <input
                  type="checkbox"
                  className="accent-neon"
                  checked={draft.allowedClientIds.includes(client.id)}
                  onChange={() => toggleClient(client.id)}
                />
                {client.name}
              </label>
            ))}
          </div>
        )}
      </div>

      {error ? <p className="text-xs text-danger" role="alert">{error}</p> : null}

      <Button type="submit" disabled={pending} loading={pending}>
        {submitLabel}
      </Button>
    </form>
  );
}
