"use client";

import { ContactUsButton } from "@/components/contact-us-modal";

/**
 * A failed RUN press on an intake surface: the sentence, and the way out it
 * names.
 *
 * FLOW AUDIT 2026-09, R17. Every one of these presses routes its failure
 * through `clientSafeRunError`, whose fallback sentence is
 * `CLIENT_RUN_REFUSAL_MESSAGE` — "Try again shortly, or contact your Karos
 * team." — and no intake page carried a contact control, so the copy named a
 * remedy the page could not reach. That constant's own docstring claims "a
 * ContactUsButton already sits in both cards that render this", which was true
 * of the two agent-detail cards and of nothing on the six intake pages.
 *
 * NOT the funnel's save failures. `INTAKE_SAVE_FAILED` and friends
 * (lib/intake-save.ts) tell the client to refresh and retry, which is a remedy
 * they already have; adding support to those would make a dropped click read
 * like an outage. This renders only where a RUN could not be started.
 */
export function IntakeRunError({ error }: { error: string | null }) {
  if (!error) return null;
  return (
    <div className="mt-3 rounded-[var(--radius)] border border-warning/30 bg-warning/10 px-4 py-2.5">
      <p className="text-xs text-warning" role="alert">
        {error}
      </p>
      {/* Full-bleed inside the notice, the same way the blocked-run card in
          agent-detail-panel.tsx mounts this control under its reason.

          NO `label`. One dialog, one name (R7 · GOV.UK *Write effective
          links*): the support dialog already answered to five, and a sixth
          spelling here would have re-opened the finding this pass closed. The
          context is in the sentence above the control, which is where it
          belongs — not in a rename of the thing being opened. */}
      <div className="-mx-4 -mb-1 mt-1">
        <ContactUsButton variant="row" />
      </div>
    </div>
  );
}
