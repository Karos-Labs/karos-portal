/**
 * The 15 preset client actions (portal revamp, Surface 08 — page 11 of the
 * SOW). Pure and client-safe: no Firestore, no framework import, so both the
 * Home widget (server component) and any future client component can call it
 * with the signals they already have in hand.
 *
 * PRESET AND DEFINED, NEVER GENERATED. The 15 rows below are the whole list,
 * typed by hand from the SOW's own table — nothing here calls a model, and
 * nothing is worded after a platform or a single agent (the locked decision
 * this file exists to keep true).
 *
 * "DONE" IS COMPUTED, NOT ASSUMED. Most of the 15 are answerable from data
 * the app already has (a profile field filled, a count crossing 1) — those
 * are checked fresh on every read (`ActionSignals`), never cached, so this
 * module cannot go stale the way a stored flag could. A few are genuinely
 * EVENTS with no state to query (a page visited, a video opened) — those
 * read `ClientActionState.status === "done"`, a row written once, elsewhere,
 * the moment the event actually happens (see the doc on `ActionSignals` below
 * for exactly which four and where each is written). "Done means done. If
 * the thing happened, the action is complete, however it happened" — the
 * locked decision this split is built to satisfy.
 */

export interface ActionDefinition {
  id: string;
  category: string;
  label: string;
  icon: string;
  hrefFor: (clientId: string) => string;
}

/**
 * Live signals this client's data can answer directly. Four fields are
 * deliberately ABSENT here (opened-a-video, opened-an-output, week-view
 * visited, feedback sent) — those four are the ones with no query, and their
 * "done" travels through `ClientActionState` instead (see resolveActionList).
 * Two more (02, 05, 07, 09) are documented PROXIES rather than the literal
 * SOW event, for the same reason: no click/open is tracked today. Each is
 * called out at its own action definition below.
 */
export interface ActionSignals {
  profileComplete: boolean;
  hasGrantedAgent: boolean;
  grantedAgentCount: number;
  hasRun: boolean;
  runCount: number;
  hasOutput: boolean;
  hasStarredAgent: boolean;
  hasManualCompetitor: boolean;
  hasUsableChannel: boolean;
  seatCount: number;
}

export const ACTION_DEFINITIONS: ActionDefinition[] = [
  {
    id: "01",
    category: "Get yourself ready",
    label: "Complete your profile",
    icon: "Building2",
    hrefFor: (id) => `/clients/${id}/settings?tab=profile`,
  },
  {
    id: "02",
    category: "Turn on your first agent",
    label: "Discover what our agents do",
    icon: "Bot",
    hrefFor: (id) => `/clients/${id}/agents`,
  },
  {
    id: "03",
    category: "Turn on your first agent",
    label: "Set up your first agent",
    icon: "Sparkles",
    hrefFor: (id) => `/clients/${id}/agents`,
  },
  {
    id: "04",
    category: "Turn on your first agent",
    label: "Run your first agent",
    icon: "Play",
    hrefFor: (id) => `/clients/${id}/agents`,
  },
  {
    id: "05",
    category: "Turn on your first agent",
    label: "See your first output",
    icon: "FileText",
    hrefFor: (id) => `/clients/${id}/settings?tab=archive`,
  },
  {
    id: "06",
    category: "Make it yours",
    label: "Star the agents you use most",
    icon: "Star",
    hrefFor: (id) => `/clients/${id}/agents`,
  },
  {
    id: "07",
    category: "Make it yours",
    label: "Review your competitors",
    icon: "Users",
    hrefFor: (id) => `/clients/${id}/settings?tab=competitors`,
  },
  {
    id: "08",
    category: "Cover everything you bought",
    label: "Set up your second agent",
    icon: "Sparkles",
    hrefFor: (id) => `/clients/${id}/agents`,
  },
  {
    id: "09",
    category: "Cover everything you bought",
    label: "Set up everything on your plan",
    icon: "ListChecks",
    hrefFor: (id) => `/clients/${id}/agents`,
  },
  {
    id: "10",
    category: "Cover everything you bought",
    label: "Confirm your company's social channels",
    icon: "Share2",
    hrefFor: (id) => `/clients/${id}/settings?tab=profile`,
  },
  {
    id: "11",
    category: "Cover everything you bought",
    label: "Add a seat for someone else on your team",
    icon: "UserPlus",
    hrefFor: (id) => `/clients/${id}/agents`,
  },
  {
    id: "12",
    category: "Get into the rhythm",
    label: "Look at your week",
    icon: "CalendarClock",
    hrefFor: () => "/calendar",
  },
  {
    id: "13",
    category: "Get into the rhythm",
    label: "Add context to a post that is coming up",
    icon: "PenLine",
    hrefFor: () => "/calendar",
  },
  {
    id: "14",
    category: "Get into the rhythm",
    label: "Give us your feedback on a post",
    icon: "MessageSquare",
    hrefFor: (id) => `/clients/${id}/settings?tab=archive`,
  },
  {
    id: "15",
    category: "Get into the rhythm",
    label: "Export a day of your content",
    icon: "Download",
    hrefFor: (id) => `/clients/${id}/downloads`,
  },
];

/**
 * Action ids resolved from ClientActionState's stored "done" row rather than
 * a live signal — see the module docstring. "15" belongs here for the same
 * reason as the other three: a zip download has no queryable trace to
 * compute "done" from after the fact, so completion has to be a row written
 * the moment the real event happens (client-downloads.tsx fires it on click).
 * It was missing from this set entirely until 2026-08 — not just missing a
 * writer like 13/14 briefly were, but absent from computeActionDone too, so
 * action 15 had no path to "done" at all, ever.
 */
export const EVENT_TRACKED_ACTION_IDS = new Set(["12", "13", "14", "15"]);

/**
 * Every action's live-computed "done" answer, for the ids NOT in
 * EVENT_TRACKED_ACTION_IDS. Approximations are named where the SOW's literal
 * event ("opened", "reviewed") has no click-tracking behind it yet:
 *
 *  · 02 ("discover what agents do", SOW event: a video opened) — no open is
 *    tracked, so this is DONE exactly when 03 is: setting up an agent means
 *    its data page has already been seen.
 *  · 05 ("see your first output", SOW event: the output opened) — proxied by
 *    "a deliverable exists at all" (`hasOutput`), since nothing logs a client
 *    opening one.
 *  · 07 ("review your competitors", SOW event: the competitors opened) —
 *    proxied by `hasManualCompetitor` (the client added one themselves)
 *    rather than "any competitor row exists", which the intel pipeline seeds
 *    automatically and would mark this done with no client action at all.
 *  · 09 ("set up everything on your plan") — proxied by "at least one run per
 *    granted agent" (`runCount >= grantedAgentCount`), since per-agent setup
 *    completeness isn't cheaply queryable from Home's own data.
 */
export function computeActionDone(signals: ActionSignals): Record<string, boolean> {
  const done03 = signals.hasGrantedAgent;
  return {
    "01": signals.profileComplete,
    "02": done03,
    "03": done03,
    "04": signals.hasRun,
    "05": signals.hasOutput,
    "06": signals.hasStarredAgent,
    "07": signals.hasManualCompetitor,
    "08": signals.grantedAgentCount >= 2,
    "09": signals.hasGrantedAgent && signals.runCount >= signals.grantedAgentCount,
    "10": signals.hasUsableChannel,
    "11": signals.seatCount >= 2,
  };
}

export type ResolvedActionStatus = "done" | "not_relevant" | "dismissed" | "eligible";

export interface ResolvedAction extends ActionDefinition {
  status: ResolvedActionStatus;
}

/** A dismissed action rotates back into the queue after this long. */
export const ACTION_DISMISS_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Every action's full resolved status: live signals for the computed ones,
 * `ClientActionState` for the event-tracked and the two client-chosen states
 * (dismissed/not_relevant). `states` is this client's whole row set, however
 * small — no per-action query, one read serves all 15.
 */
export function resolveActionList(
  signals: ActionSignals,
  states: ReadonlyMap<string, { status: "dismissed" | "not_relevant" | "done"; updatedAt: number }>,
  now: number,
): ResolvedAction[] {
  const computedDone = computeActionDone(signals);
  return ACTION_DEFINITIONS.map((def) => {
    const state = states.get(def.id);
    // not_relevant is permanent and outranks everything, including a signal
    // that would otherwise read "done" — a client who dismissed it for good
    // does not want to see it flip states later.
    if (state?.status === "not_relevant") return { ...def, status: "not_relevant" as const };
    if (state?.status === "done") return { ...def, status: "done" as const };
    if (EVENT_TRACKED_ACTION_IDS.has(def.id)) {
      return { ...def, status: "eligible" as const };
    }
    if (computedDone[def.id]) return { ...def, status: "done" as const };
    if (state?.status === "dismissed" && now - state.updatedAt < ACTION_DISMISS_COOLDOWN_MS) {
      return { ...def, status: "dismissed" as const };
    }
    return { ...def, status: "eligible" as const };
  });
}

/** The top N not-yet-done, not-hidden actions, in the SOW's own priority order (page 11 — "ordered by what we want them to do"). */
export function selectTopActions(resolved: ResolvedAction[], count = 3): ResolvedAction[] {
  return resolved.filter((a) => a.status === "eligible").slice(0, count);
}

/** A resolved action with its href already resolved to a plain string — see `toClientActions`. */
export interface ClientResolvedAction extends Omit<ResolvedAction, "hrefFor"> {
  href: string;
}

/**
 * The one boundary-safe projection every caller must run a `ResolvedAction[]`
 * through before handing it to `ActionListWidget` ("use client"). `hrefFor` is
 * a live function — fine inside pure server-side computation, but React
 * Flight refuses to serialize a function into a Client Component's props
 * ("Functions cannot be passed directly to Client Components..."), so passing
 * `ResolvedAction[]` straight across crashes the render every time, for every
 * client, unconditionally — this isn't a rare edge case, it's every Home page
 * load. Resolves `hrefFor(clientId)` into a plain `href` string and drops the
 * function itself, the same way `toClientPortalView`/`sanitizeIntegrations`
 * strip what a client component may not receive.
 */
export function toClientActions(resolved: ResolvedAction[], clientId: string): ClientResolvedAction[] {
  return resolved.map(({ hrefFor, ...rest }) => ({ ...rest, href: hrefFor(clientId) }));
}
