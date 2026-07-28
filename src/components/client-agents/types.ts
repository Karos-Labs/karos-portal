import type { ClientAgentLaunchState, ClientAgentTemplate } from "@/lib/types";
import type { LaunchBlockCode } from "@/lib/client-agents";

/**
 * The client-safe projection of a client-agent umbrella.
 *
 * Everything a browser receives about an umbrella is built HERE, on the server,
 * before it crosses the RSC boundary — the wave-1 rule. In particular
 * `launchError` is already run through clientSafeRefusal for client viewers, so
 * a service URL or an env-var name in a failed setup run cannot be read out of
 * the payload even though nothing paints it.
 */
export interface ClientAgentCardRow {
  id: string;
  clientId: string;
  /** Identity string for the platform mark ("<key> <name>"). */
  identity: string;
  /** Stored lucide icon of the bound lab agent (mark fallback). */
  icon: string;
  displayName: string;
  /** What this agent does, in the client's words. */
  blurb: string | null;
  launchState: ClientAgentLaunchState;
  launchStartedAt: number | null;
  /** Redacted for client viewers; raw for staff. */
  launchError: string | null;
  /** True when a failed client-billed launch was refunded. */
  launchRefunded: boolean;
  /**
   * What a launch costs THIS viewer. null for staff and impersonated admins
   * (their launches are free) and for a client whose agent has no calibrated
   * price yet — in which case the gate below is what explains the button.
   */
  launchCost: number | null;
  /** The §2 ladder, already evaluated server-side. */
  gate: { allowed: boolean; code?: LaunchBlockCode; reason?: string };
  /** Set when the intake rung is what blocks — links the page that fixes it. */
  setupHref?: string | null;
  setupLabel?: string | null;
  templates: ClientAgentTemplate[];
}
