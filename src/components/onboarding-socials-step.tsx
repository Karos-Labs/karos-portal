"use client";

import { IntegrationsTab } from "@/components/integrations-tab";
import type { IntegrationView } from "@/lib/integrations/sanitize";
import type { Role } from "@/lib/types";
import type { SeatView } from "@/components/linkedin-seats-workspace";

interface Props {
  clientId: string;
  integrations: IntegrationView[];
  oauthEnabledPlatforms: string[];
  currentUserRole: Role;
  /** Sanitized LinkedIn employee seats — same data Settings shows, so an
   * existing workspace's roster never appears empty here by mistake. */
  linkedinSeats?: SeatView[];
  seatLimit?: number;
  seatCost?: number;
}

/**
 * Onboarding step 3 — embeds the same IntegrationsTab used on the client
 * Settings page, so a channel connected here or later never diverges: one
 * component, one OAuth flow, one Reconnect/Disconnect behavior. New platforms
 * added to PLATFORM_REGISTRY show up here automatically.
 */
export function OnboardingSocialsStep({
  clientId,
  integrations,
  oauthEnabledPlatforms,
  currentUserRole,
  linkedinSeats,
  seatLimit,
  seatCost,
}: Props) {
  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-base font-semibold">Social media channels</h2>
        <p className="text-xs text-muted-2">
          Connect the channels your agents should publish to. Connect one, some, or all six now -
          you can always add the rest later from Settings.
        </p>
      </div>

      <IntegrationsTab
        clientId={clientId}
        integrations={integrations}
        oauthEnabledPlatforms={oauthEnabledPlatforms}
        currentUserRole={currentUserRole}
        linkedinSeats={linkedinSeats}
        seatLimit={seatLimit}
        seatCost={seatCost}
      />
    </div>
  );
}
