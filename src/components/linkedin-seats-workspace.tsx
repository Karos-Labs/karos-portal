"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button, Badge, Input } from "@/components/ui";
import { Icon } from "@/components/icon";
import { cn } from "@/lib/utils";
import {
  addEmployeeSeatAction,
  updateEmployeeSeatAction,
  removeEmployeeSeatAction,
} from "@/lib/actions/seat-actions";

/** Client-safe seat view — never carries tokens, only whether one is present. */
export interface SeatView {
  id: string;
  employeeName: string;
  employeeEmail: string;
  status: "active" | "paused";
  resumeUrl?: string | null;
  /** True when the employee has completed "Sign in with LinkedIn" (token on file). */
  connected: boolean;
}

function initials(name: string): string {
  return name.trim().split(/\s+/).slice(0, 2).map((p) => p[0]?.toUpperCase() ?? "").join("");
}

/**
 * LinkedIn Employee Advocacy workspace — a "Company Employee Roster" for the
 * connected LinkedIn integration. Staff/clients add seats (gated by the plan +
 * credit monetization guard), pause/resume, and remove them. Each seat is an
 * employee handle the analytics sync measures independently.
 */
export function LinkedInSeatsWorkspace({
  clientId,
  seats,
  seatLimit,
  seatCost,
}: {
  clientId: string;
  seats: SeatView[];
  seatLimit: number;
  seatCost: number;
}) {
  const router = useRouter();
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [gate, setGate] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const atLimit = seats.length >= seatLimit;

  function submitSeat() {
    setError(null);
    setGate(null);
    if (!name.trim() || !email.trim()) {
      setError("Name and email are required.");
      return;
    }
    startTransition(async () => {
      const res = await addEmployeeSeatAction(clientId, { employeeName: name, employeeEmail: email });
      if (res.ok) {
        setName("");
        setEmail("");
        setAdding(false);
        router.refresh();
      } else if (res.gated) {
        setGate(res.error);
      } else {
        setError(res.error);
      }
    });
  }

  function toggleStatus(seat: SeatView) {
    startTransition(async () => {
      await updateEmployeeSeatAction(clientId, seat.id, {
        status: seat.status === "active" ? "paused" : "active",
      });
      router.refresh();
    });
  }

  function remove(seat: SeatView) {
    startTransition(async () => {
      await removeEmployeeSeatAction(clientId, seat.id);
      router.refresh();
    });
  }

  return (
    <div className="border-t border-border bg-surface-2/40 p-4">
      {/* Header — wraps so the Add button never overflows narrow cards */}
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <Icon name="Users" className="h-4 w-4 shrink-0 text-neon" />
          <p className="text-sm font-medium text-foreground">Company Employee Roster</p>
          <Badge tone={atLimit ? "warning" : "neutral"}>
            {seats.length}/{seatLimit} seats
          </Badge>
        </div>
        <Button
          size="sm"
          variant="accent"
          onClick={() => setAdding((a) => !a)}
          disabled={pending}
          className="shrink-0 whitespace-nowrap"
        >
          <Icon name="Plus" className="h-3.5 w-3.5" />
          Add Employee Seat
        </Button>
      </div>

      {/* Add form */}
      {adding && (
        <div className="mb-3 space-y-2 rounded-md border border-border bg-surface p-3">
          <div className="grid gap-2 sm:grid-cols-2">
            <Input placeholder="Employee name" value={name} onChange={(e) => setName(e.target.value)} />
            <Input placeholder="Employee email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          </div>
          {atLimit && (
            <p className="text-[11px] text-muted-2">
              This is beyond your {seatLimit}-seat plan — adding a seat is a one-time {seatCost}-credit
              charge.
            </p>
          )}
          <div className="flex gap-2">
            <Button size="sm" onClick={submitSeat} loading={pending}>
              {atLimit ? `Add & charge ${seatCost} credits` : "Add seat"}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => { setAdding(false); setError(null); setGate(null); }}>
              Cancel
            </Button>
          </div>
          {error && <p className="text-xs text-danger">{error}</p>}
        </div>
      )}

      {/* Monetization blocker */}
      {gate && (
        <div className="mb-3 flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 p-3">
          <Icon name="Lock" className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
          <div className="space-y-1">
            <p className="text-xs font-medium text-foreground">Seat limit reached</p>
            <p className="text-xs text-muted">{gate}</p>
            <p className="text-[11px] text-muted-2">Ask your Karos team to raise your seat plan or top up credits.</p>
          </div>
        </div>
      )}

      {/* Roster */}
      {seats.length === 0 ? (
        <p className="rounded-md border border-dashed border-border py-6 text-center text-xs text-muted-2">
          No employee seats yet. Add a teammate to publish and measure content on their LinkedIn handle.
        </p>
      ) : (
        <ul className="space-y-2">
          {seats.map((seat) => (
            <li
              key={seat.id}
              className="rounded-md border border-border bg-surface p-3"
            >
              {/* Row 1: Employee Info (Left) + Connection Status/Button (Right) */}
              <div className="mb-2 flex items-start justify-between gap-3">
                <div className="flex min-w-0 items-start gap-3">
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-neon/15 text-sm font-semibold text-neon">
                    {initials(seat.employeeName) || "?"}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold text-foreground">{seat.employeeName}</p>
                  </div>
                </div>
                <div className="shrink-0">
                  {seat.connected ? (
                    <Badge tone="neon">
                      <Icon name="CircleCheck" className="h-3 w-3" />
                      Linked
                    </Badge>
                  ) : (
                    <a
                      href={`/api/integrations/linkedin/employee/auth?clientId=${encodeURIComponent(clientId)}&seatId=${encodeURIComponent(seat.id)}`}
                      className="inline-flex items-center gap-1.5 rounded-md bg-[#0A66C2] px-3 py-1.5 text-xs font-medium text-white transition-opacity hover:opacity-90"
                    >
                      <Icon name="LogIn" className="h-3.5 w-3.5" />
                      Sign in
                    </a>
                  )}
                </div>
              </div>

              {/* Row 2: Email (Left) + Status Badge + Action Icons (Right) */}
              <div className="flex items-center justify-between gap-3">
                <p className="truncate text-xs text-muted-2">{seat.employeeEmail}</p>
                <div className="flex shrink-0 items-center gap-2">
                  <Badge tone={seat.status === "active" ? "success" : "neutral"}>
                    {seat.status.toUpperCase()}
                  </Badge>
                  <button
                    type="button"
                    onClick={() => toggleStatus(seat)}
                    disabled={pending}
                    className="text-muted-2 transition-colors hover:text-foreground disabled:opacity-40"
                    title={seat.status === "active" ? "Pause seat" : "Activate seat"}
                  >
                    <Icon name={seat.status === "active" ? "Pause" : "Play"} className="h-4 w-4" />
                  </button>
                  <button
                    type="button"
                    onClick={() => remove(seat)}
                    disabled={pending}
                    className={cn("text-muted-2 transition-colors hover:text-danger disabled:opacity-40")}
                    title="Remove seat"
                  >
                    <Icon name="Trash2" className="h-4 w-4" />
                  </button>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
