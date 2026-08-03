"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button, Badge, Input } from "@/components/ui";
import { Icon } from "@/components/icon";
import { cn } from "@/lib/utils";
import { INTAKE_ACTION_FAILED, intakeSave } from "@/lib/intake-save";
import {
  addEmployeeSeatAction,
  updateEmployeeSeatAction,
  removeEmployeeSeatAction,
  type SeatActionResult,
} from "@/lib/actions/seat-actions";

/** Client-safe seat view - never carries tokens, only whether one is present. */
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
 * The two ways one of these writes can fail, read as one shape.
 *
 * The action REFUSES with `{ ok: false, error }` and the funnel reports a THROW
 * with `{ error }`; every caller below wants the same thing from both, and
 * asking each of them to narrow a four-armed union at three call sites is how
 * one of them ends up reading `error` off the success arm. Returns null when
 * nothing failed.
 */
function seatFailure(
  res: SeatActionResult | { error: string },
): { error: string; gated: boolean } | null {
  if (!("ok" in res)) return { error: res.error, gated: false };
  if (res.ok) return null;
  return { error: res.error, gated: res.gated === true };
}

/** The seat's state as a word a reader uses, never the stored one shouted. */
const SEAT_STATUS_LABEL: Record<SeatView["status"], string> = {
  active: "Active",
  paused: "Paused",
};

/**
 * The LinkedIn employee-seat roster for the connected LinkedIn integration:
 * teammates who have signed in with LinkedIn so we can publish and measure on
 * their own handle. Staff/clients add seats (gated by the plan + credit
 * monetization guard), pause/resume, and remove them.
 *
 * NOT the seats an agent drafts for (#83). Those are `clientSeats`, created on
 * each agent's own intake page, uncapped and free, and neither roster can see
 * the other's rows. Merging the two collections is a migration and Daniel's
 * call; until then each surface has to SAY which one it is showing, because the
 * difference between them is money — this one charges credits past
 * `linkedinSeatLimit` and the agent pages do not. Hence the header's own line
 * below, and the matching line on the LinkedIn intake page.
 *
 * Named "employee seats" throughout, matching the button that opens it and the
 * dialog it opens in. It used to head itself "Company Employee Roster" — a third
 * name for the thing, in Title Case, inside a dialog whose own comment says a
 * dialog must not rename what its trigger just named.
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
  /** Seat awaiting the second click of the two-step remove. */
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  /** Failure text for the remove path, shown inside the confirming row. */
  const [removeError, setRemoveError] = useState<string | null>(null);
  /**
   * Failure text for pause/resume, which used to discard its result entirely.
   * Carries the seat it belongs to so the message lands on the row the reader
   * just clicked rather than at the top of a roster of ten.
   */
  const [statusError, setStatusError] = useState<{ seatId: string; message: string } | null>(null);
  const [pending, startTransition] = useTransition();

  const atLimit = seats.length >= seatLimit;
  /**
   * Whether re-adding someone after this removal would be charged again.
   * evaluateSeatAddition charges when `currentSeatCount >= seatLimit`, so after
   * dropping one seat the re-add is free iff `seats.length - 1 < seatLimit` -
   * i.e. it costs credits exactly when the roster is currently OVER the limit.
   * Derived from the live count rather than a stored per-seat price because the
   * charge that matters here is the future re-add, not the original purchase.
   */
  const reAddCharges = seats.length > seatLimit;

  function submitSeat() {
    setError(null);
    setGate(null);
    if (!name.trim() || !email.trim()) {
      setError("Name and email are required.");
      return;
    }
    startTransition(async () => {
      // Same funnel as the remove below and as every intake write. The add and
      // the pause were the two paths left unwrapped when the remove learned
      // this lesson, and requireSeatAccess THROWS for all three alike (#86).
      const fail = seatFailure(
        await intakeSave(() =>
          addEmployeeSeatAction(clientId, { employeeName: name, employeeEmail: email }),
        ),
      );
      if (!fail) {
        setName("");
        setEmail("");
        setAdding(false);
        router.refresh();
        return;
      }
      if (fail.gated) setGate(fail.error);
      else setError(fail.error);
    });
  }

  function toggleStatus(seat: SeatView) {
    setStatusError(null);
    startTransition(async () => {
      const fail = seatFailure(
        await intakeSave(
          () =>
            updateEmployeeSeatAction(clientId, seat.id, {
              status: seat.status === "active" ? "paused" : "active",
            }),
          // Not a save — there is no form and no answers on screen.
          INTAKE_ACTION_FAILED,
        ),
      );
      // The result used to be discarded outright, so a refused pause looked
      // exactly like a successful one: the row refreshed back to the state it
      // was already in and said nothing at all.
      if (fail) {
        setStatusError({ seatId: seat.id, message: fail.error });
        return;
      }
      router.refresh();
    });
  }

  /**
   * Second step of the remove. Previously this fired on the first click of a
   * 16px trash icon two pixels from Pause, and ignored the result entirely: an
   * authorization failure (requireSeatAccess THROWS) refreshed the row back
   * into place with no message at all. The try/catch that fixed that is now the
   * shared funnel, so this control and the two above cannot drift apart again.
   */
  function remove(seat: SeatView) {
    setRemoveError(null);
    startTransition(async () => {
      const fail = seatFailure(
        // This read "Couldn't remove this seat. Please try again." before the
        // funnel; the save sentence that replaced it was false here.
        await intakeSave(
          () => removeEmployeeSeatAction(clientId, seat.id),
          "We couldn't remove this seat. Refresh the page to check you're still signed in, then try again.",
        ),
      );
      if (fail) {
        setRemoveError(fail.error);
        return;
      }
      setConfirmingId(null);
      router.refresh();
    });
  }

  return (
    <div className="border-t border-border bg-surface-2/40 p-4">
      {/* Header - wraps so the Add button never overflows narrow cards */}
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <Icon name="Users" className="h-4 w-4 shrink-0 text-neon" />
          <p className="text-sm font-medium text-foreground">Employee seats</p>
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
          Add employee seat
        </Button>
      </div>

      {/* #83: the agent pages ask for "a seat" too, read a different
          collection, and count nobody here — so the pill above is only honest
          if this says what it is counting. It is also where the money is: this
          roster charges credits past the plan limit and the agent pages do not. */}
      <p className="mb-3 text-[11px] text-muted-2">
        Teammates who have signed in with LinkedIn, so we can publish and measure on their own
        handle. The people your agents write for are set up on each agent&rsquo;s own page instead,
        and are not counted here.
      </p>

      {/* Add form */}
      {adding && (
        <div className="mb-3 space-y-2 rounded-md border border-border bg-surface p-3">
          <div className="grid gap-2 sm:grid-cols-2">
            <Input placeholder="Employee name" value={name} onChange={(e) => setName(e.target.value)} />
            <Input placeholder="Employee email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          </div>
          {atLimit && (
            <p className="text-[11px] text-muted-2">
              This is beyond your {seatLimit}-seat plan. Adding a seat is a one-time {seatCost}-credit
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
                  {/* The stored word, through a label table. `.toUpperCase()`
                      shouted the enum itself at the client. */}
                  <Badge tone={seat.status === "active" ? "success" : "neutral"}>
                    {SEAT_STATUS_LABEL[seat.status]}
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
                    onClick={() => {
                      setRemoveError(null);
                      setConfirmingId(seat.id);
                    }}
                    disabled={pending}
                    className={cn(
                      "text-muted-2 transition-colors hover:text-danger disabled:opacity-40",
                      confirmingId === seat.id && "text-danger",
                    )}
                    title="Remove seat"
                  >
                    <Icon name="Trash2" className="h-4 w-4" />
                  </button>
                </div>
              </div>

              {statusError?.seatId === seat.id && (
                <p className="mt-2 text-xs text-danger">{statusError.message}</p>
              )}

              {/* Row 3: two-step remove confirm — same warning-strip shape as
                  the monetization gate above. Removal is not refunded and the
                  employee's LinkedIn sign-in goes with the seat, so the first
                  click can no longer be the destructive one. */}
              {confirmingId === seat.id && (
                <div className="mt-2 flex items-start gap-2 rounded-md border border-danger/40 bg-danger/10 p-3">
                  <Icon name="TriangleAlert" className="mt-0.5 h-4 w-4 shrink-0 text-danger" />
                  <div className="min-w-0 space-y-1.5">
                    <p className="text-xs font-medium text-foreground">
                      Remove {seat.employeeName}?
                    </p>
                    <p className="text-xs text-muted">
                      Their LinkedIn sign-in is removed with the seat, so they would have to sign in
                      again.{" "}
                      {reAddCharges
                        ? `You're over your ${seatLimit}-seat plan, so adding someone back is a one-time ${seatCost}-credit charge. Removing a seat is not refunded.`
                        : "Removing a seat is not refunded."}
                    </p>
                    <p className="text-[11px] text-muted-2">
                      To stop their posts temporarily, pause the seat instead. That keeps the
                      sign-in and can be undone.
                    </p>
                    <div className="flex flex-wrap gap-2 pt-0.5">
                      <Button
                        size="sm"
                        variant="danger"
                        onClick={() => remove(seat)}
                        loading={pending}
                        disabled={pending}
                      >
                        Yes, remove seat
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                          setConfirmingId(null);
                          setRemoveError(null);
                        }}
                        disabled={pending}
                      >
                        Keep it
                      </Button>
                    </div>
                    {removeError && <p className="text-xs text-danger">{removeError}</p>}
                  </div>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
