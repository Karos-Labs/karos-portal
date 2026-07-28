"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Modal } from "@/components/modal";
import { Button, Input, Label, Select, Textarea } from "@/components/ui";
import { Icon } from "@/components/icon";
import { AgentMark } from "@/components/agent-identity";
import { createPlannedRunAction } from "@/lib/actions/planned-run-actions";
import { computeNextRun, describeCadence, shortZoneLabel } from "@/lib/scheduled-runs";
import type { CalendarClientOption, ScheduleAgentOption } from "@/components/run-calendar";
import type { PlannedRunCadence } from "@/lib/types";

const WEEKDAYS = [
  { value: 0, label: "Sunday" }, { value: 1, label: "Monday" }, { value: 2, label: "Tuesday" },
  { value: 3, label: "Wednesday" }, { value: 4, label: "Thursday" }, { value: 5, label: "Friday" },
  { value: 6, label: "Saturday" },
];

/** `YYYY-MM-DDTHH:mm` in the browser's zone — the format datetime-local wants. */
function toLocalInputValue(at: number): string {
  const d = new Date(at);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function ScheduleRunModal({
  clients,
  agents,
  defaultClientId,
  prefillAt,
  onClose,
}: {
  clients: CalendarClientOption[];
  agents: ScheduleAgentOption[];
  defaultClientId?: string;
  /** The day the user clicked on the calendar (epoch millis, 09:00 local). */
  prefillAt?: number;
  onClose: () => void;
}) {
  const router = useRouter();
  const prefill = prefillAt != null ? new Date(prefillAt) : null;
  const [clientId, setClientId] = useState(defaultClientId ?? clients[0]?.id ?? "");
  const [agentId, setAgentId] = useState(agents[0]?.id ?? "");
  const [prompt, setPrompt] = useState("");
  const [cadence, setCadence] = useState<PlannedRunCadence>(prefill ? "once" : "weekly");
  const [time, setTime] = useState("09:00");
  const [weekday, setWeekday] = useState(prefill ? prefill.getDay() : 1);
  const [dayOfMonth, setDayOfMonth] = useState(prefill ? prefill.getDate() : 1);
  // Clicking an empty day is a statement about WHEN, so the day carries into
  // the form instead of being thrown away.
  const [runAt, setRunAt] = useState(prefillAt != null ? toLocalInputValue(prefillAt) : "");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const agent = useMemo(() => agents.find((a) => a.id === agentId), [agents, agentId]);
  const [hour, minute] = time.split(":").map((n) => parseInt(n, 10));
  // The zone this preview is computed in. It travels with the schedule so the
  // server stores the same clock the person just read, instead of recomputing
  // the wall time in the container's zone (UTC in production).
  const timeZone = useMemo(
    () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    [],
  );

  const preview = useMemo(() => {
    if (cadence === "once") {
      if (!runAt) return null;
      const at = new Date(runAt).getTime();
      if (Number.isNaN(at)) return null;
      return `Fires ${new Date(at).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })} ${shortZoneLabel(timeZone, at)}`;
    }
    const nextRunAt = computeNextRun({ cadence, hour: hour || 0, minute: minute || 0, weekday, dayOfMonth, timeZone });
    const label = describeCadence({ cadence, hour: hour || 0, minute: minute || 0, weekday, dayOfMonth, nextRunAt, timeZone });
    return `${label} · next ${new Date(nextRunAt).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}`;
  }, [cadence, hour, minute, weekday, dayOfMonth, runAt, timeZone]);

  async function submit() {
    setError(null);
    if (!clientId) { setError("Pick a client."); return; }
    if (!agentId) { setError("Pick an agent."); return; }
    setSubmitting(true);
    const res = await createPlannedRunAction({
      clientId,
      customAgentId: agentId,
      prompt,
      cadence,
      timeZone,
      ...(cadence === "once"
        ? { runAt: runAt ? new Date(runAt).getTime() : undefined }
        : { hour: hour || 0, minute: minute || 0, weekday, dayOfMonth }),
    });
    setSubmitting(false);
    if (res.error) { setError(res.error); return; }
    onClose();
    router.refresh();
  }

  if (agents.length === 0) {
    return (
      <Modal open onClose={onClose} title="Schedule an agent run">
        <p className="text-sm text-muted">
          No agents are available yet. Import agents from the karos-agents repo on the{" "}
          <span className="text-foreground">Agents</span> page first, then schedule them here.
        </p>
        <div className="mt-4 flex justify-end">
          <Button variant="ghost" onClick={onClose}>Close</Button>
        </div>
      </Modal>
    );
  }

  return (
    <Modal open onClose={onClose} title="Schedule an agent run" description="Queue a repo agent to run once or on a repeating cadence.">
      <div className="space-y-4">
        {/* Client */}
        {clients.length > 1 ? (
          <div>
            <Label htmlFor="sr-client">Client</Label>
            <Select id="sr-client" value={clientId} onChange={(e) => setClientId(e.target.value)}>
              {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </Select>
          </div>
        ) : clients.length === 1 ? (
          <p className="text-xs text-muted-2">Client: <span className="text-foreground">{clients[0].name}</span></p>
        ) : null}

        {/* Agent */}
        <div>
          <Label htmlFor="sr-agent">Agent</Label>
          <Select id="sr-agent" value={agentId} onChange={(e) => setAgentId(e.target.value)}>
            {agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </Select>
          {agent?.description && (
            <div className="mt-2 flex items-start gap-2 rounded-md border border-border bg-surface-2 p-2.5">
              <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-foreground/10 bg-foreground/[0.04] text-foreground/80">
                <AgentMark identity={agent.name} icon={agent.icon} className="h-3.5 w-3.5" />
              </div>
              <p className="text-xs text-muted-2">{agent.description}</p>
            </div>
          )}
        </div>

        {/* Prompt */}
        <div>
          <Label htmlFor="sr-prompt">Request</Label>
          <Textarea
            id="sr-prompt"
            placeholder='e.g. "create 3 Instagram posts about this week&apos;s offer"'
            maxLength={4000}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
          />
          <p className="mt-1 text-[11px] text-muted-2">
            A plain-language request run every time — the agent already knows the brand and its playbook.
          </p>
        </div>

        {/* Cadence */}
        <div>
          <Label htmlFor="sr-cadence">Cadence</Label>
          <Select id="sr-cadence" value={cadence} onChange={(e) => setCadence(e.target.value as PlannedRunCadence)}>
            <option value="once">One-off</option>
            <option value="daily">Daily</option>
            <option value="weekly">Weekly</option>
            <option value="monthly">Monthly</option>
          </Select>
        </div>

        {/* Timing */}
        {cadence === "once" ? (
          <div>
            <Label htmlFor="sr-runat">Date &amp; time</Label>
            <Input id="sr-runat" type="datetime-local" value={runAt} onChange={(e) => setRunAt(e.target.value)} />
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-3">
            {cadence === "weekly" && (
              <div>
                <Label htmlFor="sr-weekday">Day of week</Label>
                <Select id="sr-weekday" value={weekday} onChange={(e) => setWeekday(parseInt(e.target.value, 10))}>
                  {WEEKDAYS.map((d) => <option key={d.value} value={d.value}>{d.label}</option>)}
                </Select>
              </div>
            )}
            {cadence === "monthly" && (
              <div>
                <Label htmlFor="sr-dom">Day of month</Label>
                <Input id="sr-dom" type="number" min={1} max={31} value={dayOfMonth} onChange={(e) => setDayOfMonth(parseInt(e.target.value, 10) || 1)} />
              </div>
            )}
            <div>
              <Label htmlFor="sr-time">Time</Label>
              <Input id="sr-time" type="time" value={time} onChange={(e) => setTime(e.target.value)} />
            </div>
          </div>
        )}

        {preview && (
          <p className="flex items-center gap-1.5 rounded-md bg-neon-soft/50 px-3 py-2 text-xs text-foreground">
            <Icon name="CalendarClock" className="h-3.5 w-3.5 text-neon" />{preview}
          </p>
        )}

        {error && <p className="text-xs text-danger">{error}</p>}

        <div className="flex justify-end gap-2 border-t border-border pt-4">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="accent" onClick={submit} loading={submitting}>Schedule run</Button>
        </div>
      </div>
    </Modal>
  );
}
