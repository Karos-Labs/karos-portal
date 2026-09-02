/**
 * The client action checklist (portal revamp, Surface 08 — page 11 of the
 * SOW; extended 2026-08 for mandatory onboarding coverage). Pure and
 * client-safe: no Firestore, no framework import, so both the Home widget
 * (server component) and any future client component can call it with the
 * signals they already have in hand.
 *
 * PRESET AND DEFINED, NEVER GENERATED — still true. Every row below is typed
 * by hand; nothing here calls a model. What is NOT true any more: the
 * original 15 rows carried a second rule alongside that one — "nothing is
 * worded after a platform or a single agent" — kept so a generic checklist
 * wouldn't read like five separate integration nags. That half is reversed,
 * deliberately, 2026-08: ids 16-20 name LinkedIn/X/Instagram/YouTube/Google
 * Business Profile by name, because a mandatory onboarding checklist that
 * cannot tell a client WHICH platform to connect is not actionable. Ids
 * 01-15 are untouched (same ids, same signals, no `ClientActionState`
 * migration) — this is an addition, not a rewrite of the locked SOW table.
 *
 * "DONE" IS COMPUTED, NOT ASSUMED. Most rows are answerable from data the app
 * already has (a profile field filled, a count crossing 1, a platform
 * connected) — those are checked fresh on every read (`ActionSignals`),
 * never cached, so this module cannot go stale the way a stored flag could.
 * A few are genuinely EVENTS with no state to query (a page visited, a video
 * opened, a document opened) — those read `ClientActionState.status ===
 * "done"`, a row written once, elsewhere, the moment the event actually
 * happens (see the doc on `ActionSignals` below, and `EVENT_TRACKED_ACTION_IDS`,
 * for exactly which ids and where each is written). "Done means done. If the
 * thing happened, the action is complete, however it happened" — the locked
 * decision this split is built to satisfy.
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
  /** Usable (connected + healthy) platform ids — drives ids 16-20's per-platform "done". */
  connectedPlatformIds: string[];
  /** An admin has actually touched this client's credit limits/balance away from CREDIT_DEFAULTS — drives id 24. */
  hasBillingConfigured: boolean;
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
    // The calendar's archive view, not Account Center's retired Archive tab
    // (portal feedback round 2, 2026-09). Written as the FLAT route so a
    // client lands on their own calendar with no redirect hop; the staff Home
    // rewrites it to the client-scoped one through `toClientActions`.
    hrefFor: () => "/calendar?view=archive",
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
    // The calendar's archive view, not Account Center's retired Archive tab
    // (portal feedback round 2, 2026-09). Written as the FLAT route so a
    // client lands on their own calendar with no redirect hop; the staff Home
    // rewrites it to the client-scoped one through `toClientActions`.
    hrefFor: () => "/calendar?view=archive",
  },
  {
    id: "15",
    category: "Get into the rhythm",
    label: "Export a day of your content",
    icon: "Download",
    hrefFor: () => "/calendar",
  },
  // Ids 16-24, added 2026-08 — see the module docstring for the reversed
  // "never worded after a platform" rule this block exists under. `tab=settings`
  // (16-20) is the real OAuth Integrations tab (integrations-tab.tsx) —
  // deliberately NOT the same destination as id 10's `tab=profile`, which only
  // edits the client's own social-handle text fields. Two different "channels"
  // concepts already coexist on the settings page; this reuses the one that
  // actually connects something.
  {
    id: "16",
    category: "Connect your channels",
    label: "Connect LinkedIn",
    icon: "Briefcase",
    hrefFor: (id) => `/clients/${id}/settings?tab=settings`,
  },
  {
    id: "17",
    category: "Connect your channels",
    label: "Connect X",
    icon: "AtSign",
    hrefFor: (id) => `/clients/${id}/settings?tab=settings`,
  },
  {
    id: "18",
    category: "Connect your channels",
    label: "Connect Instagram",
    icon: "Camera",
    hrefFor: (id) => `/clients/${id}/settings?tab=settings`,
  },
  {
    id: "19",
    category: "Connect your channels",
    label: "Connect YouTube",
    icon: "Video",
    hrefFor: (id) => `/clients/${id}/settings?tab=settings`,
  },
  {
    id: "20",
    category: "Connect your channels",
    label: "Connect Google Business Profile",
    icon: "MapPin",
    hrefFor: (id) => `/clients/${id}/settings?tab=settings`,
  },
  {
    id: "21",
    category: "Make it yours",
    label: "Set your brand voice",
    icon: "Sparkles",
    hrefFor: (id) => `/clients/${id}/settings?tab=documents`,
  },
  {
    id: "22",
    category: "Make it yours",
    label: "Set up your target persona",
    icon: "Users",
    hrefFor: (id) => `/clients/${id}/settings?tab=documents`,
  },
  {
    id: "23",
    category: "Make it yours",
    label: "Review your competitor analysis",
    icon: "Radar",
    hrefFor: (id) => `/clients/${id}/settings?tab=competitors`,
  },
  {
    id: "24",
    category: "Cover everything you bought",
    label: "Confirm your credit & billing setup",
    icon: "Coins",
    hrefFor: (id) => `/clients/${id}/settings?tab=credits`,
  },
];

/**
 * Action ids resolved from ClientActionState's stored "done" row rather than
 * a live signal — see the module docstring. "15" belongs here for the same
 * reason as the other three: a zip download has no queryable trace to
 * compute "done" from after the fact, so completion has to be a row written
 * the moment the real event happens (client-downloads.tsx fires it on
 * click — moved 2026-08 from its own standalone Downloads page onto a
 * persistent card at the bottom of the Calendar page; same component, same
 * click site, only the page it's mounted on changed).
 * It was missing from this set entirely until 2026-08 — not just missing a
 * writer like 13/14 briefly were, but absent from computeActionDone too, so
 * action 15 had no path to "done" at all, ever.
 *
 * "21"/"22"/"23" joined the same way, same reason, added alongside ids
 * 16-24: brand voice, target persona and competitor analysis are all
 * pipeline-generated CONTEXT DOCUMENTS (ClientContextDoc, docTypes
 * "brand-voice"/"target-audience"/"competitor-analysis" — client-documents.tsx),
 * not a client-authored profile field. There is nothing to query for "has the
 * client looked at this" beyond the moment they open it, so completion is a
 * row client-documents.tsx writes on open, the same as 12-15's writers.
 * (`client.brandVoice` looks like a live signal but is dead — nothing in the
 * portal writes to it any more — so it is deliberately not read here.)
 */
export const EVENT_TRACKED_ACTION_IDS = new Set(["12", "13", "14", "15", "21", "22", "23"]);

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
 *
 * 16-20 are each a single platform id membership check against
 * `connectedPlatformIds` (usable, not merely "an integration doc exists" —
 * same `integrationIsUsable` gate id 10's `hasUsableChannel` already uses,
 * just per-platform instead of "any"). 24 checks the credit doc has actually
 * been touched away from its defaults, rather than merely existing — every
 * client gets a default doc lazily, so "exists" alone would mark this done
 * for a client nobody has configured anything for.
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
    "16": signals.connectedPlatformIds.includes("linkedin"),
    "17": signals.connectedPlatformIds.includes("twitter"),
    "18": signals.connectedPlatformIds.includes("instagram"),
    "19": signals.connectedPlatformIds.includes("youtube"),
    "20": signals.connectedPlatformIds.includes("google_business_profile"),
    "24": signals.hasBillingConfigured,
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
 * small — no per-action query, one read serves the whole list.
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

/**
 * Whether the Home widget should open already-expanded rather than collapsed
 * to its usual top-3 — the "mandatory onboarding checklist" ask, satisfied by
 * PROMINENCE rather than a navigation block: `onboarding.ts`'s separate
 * 2-step signup wizard already gates first login, and turning this into a
 * second gate would make a pure boolean check depend on a live Firestore read
 * on every navigation. A client who has barely started (almost nothing
 * resolved as anything but "eligible") sees the whole list at once instead of
 * the usual top 3; one who has made real progress gets the normal collapsed
 * view, same as today.
 */
export function shouldStartExpanded(resolved: ResolvedAction[]): boolean {
  const visible = resolved.filter((a) => a.status !== "not_relevant");
  if (visible.length === 0) return false;
  const eligible = visible.filter((a) => a.status === "eligible").length;
  return eligible >= visible.length - 2;
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
export function toClientActions(
  resolved: ResolvedAction[],
  clientId: string,
  opts: {
    /**
     * Where the flat `/calendar` rows (ids 05, 12, 13, 14, 15) should open
     * instead. The flat route scopes itself to the viewer's OWN client - which
     * is the right page for a CLIENT_USER and the cross-client overview for a
     * staff member previewing that client (calendar-body.tsx's `isClient`
     * branch is the only one that scopes it, keyed off `user.clientId`). The
     * staff Home passes `/clients/${id}/calendar` so the same row lands on the
     * same client's calendar for both readers.
     */
    calendarHref?: string;
  } = {},
): ClientResolvedAction[] {
  return resolved.map(({ hrefFor, ...rest }) => {
    const href = hrefFor(clientId);
    // PREFIX rewrite, not an exact-string one (portal feedback round 2,
    // 2026-09). Two rows now point at `/calendar?view=archive` — the archive
    // moved off Account Center's settings tabs and onto the calendar — and an
    // `=== "/calendar"` test would have left exactly those two rows on the
    // cross-client overview for staff, which has no one client's archive to
    // show. The query is carried across verbatim so the destination keeps the
    // view (and the status filter) the row asked for.
    if (!opts.calendarHref || !(href === "/calendar" || href.startsWith("/calendar?"))) {
      return { ...rest, href };
    }
    return { ...rest, href: `${opts.calendarHref}${href.slice("/calendar".length)}` };
  });
}
