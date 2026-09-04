"use client";

import { createContext, useContext, useState, useEffect } from "react";
import type { StaffShellClientView } from "@/lib/client-visibility";
import type { RailAgent } from "@/components/client-rail-agents-nav";
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
  /**
   * The client's real agent roster, for the rail's "AI agents" dropdown
   * (parity pass 2026-09, ruling D3). Already projected by
   * `railAgentsForClient` — id/key/name/icon, never the agent's internal
   * `description`, which is lab-repo shorthand and staff-only.
   *
   * Empty while the picker is seeding the context optimistically: the roster
   * arrives on the next render from ClientContextSync, so the dropdown starts
   * empty for one paint rather than lying about which agents a client has.
   */
  railAgents: RailAgent[];
  /**
   * The client's SPENDABLE credits — `availableCredits()`, the balance clipped
   * by the weekly/monthly caps — for the footer pill the staff rail now shares
   * with the client's own (ruling D7). `null` while unknown (the picker's
   * optimistic seed), which hides the pill rather than printing a wrong number.
   */
  spendableCredits: number | null;
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
  railAgents,
  spendableCredits,
  isAdmin,
}: ActiveClientData) {
  const { setActiveClient } = useActiveClient();

  // Content signature, not a count: Regenerate and Correct Info change document
  // CONTENT, and a count-only dependency left the sidebar serving the document
  // the client had already replaced. `version` is bumped on every write by
  // updateContextDocContent, so this changes exactly when the text does.
  const docSignature = contextDocs.map((d) => `${d.id}:${d.version}`).join("|");
  // Same reasoning for competitors: a count-only dependency missed every change
  // that leaves the total alone - a report→manual promotion, a rename, a
  // simultaneous add+remove - so the rail kept serving the stale roster
  // (QA F62).
  const competitorSignature = competitors
    .map((c) => `${c.id}:${c.source}:${c.company}`)
    .join("|");
  // Same reasoning again for the roster the parity pass added (2026-09). It
  // changes by GRANT and by STAR — a star toggle can leave the count identical
  // while reordering the pinned set — so the signature carries ids. Without it
  // the staff rail kept serving the roster from whichever client page was
  // opened first.
  const agentSignature = railAgents.map((a) => a.id).join(",");
  /**
   * THE WHOLE PROJECTION, not a hand-picked list of its fields (review wave,
   * 2026-09).
   *
   * This used to be two hand-rolled signatures — `isAiProcessing` +
   * `aiProcessingStartedAt` for the Regenerate lock, `starredAgentIds` for the
   * agent dropdown — over an object with sixteen more fields on it, every one of
   * them PAINTED by the rail this context feeds: the brand card's name, logo,
   * website, accent and category, the whole Brand Colors row, the Company
   * sheet's profile panel. So editing a client from the rail's own pencil wrote
   * to Firestore, re-rendered the page with the new document, and left the rail
   * showing the old one until a hard reload, because nothing in the dependency
   * list had moved. The pencil is ON this rail — the surface that goes stale is
   * the surface the edit was made from.
   *
   * A JSON string of the projection is the honest dependency: `Object.keys` is
   * built by construction in `toStaffShellView`, so key ORDER is stable across
   * renders of the same shape, and a field added there is covered here with no
   * second edit. It is a handful of small scalars plus one branding object, once
   * per client-page render — cheaper than the render it guards.
   */
  const clientSignature = JSON.stringify(client);

  useEffect(() => {
    setActiveClient({ client, contextDocs, competitors, railAgents, spendableCredits, isAdmin });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    clientSignature,
    docSignature,
    competitorSignature,
    agentSignature,
    spendableCredits,
    isAdmin,
  ]);

  return null;
}
