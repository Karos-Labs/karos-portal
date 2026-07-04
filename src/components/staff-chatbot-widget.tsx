"use client";

import { CopilotDock } from "@/components/copilot-dock";
import { useActiveClient } from "@/lib/active-client-context";
import type { Agent } from "@/lib/types";

/**
 * Renders the docked AI Copilot right-rail (identical to the client portal
 * experience) when an admin is in "View as Client" mode. Returns null and
 * takes up no space when no client is selected in the sidebar picker.
 * Re-mounts with a fresh key when the selected client changes.
 */
export function StaffCopilotDock({
  agents,
  userName,
}: {
  agents: Agent[];
  userName?: string;
}) {
  const { activeClient } = useActiveClient();
  if (!activeClient) return null;

  const { client } = activeClient;

  return (
    <CopilotDock
      key={client.id}
      clientId={client.id}
      clientName={client.name}
      agents={agents.filter((a) => a.isActive && !a.isSystem && a.id !== "intel-report-agent")}
      userName={userName}
      client={{
        name: client.name,
        website: client.website,
        industry: client.industry,
      }}
    />
  );
}
