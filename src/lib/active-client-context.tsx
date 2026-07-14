"use client";

import { createContext, useContext, useState, useEffect } from "react";
import type { Client, ClientCompetitor, ClientContextDoc } from "@/lib/types";

export interface ActiveClientData {
  client: Client;
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

  useEffect(() => {
    setActiveClient({ client, contextDocs, competitors, isAdmin });
    // Re-sync when the client changes OR when the doc/competitor counts change (e.g. after
    // an add/delete + revalidatePath). Content changes within same count are rare and
    // will be picked up on the next navigation anyway.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client.id, contextDocs.length, competitors.length, isAdmin]);

  return null;
}
