"use client";

import { createContext, useContext, useState, useEffect } from "react";
import type { StaffShellClientView } from "@/lib/client-visibility";
import type { ClientCompetitor, ClientContextDoc } from "@/lib/types";

/**
 * `client` is the PROJECTION, not the document. This context is held by "use
 * client" components in the staff shell, so whatever is put here is serialized
 * into the RSC payload of every page that mounts them — see
 * StaffShellClientView for the field list and why it is the field list.
 * Widening this back to `Client` is what re-ships the join token.
 */
export interface ActiveClientData {
  client: StaffShellClientView;
  contextDocs: ClientContextDoc[];
  competitors: ClientCompetitor[];
  isAdmin: boolean;
}

interface ActiveClientContextValue {
  activeClient: ActiveClientData | null;
  setActiveClient: (data: ActiveClientData | null) => void;
}

const ActiveClientContext = createContext<ActiveClientContextValue>({
  activeClient: null,
  setActiveClient: () => {},
});

export function ActiveClientProvider({ children }: { children: React.ReactNode }) {
  const [activeClient, setActiveClient] = useState<ActiveClientData | null>(null);
  return (
    <ActiveClientContext.Provider value={{ activeClient, setActiveClient }}>
      {children}
    </ActiveClientContext.Provider>
  );
}

export function useActiveClient(): ActiveClientContextValue {
  return useContext(ActiveClientContext);
}

/**
 * Rendered inside the clients/[id] nested layout for staff.
 * Sets the global active-client context from server-fetched data.
 * Context intentionally persists when navigating elsewhere; only cleared
 * by the "View as client" picker X button or selecting a different client.
 */
export function ClientContextSync({
  client,
  contextDocs,
  competitors,
  isAdmin,
}: ActiveClientData) {
  const { setActiveClient } = useActiveClient();

  // Content signature, not a count: Regenerate and Correct Info change document
  // CONTENT, and a count-only dependency left the sidebar serving the document
  // the client had already replaced. `version` is bumped on every write by
  // updateContextDocContent, so this changes exactly when the text does.
  const docSignature = contextDocs.map((d) => `${d.id}:${d.version}`).join("|");
  // The sidebar also reads the processing lock off this same snapshot to grey
  // out Regenerate, so the fields that lock depends on belong in the signature.
  const processingSignature = `${client.isAiProcessing ? 1 : 0}:${client.aiProcessingStartedAt ?? 0}`;
  // Same reasoning for competitors: a count-only dependency missed every change
  // that leaves the total alone — a report→manual promotion, a rename, a
  // simultaneous add+remove — so the rail kept serving the stale roster
  // (QA F62).
  const competitorSignature = competitors
    .map((c) => `${c.id}:${c.source}:${c.company}`)
    .join("|");

  useEffect(() => {
    setActiveClient({ client, contextDocs, competitors, isAdmin });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client.id, docSignature, competitorSignature, isAdmin, processingSignature]);

  return null;
}
