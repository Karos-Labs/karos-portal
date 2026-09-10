"use client";

import { notFound } from "next/navigation";
import { RunCustomAgentModal, type RunnableAgentSummary } from "@/components/custom-agents";

/**
 * DEV ONLY (the parent route 404s in production; this page is only reachable
 * beside it). The run form drawn IN THE PAGE, to check the in-page shell
 * without a live client account. Nothing here submits anywhere useful: there
 * is no agent service listening locally.
 */
const AGENTS: RunnableAgentSummary[] = [
  { id: "demo-linkedin", key: "karos-linkedin-writer-v2", name: "LinkedIn Agent", clientBlurb: null, icon: "Share2", color: "#ff6b2c", enabled: true, creditCost: 20 },
  { id: "demo-x", key: "karos-x-agent-v2", name: "X Agent", clientBlurb: null, icon: "Share2", color: "#ff6b2c", enabled: true, creditCost: 20 },
  { id: "demo-reddit", key: "karos-reddit-agent", name: "Reddit Agent", clientBlurb: null, icon: "Share2", color: "#ff6b2c", enabled: true, creditCost: 20 },
];

export default function RunFormPreview() {
  if (process.env.NODE_ENV === "production") notFound();
  return (
    <div className="min-h-screen bg-background p-6 text-foreground md:p-10">
      <div className="@container mx-auto w-full max-w-3xl space-y-10">
        <div>
          <h1 className="text-xl font-semibold">The run form, in the page</h1>
          <p className="mt-2 text-sm text-muted">
            No button to open it and no dialog: the fields each agent needs, where the agent is.
          </p>
        </div>
        {AGENTS.map((agent) => (
          <div key={agent.id}>
            <p className="mb-2 font-mono text-[11px] text-muted-2">{agent.name}</p>
            <RunCustomAgentModal
              agent={agent}
              clientId="demo-client"
              engineDispatch={{}}
              contextItems={[]}
              viewerIsClient
              stayOnPage
              inline
              onClose={() => {}}
            />
          </div>
        ))}
      </div>
    </div>
  );
}
