/**
 * Where the three intake surfaces (X e13, LinkedIn e10, Reddit e15) point, and
 * where other surfaces point INTO them.
 *
 * Client-safe on purpose (no `server-only`): the anchors are rendered by the
 * intake components in the browser and consumed by the agent detail page's
 * inputs band on the server, and the two have to agree byte for byte. A rule
 * that has to hold on both sides of the RSC boundary gets ONE home, or it gets
 * two spellings that drift — which is what the anchor pairing below exists to
 * prevent.
 *
 * Nothing here reads Firestore. `intakePageAction` is handed the agent id its
 * caller already resolved (see `requireIntakeAgentAccess` in
 * agent-intake-views.ts) rather than resolving one itself, so the routing
 * decision stays pure and testable and the read stays where the page's other
 * reads are.
 */

/* ─────────────────── anchors: one row, one place to land ────────────────── */

/**
 * The DOM id an intake row's own card carries, derived from the row id
 * `toAgentInputRows` mints for it.
 *
 * The inputs band on the agent's page ("What it runs on") tells the reader to
 * open any of its rows. Its rows used to be plain `<li>`s with a hover border
 * and nothing to click, and the one real link went to the top of the intake
 * page with nothing identifying the row — worst exactly when the state was
 * worst, since a client with four empty seats clicked the empty seat and got
 * nothing (#85). Both sides now derive the target from the same row id through
 * this function, so a row can only lose its landing place by losing its id.
 *
 * `intake-` prefixed rather than the bare row id because "company" and "news"
 * are ordinary words that another element on those pages could plausibly claim.
 */
export function intakeAnchorId(rowId: string): string {
  return `intake-${rowId}`;
}

/**
 * The anchor for one seat's card.
 *
 * Spelled here rather than at the call sites because the seat row's id is
 * COMPOSED (`seat-${seat.id}` in toAgentInputRows) and the composition is the
 * part that can silently come apart: the band would build `#intake-seat-abc`
 * while the card rendered `#intake-abc`, and a hash that matches nothing scrolls
 * nowhere without erroring. The pairing is asserted directly in
 * agent-intake-anchors.test.ts.
 */
export function intakeSeatAnchorId(seatId: string): string {
  return intakeAnchorId(`seat-${seatId}`);
}

/** The band's link for one row: the intake page, at that row's own card. */
export function intakeRowHref(pageHref: string, rowId: string): string {
  return `${pageHref}#${intakeAnchorId(rowId)}`;
}

/* ────────────────── the archive link inside the feedback box ────────────── */

/**
 * The archive a reader of an intake page can actually reach.
 *
 * BOTH readers land on the SAME route now (2026-08): Account Center's Archive
 * tab, `/clients/<id>/settings?tab=archive`. This used to split — a client's
 * own Workspace board held its own `?tab=archive` view at the flat `/tasks`,
 * and staff had a client-scoped twin at `/clients/<id>/tasks?tab=archive` — but
 * the Workspace board itself is gone (`/tasks` retired entirely, the locked
 * decision "The Board is replaced by the action list on Home" finished playing
 * out), and Account Center's own Archive tab was already the one place either
 * viewer could reach the same list, so this collapses to one destination
 * instead of pointing two readers at two now-deleted pages.
 *
 * The label still moves with the READER, not the destination: "your archive"
 * is client-voiced copy; pointed at one client's workspace for a STAFF reader
 * it would be telling them this client's archive is theirs.
 */
export function clientArchiveLink(args: { clientId: string; isStaff: boolean }): {
  href: string;
  label: string;
} {
  return {
    href: `/clients/${args.clientId}/settings?tab=archive`,
    label: args.isStaff ? "this client's archive" : "your archive",
  };
}

/* ────────── the one control that offers a viewer their agent ───────── */

/**
 * Where a control that offers a viewer their agent goes, and what it may say.
 *
 * FOUR CALL SITES, one answer (grep the name for today's list). It began as the
 * three intake pages' header control (#82). The Workspace activity tab's empty
 * state was found doing the same thing — "Run an agent →" over a hard-coded
 * `/clients/<id>/agents` (#92) — and asks this rather than being edited into a
 * fourth spelling of the same promise. Everything below is therefore a claim
 * about the DESTINATIONS, not about one page's header, which is what makes it
 * safe to ask from anywhere.
 *
 * It said "Run the agent →" to everyone and went to `/clients/<id>/agents`.
 *
 * THAT PROMISE IS WRONG FOR BOTH ROLES, and the first fix here only noticed the
 * client half. It claimed "for staff that is right — the staff branch of that
 * page carries the run dialog". It does not: CD-I1 moved every staff run gesture
 * off the roster and onto the agent's own detail page, and that page says so in
 * its own comments ("both fed the run DIALOG, and CD-I1 moved every staff run
 * gesture to the agent detail page"). Its staff branch renders a header, the lab
 * import and bulk-upload buttons, a replan button, a settings link, a bind
 * control that binds rather than runs, a grid of link cards, and a read-only run
 * history. No run control anywhere — the same page the client branch refuses to
 * put one on. So a staff member read a verb the destination could not honour,
 * exactly like the client, and the fix that closed the client half PINNED the
 * false claim for the other.
 *
 * For a CLIENT it was a promise the destination is built to refuse: the
 * client branch of that page states the rule in its own comment ("No Run button
 * anywhere: a client's run gesture lives only inside a detail page") and
 * renders a header and a roster, nothing else (#82). It was backwards as
 * navigation too — the client REACHED the intake page from the agent's detail
 * page, and this sent them to that page's parent.
 *
 * So BOTH roles are sent to the agent's own page, where the run gesture actually
 * lives for either of them. `agentId` is null when the caller could not resolve
 * one it is sure the viewer may open, and the label drops the promise with the
 * destination rather than keeping it over a roster: naming the roster honestly
 * is worth more than a verb the page cannot honour.
 *
 * The two roles still differ in the WORD, because they arrive differently: a
 * client reached the intake page FROM the agent's detail page, so "Back to the
 * agent" is where they came from; a staff member typically did not, so theirs
 * names the destination instead.
 *
 * ONE LIMIT ON THAT WORD, now that a fourth caller exists. "Back" is an arrival
 * claim, and it is only true of the three intake pages — a client reading the
 * empty Workspace timeline did not come from an agent's page. It cannot be
 * WRONG there, because that caller has no resolvable instance to pass and only
 * ever reaches the roster branch; but a fifth caller that CAN resolve one would
 * need this split reconsidered rather than inherited.
 */
export function intakePageAction(args: {
  clientId: string;
  isStaff: boolean;
  /** This client's granted, enabled instance — see requireIntakeAgentAccess. */
  agentId: string | null;
}): { href: string; label: string; back: boolean } {
  // `back` is the ARROW'S direction, and it belongs to the LABEL rather than to
  // the viewer: only "Back to the agent" is a return, so only it earns a back
  // chevron. The roster branch is a forward move for both roles — a caller can
  // reach it from a surface that was never the agent's page (the Workspace
  // timeline's empty state does), and a left chevron there would point at a
  // journey the reader did not make. No arrows in the labels themselves: each
  // caller draws the icon this flag names.
  if (!args.agentId) {
    // No resolvable instance for either role: name the roster, drop the verb.
    return {
      href: `/clients/${args.clientId}/agents`,
      label: args.isStaff ? "All agents" : "Your agents",
      back: false,
    };
  }
  return {
    href: `/clients/${args.clientId}/agents/${args.agentId}`,
    label: args.isStaff ? "Open the agent" : "Back to the agent",
    back: !args.isStaff,
  };
}
