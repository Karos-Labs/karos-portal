"use client";

import { useRouter } from "next/navigation";

/**
 * Chooses what the onboarding simulation walks through: which flow (today's
 * wizard or the chat prototype), and as whom (a new company or an existing client).
 */
export function OnboardingPreviewPicker({
  clients,
  selectedClientId,
  flow,
}: {
  clients: { id: string; name: string }[];
  selectedClientId: string | null;
  flow: "current" | "chat";
}) {
  const router = useRouter();
  const go = (next: { clientId?: string | null; flow?: "current" | "chat" }) => {
    const clientId = next.clientId !== undefined ? next.clientId : selectedClientId;
    const f = next.flow ?? flow;
    const q = new URLSearchParams();
    if (clientId) q.set("clientId", clientId);
    if (f === "chat") q.set("flow", "chat");
    router.push(`/admin/onboarding-preview${q.size ? `?${q}` : ""}`);
  };
  const selectClass = "rounded-md border border-border bg-surface px-2 py-1 text-xs text-foreground";
  return (
    <div className="mb-6 flex flex-wrap items-center justify-end gap-2 text-xs text-muted-2">
      <label htmlFor="ob-sim-flow">Flow</label>
      <select
        id="ob-sim-flow"
        value={flow}
        onChange={(e) => go({ flow: e.target.value as "current" | "chat" })}
        className={selectClass}
      >
        <option value="current">Current wizard</option>
        <option value="chat">New: chat (prototype)</option>
      </select>
      <label htmlFor="ob-sim-client" className="ms-2">
        Simulate as
      </label>
      <select
        id="ob-sim-client"
        value={selectedClientId ?? ""}
        onChange={(e) => go({ clientId: e.target.value || null })}
        className={selectClass}
      >
        <option value="">New company</option>
        {[...clients]
          .sort((a, b) => a.name.localeCompare(b.name))
          .map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
      </select>
    </div>
  );
}
