import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * WHAT THE CONFIRM ACTUALLY PAINTS, asked of the RENDER rather than of the file.
 *
 * The in-flight sentence — "A run is working right now and already has their
 * details" — is gated on `runInFlight`, and every assertion protecting it was a
 * source scan: `expect(src).toMatch(/runInFlight/)` and
 * `toMatch(/may still come back with/i)`. Both are satisfied by the prop
 * declaration and the doc comment, so changing `{runInFlight ? (…) : null}` to
 * `{true ? (…) : null}` left the whole 2560-test suite green — and every client
 * who pressed Remove would read that a run was working whether or not one was.
 *
 * That is the same family as the mount defect one level up (the prop is right and
 * the render throws it away), reached from the other end, and neither a scan for
 * the identifier nor a scan for the sentence can tell the two apart. Only
 * rendering the component twice can.
 *
 * `SEAT_REMOVE_CONFIRM_TESTID` is not used here on purpose: the assertions read
 * the client's own words, because those words are the thing that must be
 * conditional.
 */

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("@/lib/actions/client-seat-actions", () => ({ removeClientSeatAction: vi.fn() }));
vi.mock("server-only", () => ({}));

import { ClientSeatRemove } from "@/components/client-seat-remove";

const IN_FLIGHT = /A run is working right now/i;

/**
 * The confirm panel, not the collapsed trigger. The component opens on a click
 * and `renderToStaticMarkup` cannot click, so the panel is reached by rendering
 * with the state the click produces — via the component's own test seam.
 */
function confirmMarkup(runInFlight: boolean): string {
  return renderToStaticMarkup(
    <ClientSeatRemove
      clientId="c1"
      seatId="seat-1"
      seatName="Daniel Herbert"
      runInFlight={runInFlight}
      initiallyConfirming
    />,
  );
}

describe("the in-flight sentence is conditional, in the DOM", () => {
  it("says a run is working when one is", () => {
    expect(confirmMarkup(true)).toMatch(IN_FLIGHT);
  });

  it("says nothing about a run when none is working", () => {
    // The direction the source scans could not see. A confirm that always shows
    // the sentence tells the client a run holds their data when none does —
    // its own false statement, and the reason the flag exists at all.
    expect(confirmMarkup(false)).not.toMatch(IN_FLIGHT);
  });

  it("shows the rest of the confirm either way", () => {
    for (const flag of [true, false]) {
      const markup = confirmMarkup(flag);
      expect(markup, `runInFlight=${flag}`).toMatch(/Remove Daniel Herbert\?/);
      expect(markup, `runInFlight=${flag}`).toMatch(/It cannot be undone/i);
    }
  });

  it("never tells a client their work arrives in batches", () => {
    // The word this component renders inside two surfaces that forbid it; the
    // sweep next door reads those three files by name and cannot see this one.
    for (const flag of [true, false]) {
      expect(confirmMarkup(flag)).not.toMatch(/\bbatch/i);
    }
  });
});
