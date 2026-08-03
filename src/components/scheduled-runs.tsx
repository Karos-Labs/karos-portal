"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Badge, Button, Input, Label, Select, Textarea } from "@/components/ui";
import { Icon } from "@/components/icon";
import {
  createScheduledRunAction,
  deleteScheduledRunAction,
  toggleScheduledRunAction,
} from "@/lib/actions";
import { describeCadence, runtimeTimeZone } from "@/lib/run-cadence";
import type { AssetType, RunCadence, ScheduledRun } from "@/lib/types";
import { relativeTime } from "@/lib/utils";

/** The agent picker only needs identity - full docs stay server-side. */
export type SchedulableAgent = { id: string; name: string; entrySkillDir: string };

const DAYS = [
  { n: 1, label: "Mon" },
  { n: 2, label: "Tue" },
  { n: 3, label: "Wed" },
  { n: 4, label: "Thu" },
  { n: 5, label: "Fri" },
  { n: 6, label: "Sat" },
  { n: 0, label: "Sun" },
];

const ASSET_TYPES: AssetType[] = ["social_post", "instagram_post", "article", "email", "note"];

/**
 * Starting point for a new schedule. Tue/Wed/Thu 09:00 is the LinkedIn
 * engagement window this repo already uses ("LinkedIn reach is highest Tue–Thu
 * at the start of the workday" — PLATFORM_SCHEDULES in lib/scheduling), which
 * is the right default for a form whose platform field also starts on linkedin.
 *
 * NO ZONE HERE. It used to carry `America/Sao_Paulo`, hardcoded, for every
 * client in the product — see `timezone` in ScheduledRunsCard for what replaced
 * it and why.
 */
const DEFAULT_CADENCE: Omit<RunCadence, "timezone"> = {
  daysOfWeek: [2, 3, 4],
  hour: 9,
  minute: 0,
};

/**
 * One schedule row. State is per row rather than per card so a failure names
 * the schedule it belongs to.
 *
 * F110: both handlers used to be fire-and-forget inside a transition - the
 * result was discarded, so a refused toggle or delete left the row exactly as
 * it was with no message, and the delete fired on a single click of an
 * unlabelled trash icon. Same treatment the calendar's card already had:
 * capture `{ error }`, surface it on the row, and confirm before deleting.
 */
function ScheduledRunRow({ run }: { run: ScheduledRun }) {
  const router = useRouter();
  const [busy, setBusy] = useState<null | "toggle" | "delete">(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  async function onToggle() {
    if (busy) return;
    setBusy("toggle");
    setError(null);
    try {
      const res = await toggleScheduledRunAction(run.id, !run.enabled);
      if (res?.error) {
        setError(res.error);
        return;
      }
      router.refresh();
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : `Couldn't ${run.enabled ? "pause" : "resume"} this schedule.`,
      );
    } finally {
      setBusy(null);
    }
  }

  async function onDelete() {
    if (busy) return;
    setBusy("delete");
    setError(null);
    try {
      const res = await deleteScheduledRunAction(run.id);
      if (res?.error) {
        setError(res.error);
        setConfirmingDelete(false);
        return;
      }
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't delete this schedule.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <li className="py-3">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <p className="truncate text-sm font-medium">{run.label}</p>
            {!run.enabled && <Badge tone="neutral">Paused</Badge>}
            {/* ON THE ROW, not only in the paragraph above the list. This
                generator submits with `charge: null`: its fires never touch the
                client's credits, never appear in the credit ledger, and still
                spend real money at the model. That was stated once, at the top
                of a card, where it reads as a property of the CARD rather than
                of each schedule someone is about to leave running. */}
            <Badge tone="neutral">Not billed</Badge>
          </div>
          <p className="truncate text-xs text-muted-2">{describeCadence(run.cadence)}</p>
          <p className="text-xs text-muted-2">
            {run.enabled ? "Next" : "Would run"} {relativeTime(run.nextRunAt)}
            {run.lastRunAt ? ` · last ${relativeTime(run.lastRunAt)}` : ""}
          </p>
        </div>
        {!confirmingDelete && (
          <div className="flex shrink-0 items-center gap-1.5">
            <Button
              size="sm"
              variant="ghost"
              onClick={onToggle}
              loading={busy === "toggle"}
              disabled={busy != null}
            >
              {run.enabled ? "Pause" : "Resume"}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setConfirmingDelete(true)}
              disabled={busy != null}
              aria-label="Delete schedule"
            >
              <Icon name="Trash2" className="h-4 w-4" />
            </Button>
          </div>
        )}
      </div>

      {confirmingDelete && (
        <div className="mt-2 space-y-2">
          <p className="text-xs text-danger">
            Delete this schedule permanently? The agent stops running on this cadence and it
            can&apos;t be undone. To stop it temporarily, pause it instead.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="danger"
              onClick={onDelete}
              loading={busy === "delete"}
              disabled={busy != null}
            >
              Yes, delete it
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setConfirmingDelete(false)}
              disabled={busy != null}
            >
              Keep it
            </Button>
          </div>
        </div>
      )}

      {error && <p className="mt-2 text-xs text-danger">{error}</p>}
    </li>
  );
}

export function ScheduledRunsCard({
  clientId,
  runs,
  agents,
}: {
  clientId: string;
  runs: ScheduledRun[];
  agents: SchedulableAgent[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [showForm, setShowForm] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // form state
  const [agentId, setAgentId] = useState(agents[0]?.id ?? "");
  const [days, setDays] = useState<number[]>(DEFAULT_CADENCE.daysOfWeek);
  const [hour, setHour] = useState(DEFAULT_CADENCE.hour);
  const [minute, setMinute] = useState(DEFAULT_CADENCE.minute);
  /**
   * THE ZONE THE HOUR ABOVE IS MEANT IN — this browser's, resolved once.
   *
   * It was a free-text field pre-filled with `America/Sao_Paulo`: every client
   * in the product started on one country's clock, and a wall clock typed by
   * someone in another one silently meant a different instant. It was also
   * unvalidated, so "BRT" or "Brazil" reached `isValidCadence` and the schedule
   * was simply refused with nothing pointing at the field.
   *
   * ONE ANSWER FOR BOTH SCHEDULERS. The planned scheduler (schedule-run-modal →
   * createPlannedRunAction) already resolved this exact question the same way —
   * the hour you type is the hour on your screen, and the zone travels with it
   * so the stored instant matches the preview you just read. This form is the
   * other schedule surface in the same product; a second answer here is the
   * thing that goes wrong.
   *
   * Lazy initialiser rather than a constant: the form subtree is behind
   * `showForm`, so this value is never rendered during a server pass, and on
   * the client it is the viewer's own zone.
   */
  const [timezone] = useState(() => runtimeTimeZone());
  const [assetType, setAssetType] = useState<AssetType>("social_post");
  const [platform, setPlatform] = useState("linkedin");
  const [prompt, setPrompt] = useState("Draft the next post.");

  function toggleDay(n: number) {
    setDays((prev) => (prev.includes(n) ? prev.filter((d) => d !== n) : [...prev, n]));
  }

  function resetForm() {
    setShowForm(false);
    setError(null);
  }

  function submit() {
    setError(null);
    startTransition(async () => {
      const res = await createScheduledRunAction({
        clientId,
        agentId,
        prompt,
        cadence: { daysOfWeek: days, hour, minute, timezone },
        assetType,
        platform: platform.trim() || undefined,
      });
      if (res.error) {
        setError(res.error);
        return;
      }
      resetForm();
      router.refresh();
    });
  }

  return (
    <div className="space-y-4">
      {runs.length === 0 ? (
        <p className="text-sm text-muted-2">No scheduled runs yet.</p>
      ) : (
        <ul className="divide-y divide-border">
          {runs.map((run) => (
            <ScheduledRunRow key={run.id} run={run} />
          ))}
        </ul>
      )}

      {showForm ? (
        <div className="space-y-3 rounded-lg border border-border p-4">
          {agents.length === 0 ? (
            <p className="text-sm text-muted-2">
              No custom agents exist yet. Create one on the Agents page first (e.g. the LinkedIn
              company-page generator), then schedule it here.
            </p>
          ) : (
            <>
              <div>
                <Label htmlFor="sr-agent">Agent</Label>
                <Select id="sr-agent" value={agentId} onChange={(e) => setAgentId(e.target.value)}>
                  {agents.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
                </Select>
                <p className="mt-1 truncate text-xs text-muted-2">
                  {agents.find((a) => a.id === agentId)?.entrySkillDir}
                </p>
              </div>

              <div>
                <Label>Days</Label>
                <div className="flex flex-wrap gap-1.5">
                  {DAYS.map((d) => (
                    <button
                      key={d.n}
                      type="button"
                      onClick={() => toggleDay(d.n)}
                      className={
                        "rounded-md border px-2.5 py-1 text-xs transition-colors " +
                        (days.includes(d.n)
                          ? "border-foreground/30 bg-foreground/[0.06] text-foreground"
                          : "border-border text-muted-2 hover:text-foreground")
                      }
                    >
                      {d.label}
                    </button>
                  ))}
                </div>
              </div>

              <div className="flex flex-wrap gap-3">
                <div className="w-20">
                  <Label htmlFor="sr-hour">Hour</Label>
                  <Input
                    id="sr-hour"
                    type="number"
                    min={0}
                    max={23}
                    value={hour}
                    onChange={(e) => setHour(Number(e.target.value))}
                  />
                </div>
                <div className="w-20">
                  <Label htmlFor="sr-min">Minute</Label>
                  <Input
                    id="sr-min"
                    type="number"
                    min={0}
                    max={59}
                    value={minute}
                    onChange={(e) => setMinute(Number(e.target.value))}
                  />
                </div>
                <div className="min-w-[180px] flex-1">
                  <Label id="sr-tz-label">Time zone</Label>
                  {/* Read-only on purpose — the hour above means the hour on
                      this screen. Shown rather than hidden so a person
                      scheduling for a client in another country can see which
                      clock they are setting. Not an <Input>: there is nothing
                      to type, and `htmlFor` on a non-labelable element labels
                      nothing. */}
                  <p
                    aria-labelledby="sr-tz-label"
                    className="flex h-9 items-center truncate rounded-md border border-border bg-surface-2 px-2.5 text-xs text-muted"
                  >
                    {timezone}
                  </p>
                </div>
              </div>

              <div className="flex flex-wrap gap-3">
                <div className="min-w-[160px] flex-1">
                  <Label htmlFor="sr-type">Asset type</Label>
                  <Select
                    id="sr-type"
                    value={assetType}
                    onChange={(e) => setAssetType(e.target.value as AssetType)}
                  >
                    {ASSET_TYPES.map((t) => (
                      <option key={t} value={t}>
                        {t}
                      </option>
                    ))}
                  </Select>
                </div>
                <div className="min-w-[160px] flex-1">
                  <Label htmlFor="sr-platform">Platform</Label>
                  <Input
                    id="sr-platform"
                    value={platform}
                    onChange={(e) => setPlatform(e.target.value)}
                    placeholder="linkedin"
                  />
                </div>
              </div>

              <div>
                <Label htmlFor="sr-prompt">Run prompt</Label>
                <Textarea
                  id="sr-prompt"
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  rows={2}
                />
              </div>

              {error && <p className="text-sm text-danger">{error}</p>}

              <div className="flex items-center gap-2">
                <Button size="sm" onClick={submit} loading={pending} disabled={!agentId || days.length === 0}>
                  Create schedule
                </Button>
                <Button size="sm" variant="ghost" onClick={resetForm} disabled={pending}>
                  Cancel
                </Button>
              </div>
            </>
          )}
        </div>
      ) : (
        <Button size="sm" variant="outline" onClick={() => setShowForm(true)}>
          <Icon name="Plus" className="h-4 w-4" />
          New scheduled run
        </Button>
      )}
    </div>
  );
}
