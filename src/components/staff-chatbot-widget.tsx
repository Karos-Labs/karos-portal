"use client";

import { CopilotDock } from "@/components/copilot-dock";
import { useActiveClient } from "@/lib/active-client-context";

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
      /* The strip starts at the right edge of the nav column it sits beside
         (CD-G8). This component returns null above unless a client context is
         active, so the only staff shell it is ever painted in is the
         client-context one - whose rail is w-72, like the client's (parity
         pass 2026-09, ruling D22). The prop stays because the two layouts
         still declare which shell they are. */
      shell="staff"
      clientId={client.id}
      viewerUid={viewerUid}
      clientName={client.name}
      userName={userName}
    />
  );
}
