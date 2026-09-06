import { afterEach, describe, expect, it, vi } from "vitest";

import { SETUP_LANDING_KEYS, SETUP_STEP_IDS } from "@/lib/setup-ladder";
import { dropLandingParams, landedFromLadder } from "@/lib/setup-landing-params";

/**
 * ONE COPY OF WHAT EVERY LADDER LANDING DOES WITH THE URL (round 6 review, E14).
 *
 * `client-profile-panel.tsx` and `client-documents.tsx` each carried their own
 * `SETUP_STEP_IDS.some(...)` and their own `new URL(location.href)` +
 * `replaceState` block. Two copies of a rule about the URL is how one of them
 * ends up dropping the hash — and the documents landing arrives at
 * `#documents`, so losing it scroll-jumps the client away from the section the
 * ladder just sent them to. Exercised for real: `window` is an object, so a
 * stub is all this needs — no jsdom in this repo (see calendar-url-state).
 */

const original = (globalThis as { window?: unknown }).window;

afterEach(() => {
  if (original === undefined) delete (globalThis as { window?: unknown }).window;
  else (globalThis as { window?: unknown }).window = original;
});

function stubWindow(href: string) {
  const replaceState = vi.fn();
  (globalThis as { window?: unknown }).window = {
    location: { href },
    history: { replaceState },
  };
  return replaceState;
}

describe("landedFromLadder", () => {
  it("accepts every real step id and nothing else", () => {
    for (const id of SETUP_STEP_IDS) {
      expect(landedFromLadder(new URLSearchParams(`${SETUP_LANDING_KEYS.for}=${id}`))).toBe(true);
    }
    // Fail open: a stale or hand-typed link lands on the ordinary tab rather
    // than opening a form nobody asked for.
    for (const bad of ["", "profil", "step-2", "1"]) {
      expect(landedFromLadder(new URLSearchParams(`${SETUP_LANDING_KEYS.for}=${bad}`))).toBe(false);
    }
    expect(landedFromLadder(new URLSearchParams(""))).toBe(false);
  });
});

describe("dropLandingParams", () => {
  it("drops only the named keys and keeps the hash", () => {
    const replaceState = stubWindow(
      "https://app.karos.test/clients/c1/settings?tab=profile&doc=brand-voice&for=voice#documents",
    );
    dropLandingParams([SETUP_LANDING_KEYS.doc, SETUP_LANDING_KEYS.for]);
    expect(replaceState).toHaveBeenCalledTimes(1);
    expect(replaceState.mock.calls[0]?.[2]).toBe(
      "/clients/c1/settings?tab=profile#documents",
    );
  });

  it("leaves a URL with none of them alone but for the rewrite", () => {
    const replaceState = stubWindow("https://app.karos.test/clients/c1/settings#documents");
    dropLandingParams([SETUP_LANDING_KEYS.edit, SETUP_LANDING_KEYS.for]);
    expect(replaceState.mock.calls[0]?.[2]).toBe("/clients/c1/settings#documents");
  });

  it("does nothing on the server rather than throwing", () => {
    delete (globalThis as { window?: unknown }).window;
    expect(() => dropLandingParams([SETUP_LANDING_KEYS.for])).not.toThrow();
  });
});
