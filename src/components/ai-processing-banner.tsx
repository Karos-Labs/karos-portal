import { Icon } from "@/components/icon";

/**
 * Shown on the Dashboard, Task Map, and Settings views while `client.isAiProcessing`
 * is true — surfaces the shared workspace lock to every user on the account so a
 * teammate on another tab understands why Regenerate / Refresh Task Map are greyed out.
 */
export function AiProcessingBanner() {
  return (
    <div className="mb-4 flex items-center gap-2.5 rounded-md border border-neon/25 bg-neon-soft px-3.5 py-2.5 text-sm text-foreground">
      <Icon name="Loader" className="h-4 w-4 shrink-0 animate-spin text-neon" />
      <p>
        <span className="font-medium">Karos Agents are building your workspace strategy</span>{" "}
        <span className="text-muted">— Regenerate and Refresh Task Map are locked until this finishes.</span>
      </p>
    </div>
  );
}
