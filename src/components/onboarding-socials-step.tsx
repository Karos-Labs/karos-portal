"use client";

import { IntegrationsTab } from "@/components/integrations-tab";
import type { IntegrationView } from "@/lib/integrations/sanitize";
import type { Role } from "@/lib/types";
import type { SeatView } from "@/components/linkedin-seats-workspace";

interface Props {
  clientId: string;
  integrations: IntegrationView[];
  oauthEnabledPlatforms: string[];
  /** Passed straight through to IntegrationsTab — see oauth.ts. */
  googleBusinessProfileRequested: boolean;
  currentUserRole: Role;
  /** Sanitized LinkedIn employee seats - same data Settings shows, so an
   * existing workspace's roster never appears empty here by mistake. */
  linkedinSeats?: SeatView[];
  seatLimit?: number;
  seatCost?: number;
}

/**
 * Onboarding step 3 - embeds the same IntegrationsTab used on the client
 * Settings page, so a channel connected here or later never diverges: one
 * component, one OAuth flow, one Reconnect/Disconnect behavior. New platforms
 * added to PLATFORM_REGISTRY show up here automatically.
 */
export function OnboardingSocialsStep({
  clientId,
  integrations,
  oauthEnabledPlatforms,
  googleBusinessProfileRequested,
  currentUserRole,
  linkedinSeats,
  seatLimit,
  seatCost,
}: Props) {
  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-base font-semibold">Social media channels</h2>
        {/* No count. PLATFORM_REGISTRY carries ten channels and this line
            said "all six" — a number the file cannot verify and the registry had
            already outgrown. The spaced hyphen it also carried was invisible to
            a per-line scan because JSX wrapped the sentence right after it:
            the browser collapses that newline to a space, so the client read
            "all six now - you can always add", and the guard must normalise JSX
            whitespace before asking the question. */}
        <p className="text-xs text-muted-2">
          Connect the channels your agents should publish to. One, some, or all of them. You can
          always add the rest later from Settings.
        </p>
      </div>

      <IntegrationsTab
        clientId={clientId}
        integrations={integrations}
        oauthEnabledPlatforms={oauthEnabledPlatforms}
      googleBusinessProfileRequested={googleBusinessProfileRequested}
        currentUserRole={currentUserRole}
        linkedinSeats={linkedinSeats}
        seatLimit={seatLimit}
        seatCost={seatCost}
      />
    </div>
  );
}
