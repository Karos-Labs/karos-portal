"use client";

import { CopilotDock } from "@/components/copilot-dock";
import { useActiveClient } from "@/lib/active-client-context";
import { isAiProcessingLockActive } from "@/lib/constants";

/**
 * Renders the docked AI Copilot right-rail (identical to the client portal
 * experience) when an admin is in "View as Client" mode. Returns null and
 * takes up no space when no client is selected in the sidebar picker.
 * Re-mounts with a fresh key when the selected client changes.
 */
export function StaffCopilotDock({ userName, viewerUid }: { userName?: string; viewerUid: string }) {
  const { activeClient } = useActiveClient();
  if (!activeClient) return null;

  const { client } = activeClient;

  return (
    <CopilotDock
      key={client.id}
      /* The staff sidebar is w-64, the client rail w-72 — the pinned strip has
         to start at the right edge of whichever one is on screen (CD-G8). */
      shell="staff"
      clientId={client.id}
      viewerUid={viewerUid}
      clientName={client.name}
      /* This dock only ever renders for a signed-in STAFF session — an admin in
         "View as Client" is served the client shell's own dock instead. Staff
         AI work is agency overhead and is never charged, so no price is quoted
         on the Refresh Task Map chip here. Stated rather than defaulted. */
      viewerIsBilled={false}
      userName={userName}
      client={{
        name: client.name,
        website: client.website,
        industry: client.industry,
        isAiProcessing: isAiProcessingLockActive(client),
      }}
    />
  );
}
