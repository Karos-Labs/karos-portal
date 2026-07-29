import type { ClientAgentLaunchState, ClientAgentTemplate } from "@/lib/types";
import type { LaunchBlockCode } from "@/lib/client-agents";
import type { TemplateRunBlockCode } from "@/lib/client-agent-runs";
import type { XOption } from "@/lib/x-options";
import type { ClientAgentScheduleRow, RunnableAgentSummary } from "@/components/custom-agents";

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
  /** The bound lab agent. Stable across re-imports of the umbrella. */
  customAgentId: string;
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
  /**
   * The CLIENT's name for that page ("Your X details"), never the operator one
   * ("X agent data") — every surface that paints this row is client-facing.
   */
  setupLabel?: string | null;
  templates: ClientAgentTemplate[];

  /* ───────────────────────── live view (WP-2) ───────────────────────── */

  /**
   * The daily pick-of-3 product (X) rather than template streams. Read from the
   * umbrella's stored `slotMode`, never inferred from a missing chain family.
   */
  optionsMode: boolean;
  /**
   * What one manual template run costs THIS viewer — the agent's flat per-run
   * price (Q6: templates inherit it). null for staff, whose runs are free.
   */
  runCost: number | null;
  /**
   * Per template key: the §7.1 run gate, evaluated server-side with the same
   * pure function the action runs, so a row can only ever offer a press the
   * server would accept (F131). Present only for a live umbrella.
   */
  templateGates: Record<string, { allowed: boolean; code?: TemplateRunBlockCode; reason?: string }>;
  /**
   * The next few days of the plan: day + the label a chip paints. INTENT ONLY —
   * no asset id, no fulfilment state, nothing that could tell a client whether
   * a future day's post already exists (§4.1, the A3 churn rule). Two producers
   * project into the same chip and the client cannot tell them apart.
   */
  week: Array<{
    dateKey: string;
    label: string;
    /**
     * The slot's own id, so a day can carry a note (§4.3). NOT a fulfilment
     * tell: every planned day has one, whether or not anything exists for it,
     * so it stays indistinguishable exactly as the label does.
     */
    slotId: string;
    /** The note on this day, if any — echoed back to whoever can read it. */
    note: { text: string; authorName: string; createdAt: number; applied: boolean } | null;
    /** False once the day has passed: a note then could never be applied. */
    canNote: boolean;
  }>;
  /**
   * TODAY's three options, for an options-mode umbrella (§4.5, WP-9).
   *
   * Present ONLY for the current day, and only once its options are assigned.
   * A future day's texts never enter this payload — their existence is the one
   * fact the churn rule keeps indistinguishable, and redaction that happens at
   * render time has already lost. Null once the client has chosen, with the
   * direction they picked, so the day can show a receipt instead of re-offering
   * options they already declined.
   */
  today: {
    slotId: string;
    options: XOption[];
    pickedDirection: string | null;
  } | null;
  /** Two-level feedback already on this umbrella (WP-3). */
  feedback: ClientAgentFeedbackRow[];
  /**
   * A template run THIS viewer's side started that has not landed yet.
   *
   * Deliberately narrow: only `manual_template` runs, never scheduled fires.
   * A client who presses "Run now" has to see that something happened (the run
   * takes 10–20 minutes and there is no run row under an umbrella card any
   * more), but a card announcing that a SCHEDULED batch is running right now
   * would say out loud that production is not day-of — the exact tell §4.1
   * removes the batch rows to hide.
   */
  activeRun: {
    /**
     * The job's own id, so the client can STOP a run they just started (F30).
     * Not a new disclosure: client run rows have always carried job ids (only
     * the /jobs link target is staff-gated), and the cancel action authorizes
     * on the job's stored clientId rather than anything the browser sends.
     */
    id: string;
    status: "queued" | "running";
    templateName: string | null;
  } | null;
  /** The bound lab agent, for the existing schedule dialog ("Adjust pace"). */
  runnable: RunnableAgentSummary | null;
  /** Its weekly schedule row, already redacted for client viewers. */
  schedule: ClientAgentScheduleRow | null;
  /**
   * Spendable credits right now — passed straight through to the shared
   * schedule dialog so its own weekly-cost warning works from the live card
   * exactly as it does from the generic one. Absent for non-billable actors.
   */
  availableCredits?: number;
}

/* ─────────────────── template click-through (CD-K1) ─────────────────── */

/**
 * One post this agent already delivered under a template.
 *
 * Built from the SAME set the page's archive rides — `agentProducedAssets`,
 * which runs a client viewer through `getClientArchiveAssets` — so opening a
 * template can never become a second, laxer route to work that has not been
 * delivered. There is deliberately no status, no draft marker and no "ready"
 * field: a template's history is a list of things that exist, and anything that
 * distinguished a pre-generated post from a day-of one would put the batch
 * shape back on the page the archive filter took it off (A3/A4).
 *
 * `at` is the deliverable stamp for THIS viewer (delivery for a client, the
 * generation instant for staff), resolved server-side by `deliverableStamp`.
 */
export interface TemplatePostRow {
  id: string;
  title: string;
  /** Epoch millis. */
  at: number;
}

/**
 * What clicking a template opens onto.
 *
 * Keyed by template key beside the registry rather than folded into
 * `ClientAgentTemplate`: the registry entry is the STORED document (and the
 * shape the curation pane writes), while this is a per-viewer projection of it.
 */
export interface TemplateDetail {
  key: string;
  /**
   * The launch run's full reasoning. The collapsed row clamps it to two lines;
   * this is what the expansion exists to show.
   */
  rationale?: string;
  /** When this template joined the registry (epoch millis). */
  addedAt: number;
  /** Where it came from — a launch run, a backfill, or a human. */
  source: ClientAgentTemplate["source"];
  /** Newest first, capped. */
  posts: TemplatePostRow[];
  /** How many delivered posts this viewer may see under it, before the cap. */
  postCount: number;
}

/**
 * One feedback entry as a browser may see it.
 *
 * `authorName` is resolved server-side rather than sent as a uid: a client
 * reading their own agent's feedback list has no business receiving the
 * internal identifiers of the staff members who answered it.
 */
export interface ClientAgentFeedbackRow {
  id: string;
  scope: "agent" | "template";
  templateKey: string | null;
  text: string;
  /** Mirrors ClientAgentFeedback["status"] — "withdrawn" is the author's own
   *  retraction and must never be painted as "Resolved" (D7). */
  status: "active" | "resolved" | "withdrawn";
  authorName: string;
  creatorRole: "client" | "staff";
  createdAt: number;
  /** True when this viewer wrote it (client) or is staff — controls edit/delete. */
  editable: boolean;
}
